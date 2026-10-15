/**
 * ParsedAlert → 給吉祥物講的訊息字串。
 *
 * 保持笨：只組「事實句」，不接 LLM、不修飾語氣 —— 輸出直接餵給 Web Speech API
 * 唸出（ADR-004 決策 4）。`formatNumber` 的特別處理正是為了「唸得出來」。
 */
import type { AlertLang, BroadcastPlan, ParsedAlert } from './types'
import { severityToEmotion } from './emotion'
import { normalize } from './severity'

export function formatAlert(a: ParsedAlert, lang: AlertLang = 'zh'): string {
  return lang === 'en' ? formatEn(a) : formatZh(a)
}

/**
 * ParsedAlert → BroadcastPlan（ADR-002 §1 的事件契約，由 ADR-004 決策 5 明文繼承）。
 * text 重用 formatAlert，emotion 由 severityToEmotion 映射。
 * instance/value 只在有值時帶上（配合 strict / noUncheckedIndexedAccess）。
 *
 * `severity` 欄位走 `speakableSeverity`（#39）：`BroadcastPlan.severity` 型別是 `string`，
 * 但 `ParsedAlert` 來自面板資料、那個標註不可信；原樣轉手等於把 `undefined` 當 `string`
 * 往下游傳。這裡與 `text` 用同一份正規化，所以「唸出來的嚴重度」與「欄位裡的嚴重度」
 * 永遠一致，下游要回顯/分組都拿得到合法字串。
 */
export function buildBroadcastPlan(a: ParsedAlert, lang: AlertLang = 'zh'): BroadcastPlan {
  return {
    text: formatAlert(a, lang),
    severity: speakableSeverity(a.severity),
    emotion: severityToEmotion(a.severity, a.status),
    name: a.name,
    status: a.status,
    ...(a.instance !== undefined ? { instance: a.instance } : {}),
    ...(a.value !== undefined ? { value: a.value } : {}),
  }
}

/**
 * 嚴重度 → 唸得出來的字串（#39）。
 *
 * `ParsedAlert.severity` 標註是 `string`，但告警來自 Grafana 的面板資料，實際可能缺值
 * （`undefined`）、是 `null`，或根本不是字串——模板字串會把它們變成要唸出口的
 * `undefined` / `null` / `[object Object]`。這層不信型別標註，只信 runtime 檢查。
 *
 * 缺值一律收斂成 `'unknown'`，不是本檔自創：`src/sources/panelAlerts.ts` 的
 * `labels['severity'] ?? 'unknown'` 早就把「沒有 severity 標籤」收斂成字串 `'unknown'`，
 * `severity.ts` 的 `RANK` 也把 `unknown` 列為排名 0 的已知值。缺值在本專案就是 `unknown`，
 * 於是這裡選「照樣念出嚴重度子句、只是念 unknown」而不是「整句省略嚴重度」——
 * 後者會讓同一支告警的播報句長度隨髒資料飄移（中文句以「，」串接，少一段就是另一個句型），
 * 回放/比對時分不出「沒有嚴重度」與「沒播報」。
 *
 * 正規化直接重用 `severity.ts` 的 `normalize`，不在本檔另寫一份（同 `emotion.ts` 的理由）：
 * 「怎麼算同一個嚴重度」只能有一份定義。順帶把 `' CRITICAL '` 這種值去空白
 * （否則 `嚴重度  CRITICAL ，` 會多出空白），空字串/全空白與缺值同樣收斂成 `unknown`
 * （`normalize('   ')` 回 `''`，不是 `null`）。
 */
function speakableSeverity(severity: unknown): string {
  const key = normalize(severity)
  return key === null || key === '' ? 'unknown' : key
}

function formatZh(a: ParsedAlert): string {
  const parts: string[] = []

  if (a.status === 'resolved') {
    parts.push(`告警已恢復：${a.name}`)
  } else {
    parts.push(`偵測到告警：${a.name}`)
    parts.push(`嚴重度 ${speakableSeverity(a.severity)}`)
  }

  if (a.instance) {parts.push(`受影響對象 ${a.instance}`)}
  if (a.value !== undefined) {parts.push(`目前數值 ${formatNumber(a.value)}`)}
  if (a.summary) {parts.push(a.summary)}

  return `${parts.join('，')}。`
}

function formatEn(a: ParsedAlert): string {
  const parts: string[] = []

  if (a.status === 'resolved') {
    parts.push(`Alert resolved: ${a.name}`)
  } else {
    parts.push(`Alert firing: ${a.name}`)
    parts.push(`severity ${speakableSeverity(a.severity)}`)
  }

  if (a.instance) {parts.push(`on ${a.instance}`)}
  if (a.value !== undefined) {parts.push(`current value ${formatNumber(a.value)}`)}
  if (a.summary) {parts.push(a.summary)}

  return `${parts.join(', ')}.`
}

/**
 * 把數值轉成適合「念出來」的字串。
 * - 一般情況：整數原樣、其餘最多兩位小數（95.2 → "95.20"、42 → "42"）。
 * - 極大值（|n| ≥ 1e21）：JS 預設會吐科學記號（"1e+21"）TTS 念不出 → 改完整位數。
 * - 非零但 < 0.01 的小數：固定兩位會塌成 "0.00" 與來源事實矛盾（adapter 刻意挑非零值）
 *   → 依量級補足小數位（最多 8 位），讓首位有效數字顯示出來。
 */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {return String(n)}
  const abs = Math.abs(n)
  if (abs >= 1e21) {return BigInt(Math.round(n)).toString()}
  if (abs > 0 && abs < 0.01) {
    const decimals = Math.min(8, 1 - Math.floor(Math.log10(abs)))
    return n.toFixed(decimals)
  }
  return Number.isInteger(n) ? n.toString() : n.toFixed(2)
}
