/**
 * `fetchPanelHistory` 的接線測試（複審 L4：原本零測試）。只 mock `@grafana/runtime` 這個邊界。
 */
import { fetchPanelHistory, ANNOTATIONS_ENDPOINT, RULER_ENDPOINT } from '../historyFetcher';
import { RULES_ENDPOINT } from '../rulesFetcher';
import { HISTORY_FETCH_LIMIT } from '../history';

const mockGet = jest.fn();
const mockConfig: { unifiedAlerting?: unknown } = {};

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ get: mockGet }),
  get config() {
    return mockConfig;
  },
}));

const DASH = 'augur-mascot-trial';

const RULES = {
  data: {
    groups: [
      {
        rules: [
          {
            name: 'ThresholdProbe',
            labels: { severity: 'warning' },
            annotations: { summary: '{{ $labels.pod }} 門檻測試', __dashboardUid__: DASH, __panelId__: '1' },
          },
        ],
      },
    ],
  },
};
const RULER = {
  'Augur Mascot': [
    {
      name: 'g',
      rules: [
        { annotations: { __dashboardUid__: DASH, __panelId__: '1' }, grafana_alert: { title: 'ThresholdProbe', condition: 'C' } },
      ],
    },
  ],
};

function route(over: Partial<Record<string, () => unknown>> = {}) {
  mockGet.mockImplementation(async (url: string) => {
    const h = over[url];
    if (h) {
      return h();
    }
    if (url === ANNOTATIONS_ENDPOINT) {
      return [];
    }
    if (url === RULES_ENDPOINT) {
      return RULES;
    }
    if (url === RULER_ENDPOINT) {
      return RULER;
    }
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  mockGet.mockReset();
  mockConfig.unifiedAlerting = { stateHistory: { backend: 'annotations' } };
});

test('backend 是 loki：先報原因，而且一個請求都不發', async () => {
  mockConfig.unifiedAlerting = { stateHistory: { backend: 'loki' } };
  route();
  await expect(fetchPanelHistory(DASH, 1, 1000, 2000)).rejects.toThrow('loki');
  expect(mockGet).not.toHaveBeenCalled();
});

test('讀紀錄的參數：type=alert、dashboardUID、panelId、時間範圍、上限；且不讓 Grafana 跳錯誤通知', async () => {
  route();
  await fetchPanelHistory(DASH, 1, 1000, 2000);
  expect(mockGet).toHaveBeenCalledWith(
    ANNOTATIONS_ENDPOINT,
    { type: 'alert', dashboardUID: DASH, panelId: 1, from: 1000, to: 2000, limit: HISTORY_FETCH_LIMIT },
    undefined,
    { showErrorAlert: false }
  );
});

test('樣板來自 rules 端點，條件欄來自 ruler，兩者併在一起', async () => {
  route();
  const h = await fetchPanelHistory(DASH, 1, 1000, 2000);
  expect(h.templates.get('ThresholdProbe')).toEqual({
    severity: 'warning',
    summary: '{{ $labels.pod }} 門檻測試',
    ruleLabels: ['severity'],
    condition: 'C',
  });
});

test('rules 端點與 ruler 都讀不到：紀錄照樣回來，只是沒有樣板（不當成整體失敗）', async () => {
  route({
    [RULES_ENDPOINT]: () => Promise.reject(new Error('403')),
    [RULER_ENDPOINT]: () => Promise.reject(new Error('403')),
  });
  const h = await fetchPanelHistory(DASH, 1, 1000, 2000);
  expect(h.raw).toEqual([]);
  expect(h.templates.size).toBe(0);
});

test('紀錄本身讀不到：整體失敗（panel 據此可見地降級）', async () => {
  route({ [ANNOTATIONS_ENDPOINT]: () => Promise.reject(new Error('500')) });
  await expect(fetchPanelHistory(DASH, 1, 1000, 2000)).rejects.toThrow('500');
});
