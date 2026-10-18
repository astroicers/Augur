/**
 * #83 AC-1：補念佇列的三條行為（ADR-007 決策 2／3）。
 *
 * 全部以**注入的時鐘**驅動 —— 這一支不讀 `Date.now`，所以「超過 10 分鐘」這條不必靠
 * 等待或 fake timers，連**邊界**（剛好等於窗長）都驗得到。
 */
import { BLOCKED_REPLAY_WINDOW_MS, createBlockedQueue } from '../blockedQueue';
import type { BroadcastPlan } from '../../core/types';

/** 一則被擋下的告警句。`name` 是去重單位，`text` 用來分辨是哪一次的狀態。 */
function plan(name: string, text: string, status: 'firing' | 'resolved' = 'firing'): BroadcastPlan {
  return { text, severity: 'critical', emotion: status === 'firing' ? 'critical' : 'resolved', name, status };
}

/** 可注入的時鐘：`clock.now` 直接改。 */
function clock(start = 1_000_000_000_000) {
  const c = { now: start };
  return { c, nowFn: () => c.now };
}

describe('#83：補念佇列的時限（ADR-007 決策 2 的「10 分鐘」）', () => {
  test('預設窗長就是 10 分鐘 —— 這個數字是決策本身，不是實作細節', () => {
    expect(BLOCKED_REPLAY_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  test('窗內的補念、超出窗長的不補（牆面螢幕沒人點、累積好幾小時的情形）', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('Old', '偵測到告警：Old。'));
    c.now += 11 * 60 * 1000;
    q.record(plan('New', '偵測到告警：New。'));
    expect(q.take().map((p) => p.text)).toEqual(['偵測到告警：New。']);
  });

  test('邊界是「含」：被擋下的時間剛好等於窗長時仍補念', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('Edge', '偵測到告警：Edge。'));
    c.now += BLOCKED_REPLAY_WINDOW_MS;
    expect(q.take().map((p) => p.text)).toEqual(['偵測到告警：Edge。']);
  });

  test('邊界的對照組：再多一毫秒就不補念了', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('Edge', '偵測到告警：Edge。'));
    c.now += BLOCKED_REPLAY_WINDOW_MS + 1;
    expect(q.take()).toEqual([]);
  });

  test('窗長可注入 —— 時限不是寫死在 take() 裡的', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn, windowMs: 1000 });
    q.record(plan('A', 'A'));
    c.now += 1001;
    expect(q.take()).toEqual([]);
  });

  test('寫入時就修剪：過期的那一筆在 record 當下就不在佇列裡了', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('Old', 'Old'));
    expect(q.size()).toBe(1);
    c.now += 11 * 60 * 1000;
    q.record(plan('New', 'New'));
    expect(q.size()).toBe(1);
  });
});

describe('#83：同一個 plan.name 只留最後一則（ADR-007 決策 3）', () => {
  test('被擋期間已恢復的，只補念恢復句', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('A', '偵測到告警：A。'));
    c.now += 1000;
    q.record(plan('A', '告警已恢復：A。', 'resolved'));
    expect(q.take().map((p) => p.text)).toEqual(['告警已恢復：A。']);
  });

  test('同名重複三次只留最後一則，佇列長度始終是 1', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('A', '第一次'));
    c.now += 1;
    q.record(plan('A', '第二次'));
    c.now += 1;
    q.record(plan('A', '第三次'));
    expect(q.size()).toBe(1);
    expect(q.take().map((p) => p.text)).toEqual(['第三次']);
  });

  test('不同名各留一則，依被擋下的時間順序取出', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('A', '偵測到告警：A。'));
    c.now += 1000;
    q.record(plan('B', '偵測到告警：B。'));
    c.now += 1000;
    q.record(plan('C', '偵測到告警：C。'));
    expect(q.take().map((p) => p.text)).toEqual(['偵測到告警：A。', '偵測到告警：B。', '偵測到告警：C。']);
  });

  test('同名的那一則補到最後面 —— 重新記一次等於重排到最新的位置', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('A', '偵測到告警：A。'));
    c.now += 1000;
    q.record(plan('B', '偵測到告警：B。'));
    c.now += 1000;
    q.record(plan('A', '告警已恢復：A。', 'resolved'));
    expect(q.take().map((p) => p.text)).toEqual(['偵測到告警：B。', '告警已恢復：A。']);
  });

  test('同名的那一則時效跟著重設：舊的那筆過期了，新的仍在窗內就照補', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('A', '偵測到告警：A。'));
    c.now += 9 * 60 * 1000;
    q.record(plan('A', '告警已恢復：A。', 'resolved'));
    c.now += 9 * 60 * 1000;
    expect(q.take().map((p) => p.text)).toEqual(['告警已恢復：A。']);
  });

  test('原樣轉交 plan **物件身分** —— 補念的就是被擋下的那一個物件', () => {
    const { nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    const p = plan('A', '偵測到告警：A。');
    q.record(p);
    expect(q.take()[0]).toBe(p);
  });
});

describe('#83：取出後清空', () => {
  test('take() 之後再 take() 一次是空的', () => {
    const { nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('A', 'A'));
    expect(q.take()).toHaveLength(1);
    expect(q.take()).toEqual([]);
    expect(q.size()).toBe(0);
  });

  test('連「已經過期、不會被回傳」的那幾則也一起清掉', () => {
    const { c, nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('Old', 'Old'));
    c.now += 11 * 60 * 1000;
    expect(q.take()).toEqual([]);
    expect(q.size()).toBe(0);
  });

  test('clear() 清空（切到靜音走這條）', () => {
    const { nowFn } = clock();
    const q = createBlockedQueue({ now: nowFn });
    q.record(plan('A', 'A'));
    q.record(plan('B', 'B'));
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.take()).toEqual([]);
  });

  test('空佇列 take() 回空陣列（沒有被擋過也按得下去）', () => {
    expect(createBlockedQueue().take()).toEqual([]);
  });
});

test('#83：不 import React —— 這一支不進 render 也測得到', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../blockedQueue.ts'), 'utf8');
  expect(src).not.toMatch(/from 'react'/);
});
