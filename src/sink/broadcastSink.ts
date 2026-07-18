/**
 * 廣播 sink（取代 airi.ts 為 active sink，SPEC/ADR-001）。
 * 起一個 WebSocketServer 給前端 avatar client；每則 BroadcastPlan 先用 TTS 合成語音，
 * 再把 { type:'broadcast', plan, audio(base64 mp3) } 推給所有連線的前端。
 * = spike-c-e2e server 邏輯的 Augur 生產模組化。
 */
import { WebSocketServer, WebSocket } from 'ws'
import type { BroadcastPlan } from '../core/types.js'
import type { TTSProvider } from '../tts/edgeTts.js'

/** 導播下游的抽象介面（server.ts 只依賴這個，不依賴具體實作）。 */
export interface Sink {
  /** 合成語音並推播一則計畫給前端。內部吞掉 TTS 失敗（改送無音訊），不 throw。 */
  broadcast(plan: BroadcastPlan): Promise<void>
  /** WS server 是否已在監聽（給 /healthz）。 */
  isReady(): boolean
  /** 關閉所有連線與 server。 */
  close(): void
}

export interface BroadcastSinkOptions {
  host: string
  wsPort: number
  tts: TTSProvider
}

export function createBroadcastSink(opts: BroadcastSinkOptions): Sink {
  const wss = new WebSocketServer({ host: opts.host, port: opts.wsPort })
  let listening = false

  wss.on('listening', () => {
    listening = true
    console.log(`[broadcast] 前端 WS 監聽於 ws://${opts.host}:${opts.wsPort}`)
  })
  wss.on('connection', () => {
    console.log(`[broadcast] 前端連上（目前 ${wss.clients.size} 個）`)
  })
  wss.on('error', (err) => {
    console.error('[broadcast] WS server 錯誤：', err instanceof Error ? err.message : err)
  })

  return {
    async broadcast(plan: BroadcastPlan): Promise<void> {
      let audio = ''
      try {
        audio = await opts.tts.synth(plan.text)
      } catch (err) {
        console.error('[broadcast] TTS 合成失敗，改送無音訊：', err instanceof Error ? err.message : err)
      }
      const msg = JSON.stringify({ type: 'broadcast', plan, audio })
      let sent = 0
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg)
          sent++
        }
      }
      console.log(`[broadcast] ${plan.severity} ${plan.name} → ${sent} 個前端`)
    },
    isReady: () => listening,
    close: () => {
      for (const client of wss.clients) client.close()
      wss.close()
    },
  }
}
