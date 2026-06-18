/**
 * 進入點（SPEC §7）：載 config → 連 AIRI（airi.ts）→ 啟動 HTTP server（server.ts）。
 */
import { serve } from '@hono/node-server'
import { loadDotEnv, loadConfig } from './config.js'
import { createAiriSink } from './airi.js'
import { createServer } from './server.js'

loadDotEnv()
const config = loadConfig()

// autoConnect：背景連 AIRI。未連上時 webhook 仍會回 200，播報會被略過並記 log。
const sink = createAiriSink(config)
const app = createServer(config, sink)

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(`[bridge] 接收層啟動於 http://${config.host}:${info.port}`)
    console.log(`[bridge] Grafana webhook：POST http://${config.host}:${info.port}/grafana/webhook`)
  },
)

function shutdown(signal: string): void {
  console.log(`\n[bridge] 收到 ${signal}，關閉中…`)
  sink.close()
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
