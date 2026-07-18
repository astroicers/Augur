/**
 * 廣播 smoke（取代 airi-smoke.ts 的廣播版）：連上前端 WS，POST 一則 mock Grafana
 * 告警到 webhook，確認收到 { type:'broadcast', plan, audio(base64 mp3) }。
 * 用法：先啟 bridge（WEBHOOK_SECRET=... pnpm dev），再 `npx tsx scripts/smoke-broadcast.ts`。
 */
import WebSocket from 'ws'

const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:3002'
const WEBHOOK = process.env.WEBHOOK ?? 'http://127.0.0.1:3001/grafana/webhook'
const SECRET = process.env.WEBHOOK_SECRET ?? 'smoke'

const payload = {
  receiver: 'augur',
  status: 'firing',
  orgId: 1,
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'High CPU Usage', severity: 'critical', instance: 'prod-db-01' },
      annotations: { summary: 'CPU 使用率超過 90%' },
      startsAt: new Date().toISOString(),
      endsAt: '0001-01-01T00:00:00Z',
      fingerprint: 'smoke-' + Date.now(),
      values: { B: 95.2, C: 1 },
    },
  ],
  commonLabels: { severity: 'critical' },
  title: '[FIRING:1] High CPU Usage',
}

const ws = new WebSocket(WS_URL)
const received: unknown[] = []
ws.on('message', (d) => received.push(JSON.parse(d.toString())))
await new Promise<void>((resolve, reject) => {
  ws.on('open', () => resolve())
  ws.on('error', reject)
})
console.log('[smoke] WS 已連上', WS_URL)

const r = await fetch(WEBHOOK, {
  method: 'POST',
  headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
console.log('[smoke] webhook 回應', r.status, await r.json())

const t0 = Date.now()
while (received.length === 0 && Date.now() - t0 < 10_000) {
  await new Promise((res) => setTimeout(res, 200))
}

if (received.length === 0) {
  console.error('[smoke] ❌ 沒收到廣播')
  process.exit(1)
}
const b = received[0] as { type: string; plan: unknown; audio?: string }
console.log(
  '[smoke] ✅ 收到廣播：',
  JSON.stringify({ type: b.type, plan: b.plan, audioBase64Len: (b.audio ?? '').length }, null, 2),
)
ws.close()
process.exit(0)
