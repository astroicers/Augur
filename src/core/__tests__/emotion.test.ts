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

beforeEach(() => {
  normalizeSpy.mockClear();
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
