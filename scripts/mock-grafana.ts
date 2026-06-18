/**
 * 模擬 Grafana 告警 → 打進 bridge → 走完整 webhook→adapter→format→AIRI 流程。
 * 不需要真實 Grafana，用來測 AIRI 端的語音播報。
 *
 * 用法（先另開一個終端 `pnpm dev` 把 bridge 起起來）：
 *   pnpm mock            # 依序送出全部情境（每筆間隔 MOCK_DELAY_MS，預設 3500ms 留給 TTS）
 *   pnpm mock list       # 只列出有哪些情境
 *   pnpm mock 3          # 只送第 3 個情境
 *   MOCK_DELAY_MS=1000 pnpm mock
 *
 * .env 指到真實 AIRI（AIRI_WS_URL + AIRI_AUTH_TOKEN）時，角色會把每筆念出來；
 * 未連上 AIRI 時，bridge 會在自己的終端 log 出「會送給 AIRI 的文字」。
 */
import { loadDotEnv, loadConfig } from '../src/config.js'

loadDotEnv()
const config = loadConfig()
const ENDPOINT = `http://${config.host}:${config.port}/grafana/webhook`
const DELAY_MS = Number.parseInt(process.env.MOCK_DELAY_MS ?? '3500', 10)

const now = new Date()
const iso = (offsetMin = 0) => new Date(now.getTime() + offsetMin * 60_000).toISOString()
const ZERO_TIME = '0001-01-01T00:00:00Z' // Grafana firing 時 endsAt 的零時間戳

interface Scenario {
  name: string
  body: unknown
}

const scenarios: Scenario[] = [
  {
    name: 'firing / critical — CPU 飆高',
    body: {
      status: 'firing',
      alerts: [{
        status: 'firing',
        labels: { alertname: 'HighCPUUsage', severity: 'critical', instance: 'prod-db-01' },
        annotations: { summary: 'CPU usage has stayed above 90 percent' },
        startsAt: iso(-3), endsAt: ZERO_TIME,
        fingerprint: 'cpu-prod-db-01',
        values: { A: 95.2, C: 1 },
      }],
      commonLabels: { severity: 'critical' },
    },
  },
  {
    name: 'firing / warning — 記憶體偏高',
    body: {
      status: 'firing',
      alerts: [{
        status: 'firing',
        labels: { alertname: 'HighMemoryUsage', severity: 'warning', instance: 'prod-web-02' },
        annotations: { summary: 'Memory usage is elevated' },
        startsAt: iso(-1), endsAt: ZERO_TIME,
        fingerprint: 'mem-prod-web-02',
        values: { B: 88.4, C: 1 },
      }],
    },
  },
  {
    name: 'firing / critical — 5xx 錯誤率（小數值，測 formatNumber）',
    body: {
      status: 'firing',
      alerts: [{
        status: 'firing',
        labels: { alertname: 'HighErrorRate', severity: 'critical', instance: 'api-gateway-01' },
        annotations: { summary: 'API 5xx error rate exceeded threshold' },
        startsAt: iso(0), endsAt: ZERO_TIME,
        fingerprint: 'err-api-gateway-01',
        values: { B: 0.004, C: 1 }, // adapter 取 0.004 → 念「0.0040」而非塌成 0.00
      }],
    },
  },
  {
    name: 'resolved — CPU 已恢復',
    body: {
      status: 'resolved',
      alerts: [{
        status: 'resolved',
        labels: { alertname: 'HighCPUUsage', severity: 'critical', instance: 'prod-db-01' },
        annotations: { summary: 'CPU usage has stayed above 90 percent' },
        startsAt: iso(-10), endsAt: iso(0),
        fingerprint: 'cpu-prod-db-01',
        values: { A: 42.1, C: 0 },
      }],
    },
  },
  {
    name: 'firing 批次 — 兩台主機磁碟不足',
    body: {
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'DiskSpaceLow', severity: 'warning', instance: 'prod-app-01' },
          annotations: { summary: 'Root partition free space is below 15 percent' },
          startsAt: iso(-2), endsAt: ZERO_TIME,
          fingerprint: 'disk-prod-app-01',
          values: { B: 13.7, C: 1 },
        },
        {
          status: 'firing',
          labels: { alertname: 'DiskSpaceLow', severity: 'critical', instance: 'prod-app-02' },
          annotations: { summary: 'Root partition free space is below 5 percent' },
          startsAt: iso(-2), endsAt: ZERO_TIME,
          fingerprint: 'disk-prod-app-02',
          values: { B: 4.3, C: 1 },
        },
      ],
    },
  },
]

function pickScenarios(): Scenario[] {
  const arg = process.argv[2]
  if (!arg) return scenarios
  if (arg === 'list') {
    scenarios.forEach((s, i) => console.log(`${i + 1}. ${s.name}`))
    process.exit(0)
  }
  const idx = Number.parseInt(arg, 10)
  if (Number.isInteger(idx) && idx >= 1 && idx <= scenarios.length) return [scenarios[idx - 1]!]
  console.error(`未知參數「${arg}」。用 "pnpm mock list" 看清單。`)
  process.exit(1)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const chosen = pickScenarios()
  console.log(`[mock] 目標 ${ENDPOINT}（共 ${chosen.length} 筆，間隔 ${DELAY_MS}ms）\n`)

  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i]!
    process.stdout.write(`[mock] (${i + 1}/${chosen.length}) ${s.name} … `)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.webhookSecret}`,
        },
        body: JSON.stringify(s.body),
      })
      console.log(`HTTP ${res.status}`)
    } catch (err) {
      console.log('送出失敗：', err instanceof Error ? err.message : err)
      console.error('  → bridge 有起來嗎？先在另一個終端跑 `pnpm dev`。')
    }
    if (i < chosen.length - 1) await sleep(DELAY_MS)
  }
  console.log('\n[mock] 完成。看 bridge 終端的 [bridge]/[airi] log；若已連上 AIRI，角色應已念出每一筆。')
}

void main()
