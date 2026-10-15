/**
 * `formatAlert` 的播報句單元測試（#39 AC-2）。
 *
 * 在本票之前，`format.ts` 只有 `format-plan.test.ts` 經 `buildBroadcastPlan` 間接
 * 覆蓋播報句，且用的全是乾淨 severity；於是「嚴重度缺值時念出 `undefined`」
 * （QA 在 #38 記錄）一路無人攔。這支直接打 `formatAlert`，並對**整句**下斷言——
 * 中文句以「，」串接，省略方式不同會產生不同的破碎句，只斷言「不含 undefined」
 * 會讓「整句省略嚴重度」與「念 unknown」兩種實作都算過。
 */
import { formatAlert } from '../format';
import type { ParsedAlert } from '../types';

function mk(over: Partial<ParsedAlert> = {}): ParsedAlert {
  return {
    status: 'firing',
    source: 'grafana',
    name: 'HighCPU',
    severity: 'critical',
    instance: 'host-1',
    summary: 'CPU high',
    value: 95.2,
    startsAt: '2026-01-01T00:00:00Z',
    fingerprint: 'fp-1',
    ...over,
  };
}

/** 型別標註說 severity 是 string，但本票要測的正是「標註不可信」的那些值。 */
function withSeverity(severity: unknown, over: Partial<ParsedAlert> = {}): ParsedAlert {
  return { ...mk(over), severity } as unknown as ParsedAlert;
}

/** 缺值/非字串都收斂成這個字串（= `panelAlerts.ts` 的 `?? 'unknown'`）。 */
const DIRTY: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['空字串', ''],
  ['全空白', '   '],
  ['數字 0', 0],
  ['數字 42', 42],
  ['NaN', NaN],
  ['空物件', {}],
  ['有 severity 欄位的物件', { severity: 'critical' }],
  ['空陣列', []],
  ['單元素陣列', ['critical']],
  ['true', true],
  ['function', () => 'critical'],
];

// ---- 乾淨輸入：既有行為一字未改 ----

test('firing：中文句帶名稱、嚴重度、對象、數值、摘要', () => {
  expect(formatAlert(mk())).toBe(
    '偵測到告警：HighCPU，嚴重度 critical，受影響對象 host-1，目前數值 95.20，CPU high。',
  );
});

test('firing：英文句同構（lang=en）', () => {
  expect(formatAlert(mk(), 'en')).toBe(
    'Alert firing: HighCPU, severity critical, on host-1, current value 95.20, CPU high.',
  );
});

test('resolved：不帶嚴重度子句（兩種語言）', () => {
  const a = mk({ status: 'resolved' });
  expect(formatAlert(a)).toBe('告警已恢復：HighCPU，受影響對象 host-1，目前數值 95.20，CPU high。');
  expect(formatAlert(a, 'en')).toBe('Alert resolved: HighCPU, on host-1, current value 95.20, CPU high.');
});

test('lang 預設為 zh', () => {
  expect(formatAlert(mk())).toBe(formatAlert(mk(), 'zh'));
});

// ---- #39 AC-2：嚴重度缺值、null、非字串 ----

test('AC-2：髒嚴重度一律念 unknown，整句釘死（zh）', () => {
  const expected = '偵測到告警：HighCPU，嚴重度 unknown，受影響對象 host-1，目前數值 95.20，CPU high。';
  // 斷言帶上 label，失敗時的 diff 直接說是哪一筆髒值，不必數迴圈。
  for (const [label, v] of DIRTY) {
    expect([label, formatAlert(withSeverity(v))]).toEqual([label, expected]);
  }
});

test('AC-2：髒嚴重度一律念 unknown，整句釘死（en）', () => {
  for (const [, v] of DIRTY) {
    expect(formatAlert(withSeverity(v), 'en')).toBe(
      'Alert firing: HighCPU, severity unknown, on host-1, current value 95.20, CPU high.',
    );
  }
});

test('AC-2：播報句不含 undefined / null / [object Object] 等 JS 轉字串痕跡', () => {
  for (const [, v] of DIRTY) {
    for (const lang of ['zh', 'en'] as const) {
      const text = formatAlert(withSeverity(v), lang);
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('null');
      expect(text).not.toContain('[object Object]');
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('=>');
      expect(text).not.toContain('function');
    }
  }
});

test('AC-2：髒嚴重度與字串 unknown 的播報句完全一致', () => {
  const baseline = { zh: formatAlert(withSeverity('unknown')), en: formatAlert(withSeverity('unknown'), 'en') };
  for (const [, v] of DIRTY) {
    expect(formatAlert(withSeverity(v))).toBe(baseline.zh);
    expect(formatAlert(withSeverity(v), 'en')).toBe(baseline.en);
  }
});

test('AC-2：髒嚴重度不改變句型——子句數與乾淨輸入相同', () => {
  const clean = formatAlert(mk()).split('，').length;
  for (const [, v] of DIRTY) {
    expect(formatAlert(withSeverity(v)).split('，').length).toBe(clean);
  }
});

test('AC-2：resolved 不念嚴重度，髒值也不滲進句子', () => {
  for (const [, v] of DIRTY) {
    expect(formatAlert(withSeverity(v, { status: 'resolved' }))).toBe(
      '告警已恢復：HighCPU，受影響對象 host-1，目前數值 95.20，CPU high。',
    );
  }
});

test('AC-2：髒嚴重度不拋例外（最小 ParsedAlert，連可選欄位都缺）', () => {
  for (const [, v] of DIRTY) {
    const bare = withSeverity(v);
    delete bare.instance;
    delete bare.summary;
    delete bare.value;
    expect(() => formatAlert(bare)).not.toThrow();
    expect(formatAlert(bare)).toBe('偵測到告警：HighCPU，嚴重度 unknown。');
    expect(formatAlert(bare, 'en')).toBe('Alert firing: HighCPU, severity unknown.');
  }
});

// ---- 正規化：與 severity.ts 的 normalize 同一份 ----

test('嚴重度去空白、轉小寫後才念出（不是原樣轉手）', () => {
  expect(formatAlert(withSeverity(' CRITICAL '))).toBe(
    '偵測到告警：HighCPU，嚴重度 critical，受影響對象 host-1，目前數值 95.20，CPU high。',
  );
  expect(formatAlert(withSeverity('\tWarning\n'), 'en')).toBe(
    'Alert firing: HighCPU, severity warning, on host-1, current value 95.20, CPU high.',
  );
});

test('未知但合法的字串嚴重度照原字念（只正規化，不改寫成 unknown）', () => {
  expect(formatAlert(withSeverity('fatal'))).toContain('嚴重度 fatal');
  expect(formatAlert(withSeverity('Sev1'), 'en')).toContain('severity sev1');
});
