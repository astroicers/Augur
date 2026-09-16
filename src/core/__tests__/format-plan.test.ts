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
