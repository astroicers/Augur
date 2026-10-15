/**
 * `severity.ts` 整支以「委派給真實實作的 jest.fn」包起來（#39 AC-1 的結構護欄）。
 *
 * 為什麼是 `jest.mock` 而不是 `jest.spyOn(severityMod, 'normalize')`：本專案的 jest
 * transform 是 `@swc/jest`（`.config/jest.config.js`），swc 的 CJS 輸出把每個 export
 * 寫成 **non-configurable getter**（`Object.defineProperty(exports, name, { get })`），
 * `jest.spyOn` 會直接拋 `TypeError: Cannot redefine property: normalize`。
 * `jest.mock` 換掉的是 module registry 的整筆記錄，不受 getter 限制。
 *
 * 包裝一律 `jest.fn(actual.xxx)`，行為與真實實作一字不差——所以本檔其餘每一條測試
 * 斷言的都還是真邏輯，只是順便可觀測。
 */
jest.mock('../severity', () => {
  const actual = jest.requireActual('../severity');
  return { ...actual, normalize: jest.fn(actual.normalize) };
});

import { severityToEmotion } from '../emotion';
import { normalize, rankOf } from '../severity';

const normalizeSpy = normalize as jest.MockedFunction<typeof normalize>;
/** 真實實作。`beforeEach` 重設時要拿它裝回去 —— `mockReset()` 會把實作一起清掉。 */
const actualNormalize: typeof normalize = jest.requireActual('../severity').normalize;

/**
 * ⚠️ 這裡是 `mockReset()` 而不是 `mockClear()`。
 *
 * `mockClear()` 只清呼叫紀錄，**`mockReturnValueOnce` 排進去的佇列會留著**。
 * 下面有兩條測試各排一筆 once 回傳值然後立刻消費掉 —— 只要其中任何一條在
 * 消費之前就失敗（斷言翻紅會中斷該測試），那筆冒牌回傳就會留在佇列裡，
 * 由**下一條測試的第一次 normalize 呼叫**吃掉。症狀是一條真正的失敗後面
 * 跟著一串莫名其妙的連鎖失敗，而且哪一條被污染取決於檔案裡的順序。
 *
 * `mockReset()` 連佇列與實作一起清掉，所以要把委派真實實作的那層裝回去 ——
 * 本檔的前提是「包裝與真實實作一字不差」（見檔頭），少了這行每條測試都會改成在量 undefined。
 */
beforeEach(() => {
  normalizeSpy.mockReset();
  normalizeSpy.mockImplementation(actualNormalize);
});

test('resolved 狀態一律映射 resolved（不看 severity）', () => {
  expect(severityToEmotion('critical', 'resolved')).toBe('resolved');
  expect(severityToEmotion('warning', 'resolved')).toBe('resolved');
  expect(severityToEmotion('unknown', 'resolved')).toBe('resolved');
});

test('firing 時依 §6 映射', () => {
  expect(severityToEmotion('critical', 'firing')).toBe('critical');
  expect(severityToEmotion('error', 'firing')).toBe('critical'); // §6 未列 error → 併 critical
  expect(severityToEmotion('warning', 'firing')).toBe('warning');
  expect(severityToEmotion('info', 'firing')).toBe('calm');
  expect(severityToEmotion('unknown', 'firing')).toBe('calm');
  expect(severityToEmotion('garbage', 'firing')).toBe('calm');
});

test('大小寫不敏感、去空白', () => {
  expect(severityToEmotion(' CRITICAL ', 'firing')).toBe('critical');
  expect(severityToEmotion('Warning', 'firing')).toBe('warning');
});

// ---- #30：severity 缺值或非字串（#19 在 severity.ts 修過的同類缺陷）----

test('firing 時缺值、非字串、空字串一律回 calm 且不拋', () => {
  const dirty: unknown[] = [
    undefined, null, 0, 42, NaN, '', '   ',
    {}, { severity: 'critical' }, [], ['critical'],
    true, Symbol('critical'), () => 'critical',
  ];
  for (const v of dirty) {
    expect(severityToEmotion(v, 'firing')).toBe('calm');
  }
});

test('firing 時缺值/非字串與字串 unknown 的表情完全一致', () => {
  const unknownEmotion = severityToEmotion('unknown', 'firing');
  for (const v of [undefined, null, 0, {}, [], true, '']) {
    expect(severityToEmotion(v, 'firing')).toBe(unknownEmotion);
  }
});

test('resolved 狀態對缺值/非字串照樣回 resolved 且不拋', () => {
  for (const v of [undefined, null, 0, 42, '', '   ', {}, [], true, () => 'critical']) {
    expect(severityToEmotion(v, 'resolved')).toBe('resolved');
  }
});

test('物件原型上的鍵不算已知嚴重度（與 severity.ts 共用 normalize 的推論）', () => {
  for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    expect(severityToEmotion(k, 'firing')).toBe('calm');
  }
});

// ---- #39 AC-1：把「同一份 normalize」從措辭變成斷言 ----

/**
 * 原本這條叫「正規化規則與 severity.ts 同一份（normalize 是唯一事實源）」，
 * 註解還寫「不只斷言結果相同，而是釘住同一套 normalize」——但斷言只有
 * `f(v) === f(normalize(v))` 與 `rankOf(v) === rankOf(normalize(v))`。
 * 因為 `normalize` 冪等（`normalize(normalize(v)) === normalize(v)`），
 * `emotion.ts` 內嵌一份自己的 `trim().toLowerCase()` 副本也會全綠——
 * 名稱宣稱的是結構，斷言量到的只是行為。
 *
 * 處置：**改名如實描述 + 另立結構護欄**（票文 AC-1 的「擇一」兩邊都做）。
 * 只改名會讓 #30 AC-4（重用同一套 normalize）完全沒有回歸護欄，
 * 等於把本票發現的問題改成「如實描述它還在」。
 */
test('行為一致：正規化前後的 emotion 與 rankOf 同進同出（冪等性，不保證同一份實作）', () => {
  expect(normalize(' CRITICAL ')).toBe('critical');
  expect(normalize(42)).toBeNull();
  for (const v of [' CRITICAL ', 'Error', '\twarning\n', 'INFO']) {
    expect(severityToEmotion(v, 'firing')).toBe(
      severityToEmotion(normalize(v), 'firing'),
    );
    expect(rankOf(v)).toBe(rankOf(normalize(v)));
  }
});

test('結構護欄：severityToEmotion 把原始值交給 severity.ts 的 normalize（不是內嵌副本）', () => {
  expect(severityToEmotion(' CRITICAL ', 'firing')).toBe('critical');
  // 收到的是**未加工的原始值**：正規化發生在 severity.ts 內，不是呼叫前先自己 trim 一次。
  expect(normalizeSpy).toHaveBeenCalledTimes(1);
  expect(normalizeSpy).toHaveBeenCalledWith(' CRITICAL ');
  expect(normalizeSpy).toHaveReturnedWith('critical');

  // 非字串也走同一條路（normalize 回 null → default → calm），不是另一條 typeof 分支。
  normalizeSpy.mockClear();
  expect(severityToEmotion(undefined, 'firing')).toBe('calm');
  expect(normalizeSpy).toHaveBeenCalledWith(undefined);
  expect(normalizeSpy).toHaveReturnedWith(null);
});

test('結構護欄：emotion 的判定由 normalize 的回傳值驅動（副本復活會翻紅）', () => {
  // 把 normalize 的回傳換掉：若 emotion.ts 真的只信這份 normalize，結果必須跟著變。
  // 內嵌一份 trim().toLowerCase() 副本的實作會忽略這個回傳、照樣回 'critical' → 翻紅。
  normalizeSpy.mockReturnValueOnce('warning');
  expect(severityToEmotion('critical', 'firing')).toBe('warning');

  normalizeSpy.mockReturnValueOnce('critical');
  expect(severityToEmotion('info', 'firing')).toBe('critical');

  // 冒牌回傳用完即棄，真實行為未被汙染。
  expect(severityToEmotion('critical', 'firing')).toBe('critical');
});

test('結構護欄：resolved 的早退在 normalize 之前（完全不看 severity）', () => {
  expect(severityToEmotion(' CRITICAL ', 'resolved')).toBe('resolved');
  expect(normalizeSpy).not.toHaveBeenCalled();
});

// ---- #47 AC-5：`mockReturnValueOnce` 佇列不得跨測試外洩 ----

/**
 * 這兩條是**一對**，而且順序有意義（jest 在同一檔內依宣告順序跑）。
 *
 * 上面那兩條結構護欄都是「排一筆 once 回傳值 → 立刻消費掉」。只要其中任一條在
 * 消費之前就斷言失敗，那筆冒牌回傳值會留在佇列裡 —— `mockClear()` 不清佇列 ——
 * 由下一條測試的第一次 `normalize` 呼叫吃掉，於是一條真失敗後面跟著一串假失敗。
 *
 * 這裡把那個情境做成常駐護欄：前一條刻意排一筆卻不消費，後一條驗真實行為。
 * 把 `beforeEach` 改回 `mockClear()` 的話，後一條會紅在
 * `severityToEmotion('info', 'firing')` 回 `'critical'`（實測）。
 */
test('佇列外洩護欄（上）：刻意排一筆 mockReturnValueOnce 卻不消費', () => {
  normalizeSpy.mockReturnValueOnce('critical');
  expect(normalizeSpy).not.toHaveBeenCalled();
});

test('佇列外洩護欄（下）：上一條留在佇列裡的冒牌回傳值不得流到這裡', () => {
  expect(severityToEmotion('info', 'firing')).toBe('calm');
  expect(normalizeSpy).toHaveBeenCalledTimes(1);
  expect(normalizeSpy).toHaveReturnedWith('info');
});
