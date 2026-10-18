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

/** 表情狀態 — 對映 `docs/sprite/sprite-sheet-spec.md`〈附錄 B〉§6（severity/status → 表情）。 */
export type Emotion = 'calm' | 'warning' | 'critical' | 'resolved'

/**
 * 一則**沒有**交給播報器的原因（`BroadcastItem.suppressed`，#63／#64）。
 *
 * - `'flapping'`：抖動抑制 —— 這個 fingerprint 在窗內翻太多次。
 * - `'quiet'`：值班靜音時段 —— 現在落在時段內，而它破不了靜音。
 *
 * **住在這裡而不是 `director/BroadcastDirector.ts`**（原本的家，#81 移來）：清單列要標出
 * 「這句為什麼沒念」，於是 `feed/` 也得認得這個型別，而 `feed/feedRows.ts` 與導播兩邊都有
 * 一支既有測試逐項比對自己的 import 清單（純函式的機械承接）。放進這條唯一的抽象邊界旁邊，
 * 兩邊都只讀 `core/types`，誰都不必 import 另一邊。導播照舊 re-export 它，呼叫端不受影響。
 *
 * ADR-007 的**每瀏覽器靜音**刻意不在這裡出現：那是呼叫端自己持有的開關（它按的、它存的），
 * 而這個型別報的是「導播自己決定、呼叫端看不到的原因」。
 */
export type SuppressReason = 'flapping' | 'quiet'

/**
 * 播報計畫 — 導播輸出給前端 avatar 的單則指令（取代舊的純 text sink）。
 * text 給 TTS 念；emotion 驅動表情；其餘欄位供前端 feed / 除錯。
 */
export interface BroadcastPlan {
  /** 要念出的事實句（formatAlert 產） */
  text: string
  /**
   * **正規化後**的嚴重度：去空白、轉小寫（`' CRITICAL '` → `'critical'`），
   * 缺值／空白／非字串一律收斂成 `'unknown'`（#39 起；`format.ts` 的 `speakableSeverity`）。
   * 與 `text` 裡唸出來的那個嚴重度保證同值，所以下游回顯／分組都拿得到合法字串，
   * 但**不是** `ParsedAlert.severity` 的原值——要原值請讀來源的 `ParsedAlert`。
   * 常見值：critical / error / warning / info / unknown（其餘字串照原字保留）。
   */
  severity: string
  /** 表情（severityToEmotion 產） */
  emotion: Emotion
  /**
   * 告警名稱——**原樣轉手** `ParsedAlert.name`，未經 `severity` 那套收斂。
   * 面板資料缺名稱時這裡就是 `undefined`／非字串，與 `text` 裡唸出的替代詞
   * （zh「未命名告警」／en "unnamed alert"，#46）不保證一致。
   */
  name: string
  /** 告警狀態 */
  status: 'firing' | 'resolved'
  /** 受影響對象（可選） */
  instance?: string
  /** 實際數值（可選） */
  value?: number
}
