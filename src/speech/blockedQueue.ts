/**
 * 被瀏覽器擋下的告警句（補念佇列，ADR-007 決策 2／3）。
 *
 * 使用者還沒在頁面上互動過時，瀏覽器會以 `not-allowed` 擋下發聲 —— 而導播已經把那一則
 * 記成「念過了」，不留下來就永遠不會再念。這裡留著它們，等使用者按下「點一下啟用語音」
 * 時一次補完。
 *
 * #83 從 `MascotPanel.tsx` 的 `blockedRef` 搬出來：**不 import React**、不碰 DOM、
 * **不讀時鐘**（`now` 從參數注入），所以三條行為各自驗得到。
 *
 * 三條行為（與搬出來之前逐字相同）：
 *
 * 1. **只留窗內的**：被擋超過 `windowMs` 的不補。牆面螢幕可能好幾小時沒人點，第一次
 *    有人點下去不該補念幾十句過時的話（複審 F2）。
 *    ⚠️ **邊界是「含」**：被擋下的時間**剛好等於**窗長時仍算窗內、仍會補念。
 *    （`at >= now - windowMs`，搬出來之前就是這一形；兩處比較用的是同一支 `within`。）
 * 2. **同一個 `plan.name` 只留最後一則**：被擋期間已經恢復的，只念恢復句（複審 F2）。
 *    修剪在**寫入時**就做（第二輪複審 N2），沒人點的牆面螢幕配上重播間隔時清單才不會一直長。
 * 3. **取出後清空**：`take()` 回傳窗內的那幾則，並把佇列**整個**清空 ——
 *    連**已經過期、不會被回傳**的那幾則一起丟。它們之後只會更過期，留著只是佔記憶體。
 */
import type { BroadcastPlan } from '../core/types';

/**
 * 補念的時間上限：被擋超過這麼久的句子不補。
 * ADR-007 決策 2 的「10 分鐘」就是這個數字，改它等於改決策。
 */
export const BLOCKED_REPLAY_WINDOW_MS = 10 * 60 * 1000;

export interface BlockedQueueOptions {
  /** 現在幾點。預設 `Date.now`；測試注入自己的時鐘。 */
  now?: () => number;
  /** 補念時限。預設 `BLOCKED_REPLAY_WINDOW_MS`。 */
  windowMs?: number;
}

export interface BlockedQueue {
  /** 記下一則被擋下的告警句（寫入時就修剪：丟掉過期的、同名只留這一筆）。 */
  record(plan: BroadcastPlan): void;
  /** 取出要補念的那幾則（窗內、同名只留最後一則、依被擋下的時間順序），並清空佇列。 */
  take(): BroadcastPlan[];
  /** 清空（切到靜音時走這條：靜音就是「不要再念」，被擋的也不該留著等下一次解除）。 */
  clear(): void;
  /** 目前留著幾筆。給測試與診斷用 —— 「取出後清空」是看得見的，不是推論出來的。 */
  size(): number;
}

/** 建一個補念佇列。狀態全在閉包裡，一個 panel 一個。 */
export function createBlockedQueue({
  now = Date.now,
  windowMs = BLOCKED_REPLAY_WINDOW_MS,
}: BlockedQueueOptions = {}): BlockedQueue {
  let items: Array<{ plan: BroadcastPlan; at: number }> = [];

  /** 窗內嗎。**邊界含**：剛好等於窗長仍算窗內。寫入與取出共用這一支，兩邊不可能漂開。 */
  const within = (at: number, cutoff: number) => at >= cutoff;

  return {
    record(plan) {
      const at = now();
      const cutoff = at - windowMs;
      items = [...items.filter((b) => within(b.at, cutoff) && b.plan.name !== plan.name), { plan, at }];
    },
    take() {
      const cutoff = now() - windowMs;
      const recent = items.filter((b) => within(b.at, cutoff));
      // 整個清空（不是只清回傳的那幾則）—— 留下來的只會更過期。
      items = [];
      // 同名去重**不在這裡重做**：`record` 是唯一的寫入口，它已經保證佇列裡每個
      // `plan.name` 最多一筆。在這裡再濾一次只會多一份沒有任何測試殺得掉的死碼。
      return recent.map((b) => b.plan);
    },
    clear() {
      items = [];
    },
    size() {
      return items.length;
    },
  };
}
