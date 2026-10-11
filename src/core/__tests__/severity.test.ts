import { meetsMin, rankOf, isKnownSeverity } from '../severity';

test('meetsMin: 空門檻不過濾（全部放行）', () => {
  expect(meetsMin('info', '')).toBe(true);
  expect(meetsMin('unknown', '')).toBe(true);
  expect(meetsMin('whatever', undefined)).toBe(true);
});

test('meetsMin: 依排名比較', () => {
  expect(meetsMin('critical', 'warning')).toBe(true);
  expect(meetsMin('warning', 'warning')).toBe(true);
  expect(meetsMin('info', 'warning')).toBe(false);
  expect(meetsMin('error', 'warning')).toBe(true);
});

test('meetsMin: 大小寫不敏感、未知值視為最低', () => {
  expect(meetsMin('CRITICAL', 'warning')).toBe(true);
  expect(meetsMin('Warning', 'warning')).toBe(true);
  expect(meetsMin('unknown', 'info')).toBe(false);
  expect(meetsMin('garbage', 'info')).toBe(false);
});

test('rankOf / isKnownSeverity', () => {
  expect(rankOf('critical')).toBe(4);
  expect(rankOf('nope')).toBe(0);
  expect(isKnownSeverity('warning')).toBe(true);
  expect(isKnownSeverity('WARNING')).toBe(true);
  expect(isKnownSeverity('nope')).toBe(false);
});

// ---- #19:severity 缺值或非字串 ----

test('rankOf: 缺值、非字串、空字串一律回 0 且不拋', () => {
  const dirty: unknown[] = [
    undefined, null, 0, 42, NaN, '', '   ',
    {}, { severity: 'critical' }, [], ['critical'],
    true, Symbol('critical'), () => 'critical',
  ];
  for (const v of dirty) {
    expect(rankOf(v)).toBe(0);
  }
});

test('rankOf: 物件原型上的鍵不算已知嚴重度', () => {
  expect(rankOf('toString')).toBe(0);
  expect(rankOf('constructor')).toBe(0);
  expect(rankOf('__proto__')).toBe(0);
  expect(rankOf('hasOwnProperty')).toBe(0);
});

test('meetsMin: 缺值/非字串的嚴重度不拋,且低於任何已知門檻即不放行', () => {
  for (const v of [undefined, null, 0, 42, {}, [], true]) {
    expect(meetsMin(v, 'info')).toBe(false);
    expect(meetsMin(v, 'critical')).toBe(false);
    // 空門檻照舊全部放行,缺值也一樣。
    expect(meetsMin(v, '')).toBe(true);
    expect(meetsMin(v, undefined)).toBe(true);
  }
});

test('meetsMin: 門檻為 unknown 是排名底線,等同不過濾', () => {
  // AC-2 的「低於任何已知門檻即不放行」止於排名 0 的門檻:
  // unknown 是底線,拿底線當門檻放行所有東西（含缺值），與既有 0 >= 0 行為一致。
  expect(meetsMin(undefined, 'unknown')).toBe(true);
  expect(meetsMin(null, 'unknown')).toBe(true);
  expect(meetsMin('garbage', 'unknown')).toBe(true);
  expect(meetsMin('critical', 'unknown')).toBe(true);
});

test('meetsMin: 非字串門檻視為沒設門檻（全部放行,不拋）', () => {
  for (const min of [null, 0, 42, {}, [], true]) {
    expect(meetsMin('info', min)).toBe(true);
    expect(meetsMin(undefined, min)).toBe(true);
  }
});

test('isKnownSeverity: 非字串回 false,不拋', () => {
  for (const v of [undefined, null, 0, 42, '', '   ', {}, [], true, Symbol('warning'), () => 'warning']) {
    expect(isKnownSeverity(v)).toBe(false);
  }
  expect(isKnownSeverity('toString')).toBe(false);
  expect(isKnownSeverity('constructor')).toBe(false);
  expect(isKnownSeverity('__proto__')).toBe(false);
  // 既有行為照舊:前後空白與大小寫都容忍。
  expect(isKnownSeverity('  Critical ')).toBe(true);
});
