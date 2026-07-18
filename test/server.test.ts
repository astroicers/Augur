/**
 * server.ts 接線整合測試：用 Hono 的 app.request 直接打 webhook（不起 server、不連 AIRI、不走網路）。
 * 驗證 Phase 2 的過濾 + 去重在「真正的處理迴圈」裡有生效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../src/server.js'
import { createDedup } from '../src/core/dedup.js'
import type { AppConfig } from '../src/config.js'
import type { Sink } from '../src/sink/broadcastSink.js'
import type { BroadcastPlan } from '../src/core/types.js'

const SECRET = 'testsecret'

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 3001,
    webhookSecret: SECRET,
    airiWsUrl: 'ws://127.0.0.1:1/ws',
    airiAuthToken: 'x',
    airiName: 'test',
    maxBodyBytes: 1_048_576,
    alertLang: 'en',
    minSeverity: 'warning',
    dedupWindowSec: 300,
    wsPort: 3002,
    ttsVoice: 'zh-TW-HsiaoChenNeural',
    ...over,
  }
}

/** 收集被廣播的 BroadcastPlan 的假 sink（不起真 WS、不合成 TTS）。 */
function makeSink(): Sink & { plans: BroadcastPlan[] } {
  const plans: BroadcastPlan[] = []
  return {
    plans,
    broadcast: async (p) => {
      plans.push(p)
    },
    isReady: () => true,
    close: () => {},
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0)) // 讓 queueMicrotask 內的播報跑完

function firing(name: string, severity: string, fingerprint: string) {
  return {
    status: 'firing',
    alerts: [{
      status: 'firing',
      labels: { alertname: name, severity, instance: 'host-1' },
      annotations: { summary: `${name} summary` },
      startsAt: '2026-01-01T00:00:00Z',
      fingerprint,
    }],
  }
}
function resolved(name: string, fingerprint: string) {
  return {
    status: 'resolved',
    alerts: [{
      status: 'resolved',
      labels: { alertname: name, severity: 'critical', instance: 'host-1' },
      annotations: { summary: `${name} summary` },
      startsAt: '2026-01-01T00:00:00Z',
      fingerprint,
    }],
  }
}

async function post(app: ReturnType<typeof createServer>, body: unknown) {
  const res = await app.request('/grafana/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  })
  await tick()
  return res
}

test('整合：過濾 info、去重重送、resolved 綁狀態', async () => {
  const clock = 1000
  const sink = makeSink()
  const dedup = createDedup(300, { now: () => clock, startCleanup: false })
  const app = createServer(makeConfig({ minSeverity: 'warning' }), sink, dedup)

  assert.equal((await post(app, firing('HighCPU', 'critical', 'fp-cpu'))).status, 200) // 播
  await post(app, firing('HighCPU', 'critical', 'fp-cpu')) // 同 fp 重送 → 去重略過
  await post(app, firing('BackupNotice', 'info', 'fp-info')) // info < warning → 過濾
  await post(app, resolved('HighCPU', 'fp-cpu')) // 有播過 firing → 播恢復

  assert.deepEqual(
    sink.plans.map((p) => p.text),
    ['Alert firing: HighCPU, severity critical, on host-1, HighCPU summary.', 'Alert resolved: HighCPU, on host-1, HighCPU summary.'],
  )
  assert.deepEqual(sink.plans.map((p) => p.emotion), ['critical', 'resolved'])
})

test('整合：未授權 webhook 回 401 且不播報', async () => {
  const sink = makeSink()
  const dedup = createDedup(300, { startCleanup: false })
  const app = createServer(makeConfig(), sink, dedup)
  const res = await app.request('/grafana/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
    body: JSON.stringify(firing('X', 'critical', 'fp')),
  })
  await tick()
  assert.equal(res.status, 401)
  assert.equal(sink.plans.length, 0)
  dedup.close()
})
