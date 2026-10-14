import { severityToEmotion } from '../emotion';
import { normalize, rankOf } from '../severity';

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

test('正規化規則與 severity.ts 同一份（normalize 是唯一事實源）', () => {
  // 不只斷言結果相同，而是釘住「同一套 normalize」：
  // 能被 rankOf 認出的鍵，emotion 這側必須認出同一個鍵。
  expect(normalize(' CRITICAL ')).toBe('critical');
  expect(normalize(42)).toBeNull();
  for (const v of [' CRITICAL ', 'Error', '\twarning\n', 'INFO']) {
    expect(severityToEmotion(v, 'firing')).toBe(
      severityToEmotion(normalize(v), 'firing'),
    );
    expect(rankOf(v)).toBe(rankOf(normalize(v)));
  }
});
