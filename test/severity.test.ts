import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meetsMin, rankOf, isKnownSeverity } from '../src/core/severity.js'

test('meetsMin: 空門檻不過濾（全部放行）', () => {
  assert.equal(meetsMin('info', ''), true)
  assert.equal(meetsMin('unknown', ''), true)
  assert.equal(meetsMin('whatever', undefined), true)
})

test('meetsMin: 依排名比較', () => {
  assert.equal(meetsMin('critical', 'warning'), true)
  assert.equal(meetsMin('warning', 'warning'), true)
  assert.equal(meetsMin('info', 'warning'), false)
  assert.equal(meetsMin('error', 'warning'), true)
})

test('meetsMin: 大小寫不敏感、未知值視為最低', () => {
  assert.equal(meetsMin('CRITICAL', 'warning'), true)
  assert.equal(meetsMin('Warning', 'warning'), true)
  assert.equal(meetsMin('unknown', 'info'), false)
  assert.equal(meetsMin('garbage', 'info'), false)
})

test('rankOf / isKnownSeverity', () => {
  assert.equal(rankOf('critical'), 4)
  assert.equal(rankOf('nope'), 0)
  assert.equal(isKnownSeverity('warning'), true)
  assert.equal(isKnownSeverity('WARNING'), true)
  assert.equal(isKnownSeverity('nope'), false)
})
