/**
 * 值班靜音時段的純函式（#63 AC-4）。
 *
 * 這一支只跑 `parseQuietHours` / `isQuietAt` / `minuteOfDayAt` / `describeQuietHours` ——
 * 不建導播、不 render 任何東西、不 import React。四個函式都住在
 * `director/BroadcastDirector.ts`（住在那裡的理由寫在該檔那一段的註解：
 * 既有的 `AC-1：導播不 import react、不碰 DOM` 逐項比對該檔的 import 清單，
 * 而本票 AC-1 要求既有測試一行不改）。
 *
 * **時刻一律自己算**：`new Date(2026, 9, 15, 22, 30)` 是**本地時間**的建構式，
 * 所以不論 jest 把 `TZ` 設成什麼，這些斷言都成立（根 `jest.config.js` 目前固定 UTC）。
 */
import { describeQuietHours, isQuietAt, minuteOfDayAt, parseQuietHours } from '../BroadcastDirector';

/** `HH:MM` → 當天的第幾分鐘（測試自己算一份，不借用受測碼的內部函式）。 */
const min = (hours: number, minutes: number) => hours * 60 + minutes;

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

test('解析：跨午夜與不跨午夜都解析成「當天的第幾分鐘」', () => {
  expect(parseQuietHours('22:00-07:00')).toEqual({ range: { startMin: min(22, 0), endMin: min(7, 0) }, problem: null });
  expect(parseQuietHours('12:00-13:00')).toEqual({
    range: { startMin: min(12, 0), endMin: min(13, 0) },
    problem: null,
  });
});

test('解析：前後空白、`-` 兩側的空白、只寫一位的時都接受', () => {
  expect(parseQuietHours('  22:30 - 07:05  ').range).toEqual({ startMin: min(22, 30), endMin: min(7, 5) });
  expect(parseQuietHours('7:00-19:30').range).toEqual({ startMin: min(7, 0), endMin: min(19, 30) });
  expect(parseQuietHours('00:00-00:01').range).toEqual({ startMin: 0, endMin: 1 });
  expect(parseQuietHours('23:59-00:00').range).toEqual({ startMin: min(23, 59), endMin: 0 });
});

test('AC-4：全形的冒號、減號、數字與全形空白**都接受**（中文輸入法打出來的就是這些）', () => {
  // 編輯器的說明是中文 —— 只認半形的話整個選項會靜默失效，而使用者看不出哪裡錯。
  // 理由與 `core/severityAliases.ts` 收全形分隔符同一條。
  expect(parseQuietHours('２２：００－０７：００').range).toEqual({ startMin: min(22, 0), endMin: min(7, 0) });
  expect(parseQuietHours('22：00－07：00').range).toEqual({ startMin: min(22, 0), endMin: min(7, 0) });
  expect(parseQuietHours('　22:00 － 07:00　').range).toEqual({ startMin: min(22, 0), endMin: min(7, 0) });
});

test('AC-4：留空（含只有空白、缺鍵）視同沒設定，原因是 empty', () => {
  for (const spec of ['', '   ', '　', undefined, null, 42, {}]) {
    expect(parseQuietHours(spec)).toEqual({ range: null, problem: 'empty' });
  }
});

test('AC-4：缺 `-`、或 `-` 多於一個 → not-a-range，視同沒設定', () => {
  // 一個 `-` 分成兩段才算一個區段。`~`、空白、頓號都不是分隔符（只收 `-` 與全形 `－`）。
  for (const spec of ['22:00', '22:00 07:00', '22:00~07:00', '22:00、07:00', '22:00-07:00-08:00']) {
    const parsed = parseQuietHours(spec);
    expect(parsed.range).toBeNull();
    expect(parsed.problem).toBe('not-a-range');
  }
});

test('AC-4：時間不合法 → bad-time，視同沒設定', () => {
  // 只有一端寫得出來也不行（`22:00-`、`-07:00`）—— 那是打到一半，不是一個區段。
  for (const spec of [
    '25:00-07:00',
    '22:00-24:00',
    '12:60-13:00',
    '7:5-8:00',
    '2200-0700',
    'abc-def',
    '22:00-',
    '-07:00',
  ]) {
    const parsed = parseQuietHours(spec);
    expect(parsed.range).toBeNull();
    expect(parsed.problem).toBe('bad-time');
  }
});

test('AC-4：起訖相同 → same-endpoints，視同沒設定（不猜「整天靜音」）', () => {
  // 照端點規則（起點含、終點不含）它是「整天都不靜音」，但寫下它的人想的幾乎一定是
  // 「整天都靜音」。兩種讀法都說得通的設定不猜，視同沒設定並回報原因。
  expect(parseQuietHours('22:00-22:00')).toEqual({ range: null, problem: 'same-endpoints' });
  expect(parseQuietHours('00:00-00:00').problem).toBe('same-endpoints');
  expect(parseQuietHours(' 7:00 - 07:00 ').problem).toBe('same-endpoints');
});

test('AC-4：任何輸入都不拋例外（設定來自 dashboard JSON）', () => {
  for (const spec of ['', '-', '::', '--', '1-2-3', '〇〇:〇〇-〇〇:〇〇', '🙂-🙃', ':-:', '-07:00', 'NaN:NaN-1:1']) {
    expect(() => parseQuietHours(spec)).not.toThrow();
    expect(parseQuietHours(spec).range).toBeNull();
  }
});

test('AC-4：describeQuietHours 回報原因；沒設定或解析成功回空字串', () => {
  expect(describeQuietHours(null)).toBe('');
  expect(describeQuietHours('empty')).toBe('');
  expect(describeQuietHours(parseQuietHours('22:00-07:00').problem)).toBe('');
  expect(describeQuietHours(parseQuietHours('').problem)).toBe('');
  for (const spec of ['22:00', '25:00-07:00', '22:00-22:00']) {
    const msg = describeQuietHours(parseQuietHours(spec).problem);
    expect(msg).not.toBe('');
    expect(msg).toContain('視同沒設定');
  }
  // 三種原因各自講不同的話（都寫成同一句的話，使用者看不出要改什麼）。
  const texts = ['22:00', '25:00-07:00', '22:00-22:00'].map((s) => describeQuietHours(parseQuietHours(s).problem));
  expect(new Set(texts).size).toBe(3);
});

// ---------------------------------------------------------------------------
// 端點規則：**起點含、終點不含**
// ---------------------------------------------------------------------------

test('AC-2：不跨午夜的區段 —— 起點含、終點不含', () => {
  const range = parseQuietHours('12:00-13:00').range;
  expect(isQuietAt(range, min(11, 59))).toBe(false);
  expect(isQuietAt(range, min(12, 0))).toBe(true); // 起點**含**
  expect(isQuietAt(range, min(12, 59))).toBe(true);
  expect(isQuietAt(range, min(13, 0))).toBe(false); // 終點**不含**
  expect(isQuietAt(range, min(23, 59))).toBe(false);
});

test('AC-2：跨午夜的區段 —— 同樣是起點含、終點不含，且跨過 00:00', () => {
  const range = parseQuietHours('22:00-07:00').range;
  expect(isQuietAt(range, min(21, 59))).toBe(false);
  expect(isQuietAt(range, min(22, 0))).toBe(true); // 起點**含**
  expect(isQuietAt(range, min(23, 59))).toBe(true);
  expect(isQuietAt(range, 0)).toBe(true); // 00:00 —— 跨午夜的條件是「或」不是「且」
  expect(isQuietAt(range, min(3, 0))).toBe(true);
  expect(isQuietAt(range, min(6, 59))).toBe(true);
  expect(isQuietAt(range, min(7, 0))).toBe(false); // 終點**不含**
  expect(isQuietAt(range, min(12, 0))).toBe(false);
});

test('AC-2：相鄰的三段把一天剛好鋪滿一次 —— 端點規則的機械後果（不重疊、不留縫）', () => {
  // 這一條是上面兩條的通則：接得起來且不重疊，正是「起點含、終點不含」的定義。
  const ranges = ['07:00-12:00', '12:00-22:00', '22:00-07:00'].map((s) => parseQuietHours(s).range);
  for (let at = 0; at < 24 * 60; at++) {
    expect(ranges.filter((r) => isQuietAt(r, at))).toHaveLength(1);
  }
});

test('沒設定或格式錯誤（range 為 null）時一律不靜音 —— 「行為與沒有這個選項時相同」的機械保證', () => {
  for (const spec of ['', '亂寫', '25:00-07:00', '22:00-22:00']) {
    const range = parseQuietHours(spec).range;
    for (const at of [0, min(3, 0), min(12, 0), min(22, 30), min(23, 59)]) {
      expect(isQuietAt(range, at)).toBe(false);
    }
  }
});

test('isQuietAt：超出 0–1439 的分鐘數先收斂回當天（不會因為算錯而漏判整段）', () => {
  const range = parseQuietHours('22:00-07:00').range;
  expect(isQuietAt(range, 24 * 60 + min(3, 0))).toBe(true);
  expect(isQuietAt(range, -60)).toBe(true); // 前一天的 23:00
  expect(isQuietAt(range, 24 * 60 + min(12, 0))).toBe(false);
});

// ---------------------------------------------------------------------------
// 時刻 → 當天的第幾分鐘（**瀏覽器本地時間**）
// ---------------------------------------------------------------------------

test('AC-2：minuteOfDayAt 用的是瀏覽器本地時間', () => {
  // 本地時間的建構式 → 不論 TZ 設成什麼都成立。
  expect(minuteOfDayAt(new Date(2026, 9, 15, 22, 30, 15).getTime())).toBe(min(22, 30));
  expect(minuteOfDayAt(new Date(2026, 9, 15, 0, 0, 0).getTime())).toBe(0);
  expect(minuteOfDayAt(new Date(2026, 9, 15, 23, 59, 59).getTime())).toBe(min(23, 59));
  // 日界線的兩側：同一個絕對時刻在跨午夜的區段裡一邊算在內、一邊不算。
  const range = parseQuietHours('22:00-07:00').range;
  expect(isQuietAt(range, minuteOfDayAt(new Date(2026, 9, 15, 21, 59).getTime()))).toBe(false);
  expect(isQuietAt(range, minuteOfDayAt(new Date(2026, 9, 16, 0, 1).getTime()))).toBe(true);
});
