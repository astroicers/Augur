/**
 * 去重 / 防洪 + resolved 綁狀態。
 *
 * 兩個職責,共用一張 `Map<fingerprint, 上次「播過 firing」的時間戳>`:
 *  1. 防洪:同 fingerprint 的 firing 在 `windowSec` 內只播一次。
 *  2. resolved 綁狀態:只有「先前真的播過 firing」的 fingerprint,其 resolved 才播「已恢復」;
 *     播完即刪該 key。沒播過 firing 的孤兒 resolved 直接吞掉(避免重啟/補送時亂報恢復)。
 *
 * 為什麼 pull 模型下更需要它(ADR-004):push 模型防的是「Grafana 週期重送 firing」;
 * panel plugin 是 pull —— 每個 refresh interval(預設 30s)都會重新評估告警狀態,
 * 沒有防洪就會每 30 秒把同一則念一次。
 *
 * 記憶體:防洪窗(`windowSec`)只決定「多久內不重播」,不等於保留期。
 * resolved 追蹤需要在告警「持續 firing」期間一直記得 → 保留期取一個遠大於防洪窗的值,
 * 由週期清理回收真正過期(長時間沒再出現)的 key。
 */
import type { ParsedAlert } from './types'

export interface Dedup {
  /** 此告警是否該播報(已套用防洪 + resolved 綁狀態)。 */
  shouldSpeak(alert: ParsedAlert): boolean
  /** 停掉清理 timer(關閉流程呼叫)。 */
  close(): void
}

export interface DedupOptions {
  /** 注入時鐘(測試用),預設 Date.now。 */
  now?: () => number
  /** 是否啟動週期清理 timer(預設 true;測試可關)。 */
  startCleanup?: boolean
}

export function createDedup(windowSec: number, opts: DedupOptions = {}): Dedup {
  const now = opts.now ?? Date.now
  const windowMs = Math.max(0, windowSec) * 1000
  // 保留期:至少 6 小時,涵蓋一般事件存活時間與 Grafana 的重送間隔,確保 resolved 追得到。
  const retentionMs = Math.max(windowMs, 6 * 60 * 60 * 1000)

  /** fingerprint → 上次「播過 firing」的時間戳(ms)。 */
  const lastFiring = new Map<string, number>()

  function shouldSpeak(alert: ParsedAlert): boolean {
    const key = alert.fingerprint
    const t = now()

    if (alert.status === 'resolved') {
      // 只有先前播過 firing 的才播 resolved,播完清掉狀態。
      if (lastFiring.has(key)) {
        lastFiring.delete(key)
        return true
      }
      return false
    }

    // firing:防洪 — 窗內已播過就略過。
    const last = lastFiring.get(key)
    if (last !== undefined && t - last < windowMs) {
      return false
    }
    lastFiring.set(key, t)
    return true
  }

  function prune(): void {
    const t = now()
    for (const [key, ts] of lastFiring) {
      if (t - ts > retentionMs) {lastFiring.delete(key)}
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  if (opts.startCleanup !== false) {
    timer = setInterval(prune, Math.max(windowMs, 60_000))
  }

  return {
    shouldSpeak,
    close() {
      if (timer) {clearInterval(timer)}
    },
  }
}
