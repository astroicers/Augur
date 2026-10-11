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
 * 用 `Map` 而非物件字面值:物件查表會連 `Object.prototype` 一起查到。
 * 查表前先 `toLowerCase()`,所以舊實作實際踩到的只有**全小寫**的那幾個原型成員:
 * `rankOf('constructor')` 會回到 `Object` 這個 function、`rankOf('__proto__')` 會回到
 * `Object.prototype`,`isKnownSeverity` 對這兩個都回 `true`。
 * (`'toString'`/`'hasOwnProperty'` 被小寫成 `tostring`/`hasownproperty` 而查不到,
 * 舊實作本來就回 0 —— 列在測試裡是為了把整類鍵一起釘住,不是因為它們壞過。)
 * `Map` 把整類問題一次拿掉,不必逐個列舉哪些鍵會中。
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
  if (key === null) {return 0}
  return RANK.get(key) ?? 0
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
 * 缺值或非字串的 `severity` 一律**等同 `unknown`**(排名 0),於是低於 UI 能選到的
 * 任何門檻(critical/error/warning/info)即不放行。這個等同不是本檔自創的:
 * `src/sources/panelAlerts.ts:128` 的 `labels['severity'] ?? 'unknown'` 早就把
 * 「沒有 severity 標籤」收斂成字串 `'unknown'`——缺值在本專案就是 `unknown`。
 *
 * 推論:門檻本身是 `unknown`(排名也是 0)時全部放行,缺值也放行。
 * `unknown` 是排名底線,拿底線當門檻等同不過濾;要讓缺值不放行就得讓
 * 缺值與字串 `'unknown'` 行為分岔,那與上面那條等同(與 AC-1 的「等同 unknown」)相衝。
 */
export function meetsMin(severity: unknown, min: unknown): boolean {
  if (typeof min !== 'string' || min.trim() === '') {return true}
  return rankOf(severity) >= rankOf(min)
}
