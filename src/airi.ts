/**
 * AIRI sink：@proj-airi/server-sdk 的封裝（SPEC §8 / 調查項目 1）。
 *
 * 唯一發聲路徑：送 `input:text` 事件 → AIRI 本地 LLM brain → 桌面 TTS 念出。
 * server-sdk 協議層「沒有」直接 TTS / speak 事件（已驗證 v0.10.2 原始碼），
 * 所以精確逐字播報無法保證，文字會被角色用自己的語氣轉述——這正是 §5 架構與
 * §134「format 保持笨、語氣交給 AIRI」的設計意圖。
 */
import { Client } from '@proj-airi/server-sdk'
import type { AppConfig } from './config.js'

export interface AiriSink {
  /** 把一段文字送給 AIRI 讓角色念出來（非阻塞；未連上時記 log 不丟例外）。 */
  speakAlert: (text: string) => void
  /** 是否已連上且可發送。 */
  isReady: () => boolean
  /** 關閉連線。 */
  close: () => void
}

export function createAiriSink(config: AppConfig): AiriSink {
  // autoConnect 預設 true → 建構即在背景連線；autoReconnect 預設 true → 斷線自動重連。
  const client = new Client({
    name: config.airiName,
    url: config.airiWsUrl,
    token: config.airiAuthToken,
    onReady: () => console.log(`[airi] 已連上 ${config.airiWsUrl}（角色可發聲）`),
    onError: (err: unknown) => console.error('[airi] client error：', err instanceof Error ? err.message : err),
    onClose: () => console.warn('[airi] 連線關閉'),
  })

  function speakAlert(text: string): void {
    const ok = client.send({ type: 'input:text', data: { text } })
    if (!ok) {
      console.warn(`[airi] 尚未連上，略過此次播報：${text}`)
    }
  }

  return {
    speakAlert,
    isReady: () => client.isReady,
    close: () => client.close(),
  }
}
