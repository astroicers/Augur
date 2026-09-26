/** 播報語言（告警唸稿用哪種語言組句）。 */
export type AlertLang = 'zh' | 'en'

/**
 * 來源中立的核心型別 — 這是整個架構唯一的抽象邊界。
 *
 * 來源層負責把該來源的原始格式轉成 ParsedAlert[]；core/ 只認得 ParsedAlert，
 * 不知道任何來源細節。ADR-004 之後的來源是 panel 自己的 `props.data`
 * （alertState 為主、fieldConfig.thresholds 為輔），來源層屬 P4 範圍、尚未實作。
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

/** 表情狀態 — 對映 `live2d/_archive/live2d-template-spec-v1.md` §6（severity/status → 表情）。 */
export type Emotion = 'calm' | 'warning' | 'critical' | 'resolved'

/**
 * 播報計畫 — 導播輸出給前端 avatar 的單則指令（取代舊的純 text sink）。
 * text 給 TTS 念；emotion 驅動表情；其餘欄位供前端 feed / 除錯。
 */
export interface BroadcastPlan {
  /** 要念出的事實句（formatAlert 產） */
  text: string
  /** 原始嚴重度（critical/error/warning/info/unknown） */
  severity: string
  /** 表情（severityToEmotion 產） */
  emotion: Emotion
  /** 告警名稱 */
  name: string
  /** 告警狀態 */
  status: 'firing' | 'resolved'
  /** 受影響對象（可選） */
  instance?: string
  /** 實際數值（可選） */
  value?: number
}
