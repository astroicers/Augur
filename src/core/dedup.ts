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
  /**
   * 忘掉某個 fingerprint 的狀態,**不播任何東西**。
   *
   * 給「episode 被取代而不是恢復」用 —— 例如降級路徑先以 `alert:panel:N` 播了一句
   * 泛用「告警」,稍後 rules 端點恢復、拿到具名規則之後,那個泛用 episode 就該無聲消失。
   *
   * ⚠️ **沒有這個方法的話那條路徑會永久靜音。** `lastFiring` 只在「播出 resolved」時
   * 才刪 key,而預設 `repeatFiringMin: 0` → 窗是 `Infinity` → `t - last < Infinity` 恆真,
   * 於是同一個 fingerprint 再也不會被播報。症狀是**告警真的在燒而面板一聲不吭**,
   * 且不留任何錯誤訊息。
   */
  forget(fingerprint: string): void
  /**
   * 換防洪窗,**不動已記住的狀態**。
   *
   * 給「使用者在編輯面板時改了 repeatFiringMin」用。先前的作法是重建整個 dedup,
   * 而那會把 `lastFiring` 一起清掉 —— 對面正在燒的告警於是被重播一次;
   * 更糟的是它與 source 的重建時機不一致(兩個 effect 的 deps 不同),
   * 會出現「episodes 清了而 lastFiring 沒清」的組合,那個組合是**永久靜音**。
   */
  setWindow(windowSec: number): void
  /** 停掉清理 timer(關閉流程呼叫)。 */
  close(): void
}

export interface DedupOptions {
  /** 注入時鐘(測試用),預設 Date.now。 */
  now?: () => number
  /** 是否啟動週期清理 timer(預設 true;測試可關)。 */
  startCleanup?: boolean
}

/** 清理 timer 的週期上限。也是 `windowMs` 為 Infinity 時實際採用的週期。 */
const MAX_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

export function createDedup(windowSec: number, opts: DedupOptions = {}): Dedup {
  const now = opts.now ?? Date.now
  let windowMs = Math.max(0, windowSec) * 1000
  // 保留期:至少 6 小時,涵蓋一般事件存活時間與 Grafana 的重送間隔,確保 resolved 追得到。
  let retentionMs = Math.max(windowMs, MAX_PRUNE_INTERVAL_MS)

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

  /**
   * 清理週期。**必須是有限值。**
   *
   * 原本是 `Math.max(windowMs, 60_000)`,而 panel 在預設選項下算出來的 windowSec
   * 正是 `Number.POSITIVE_INFINITY`(repeatFiringMin: 0 → 永不重播),
   * 於是這裡變成 `setInterval(prune, Infinity)`。Infinity 不是「永遠不跑」——
   * 它被 ToInt32 夾成 0,瀏覽器再夾到 4ms、Node 夾到 1ms,結果是一個 CPU 熱迴圈。
   * 實測 `setInterval(fn, Infinity)`:**120ms 內觸發 114 次**,
   * 而 Node 自己會印 `TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed integer`。
   * 目前所有呼叫端都傳 `startCleanup: false`,所以這條路沒有在生產裡踩到過 ——
   * 但那也表示它從來沒有被任何測試走過,而預設值是「開」。
   */
  function pruneIntervalMs(): number {
    return Math.min(Math.max(windowMs, 60_000), MAX_PRUNE_INTERVAL_MS)
  }

  let timer: ReturnType<typeof setInterval> | undefined
  function startTimer() {
    if (opts.startCleanup === false) {
      return
    }
    timer = setInterval(prune, pruneIntervalMs())
  }
  function stopTimer() {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
  startTimer()

  return {
    shouldSpeak,
    forget(fingerprint: string) {
      lastFiring.delete(fingerprint)
    },
    setWindow(sec: number) {
      windowMs = Math.max(0, sec) * 1000
      retentionMs = Math.max(windowMs, MAX_PRUNE_INTERVAL_MS)
      // 週期是由 windowMs 算出來的,換窗就要重排,否則新的窗對清理不生效。
      if (timer !== undefined) {
        stopTimer()
        startTimer()
      }
    },
    close() {
      stopTimer()
    },
  }
}
