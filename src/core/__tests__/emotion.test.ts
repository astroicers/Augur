import { severityToEmotion } from '../emotion';

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
