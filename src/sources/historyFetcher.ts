/**
 * 播報紀錄的資料來源（ADR-006 決策 1）—— 讀 Grafana 已經在存的告警狀態歷史，唯讀。
 *
 * 獨立成一支的理由同 `rulesFetcher.ts`：`history.ts` 的邏輯要能在 jest 裡測，
 * 不該拖進 `@grafana/runtime`。
 *
 * `/api/annotations` 是 Grafana 有公開文件的 HTTP API；Viewer 讀得到
 * （2026-10-13 於 12.4.12 實測，ADR-006 V-1）。
 */
import { config, getBackendSrv } from '@grafana/runtime';
import { HISTORY_FETCH_LIMIT, historyBackendProblem, parseRuleTemplates, type RuleTemplate } from './history';
import { RULES_ENDPOINT } from './rulesFetcher';

export const ANNOTATIONS_ENDPOINT = '/api/annotations';

export interface PanelHistory {
  /** `/api/annotations` 的原始回應；形狀由 `historyToEntries` 檢查。 */
  raw: unknown;
  /** 綁在本 panel 的規則的嚴重度與摘要樣板。 */
  templates: Map<string, RuleTemplate>;
}

export async function fetchPanelHistory(
  dashboardUid: string,
  panelId: number,
  fromMs: number,
  toMs: number
): Promise<PanelHistory> {
  // 12.4.12 實測：前端設定帶 `unifiedAlerting.alertStateHistoryBackend`；@grafana/runtime 的型別沒列，故走結構型別。
  const backend = (config as unknown as { unifiedAlerting?: { alertStateHistoryBackend?: unknown } }).unifiedAlerting
    ?.alertStateHistoryBackend;
  const problem = historyBackendProblem(backend);
  if (problem) {
    throw new Error(problem);
  }
  const [raw, rules] = await Promise.all([
    // showErrorAlert: false —— 讀不到時由 panel 自己寫明原因（決策 7），
    // 不要讓 Grafana 每次 refresh 都跳一個錯誤通知。
    getBackendSrv().get(
      ANNOTATIONS_ENDPOINT,
      { type: 'alert', dashboardUID: dashboardUid, panelId, from: fromMs, to: toMs, limit: HISTORY_FETCH_LIMIT },
      undefined,
      { showErrorAlert: false }
    ),
    // 樣板拿不到不算失敗：紀錄照樣列，只是沒有摘要、嚴重度改用紀錄自己的 label。
    getBackendSrv()
      .get(RULES_ENDPOINT, { dashboard_uid: dashboardUid, panel_id: panelId }, undefined, { showErrorAlert: false })
      .catch(() => null),
  ]);
  return { raw, templates: parseRuleTemplates(rules, dashboardUid, panelId) };
}
