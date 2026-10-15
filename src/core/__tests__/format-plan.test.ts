import { severityToEmotion } from '../emotion';
import { buildBroadcastPlan } from '../format';
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

test('firing critical → text + emotion critical + 帶 instance/value', () => {
  const plan = buildBroadcastPlan(mk(), 'en');
  expect(plan.text).toBe('Alert firing: HighCPU, severity critical, on host-1, current value 95.20, CPU high.');
  expect(plan.emotion).toBe('critical');
  expect(plan.severity).toBe('critical');
  expect(plan.name).toBe('HighCPU');
  expect(plan.status).toBe('firing');
  expect(plan.instance).toBe('host-1');
  expect(plan.value).toBe(95.2);
});

test('resolved → emotion resolved', () => {
  const plan = buildBroadcastPlan(mk({ status: 'resolved' }), 'en');
  expect(plan.emotion).toBe('resolved');
  expect(plan.status).toBe('resolved');
});

test('warning → emotion warning；info → calm', () => {
  expect(buildBroadcastPlan(mk({ severity: 'warning' }), 'en').emotion).toBe('warning');
  expect(buildBroadcastPlan(mk({ severity: 'info' }), 'en').emotion).toBe('calm');
});

test('缺 instance/value 時不帶該欄位（undefined 不出現）', () => {
  const bare = mk();
  delete bare.instance;
  delete bare.value;
  const plan = buildBroadcastPlan(bare, 'en');
  expect(plan).not.toHaveProperty('instance');
  expect(plan).not.toHaveProperty('value');
});

// ---- #39：BroadcastPlan.severity 欄位（票上留言 (c) 指出的同檔殘留）----

/**
 * `BroadcastPlan.severity` 型別是 `string`，但來源是面板資料；在本票之前這個欄位
 * 原樣轉手 `a.severity`，缺值時下游拿到的是貨真價實的 `undefined`。
 * 本票讓它與 `text` 走同一份正規化（`severity.ts` 的 `normalize`，缺值 → `'unknown'`），
 * 所以「唸出來的」與「欄位裡的」永遠一致。
 */
const DIRTY_SEVERITIES: unknown[] = [
  undefined, null, '', '   ', 0, 42, NaN, {}, { severity: 'critical' }, [], ['critical'],
  true, () => 'critical',
];

/** 型別標註說 severity 是 string，這裡要測的正是「標註不可信」的那些值。 */
function withSeverity(severity: unknown, over: Partial<ParsedAlert> = {}): ParsedAlert {
  return { ...mk(over), severity } as unknown as ParsedAlert;
}

test('#39：severity 缺值/非字串時 plan.severity 是字串 unknown，不是 undefined', () => {
  for (const v of DIRTY_SEVERITIES) {
    const plan = buildBroadcastPlan(withSeverity(v), 'en');
    expect(plan.severity).toBe('unknown');
    expect(typeof plan.severity).toBe('string');
  }
});

test('#39：plan.severity 與 plan.text 念出的嚴重度一致', () => {
  for (const v of [...DIRTY_SEVERITIES, 'critical', ' CRITICAL ', '\tWarning\n', 'info', 'fatal']) {
    const plan = buildBroadcastPlan(withSeverity(v), 'en');
    expect(plan.text).toContain(`severity ${plan.severity}`);
  }
});

test('#39：resolved 時 plan.severity 照樣正規化（text 不念，欄位仍要合法）', () => {
  const plan = buildBroadcastPlan(withSeverity(undefined, { status: 'resolved' }), 'en');
  expect(plan.severity).toBe('unknown');
  expect(plan.text).not.toContain('undefined');
  expect(plan.emotion).toBe('resolved');
});

test('#39：乾淨嚴重度的 plan.severity 一字未改；僅去空白轉小寫', () => {
  expect(buildBroadcastPlan(mk({ severity: 'critical' }), 'en').severity).toBe('critical');
  expect(buildBroadcastPlan(mk({ severity: 'warning' }), 'en').severity).toBe('warning');
  expect(buildBroadcastPlan(mk({ severity: 'fatal' }), 'en').severity).toBe('fatal');
  expect(buildBroadcastPlan(mk({ severity: ' CRITICAL ' }), 'en').severity).toBe('critical');
});

test('#39：plan.severity 正規化不改變 emotion 判定', () => {
  for (const v of [' CRITICAL ', 'Error', 'WARNING', undefined, null, {}]) {
    const plan = buildBroadcastPlan(withSeverity(v), 'en');
    expect(plan.emotion).toBe(severityToEmotion(v, 'firing'));
  }
});

// ---- #46：name / instance / summary / value 的髒值經 buildBroadcastPlan 之後 ----

/**
 * 句子本身的整句斷言在 `format.test.ts`（#46 AC-1/AC-2）；這裡只確認
 * **真正餵給 TTS 的那條路徑**（`buildBroadcastPlan().text`）同樣乾淨——
 * panel 與 history 都是經這個函式取 text，不是直接呼叫 `formatAlert`。
 */
const DIRTY_FIELD_VALUES: unknown[] = [undefined, null, '', '   ', {}, [], [1, 2], NaN, true, () => 'x'];

test('#46：name 髒值時 plan.text 唸替代詞，整句釘死（兩種語言）', () => {
  for (const v of DIRTY_FIELD_VALUES) {
    const a = { ...mk(), name: v } as unknown as ParsedAlert;
    expect(buildBroadcastPlan(a, 'zh').text).toBe(
      '偵測到告警：未命名告警，嚴重度 critical，受影響對象 host-1，目前數值 95.20，CPU high。',
    );
    expect(buildBroadcastPlan(a, 'en').text).toBe(
      'Alert firing: unnamed alert, severity critical, on host-1, current value 95.20, CPU high.',
    );
  }
});

test('#46：instance/summary/value 髒值時 plan.text 省略該子句，整句釘死（zh）', () => {
  for (const v of DIRTY_FIELD_VALUES) {
    const a = { ...mk(), instance: v, summary: v, value: v } as unknown as ParsedAlert;
    expect(buildBroadcastPlan(a, 'zh').text).toBe('偵測到告警：HighCPU，嚴重度 critical。');
  }
});

test('#46：髒值不讓 undefined / null / [object Object] 進到 plan.text', () => {
  for (const v of DIRTY_FIELD_VALUES) {
    const a = { ...mk(), name: v, severity: v, instance: v, summary: v, value: v } as unknown as ParsedAlert;
    for (const lang of ['zh', 'en'] as const) {
      const { text } = buildBroadcastPlan(a, lang);
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('null');
      expect(text).not.toContain('[object Object]');
      expect(text).not.toContain('NaN');
    }
  }
});
