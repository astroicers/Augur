/**
 * 抖動抑制的純函式與狀態機（#64 AC-4）。
 *
 * 這一支只跑 `parseFlapping` / `describeFlapping` / `createFlappingTracker` ——
 * 不建導播、不 render 任何東西、不 import React。**時鐘是注入的**，所以「穩定滿 10 分鐘」
 * 是把時鐘撥過去，不是真的等 10 分鐘。
 *
 * 三者都住在 `director/BroadcastDirector.ts`，理由寫在該檔那一段的註解
 * （既有的 `AC-1：導播不 import react、不碰 DOM` 逐項比對該檔的 import 清單，
 * 而本票 AC-1 要求既有測試一行不改）—— 與 #63 的 `quietHours.test.ts` 同一個狀態。
 *
 * ⚠️ 命名：`src/avatar/flap.ts` 是**嘴型開合**，與本檔無關。
 */
import type { ParsedAlert } from '../../core/types';
import {
  createFlappingTracker,
  describeFlapping,
  parseFlapping,
  type FlappingConfig,
  type FlappingTracker,
} from '../BroadcastDirector';

const MINUTE = 60_000;
/** 分鐘 → ms 的偏移（測試裡一律用這個寫時刻，看得出「第幾分鐘」）。 */
const min = (minutes: number) => minutes * MINUTE;

/** 票文那句例子：10 分鐘內翻 4 次就先不念，穩定 10 分鐘後恢復。 */
const CONFIG: FlappingConfig = { threshold: 4, windowMs: min(10) };

const T0 = 1_000_000;

function alert(status: 'firing' | 'resolved', fingerprint: string): ParsedAlert {
  return {
    status,
    source: 'test',
    name: 'CPU',
    severity: 'critical',
    startsAt: '2026-10-15T00:00:00.000Z',
    fingerprint,
  };
}

interface Harness {
  tracker: FlappingTracker;
  /** 把時鐘撥到 `T0 + offsetMs`。 */
  at(offsetMs: number): void;
  /** 在當下時刻看一則 → 回「要不要抑制」。 */
  see(status: 'firing' | 'resolved', fingerprint?: string, config?: FlappingConfig): boolean;
  release(config?: FlappingConfig): readonly ParsedAlert[];
}

function harness(): Harness {
  let clock = T0;
  const tracker = createFlappingTracker({ now: () => clock });
  return {
    tracker,
    at: (offsetMs) => void (clock = T0 + offsetMs),
    see: (status, fingerprint = 'fp-a', config = CONFIG) => tracker.observe(alert(status, fingerprint), config),
    release: (config = CONFIG) => tracker.release(config),
  };
}

/** firing 開始、每分鐘翻一次，共 `rounds` 輪（= `rounds - 1` 次翻轉）。回傳每一輪的抑制與否。 */
function flipEveryMinute(h: Harness, rounds: number, config = CONFIG, fingerprint = 'fp-a'): boolean[] {
  const seen: boolean[] = [];
  for (let i = 0; i < rounds; i++) {
    h.at(min(i));
    seen.push(h.see(i % 2 === 0 ? 'firing' : 'resolved', fingerprint, config));
  }
  return seen;
}

/** 翻到被抑制：門檻 4、每分鐘翻一次共 6 輪 —— 最後一次翻轉在 T0+5min，當下狀態是 resolved。 */
function suppressedHarness(): Harness {
  const h = harness();
  const seen = flipEveryMinute(h, 6);
  // 前提成立才算（這個 helper 之後的每一條都靠它）：第 6 輪起被抑制。
  expect(seen).toEqual([false, false, false, false, false, true]);
  return h;
}

// ---------------------------------------------------------------------------
// 解析（AC-1 的「0 或留空 = 關閉」與窗長的補強規則）
// ---------------------------------------------------------------------------

test('AC-1：門檻 0、留空、缺鍵都是「關閉」—— config 為 null，而且不是錯誤', () => {
  for (const spec of [0, '', '   ', undefined, null]) {
    expect(parseFlapping(spec, 10)).toEqual({ config: null, problem: 'off' });
  }
  // 關閉不是錯誤 → 沒有話要回報。
  expect(describeFlapping('off')).toBe('');
  expect(describeFlapping(null)).toBe('');
});

test('門檻是負數、NaN、Infinity 或非數字 → bad-threshold，同樣關閉（不拋例外）', () => {
  for (const spec of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', {}, true, []]) {
    expect(parseFlapping(spec, 10)).toEqual({ config: null, problem: 'bad-threshold' });
  }
  expect(describeFlapping('bad-threshold')).toContain('0 以上');
});

test('窗長不是大於 0 的數字（0、負數、留空、非數字）→ bad-minutes，整個抑制關閉', () => {
  for (const spec of [0, -5, '', '   ', undefined, null, 'abc', Number.NaN]) {
    expect(parseFlapping(4, spec)).toEqual({ config: null, problem: 'bad-minutes' });
  }
  // 窗長 0 會讓「穩定滿窗」在定義上立刻成立，所以它不是「門檻關閉」以外的任何意思。
  expect(describeFlapping('bad-minutes')).toContain('大於 0');
});

test('解析成功：窗長換成 ms，門檻的小數往上取整，數字字串照收', () => {
  expect(parseFlapping(4, 10)).toEqual({ config: { threshold: 4, windowMs: min(10) }, problem: null });
  expect(parseFlapping(2.5, 0.5).config).toEqual({ threshold: 3, windowMs: 30_000 });
  expect(parseFlapping('4', '10').config).toEqual({ threshold: 4, windowMs: min(10) });
});

// ---------------------------------------------------------------------------
// 狀態機（AC-2 / AC-3 / AC-4 的七項）
// ---------------------------------------------------------------------------

test('AC-2：第一次看到不算翻轉，狀態沒變也不算翻轉（門檻 1 都不抑制）', () => {
  const h = harness();
  const tight: FlappingConfig = { threshold: 1, windowMs: min(10) };
  h.at(0);
  expect(h.see('firing', 'fp-a', tight)).toBe(false);
  h.at(min(1));
  expect(h.see('firing', 'fp-a', tight)).toBe(false); // 同一個狀態 —— 持續燒的重播由 dedup 管
  h.at(min(2));
  expect(h.see('resolved', 'fp-a', tight)).toBe(false); // 第 1 次翻轉 = 達到門檻 → 這一次照念
  h.at(min(3));
  expect(h.see('firing', 'fp-a', tight)).toBe(true);
});

test('AC-4：未達門檻 —— 門檻 4、只翻 3 次，每一次都照常交付', () => {
  const h = harness();
  expect(flipEveryMinute(h, 4)).toEqual([false, false, false, false]);
});

test('AC-4：剛好達到門檻的那一次照常交付，之後的翻轉才不交付', () => {
  // AC-2 的字面是「翻轉次數**達到**門檻，**之後的**翻轉不交給播報器」——
  // 所以門檻 4 的意思是「第 4 次翻轉是最後一次出聲」。
  const h = harness();
  expect(flipEveryMinute(h, 6)).toEqual([false, false, false, false, false, true]);
});

test('AC-4：抑制中的翻轉一律不交付（連翻三次都不出聲）', () => {
  const h = suppressedHarness();
  h.at(min(6));
  expect(h.see('firing')).toBe(true);
  h.at(min(7));
  expect(h.see('resolved')).toBe(true);
  h.at(min(8));
  expect(h.see('firing')).toBe(true);
});

test('AC-2：窗外的翻轉不計數 —— 翻 3 次、隔了一整個窗之後重新算', () => {
  const h = harness();
  flipEveryMinute(h, 4); // 翻 3 次（T0+1／+2／+3 分）
  h.at(min(20));
  expect(h.see('firing')).toBe(false); // 窗內只剩這一次翻轉
  h.at(min(21));
  expect(h.see('resolved')).toBe(false);
  h.at(min(22));
  expect(h.see('firing')).toBe(false);
  h.at(min(23));
  expect(h.see('resolved')).toBe(false); // 窗內第 4 次 = 達到門檻 → 這一次照念
  h.at(min(24));
  expect(h.see('firing')).toBe(true);
});

test('AC-4：穩定滿一個窗才解除 —— 差 1ms 時還在抑制中', () => {
  const h = suppressedHarness(); // 最後一次翻轉在 T0+5min
  h.at(min(15) - 1);
  expect(h.release()).toEqual([]);
  // 還在抑制中：這一次翻轉照樣不交付。
  expect(h.see('firing')).toBe(true);
});

test('AC-4 / AC-3：穩定滿窗就解除，而且回傳的是當下狀態那一則（最後其實已經恢復）', () => {
  const h = suppressedHarness(); // 抑制前最後播報的是 firing，當下狀態是 resolved
  h.at(min(15));
  const pending = h.release();
  expect(pending.map((a) => a.status)).toEqual(['resolved']);
  expect(pending[0]!.fingerprint).toBe('fp-a');
  // 解除之後的下一次狀態變化照常交付。
  h.at(min(16));
  expect(h.see('firing')).toBe(false);
});

test('AC-3：解除時當下狀態與抑制前最後播報的相同 → 不補念，而且抑制確實解除了', () => {
  const h = harness();
  // 門檻 5：第 5 次翻轉（T0+5min、resolved）是達標那一次，照念 → 之後穩定在 resolved。
  const loose: FlappingConfig = { threshold: 5, windowMs: min(10) };
  expect(flipEveryMinute(h, 6, loose)).toEqual([false, false, false, false, false, false]);
  h.at(min(15));
  expect(h.release(loose)).toEqual([]);
  // 解除了（不是「還在抑制」）：下一次翻轉照常交付。
  h.at(min(16));
  expect(h.see('firing', 'fp-a', loose)).toBe(false);
});

test('AC-4：不同 fingerprint 互不影響 —— 一則被抑制時另一則照常交付', () => {
  const h = suppressedHarness();
  h.at(min(6));
  expect(h.see('firing')).toBe(true);
  expect(h.see('firing', 'fp-b')).toBe(false);
  h.at(min(7));
  expect(h.see('resolved')).toBe(true); // fp-a 又翻一次，照樣不出聲
  expect(h.see('resolved', 'fp-b')).toBe(false);
  // 解除也是各自算：fp-a 滿窗後補念它自己當下的狀態（抑制期間最後翻成 resolved），
  // 而 fp-b 從沒被抑制，所以沒有待補念的話。
  h.at(min(17));
  expect(h.release().map((a) => a.fingerprint)).toEqual(['fp-a']);
});

test('AC-4：換門檻之後的下一次判斷就讀到新門檻（同一段翻轉歷史，門檻改小就開始抑制）', () => {
  const h = harness();
  const loose: FlappingConfig = { threshold: 10, windowMs: min(10) };
  expect(flipEveryMinute(h, 5, loose)).toEqual([false, false, false, false, false]); // 翻 4 次
  const tight: FlappingConfig = { threshold: 2, windowMs: min(10) };
  h.at(min(5));
  expect(h.see('resolved', 'fp-a', tight)).toBe(false); // 達標那一次照念
  h.at(min(6));
  expect(h.see('firing', 'fp-a', tight)).toBe(true);
});

test('AC-4：換窗長之後的下一次判斷就讀到新窗長（同一個時刻，窗調短就算穩定滿窗）', () => {
  const h = suppressedHarness(); // 最後一次翻轉在 T0+5min
  h.at(min(7));
  expect(h.release()).toEqual([]); // 窗 10 分鐘：還沒穩定滿窗
  expect(h.release({ threshold: 4, windowMs: min(1) })).toHaveLength(1); // 窗 1 分鐘：已滿窗
});

test('AC-1：reset() 之後翻轉次數從零開始（抑制關掉再開讀不到舊次數）', () => {
  const h = suppressedHarness();
  h.tracker.reset();
  h.at(min(6));
  expect(h.see('firing')).toBe(false);
  expect(h.release()).toEqual([]);
});

test('沒有任何 fingerprint 在抑制中時 release() 什麼都不回；過了回收期限之後行為也不變', () => {
  const h = harness();
  h.at(0);
  expect(h.see('firing')).toBe(false);
  h.at(min(30));
  expect(h.release()).toEqual([]);
  // 掃到 13 小時後 —— 行為不變：下一則照常交付。
  // （回收本身沒有被這裡驗到：回收與否，下面這一則都不構成抑制。回收是記憶體面的保證，見 `release()`。）
  h.at(min(60 * 13));
  expect(h.release()).toEqual([]);
  expect(h.see('resolved')).toBe(false);
});
