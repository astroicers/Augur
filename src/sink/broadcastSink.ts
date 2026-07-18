/**
 * 廣播 sink（取代 airi.ts 為 active sink，ADR-001）。
 * 起一個 WebSocketServer 給前端 avatar client；每則 BroadcastPlan 先用 TTS 合成語音，
 * 再把 { type:'broadcast', plan, audio(base64 mp3) } 推給所有連線的前端。
 * = spike-c-e2e server 邏輯的 Augur 生產模組化。
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { BroadcastPlan } from '../core/types.js'
import { severityToEmotion } from '../core/emotion.js'
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
  /** dev/demo：允許前端經 WS 送 {type:'trigger',severity} 觸發示範播報。預設 true。 */
  allowDevTrigger?: boolean
}

/** 示範播報用的句子（dev-trigger）。 */
const DEMO_TEXT: Record<string, string> = {
  critical: '嚴重警報：資料庫 CPU 使用率達 95%，已持續五分鐘。',
  warning: '警告：API 平均延遲上升至 800 毫秒。',
  resolved: '已恢復：資料庫 CPU 已回到正常範圍。',
  info: '狀態更新：系統目前一切正常。',
}

export function createBroadcastSink(opts: BroadcastSinkOptions): Sink {
  const wss = new WebSocketServer({ host: opts.host, port: opts.wsPort })
  let listening = false
  const allowDevTrigger = opts.allowDevTrigger !== false

  async function emit(plan: BroadcastPlan): Promise<void> {
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
  }

  function demoPlan(severity: string): BroadcastPlan {
    const status: BroadcastPlan['status'] = severity === 'resolved' ? 'resolved' : 'firing'
    return {
      text: DEMO_TEXT[severity] ?? `測試播報：${severity}`,
      severity,
      emotion: severityToEmotion(severity, status),
      name: 'demo',
      status,
    }
  }

  wss.on('listening', () => {
    listening = true
    console.log(`[broadcast] 前端 WS 監聽於 ws://${opts.host}:${opts.wsPort}`)
  })
  wss.on('connection', (ws) => {
    console.log(`[broadcast] 前端連上（目前 ${wss.clients.size} 個）`)
    if (!allowDevTrigger) return
    // dev/demo：前端測試鈕送 {type:'trigger',severity} → 觸發一則示範播報。
    // ⚠️ 生產應設 ALLOW_DEV_TRIGGER=false 或加 WS auth（P4）——任何連上者皆可觸發 TTS。
    ws.on('message', (raw: RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; severity?: string }
        if (msg.type === 'trigger') void emit(demoPlan(String(msg.severity ?? 'critical')))
      } catch {
        // 忽略非 JSON 訊息
      }
    })
  })
  wss.on('error', (err) => {
    console.error('[broadcast] WS server 錯誤：', err instanceof Error ? err.message : err)
  })

  return {
    broadcast: (plan) => emit(plan),
    isReady: () => listening,
    close: () => {
      for (const client of wss.clients) client.close()
      wss.close()
    },
  }
}
