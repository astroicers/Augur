import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDedup } from '../src/core/dedup.js'
import type { ParsedAlert } from '../src/core/types.js'

function mkAlert(p: Partial<ParsedAlert> = {}): ParsedAlert {
  return {
    status: 'firing',
    source: 'test',
    name: 'X',
    severity: 'warning',
    startsAt: '2026-01-01T00:00:00Z',
    fingerprint: 'fp1',
    ...p,
  }
}

test('firing 防洪：窗內只播一次，窗過後再播', () => {
  let clock = 1000
  const d = createDedup(300, { now: () => clock, startCleanup: false })

  assert.equal(d.shouldSpeak(mkAlert()), true) // 第一次
  assert.equal(d.shouldSpeak(mkAlert()), false) // 窗內重送 → 略過
  clock += 300_000 // 前進 300s（= 窗邊界）
  assert.equal(d.shouldSpeak(mkAlert()), true) // 窗過 → 再播
})

test('resolved 綁狀態：只有播過 firing 的才播恢復', () => {
  const clock = 1000
  const d = createDedup(300, { now: () => clock, startCleanup: false })

  assert.equal(d.shouldSpeak(mkAlert({ status: 'firing' })), true)
  assert.equal(d.shouldSpeak(mkAlert({ status: 'resolved' })), true) // 有對應 firing
  assert.equal(d.shouldSpeak(mkAlert({ status: 'resolved' })), false) // key 已清，重送恢復 → 吞掉
})

test('孤兒 resolved（沒播過 firing）直接吞掉', () => {
  const clock = 1000
  const d = createDedup(300, { now: () => clock, startCleanup: false })
  assert.equal(d.shouldSpeak(mkAlert({ status: 'resolved' })), false)
})

test('resolved 後同 fingerprint 再 firing = 新事件，立即可播', () => {
  const clock = 1000
  const d = createDedup(300, { now: () => clock, startCleanup: false })
  d.shouldSpeak(mkAlert({ status: 'firing' }))
  d.shouldSpeak(mkAlert({ status: 'resolved' })) // 清掉狀態
  assert.equal(d.shouldSpeak(mkAlert({ status: 'firing' })), true) // 雖在窗內，但 key 已清 → 播
})

test('不同 fingerprint 各自獨立', () => {
  const clock = 1000
  const d = createDedup(300, { now: () => clock, startCleanup: false })
  assert.equal(d.shouldSpeak(mkAlert({ fingerprint: 'a' })), true)
  assert.equal(d.shouldSpeak(mkAlert({ fingerprint: 'b' })), true)
  assert.equal(d.shouldSpeak(mkAlert({ fingerprint: 'a' })), false)
})

test('windowSec=0 等同關閉防洪（firing 每次都播）', () => {
  const clock = 1000
  const d = createDedup(0, { now: () => clock, startCleanup: false })
  assert.equal(d.shouldSpeak(mkAlert()), true)
  assert.equal(d.shouldSpeak(mkAlert()), true)
})

test('close() 可重複呼叫不報錯', () => {
  const d = createDedup(300, { startCleanup: false })
  d.close()
  d.close()
})
