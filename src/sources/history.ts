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
 *  - **名字跟著 `alertNameLabel`**（#70）：播報端取名改讀某個 instance label 時，紀錄端
 *    要一起改，否則同一則告警在兩邊叫不同名字 —— 句子因此不同，`MascotPanel` 的
 *    sessionOnly 合併（比對句子）就會把同一則列兩次。取名見 `historyAlertNameOf`。
 */
import { buildBroadcastPlan } from '../core/format';
import { meetsMin } from '../core/severity';
import { resolveSeverity, type SeverityAliasMap } from '../core/severityAliases';
import type { AlertLang, BroadcastPlan, ParsedAlert } from '../core/types';
import { panelRulerRulesOf, panelRulesOf } from './panelRules';

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
  /**
   * 規則的條件欄（refId，例如 `B`、`C`），取自 ruler API。播報念的「目前數值」是 rules 端點的
   * `alerts[].value`，那是**條件那一欄**的值（12.4.12 實測：A→B reduce→C threshold 時念 1，不是 A 的 0.93）。
   */
  condition?: string;
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
  /**
   * 範圍內可能還有更多，以及原因：`display`＝紀錄超過顯示上限；`fetch`＝原始狀態變化拿滿了請求上限
   * （其中有些是不列的 Pending／NoData，所以列出來的可能遠少於 200 條）。兩者的提示要分開寫。
   */
  truncated: 'display' | 'fetch' | null;
}

const LABEL_NAME = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * 從前端設定的 `unifiedAlerting` 取出 state history 的 backend。
 * `alertStateHistoryBackend` 在 @grafana/data 的型別裡已被標為棄用、要改用 `stateHistory.backend`；
 * 只讀舊欄位的話，Grafana 移除它之後會拿到 undefined 而放行 —— 部署若用 loki，就會靜默顯示「沒有紀錄」。
 */
export function historyBackendFrom(unifiedAlerting: unknown): unknown {
  const ua = unifiedAlerting as { stateHistory?: { backend?: unknown }; alertStateHistoryBackend?: unknown } | undefined;
  return ua?.stateHistory?.backend ?? ua?.alertStateHistoryBackend;
}

/**
 * 告警歷史存在哪裡會決定讀不讀得到（取法見 `historyBackendFrom`）。
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
 * （#70 起多一個受影響面：`alertNameLabel` 指到的 label 若是這種值，念出來的名字會被截斷 ——
 * 詳見 `historyAlertNameOf`。值裡含 `=` 或空白不受影響：`(.*)` 吃到該段結尾。）
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
  type TemplateRule = { name?: string; labels?: Record<string, string> };
  // 走訪與綁定比對共用 `panelRules.ts`；這裡只決定「從一條規則取什麼」。
  for (const { rule, annotations: ann } of panelRulesOf<TemplateRule>(raw, dashboardUid, panelId)) {
    if (!rule.name) {
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
  return out;
}

/**
 * 從 ruler API（`/api/ruler/grafana/api/v1/rules`）的回應取「綁在本 panel 的規則 → 條件欄」。
 * 回應形狀（12.4.12 實測）：`{ <資料夾>: [ { name, rules: [ { annotations, grafana_alert: { title, condition } } ] } ] }`。
 */
export function parseRulerConditions(raw: unknown, dashboardUid: string, panelId: number): Map<string, string> {
  const out = new Map<string, string>();
  type RulerRule = { grafana_alert?: { title?: string; condition?: string } };
  for (const { rule } of panelRulerRulesOf<RulerRule>(raw, dashboardUid, panelId)) {
    const title = rule.grafana_alert?.title;
    const condition = rule.grafana_alert?.condition;
    if (!title || !condition) {
      continue;
    }
    out.set(title, condition);
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
  opts: { minSeverity: string; lang: AlertLang; aliases?: SeverityAliasMap; alertNameLabel?: string }
): HistoryResult {
  if (!Array.isArray(raw)) {
    throw new Error('告警歷史的回應不是清單');
  }
  const nameLabel = (opts.alertNameLabel ?? '').trim();
  const sorted = [...(raw as RawAnnotation[])].sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const entries: HistoryEntry[] = [];
  for (const a of sorted) {
    const prev = String(a.prevState ?? '');
    const next = String(a.newState ?? '');
    // 吉祥物只念兩種變化：從非 Alerting 進入 Alerting（偵測到）、離開 Alerting／Recovering 回到 Normal（恢復）。
    // `Alerting (NoData)`→`Alerting` 這種只換 reason 的變化不是新的「偵測到」——播報端不會再念一次。
    // `Recovering` 是 keep_firing_for 的過渡態；列在它回到 Normal 時。⚠️ 未實測：播報端可能在進入 Recovering
    // 時就念恢復（它只保留 alerting 的 instance）；Alerting→NoData／Error 也可能播報端念恢復而此處不列（ADR-006 待驗風險 4）。
    const wasFiring = prev.startsWith('Alerting') || prev.startsWith('Recovering');
    const status =
      next.startsWith('Alerting') && !prev.startsWith('Alerting')
        ? 'firing'
        : wasFiring && next.startsWith('Normal')
          ? 'resolved'
          : null;
    if (!status) {
      continue;
    }
    const parsed = parseAnnotationText(String(a.text ?? ''));
    // 規則名與念出來的名字是**兩件事**（#70 AC-4）：規則樣板、條件欄、規則層嚴重度一律用
    // 規則名查（`alertNameLabel` 設了也一樣，拿 label 值去查只會查不到而掉摘要與數值）。
    const ruleName = a.alertName ?? parsed?.title ?? 'unknown';
    const tpl = templates.get(ruleName);
    const name = historyAlertNameOf(parsed?.labels, ruleName, nameLabel);
    const severity = parsed?.labels['severity'] ?? tpl?.severity ?? 'unknown';
    // 與播報同一個門檻，也與播報同一張別名表（#51）：門檻在兩邊判得不一樣的話，
    // 紀錄清單會出現「播過但紀錄裡沒有」或反之。`aliases` 省略 → 恆等，行為照舊。
    // resolved 也要過：播報那邊 resolved 只會跟在播過的 firing 後面，
    // 被門檻擋掉的 firing 不會有恢復句。
    if (!meetsMin(resolveSeverity(severity, opts.aliases), opts.minSeverity)) {
      continue;
    }
    const summary =
      tpl?.summary !== undefined && parsed ? renderSummary(tpl.summary, parsed.labels, tpl.ruleLabels) : undefined;
    const value = status === 'firing' ? conditionValue(a.data?.values, tpl?.condition) : undefined;
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
    const plan = buildBroadcastPlan(alert, opts.lang, opts.aliases);
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
    truncated: raw.length >= HISTORY_FETCH_LIMIT ? 'fetch' : entries.length > HISTORY_DISPLAY_LIMIT ? 'display' : null,
  };
}

/**
 * 一筆紀錄念出來的名字（#70）。播報端的對應物是 `panelAlerts.ts` 的 `alertNameOf` ——
 * 兩邊**必須同進同退**：名字進句子，句子是 `MascotPanel` 判斷「這一則紀錄裡有了嗎」的依據。
 *
 * 三條規則，與播報端同一個形狀（只有退路不同：這裡沒有 rules 端點的 instance labels，
 * 退的是紀錄自己的規則名，也就是這個函式不存在時那一行運算式的值）：
 *  1. `nameLabel` 為空 → 回 `ruleName`，與沒有這個選項時**逐字相同**（AC-1 的機械保證）。
 *  2. 指定的 label 在**這一筆**的 `{labels}` 段裡有非空白的值 → 用它（修剪前後空白）。
 *  3. 不存在、空字串或只有空白 → 退回第 1 條（AC-3）。**不留空名**：空名會讓句子念成
 *     「偵測到告警：」後面一片空白（#19→#30→#39→#46 同一族的缺值坑）。
 *
 * ⚠️ **只支援 `parseAnnotationText` 拆得出來的那種形狀。** label 值裡含 `, <名稱>=` 時那支會
 * 拆錯（它的 docstring 已標明，格式本身沒有文件保證），於是這裡可能取到被截斷的值而**不會**
 * 走第 3 條 —— 失敗形態是念錯名字，不是空名或例外。含 `=` 與空白的值不受影響（`(.*)` 吃到底）。
 * 這條路徑的產物會被念出來，所以行為由 `history.test.ts` 的三個 fixture 釘住，不靠讀程式推。
 */
function historyAlertNameOf(
  labels: Record<string, string> | undefined,
  ruleName: string,
  nameLabel: string
): string {
  if (!nameLabel) {
    return ruleName;
  }
  // String() 而不是直接 .trim()：理由同播報端 —— 紀錄字串是自由文字，拆出來的值在
  // runtime 沒有型別保證，而本層的契約是「拆不出來就少一段」，不丟例外。
  const picked = String(labels?.[nameLabel] ?? '').trim();
  return picked !== '' ? picked : ruleName;
}

/**
 * 與播報同一個數值：條件那一欄的值（見 `RuleTemplate.condition`）。
 * 不知道條件欄時（ruler API 讀不到）：各欄數值都相同就照用，不同就**不給數值** ——
 * 寧可紀錄句少一段，也不要顯示一個和當時念的不一樣的數字。
 */
function conditionValue(values: Record<string, unknown> | undefined, condition: string | undefined): number | undefined {
  if (!values) {
    return undefined;
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  if (condition !== undefined) {
    return num(values[condition]);
  }
  const all = Object.values(values).map(num);
  if (!all.length || all.some((v) => v === undefined)) {
    return undefined;
  }
  return all.every((v) => v === all[0]) ? all[0] : undefined;
}
