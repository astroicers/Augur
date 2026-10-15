/**
 * ParsedAlert → 給吉祥物講的訊息字串。
 *
 * 保持笨：只組「事實句」，不接 LLM、不修飾語氣 —— 輸出直接餵給 Web Speech API
 * 唸出（ADR-004 決策 4）。`formatNumber` 的特別處理、以及 `speakable*` 這族守門
 * （面板資料不可信，缺值／非字串一律不得唸成 `undefined` / `[object Object]`）
 * 正是為了「唸得出來」。
 */
import type { AlertLang, BroadcastPlan, ParsedAlert } from './types'
import { severityToEmotion } from './emotion'
import { normalize } from './severity'
import { resolveSeverity, type SeverityAliasMap } from './severityAliases'

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
 *
 * `aliases`（#51，選填）是嚴重度別名表。它**只影響 emotion**：導播層在這裡先把
 * `P1` 這類 label 正規化成標準嚴重度，再餵給 `severityToEmotion` —— 那個函式本身
 * 不收設定參數（延續 2026-09-18 不擴 `Emotion` 那次裁定所依據的純函式語意）。
 * `text` 與 `severity` 照舊帶**原始** label（經 `speakableSeverity` 正規化）：告警上
 * 寫的是 `P1`，念成 `critical` 會讓聽到的人對不上 Grafana 裡看到的那一則。
 * 省略或空表 → 與先前完全相同。
 */
export function buildBroadcastPlan(
  a: ParsedAlert,
  lang: AlertLang = 'zh',
  aliases?: SeverityAliasMap
): BroadcastPlan {
  return {
    text: formatAlert(a, lang),
    severity: speakableSeverity(a.severity),
    emotion: severityToEmotion(resolveSeverity(a.severity, aliases), a.status),
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

/**
 * 名稱缺值／非字串時改念的替代詞（#46 AC-1；zh / en 各一，**值就定在這裡**）。
 *
 * `ParsedAlert.name` 標註是 `string`，但與 `severity` 同樣來自 Grafana 的面板資料、
 * 同樣不可信——原樣塞進模板字串就會唸出「偵測到告警：undefined」。
 *
 * 選「照樣唸名稱子句、只是唸替代詞」而不是「整句省略名稱」，理由與 #39 的
 * `speakableSeverity` 同一條：名稱是句子的主語，省掉會讓句子塌成
 * 「偵測到告警：，嚴重度 critical。」——那是另一個句型，回放／比對時分不出
 * 「告警沒有名字」與「句子組壞了」。
 *
 * 用詞刻意**不**沿用 severity 的 `unknown`／「未知」：「未知告警」會被聽成
 * 「這則告警的內容不明」，但這裡不明的只有名稱，其餘欄位照常唸得出來。
 */
const UNNAMED_ZH = '未命名告警'
const UNNAMED_EN = 'unnamed alert'

/**
 * 可唸出的文字欄位（`name` / `instance` / `summary`）→ 原字串，否則 `undefined`（#46 AC-1/AC-2）。
 *
 * 非字串（物件／陣列／數字／布林／`null`）一律當**缺值**：模板字串會把它們變成
 * 要唸出口的 `[object Object]`、`1,2`、`null`。這層不信型別標註、只信 runtime 檢查，
 * 與 `severity.ts`／`emotion.ts` 同一個理由。
 *
 * 兩個刻意的細節：
 *  - 判空用 `trim()`，但**回傳未 trim 的原字串**。AC-3 要求正常字串的輸出與修補前
 *    逐字相同，所以 `' host-1 '` 照舊唸成「受影響對象  host-1 」；唯一變的是
 *    全空白字串從「唸出一個空子句（`受影響對象    `）」改成與空字串一樣省略。
 *  - 回 `undefined` 而不是像 severity 那樣回代表字：`instance`／`summary` 本來就是
 *    可選欄位，省略整個子句正是它們缺值時的既有行為；`name` 則由呼叫端 `?? 替代詞`
 *    補上，因為它是必填的主語。
 */
function speakableText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/**
 * 可唸出的數值（`value`）→ 已格式化的字串，否則 `undefined`（#46）。
 *
 * 票文 AC-2 只列了 `instance` 與 `summary`，但標題寫的是「其他欄位」，而 `value`
 * 是同一個缺陷的同一個實例：`value?: number` 的標註同樣來自面板資料、同樣不可信。
 * 舊實作把守門放在 `formatNumber` 的第一行（`!Number.isFinite(n) → String(n)`），
 * 那條路徑**正好**產出本票要擋的東西：`{}` → `[object Object]`、`[1, 2]` → `1,2`、
 * `null` → `null`、`NaN` → `NaN`。守門因此整個移到這裡，並從「回一個字串」
 * 改成「回 undefined 讓子句省略」——數值唸不出來時，不唸比亂唸正確。
 */
function speakableNumber(v: unknown): string | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? formatNumber(v) : undefined
}

function formatZh(a: ParsedAlert): string {
  const parts: string[] = []
  const name = speakableText(a.name) ?? UNNAMED_ZH
  const instance = speakableText(a.instance)
  const value = speakableNumber(a.value)
  const summary = speakableText(a.summary)

  if (a.status === 'resolved') {
    parts.push(`告警已恢復：${name}`)
  } else {
    parts.push(`偵測到告警：${name}`)
    parts.push(`嚴重度 ${speakableSeverity(a.severity)}`)
  }

  if (instance !== undefined) {parts.push(`受影響對象 ${instance}`)}
  if (value !== undefined) {parts.push(`目前數值 ${value}`)}
  if (summary !== undefined) {parts.push(summary)}

  return `${parts.join('，')}。`
}

function formatEn(a: ParsedAlert): string {
  const parts: string[] = []
  const name = speakableText(a.name) ?? UNNAMED_EN
  const instance = speakableText(a.instance)
  const value = speakableNumber(a.value)
  const summary = speakableText(a.summary)

  if (a.status === 'resolved') {
    parts.push(`Alert resolved: ${name}`)
  } else {
    parts.push(`Alert firing: ${name}`)
    parts.push(`severity ${speakableSeverity(a.severity)}`)
  }

  if (instance !== undefined) {parts.push(`on ${instance}`)}
  if (value !== undefined) {parts.push(`current value ${value}`)}
  if (summary !== undefined) {parts.push(summary)}

  return `${parts.join(', ')}.`
}

/**
 * 把**有限數值**轉成適合「念出來」的字串。
 * - 一般情況：整數原樣、其餘最多兩位小數（95.2 → "95.20"、42 → "42"）。
 * - 極大值（|n| ≥ 1e21）：JS 預設會吐科學記號（"1e+21"）TTS 念不出 → 改完整位數。
 * - 非零但 < 0.01 的小數：固定兩位會塌成 "0.00" 與來源事實矛盾（adapter 刻意挑非零值）
 *   → 依量級補足小數位（最多 8 位），讓首位有效數字顯示出來。
 *
 * 前置條件：`n` 已由唯一的呼叫端 `speakableNumber` 確認為 `number` 且 `Number.isFinite`。
 * 本函式原本自己擋非有限值（`return String(n)`），但那條路徑回的正是本票要擋的
 * `[object Object]` / `NaN` / `null`（#46）—— 守門上移後它既是死碼、又是誤導，故移除。
 */
function formatNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e21) {return BigInt(Math.round(n)).toString()}
  if (abs > 0 && abs < 0.01) {
    const decimals = Math.min(8, 1 - Math.floor(Math.log10(abs)))
    return n.toFixed(decimals)
  }
  return Number.isInteger(n) ? n.toString() : n.toFixed(2)
}
