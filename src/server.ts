/**
 * HTTP 接收層（SPEC §8.1）。
 * 目前只掛一個路由：POST /grafana/webhook。
 * 流程：驗 secret → 交 grafana adapter 解析 → 每個 ParsedAlert 走 format → sink。
 * 永遠快速回 200（避免來源重送）；實際推送非同步進行，失敗只記 log。
 */
import { Hono, type Context, type Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { timingSafeEqual } from 'node:crypto'
import type { AppConfig } from './config.js'
import type { Sink } from './sink/broadcastSink.js'
import { parseGrafanaWebhook, type GrafanaWebhookBody } from './sources/grafana.js'
import { buildBroadcastPlan } from './core/format.js'
import { meetsMin } from './core/severity.js'
import type { Dedup } from './core/dedup.js'

/**
 * 比對 Authorization header 與 WEBHOOK_SECRET。
 * Grafana「Authorization Header」預設 scheme = Bearer → 標頭會是 "Bearer <secret>"，
 * 因此容許帶或不帶 Bearer 前綴。用 timingSafeEqual 做定長時間比對。
 */
function secretMatches(authHeader: string | undefined, secret: string): boolean {
  if (!authHeader) return false
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createServer(config: AppConfig, sink: Sink, dedup: Dedup): Hono {
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true, ready: sink.isReady() }))

  // 先驗 secret（只看 header）→ 未授權在讀 body 前就 401；通過後才以 bodyLimit 限制 body 大小（防記憶體耗盡）。
  const auth = async (c: Context, next: Next) => {
    if (!secretMatches(c.req.header('Authorization'), config.webhookSecret)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }

  app.post(
    '/grafana/webhook',
    auth,
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    async (c) => {
      let body: GrafanaWebhookBody
      try {
        body = await c.req.json<GrafanaWebhookBody>()
      } catch {
        return c.json({ error: 'invalid json' }, 400)
      }

      // 快速回 200；播報非同步進行，失敗只記 log。多則告警依序 await（避免疊音）。
      queueMicrotask(async () => {
        try {
          const alerts = parseGrafanaWebhook(body)
          for (const alert of alerts) {
            // 1) severity 過濾（resolved 不受門檻擋，是否播由去重決定）
            if (alert.status === 'firing' && !meetsMin(alert.severity, config.minSeverity)) {
              console.log(`[bridge] 過濾 severity=${alert.severity} < ${config.minSeverity}：${alert.name}`)
              continue
            }
            // 2) 去重防洪 + resolved 綁狀態
            if (!dedup.shouldSpeak(alert)) {
              console.log(`[bridge] 去重略過：${alert.status} ${alert.name}`)
              continue
            }
            const plan = buildBroadcastPlan(alert, config.alertLang)
            console.log(`[bridge] ${alert.status} ${alert.name} → 播報：${plan.text}`)
            await sink.broadcast(plan)
          }
        } catch (err) {
          console.error('[bridge] 處理 webhook 失敗：', err)
        }
      })

      return c.json({ ok: true })
    },
  )

  return app
}
