/** 播報語言（告警唸稿用哪種語言組句）。 */
export type AlertLang = 'zh' | 'en'

/**
 * 來源中立的核心型別 — 這是整個架構唯一的抽象邊界（SPEC §3 / §9.2）。
 *
 * 每個來源 adapter（目前只有 sources/grafana.ts）負責把該來源的原始格式
 * 轉成 ParsedAlert[]。core/ 與 airi.ts 只認得 ParsedAlert，不知道任何來源細節。
 */
export interface ParsedAlert {
  /** 告警狀態 */
  status: 'firing' | 'resolved'
  /** 來源標記（例如 'grafana'）；欄位本身不含來源特定結構 */
  source: string
  /** 告警名稱 */
  name: string
  /** 嚴重度，缺省 'unknown' */
  severity: string
  /** 受影響對象（可選） */
  instance?: string
  /** 摘要（可選） */
  summary?: string
  /** 實際數值（可選） */
  value?: number
  /** 開始時間（ISO8601 字串） */
  startsAt: string
  /** 去重 key */
  fingerprint: string
  /** 可選：回連來源的 URL */
  panelURL?: string
}
