/**
 * `fetchPanelRules` 的接線測試。只 mock `@grafana/runtime` 這個邊界。
 *
 * **為什麼需要這一支**（#69）：端點（本檔）與解析（`panelAlerts.ts` 的
 * `parseRulesResponse`）分住兩支檔，而「用哪個 label 當告警名」這個參數是**選填**的 ——
 * 中間少傳一個就不會讓 `npm run typecheck` 變紅，症狀是使用者設了選項卻完全沒反應
 * （面板照舊只念第一則）。那條線只有在這一層串起來測才看得到。
 */
import { fetchPanelRules, RULES_ENDPOINT } from '../rulesFetcher';

const mockGet = jest.fn();
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ get: mockGet }),
}));

const DASH = 'augur-poc';
const PANEL = 1;

/** 值班牆的形狀：一條總規則、兩個 firing instance，alertname 都被規則名蓋掉（eks-infra#1210）。 */
const WALL = {
  data: {
    groups: [
      {
        rules: [
          {
            name: 'OncallWall',
            annotations: { __dashboardUid__: DASH, __panelId__: String(PANEL) },
            alerts: [
              {
                state: 'Alerting',
                labels: { alertname: 'OncallWall', wall_alertname: 'Watchdog', severity: 'warning' },
                annotations: {},
              },
              {
                state: 'Alerting',
                labels: { alertname: 'OncallWall', wall_alertname: 'KubeletTooManyPods', severity: 'critical' },
                annotations: {},
              },
            ],
          },
        ],
      },
    ],
  },
};

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockResolvedValue(WALL);
});

test('打的是 rules 端點，且帶 dashboard_uid 與 panel_id 兩個過濾參數', async () => {
  await fetchPanelRules(DASH, PANEL);
  expect(mockGet).toHaveBeenCalledWith(RULES_ENDPOINT, { dashboard_uid: DASH, panel_id: PANEL });
});

test('不給 alertNameLabel → 名字照舊取 alertname（兩則都是被覆蓋的規則名）', async () => {
  expect((await fetchPanelRules(DASH, PANEL)).map((d) => d.alertname)).toEqual(['OncallWall', 'OncallWall']);
});

test('#69：alertNameLabel 要一路傳到解析 —— 這個參數不進查詢字串，只影響取名', async () => {
  const out = await fetchPanelRules(DASH, PANEL, 'wall_alertname');
  expect(out.map((d) => d.alertname)).toEqual(['Watchdog', 'KubeletTooManyPods']);
  // 端點不認得這個概念：查詢參數仍然只有兩個。
  expect(mockGet).toHaveBeenCalledWith(RULES_ENDPOINT, { dashboard_uid: DASH, panel_id: PANEL });
});
