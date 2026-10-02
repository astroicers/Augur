import { createDedup } from '../dedup';
import type { ParsedAlert } from '../types';

function mkAlert(p: Partial<ParsedAlert> = {}): ParsedAlert {
  return {
    status: 'firing',
    source: 'test',
    name: 'X',
    severity: 'warning',
    startsAt: '2026-01-01T00:00:00Z',
    fingerprint: 'fp1',
    ...p,
  };
}

test('firing 防洪：窗內只播一次，窗過後再播', () => {
  let clock = 1000;
  const d = createDedup(300, { now: () => clock, startCleanup: false });

  expect(d.shouldSpeak(mkAlert())).toBe(true); // 第一次
  expect(d.shouldSpeak(mkAlert())).toBe(false); // 窗內重送 → 略過
  clock += 300_000; // 前進 300s（= 窗邊界）
  expect(d.shouldSpeak(mkAlert())).toBe(true); // 窗過 → 再播
});

test('resolved 綁狀態：只有播過 firing 的才播恢復', () => {
  const clock = 1000;
  const d = createDedup(300, { now: () => clock, startCleanup: false });

  expect(d.shouldSpeak(mkAlert({ status: 'firing' }))).toBe(true);
  expect(d.shouldSpeak(mkAlert({ status: 'resolved' }))).toBe(true); // 有對應 firing
  expect(d.shouldSpeak(mkAlert({ status: 'resolved' }))).toBe(false); // key 已清，重送恢復 → 吞掉
});

test('孤兒 resolved（沒播過 firing）直接吞掉', () => {
  const clock = 1000;
  const d = createDedup(300, { now: () => clock, startCleanup: false });
  expect(d.shouldSpeak(mkAlert({ status: 'resolved' }))).toBe(false);
});

test('resolved 後同 fingerprint 再 firing = 新事件，立即可播', () => {
  const clock = 1000;
  const d = createDedup(300, { now: () => clock, startCleanup: false });
  d.shouldSpeak(mkAlert({ status: 'firing' }));
  d.shouldSpeak(mkAlert({ status: 'resolved' })); // 清掉狀態
  expect(d.shouldSpeak(mkAlert({ status: 'firing' }))).toBe(true); // 雖在窗內，但 key 已清 → 播
});

test('不同 fingerprint 各自獨立', () => {
  const clock = 1000;
  const d = createDedup(300, { now: () => clock, startCleanup: false });
  expect(d.shouldSpeak(mkAlert({ fingerprint: 'a' }))).toBe(true);
  expect(d.shouldSpeak(mkAlert({ fingerprint: 'b' }))).toBe(true);
  expect(d.shouldSpeak(mkAlert({ fingerprint: 'a' }))).toBe(false);
});

test('windowSec=0 等同關閉防洪（firing 每次都播）', () => {
  const clock = 1000;
  const d = createDedup(0, { now: () => clock, startCleanup: false });
  expect(d.shouldSpeak(mkAlert())).toBe(true);
  expect(d.shouldSpeak(mkAlert())).toBe(true);
});

test('close() 可重複呼叫不報錯', () => {
  const d = createDedup(300, { startCleanup: false });
  d.close();
  d.close();
});

/**
 * 以下四條補的是 2026-09-28 變異測試指出的洞：
 * **`startCleanup` 在 11 個呼叫端（生產 1 + 測試 10）全部是 `false`**，
 * 於是 `prune()` 與 `close()` 的 `clearInterval` 分支一次都沒被走過。
 * 後果有三：
 *  - 模組檔頭寫的「由週期清理回收真正過期的 key」對出貨的 panel 不成立
 *  - 上面那條 `close() 可重複呼叫不報錯` **無法為它的名字失敗** ——
 *    timer 永遠是 undefined，一個忘了 clearInterval 的 close() 照樣過
 *  - 預設路徑（清理開著）在 panel 實際算出的 windowSec 下是個 CPU 熱迴圈
 */

test('close() 真的停掉清理 timer（startCleanup 開著才驗得到）', () => {
  jest.useFakeTimers();
  try {
    const before = jest.getTimerCount();
    const d = createDedup(300, { startCleanup: true });
    expect(jest.getTimerCount()).toBe(before + 1);
    d.close();
    expect(jest.getTimerCount()).toBe(before);
    d.close(); // 可重複呼叫
    expect(jest.getTimerCount()).toBe(before);
  } finally {
    jest.useRealTimers();
  }
});

test('清理週期必須是有限值 —— windowSec = Infinity 時不得退化成 0ms 熱迴圈', () => {
  jest.useFakeTimers();
  const spy = jest.spyOn(global, 'setInterval');
  try {
    // panel 在預設選項（repeatFiringMin: 0）下算出來的就是 Infinity。
    const d = createDedup(Number.POSITIVE_INFINITY, { startCleanup: true });
    const delay = spy.mock.calls[spy.mock.calls.length - 1]![1] as number;
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(60_000);
    // Infinity 會被 ToInt32 夾成 0（Node 夾到 1ms），實測 120ms 內觸發 114 次。
    expect(delay).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    d.close();
  } finally {
    spy.mockRestore();
    jest.useRealTimers();
  }
});

test('prune 只回收過期的 key，不是清掉全部，而且保留期取的是上限不是下限', () => {
  jest.useFakeTimers();
  try {
    let clock = 1000;
    const d = createDedup(300, { now: () => clock, startCleanup: true });
    // 三個不同年紀的 key。中間那個是關鍵：
    // 保留期若寫成 min(windowMs, 6h) = 5 分鐘，它會被誤清；寫成 max = 6 小時才留得住。
    expect(d.shouldSpeak(mkAlert({ fingerprint: 'old' }))).toBe(true);
    clock += 7 * 60 * 60 * 1000;
    expect(d.shouldSpeak(mkAlert({ fingerprint: 'mid' }))).toBe(true);
    clock += 60 * 60 * 1000;
    expect(d.shouldSpeak(mkAlert({ fingerprint: 'fresh' }))).toBe(true);

    // 清理週期是 max(windowMs, 60s) = 300s，不是 60s。
    // （第一版只前進 60s，prune 根本沒跑，而測試「失敗」了 —— 是測試寫錯不是程式錯。）
    jest.advanceTimersByTime(300_000);

    // old 已 8 小時 > 保留期 → 回收。它的 resolved 成了孤兒，應被吞掉。
    expect(d.shouldSpeak(mkAlert({ fingerprint: 'old', status: 'resolved' }))).toBe(false);
    // mid 才 1 小時 < 6 小時保留期 → 必須還記得，恢復播得出來。
    expect(d.shouldSpeak(mkAlert({ fingerprint: 'mid', status: 'resolved' }))).toBe(true);
    // fresh 剛記下 → 一定還在。prune 若改成「每次全清」，這兩行都會變 false。
    expect(d.shouldSpeak(mkAlert({ fingerprint: 'fresh', status: 'resolved' }))).toBe(true);
    d.close();
  } finally {
    jest.useRealTimers();
  }
});

test('setWindow 換窗但不清掉已記住的狀態', () => {
  let clock = 1000;
  const d = createDedup(Number.POSITIVE_INFINITY, { now: () => clock, startCleanup: false });
  expect(d.shouldSpeak(mkAlert())).toBe(true);
  expect(d.shouldSpeak(mkAlert())).toBe(false); // 窗是 Infinity → 永不重播

  // 使用者把 repeatFiringMin 由 0 改成 5 分鐘。
  d.setWindow(300);
  // 狀態沒被清掉 —— 窗內仍然不重播。重建 dedup 的話這裡會變 true（誤重播）。
  expect(d.shouldSpeak(mkAlert())).toBe(false);
  clock += 300_000;
  expect(d.shouldSpeak(mkAlert())).toBe(true); // 新窗過了 → 重播
});

test('setWindow 也要更新保留期 —— 換大窗後既有 key 不得被舊保留期清掉', () => {
  // 2026-09-29 變異測試：拿掉 setWindow 裡的 retentionMs 更新，全套照綠。
  // 場景：小窗（保留期取下限 6h）換成 8h 大窗 → 保留期應跟著變 8h；
  // 一個 7 小時前播過的 firing，其 resolved 必須還播得出來。
  jest.useFakeTimers();
  try {
    let clock = 1000;
    const d = createDedup(300, { now: () => clock, startCleanup: true });
    expect(d.shouldSpeak(mkAlert({ fingerprint: 'k' }))).toBe(true);
    d.setWindow(8 * 60 * 60); // 窗 8h > 6h 下限 → retention 應變 8h
    clock += 7 * 60 * 60 * 1000;
    jest.advanceTimersByTime(8 * 60 * 60 * 1000); // 讓 prune 至少跑一次
    // retention 若停留在 6h，k 已被清 → resolved 變孤兒被吞 → false。
    expect(d.shouldSpeak(mkAlert({ fingerprint: 'k', status: 'resolved' }))).toBe(true);
    d.close();
  } finally {
    jest.useRealTimers();
  }
});

test('setWindow 要重排清理 timer —— 新窗的週期要真的生效', () => {
  // 同一輪變異測試：拿掉「stopTimer + startTimer」的重排，全套照綠 ——
  // 而 setWindow 的註解自己寫著「換窗就要重排,否則新的窗對清理不生效」。
  jest.useFakeTimers();
  const spy = jest.spyOn(global, 'setInterval');
  try {
    const d = createDedup(30, { startCleanup: true }); // 週期 = max(30s, 60s) = 60s
    expect(spy.mock.calls[spy.mock.calls.length - 1]![1]).toBe(60_000);
    d.setWindow(7200); // 週期應變 min(max(7200s, 60s), 6h) = 2h
    expect(spy.mock.calls[spy.mock.calls.length - 1]![1]).toBe(7_200_000);
    d.close();
  } finally {
    spy.mockRestore();
    jest.useRealTimers();
  }
});
