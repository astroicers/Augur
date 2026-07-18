import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBroadcastPlan } from '../src/core/format.js'
import type { ParsedAlert } from '../src/core/types.js'

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
  }
}

test('firing critical → text + emotion critical + 帶 instance/value', () => {
  const plan = buildBroadcastPlan(mk(), 'en')
  assert.equal(plan.text, 'Alert firing: HighCPU, severity critical, on host-1, current value 95.20, CPU high.')
  assert.equal(plan.emotion, 'critical')
  assert.equal(plan.severity, 'critical')
  assert.equal(plan.name, 'HighCPU')
  assert.equal(plan.status, 'firing')
  assert.equal(plan.instance, 'host-1')
  assert.equal(plan.value, 95.2)
})

test('resolved → emotion resolved', () => {
  const plan = buildBroadcastPlan(mk({ status: 'resolved' }), 'en')
  assert.equal(plan.emotion, 'resolved')
  assert.equal(plan.status, 'resolved')
})

test('warning → emotion warning；info → calm', () => {
  assert.equal(buildBroadcastPlan(mk({ severity: 'warning' }), 'en').emotion, 'warning')
  assert.equal(buildBroadcastPlan(mk({ severity: 'info' }), 'en').emotion, 'calm')
})

test('缺 instance/value 時不帶該欄位（undefined 不出現）', () => {
  const bare = mk()
  delete bare.instance
  delete bare.value
  const plan = buildBroadcastPlan(bare, 'en')
  assert.ok(!('instance' in plan), 'instance 不應存在')
  assert.ok(!('value' in plan), 'value 不應存在')
})
