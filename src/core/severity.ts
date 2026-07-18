/**
 * 嚴重度排名與門檻過濾(SPEC §12 Phase 2:severity 過濾)。
 *
 * Grafana 的 `labels.severity` 是任意字串,但實務上集中在幾個常見值。
 * 這裡給一張排名表,讓 bridge 能「只播 >= 門檻」的告警,把雜訊擋在發聲之前。
 */

/** 已知嚴重度 → 排名(數字越大越嚴重)。未知字串視為最低(0)。 */
const RANK: Record<string, number> = {
  critical: 4,
  error: 3,
  warning: 2,
  info: 1,
  unknown: 0,
}

/** 取嚴重度排名;大小寫不敏感,未知值回 0。 */
export function rankOf(severity: string): number {
  return RANK[severity.trim().toLowerCase()] ?? 0
}

/** `min` 是否為合法的已知嚴重度字串(config 驗證用)。 */
export function isKnownSeverity(s: string): boolean {
  return s.trim().toLowerCase() in RANK
}

/**
 * 此告警的嚴重度是否達到門檻。
 * `min` 為空字串/undefined → 不過濾(全部放行,最不意外)。
 */
export function meetsMin(severity: string, min: string | undefined): boolean {
  if (!min) return true
  return rankOf(severity) >= rankOf(min)
}
