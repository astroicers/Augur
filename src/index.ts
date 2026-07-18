/**
 * 進入點：載 config → 建廣播 sink（Edge TTS + 前端 WS，ADR-001）→ 啟動 HTTP server。
 * （AIRI 已由瀏覽器 avatar 取代，ADR-008 Superseded；airi.ts 保留為 dormant。）
 */
import { serve } from '@hono/node-server'
import { loadDotEnv, loadConfig } from './config.js'
import { createBroadcastSink } from './sink/broadcastSink.js'
import { createEdgeTTS } from './tts/edgeTts.js'
import { createServer } from './server.js'
import { createDedup } from './core/dedup.js'

loadDotEnv()
const config = loadConfig()

// 廣播 sink：起前端 WS server + Edge TTS。webhook 永遠快速回 200，TTS 失敗只記 log。
const tts = createEdgeTTS(config.ttsVoice)
const sink = createBroadcastSink({ host: config.host, wsPort: config.wsPort, tts })
// 去重/防洪 + resolved 綁狀態（Phase 2）。
const dedup = createDedup(config.dedupWindowSec)
const app = createServer(config, sink, dedup)

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(`[bridge] 接收層啟動於 http://${config.host}:${info.port}`)
    console.log(`[bridge] Grafana webhook：POST http://${config.host}:${info.port}/grafana/webhook`)
    console.log(`[bridge] 前端 avatar WS：ws://${config.host}:${config.wsPort}`)
  },
)

function shutdown(signal: string): void {
  console.log(`\n[bridge] 收到 ${signal}，關閉中…`)
  sink.close()
  dedup.close()
  server.close(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// AIRI ws 端的錯誤（例如 invalid token / 斷線）由 server-sdk 以非同步事件丟出，
// 可能逸出成 uncaughtException。bridge 的 HTTP 接收層不該因此整個掛掉 →
// 記 log 並維持運行（符合「sink 失敗只記 log、永遠快速回 200」的設計）。
process.on('uncaughtException', (err) => {
  console.error('[bridge] 已捕捉例外（多半來自 AIRI 連線，如 invalid token）：', err instanceof Error ? err.message : err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[bridge] 已捕捉未處理 rejection：', reason instanceof Error ? reason.message : reason)
})
