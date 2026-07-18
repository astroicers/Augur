import { test } from 'node:test'
import assert from 'node:assert/strict'
import { severityToEmotion } from '../src/core/emotion.js'

test('resolved 狀態一律映射 resolved（不看 severity）', () => {
  assert.equal(severityToEmotion('critical', 'resolved'), 'resolved')
  assert.equal(severityToEmotion('warning', 'resolved'), 'resolved')
  assert.equal(severityToEmotion('unknown', 'resolved'), 'resolved')
})

test('firing 時依 §6 映射', () => {
  assert.equal(severityToEmotion('critical', 'firing'), 'critical')
  assert.equal(severityToEmotion('error', 'firing'), 'critical') // §6 未列 error → 併 critical
  assert.equal(severityToEmotion('warning', 'firing'), 'warning')
  assert.equal(severityToEmotion('info', 'firing'), 'calm')
  assert.equal(severityToEmotion('unknown', 'firing'), 'calm')
  assert.equal(severityToEmotion('garbage', 'firing'), 'calm')
})

test('大小寫不敏感、去空白', () => {
  assert.equal(severityToEmotion(' CRITICAL ', 'firing'), 'critical')
  assert.equal(severityToEmotion('Warning', 'firing'), 'warning')
})
