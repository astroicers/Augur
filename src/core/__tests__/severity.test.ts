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
