/**
 * `RulesFetcher` 的正式實作 —— 打 Grafana 的 Alerting rules 端點。
 *
 * 獨立成一支是為了讓 `panelAlerts.ts` 不必 import `@grafana/runtime`：
 * 那支的邏輯要能在 jest 裡以注入的假 fetcher 測，不該拖進 Grafana runtime。
 *
 * ⚠️ 這個端點**無官方文件保證穩定性**（`.asp-fact-check.md` 標中高風險）。
 * Grafana 自己的 Alerting UI 在用它，而且我們實測過確切的 payload 形狀，
 * 但它壞掉是預期內的一種結果 —— 呼叫端有泛用句降級路徑。
 */
import { getBackendSrv } from '@grafana/runtime';
import { parseRulesResponse, type RuleDetail, type RulesFetcher } from './panelAlerts';

export const RULES_ENDPOINT = '/api/prometheus/grafana/api/v1/rules';

export const fetchPanelRules: RulesFetcher = async (
  dashboardUid: string,
  panelId: number
): Promise<RuleDetail[]> => {
  // 實測 dashboard_uid + panel_id 過濾有效（全庫 9 條縮到 1 條）。
  // parseRulesResponse 仍會再比對一次註解 —— 過濾參數若被忽略，
  // 我們會把整個 dashboard 的告警都念出來。
  const raw = await getBackendSrv().get(RULES_ENDPOINT, {
    dashboard_uid: dashboardUid,
    panel_id: panelId,
  });
  return parseRulesResponse(raw, dashboardUid, panelId);
};
