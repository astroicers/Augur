/**
 * ParsedAlert → 給吉祥物講的訊息字串。
 *
 * 保持笨：只組「事實句」，不接 LLM、不修飾語氣 —— 輸出直接餵給 Web Speech API
 * 唸出（ADR-004 決策 4）。`formatNumber` 的特別處理正是為了「唸得出來」。
 */
import type { AlertLang, BroadcastPlan, ParsedAlert } from './types'
import { severityToEmotion } from './emotion'

export function formatAlert(a: ParsedAlert, lang: AlertLang = 'zh'): string {
  return lang === 'en' ? formatEn(a) : formatZh(a)
}

/**
 * ParsedAlert → BroadcastPlan（ADR-002 §1 的事件契約，由 ADR-004 決策 5 明文繼承）。
 * text 重用 formatAlert，emotion 由 severityToEmotion 映射。
 * instance/value 只在有值時帶上（配合 strict / noUncheckedIndexedAccess）。
 */
export function buildBroadcastPlan(a: ParsedAlert, lang: AlertLang = 'zh'): BroadcastPlan {
  return {
    text: formatAlert(a, lang),
    severity: a.severity,
    emotion: severityToEmotion(a.severity, a.status),
    name: a.name,
    status: a.status,
    ...(a.instance !== undefined ? { instance: a.instance } : {}),
    ...(a.value !== undefined ? { value: a.value } : {}),
  }
}

function formatZh(a: ParsedAlert): string {
  const parts: string[] = []

  if (a.status === 'resolved') {
    parts.push(`告警已恢復：${a.name}`)
  } else {
    parts.push(`偵測到告警：${a.name}`)
    parts.push(`嚴重度 ${a.severity}`)
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
    parts.push(`severity ${a.severity}`)
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
