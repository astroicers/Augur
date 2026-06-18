/**
 * Grafana adapter（目前唯一來源，SPEC §8.2）。
 * 輸入：Grafana unified alerting webhook body。輸出：ParsedAlert[]。
 *
 * 取值規則（§8.2）：
 *   status   ← alert.status（firing / resolved）
 *   name     ← labels.alertname
 *   severity ← labels.severity，缺省 'unknown'
 *   instance ← labels.instance（可選）
 *   summary  ← annotations.summary（退而求其次 description）
 *   value    ← values（refId→number）取代表性數值
 */
import type { ParsedAlert } from '../core/types.js'

const SOURCE = 'grafana'

/** 只描述我們會讀到的欄位；Grafana 還有很多欄位，這裡不需要全列。 */
interface GrafanaAlert {
  status?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  /** refId(A/B/C…) → 評估值。可能為空 {}。 */
  values?: Record<string, unknown>
  startsAt?: string
  endsAt?: string
  fingerprint?: string
  panelURL?: string
  dashboardURL?: string
}

export interface GrafanaWebhookBody {
  status?: string
  alerts?: GrafanaAlert[]
  commonLabels?: Record<string, string>
}

/**
 * 從 Grafana 的 values(refId→number) 取一個「代表性數值」。
 * refId 不固定（使用者可自訂），且常含布林條件（值為 0/1，例如 Math/閾值表達式）。
 * 規則：依 refId 字母排序，優先回傳第一個「非 0/1」的有限數值；
 *       若全是 0/1 或只有條件值，回傳排序後第一個有限數值，仍保留可播報資訊。
 */
function pickRepresentativeValue(values?: Record<string, unknown>): number | undefined {
  if (!values) return undefined
  const numeric = Object.entries(values)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
    .sort((a, b) => a[0].localeCompare(b[0]))
  if (numeric.length === 0) return undefined
  const meaningful = numeric.find(([, v]) => v !== 0 && v !== 1)
  return (meaningful ?? numeric[0])![1]
}

export function parseGrafanaWebhook(body: GrafanaWebhookBody): ParsedAlert[] {
  const alerts = Array.isArray(body?.alerts) ? body.alerts : []

  return alerts.map((a): ParsedAlert => {
    const labels = a.labels ?? {}
    const annotations = a.annotations ?? {}
    const status: ParsedAlert['status'] = a.status === 'resolved' ? 'resolved' : 'firing'

    const alert: ParsedAlert = {
      status,
      source: SOURCE,
      name: labels.alertname ?? 'unknown',
      severity: labels.severity ?? 'unknown',
      startsAt: a.startsAt ?? new Date().toISOString(),
      // Grafana 一定會帶 fingerprint；保險起見給個 fallback。
      fingerprint: a.fingerprint ?? `${labels.alertname ?? 'unknown'}:${a.startsAt ?? ''}`,
    }

    if (labels.instance) alert.instance = labels.instance

    const summary = annotations.summary ?? annotations.description
    if (summary) alert.summary = summary

    const value = pickRepresentativeValue(a.values)
    if (value !== undefined) alert.value = value

    const link = a.panelURL || a.dashboardURL
    if (link) alert.panelURL = link

    return alert
  })
}
