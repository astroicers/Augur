/**
 * 播報紀錄（ADR-006）：把 Grafana 的告警狀態歷史轉成和播報**同一套句子**的紀錄。
 *
 * 只讀不寫、不播：這裡產的東西只給 feed 顯示，**永遠不進語音佇列**（ADR-006 決策 5）。
 * 抓資料的部分在 `historyFetcher.ts`，理由同 `rulesFetcher.ts`：本檔要能在 jest 裡
 * 不拖進 `@grafana/runtime` 地測。
 *
 * 紀錄句與播報句**逐字相同**是硬要求（G-ADR006-2），所以：
 *  - 組句一律走 `buildBroadcastPlan`，不在這裡另寫一套措辭。
 *  - 欄位的取捨跟 `panelAlerts.ts` 一致：不填 `instance`、resolved 不帶數值、
 *    嚴重度門檻與播報同一個 `meetsMin`。
 */
import { buildBroadcastPlan } from '../core/format';
import { meetsMin } from '../core/severity';
import type { AlertLang, BroadcastPlan, ParsedAlert } from '../core/types';

/** feed 一次最多顯示幾條（ADR-006 決策 4）。 */
export const HISTORY_DISPLAY_LIMIT = 200;
/**
 * 一次向 Grafana 要幾筆原始紀錄。比顯示上限大：原始紀錄裡還有 Pending、NoData 這些
 * 會被濾掉的狀態變化，要多拿一些才湊得滿 200 條。拿滿了就代表可能還有更早的。
 */
export const HISTORY_FETCH_LIMIT = 500;

/** 規則層（不是 instance 層）的設定：嚴重度與「還沒填值」的摘要樣板。 */
export interface RuleTemplate {
  severity?: string;
  summary?: string;
  /**
   * 規則層 label 的名稱。Grafana 渲染摘要時，`$labels` 裡**沒有**這些（實測渲染成 `[no value]`），
   * 但紀錄字串裡有 —— 填樣板時必須排除，否則紀錄句和念出來的不一樣。
   */
  ruleLabels?: string[];
}

export interface HistoryEntry {
  key: string;
  /** 狀態變化的時間（epoch ms）。 */
  time: number;
  /** 與播報逐字相同的句子。 */
  text: string;
  plan: BroadcastPlan;
  /** 篩選框比對用：句子加上所有 label 值，已轉小寫。 */
  search: string;
}

export interface HistoryResult {
  entries: HistoryEntry[];
  /** 範圍內可能還有更多（顯示被截斷，或原始紀錄拿滿了上限）。 */
  truncated: boolean;
}

const LABEL_NAME = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * 告警歷史存在哪裡（前端設定 `unifiedAlerting.alertStateHistoryBackend`）會決定讀不讀得到。
 *
 * backend 不是 annotations 時，`/api/annotations` 回的是**空清單**而不是錯誤 —— 不先擋的話，
 * panel 會把「歷史存在別處」顯示成「這段時間沒有紀錄」（ADR-006 決策 7）。
 * `multiple` 放行：annotations 可能是其中之一，讀不到時就是空清單，這點在 README 寫明。
 * 設定不存在（較舊版本）也放行，交給實際的讀取結果說話。
 */
export function historyBackendProblem(backend: unknown): string | null {
  if (backend === undefined || backend === null || backend === '' || backend === 'annotations' || backend === 'multiple') {
    return null;
  }
  return `Grafana 的告警歷史存在 ${String(backend)}，不是 annotations`;
}

/**
 * 拆 Grafana 組出來的紀錄字串：`<規則名> {k=v, k=v} - A=…, B=…`。
 *
 * ⚠️ 這個格式**沒有文件保證**（ADR-006〈接受的代價〉）。認不得就回 null ——
 * 呼叫端照樣列出這一條，只是不帶摘要。label 值裡含 `, <名稱>=` 這種樣子時會拆錯，
 * 那也只會讓摘要填錯或消失，規則名、嚴重度、數值、時間不受影響。
 */
export function parseAnnotationText(text: string): { title: string; labels: Record<string, string> } | null {
  const m = /^(.*?) \{(.*)\} - (.*)$/s.exec(text);
  if (!m) {
    return null;
  }
  const labels: Record<string, string> = {};
  const body = m[2]!;
  if (body !== '') {
    for (const part of body.split(new RegExp(`, (?=${LABEL_NAME}=)`))) {
      const kv = new RegExp(`^(${LABEL_NAME})=(.*)$`, 's').exec(part);
      if (!kv) {
        return null;
      }
      labels[kv[1]!] = kv[2]!;
    }
  }
  return { title: m[1]!, labels };
}

/** Grafana 對 `$labels` 裡沒有的 label 的渲染結果（12.4.12 實測）。 */
export const NO_VALUE = '[no value]';

/**
 * 用 instance labels 填規則的摘要樣板，**照 Grafana 的渲染規則**。只支援 `{{ $labels.X }}`。
 *
 * 2026-10-13 於 12.4.12 實測（ADR-006 V-7）：Grafana 渲染時的 `$labels` 只有查詢結果的 label
 * 加上 alertname、grafana_folder；**規則層的 label（`ruleLabels`）與不存在的 label 都渲染成 `[no value]`**。
 * 紀錄字串裡的 labels 卻包含規則層的 label，照填就會和念出來的不一樣。
 *
 * `{{ $value }}` 與其他語法刻意不支援：Grafana 會把 `$value` 渲染成 `[ var='A' labels={…} value=… ]`，
 * 前端不可能逐字重現（ADR-006 決策 3 更正）。遇到就回 undefined —— 寧可不帶摘要，
 * 也不要顯示一句和當時念的不一樣的話。
 */
export function renderSummary(
  template: string,
  labels: Record<string, string>,
  ruleLabels: readonly string[] = []
): string | undefined {
  const excluded = new Set(ruleLabels);
  const out = template.replace(new RegExp(`\\{\\{\\s*\\$labels\\.(${LABEL_NAME})\\s*\\}\\}`, 'g'), (_, name: string) =>
    excluded.has(name) ? NO_VALUE : (labels[name] ?? NO_VALUE)
  );
  return out.includes('{{') ? undefined : out;
}

/**
 * 從 rules 端點的原始回應取「綁在本 panel 的每條規則」的嚴重度與摘要樣板。
 * 跟 `parseRulesResponse` 不同：那支只要正在燒的 instance，這裡要所有規則
 * （沒在燒的規則也有歷史），而且要的是**還沒填值**的 rule-level 樣板（ADR-006 V-4）。
 */
export function parseRuleTemplates(raw: unknown, dashboardUid: string, panelId: number): Map<string, RuleTemplate> {
  const out = new Map<string, RuleTemplate>();
  const groups = (raw as { data?: { groups?: unknown[] } })?.data?.groups;
  if (!Array.isArray(groups)) {
    return out;
  }
  for (const g of groups) {
    const rules = (g as { rules?: unknown[] })?.rules;
    if (!Array.isArray(rules)) {
      continue;
    }
    for (const r of rules) {
      const rule = r as { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
      const ann = rule.annotations ?? {};
      // 同 parseRulesResponse：端點的過濾參數萬一被忽略，這裡再比對一次。
      if (!rule.name || ann['__dashboardUid__'] !== dashboardUid || ann['__panelId__'] !== String(panelId)) {
        continue;
      }
      const severity = rule.labels?.['severity'];
      const summary = ann['summary'];
      out.set(rule.name, {
        ...(severity !== undefined ? { severity } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(rule.labels ? { ruleLabels: Object.keys(rule.labels) } : {}),
      });
    }
  }
  return out;
}

interface RawAnnotation {
  id?: number;
  alertName?: string;
  prevState?: string;
  newState?: string;
  time?: number;
  text?: string;
  data?: { values?: Record<string, unknown> };
}

/**
 * 把 `/api/annotations?type=alert` 的回應轉成紀錄。
 * 回應不是陣列就**丟出**：那是權限、端點或 backend 的問題，panel 要可見地降級（決策 7），
 * 不能當成「沒有紀錄」。
 */
export function historyToEntries(
  raw: unknown,
  templates: Map<string, RuleTemplate>,
  opts: { minSeverity: string; lang: AlertLang }
): HistoryResult {
  if (!Array.isArray(raw)) {
    throw new Error('告警歷史的回應不是清單');
  }
  const sorted = [...(raw as RawAnnotation[])].sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const entries: HistoryEntry[] = [];
  for (const a of sorted) {
    const prev = String(a.prevState ?? '');
    const next = String(a.newState ?? '');
    // 吉祥物只念兩種變化：進入 Alerting（偵測到）、離開 Alerting 回到 Normal（恢復）。
    const status = next.startsWith('Alerting')
      ? 'firing'
      : prev.startsWith('Alerting') && next.startsWith('Normal')
        ? 'resolved'
        : null;
    if (!status) {
      continue;
    }
    const parsed = parseAnnotationText(String(a.text ?? ''));
    const name = a.alertName ?? parsed?.title ?? 'unknown';
    const tpl = templates.get(name);
    const severity = parsed?.labels['severity'] ?? tpl?.severity ?? 'unknown';
    // 與播報同一個門檻。resolved 也要過：播報那邊 resolved 只會跟在播過的 firing 後面，
    // 被門檻擋掉的 firing 不會有恢復句。
    if (!meetsMin(severity, opts.minSeverity)) {
      continue;
    }
    const summary =
      tpl?.summary !== undefined && parsed ? renderSummary(tpl.summary, parsed.labels, tpl.ruleLabels) : undefined;
    const value = status === 'firing' ? firstValue(a.data?.values) : undefined;
    const time = a.time ?? 0;
    const alert: ParsedAlert = {
      status,
      source: 'grafana-history',
      name,
      severity,
      startsAt: new Date(time).toISOString(),
      fingerprint: `alert:${name}`,
      ...(summary !== undefined ? { summary } : {}),
      ...(value !== undefined ? { value } : {}),
    };
    const plan = buildBroadcastPlan(alert, opts.lang);
    entries.push({
      key: `h:${a.id ?? `${time}:${name}:${status}`}`,
      time,
      text: plan.text,
      plan,
      search: [plan.text, ...Object.values(parsed?.labels ?? {})].join(' ').toLowerCase(),
    });
  }
  return {
    entries: entries.slice(0, HISTORY_DISPLAY_LIMIT),
    truncated: entries.length > HISTORY_DISPLAY_LIMIT || raw.length >= HISTORY_FETCH_LIMIT,
  };
}

/** 規則的查詢結果是 A（ADR-004 實作的條件 B＝`$A`）；沒有 A 才退回第一個數值。 */
function firstValue(values: Record<string, unknown> | undefined): number | undefined {
  if (!values) {
    return undefined;
  }
  const pick = values['A'] ?? Object.values(values)[0];
  return typeof pick === 'number' && Number.isFinite(pick) ? pick : undefined;
}
