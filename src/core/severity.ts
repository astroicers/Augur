/**
 * 嚴重度排名與門檻過濾。
 *
 * 嚴重度是任意字串,但實務上集中在幾個常見值。
 * 這裡給一張排名表,讓播報端能「只播 >= 門檻」的告警,把雜訊擋在發聲之前。
 *
 * 入參一律收 `unknown`:告警來自 Grafana 的面板資料,欄位可能缺值(`undefined`)、
 * 是 `null`,或根本不是字串。這層不信型別標註,只信 runtime 檢查——
 * 播報流程不該因為一筆髒資料整條中斷。
 */

/**
 * 已知嚴重度 → 排名(數字越大越嚴重)。未知值視為最低(0)。
 *
 * 用 `Map` 而非物件字面值:物件查表會連 `Object.prototype` 一起查到,
 * `rankOf('toString')` 會回到一個 function、`isKnownSeverity('constructor')` 會回 `true`。
 */
const RANK = new Map<string, number>([
  ['critical', 4],
  ['error', 3],
  ['warning', 2],
  ['info', 1],
  ['unknown', 0],
])

/** 正規化成查表鍵;非字串回 `null`(查不到 → 排名 0)。 */
function normalize(severity: unknown): string | null {
  return typeof severity === 'string' ? severity.trim().toLowerCase() : null
}

/** 取嚴重度排名;大小寫不敏感,未知值/非字串/缺值一律回 0。 */
export function rankOf(severity: unknown): number {
  const key = normalize(severity)
  return (key === null ? undefined : RANK.get(key)) ?? 0
}

/** `s` 是否為合法的已知嚴重度字串(config 驗證用);非字串回 `false`。 */
export function isKnownSeverity(s: unknown): boolean {
  const key = normalize(s)
  return key !== null && RANK.has(key)
}

/**
 * 此告警的嚴重度是否達到門檻。
 * `min` 為空字串/undefined/非字串 → 不過濾(全部放行,最不意外)。
 *
 * 缺值或非字串的 `severity` 視為最低排名(0),低於任何已知門檻即不放行;
 * 門檻本身是 `unknown`(排名也是 0)時照舊放行——`unknown` 是排名底線,
 * 拿底線當門檻等同不過濾。
 */
export function meetsMin(severity: unknown, min: unknown): boolean {
  if (typeof min !== 'string' || min.trim() === '') {return true}
  return rankOf(severity) >= rankOf(min)
}
