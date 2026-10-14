import {
  DASHBOARD_UID_ANNOTATION,
  PANEL_ID_ANNOTATION,
  boundToPanel,
  panelRulerRulesOf,
  panelRulesOf,
} from '../panelRules';
import { parseRuleTemplates, parseRulerConditions } from '../history';
import { parseRulesResponse } from '../panelAlerts';

const DASH = 'augur-poc';
const PANEL = 1;

/** 綁在本 panel 的註解。 */
const BOUND = { [DASHBOARD_UID_ANNOTATION]: DASH, [PANEL_ID_ANNOTATION]: '1' };
const OTHER_PANEL = { [DASHBOARD_UID_ANNOTATION]: DASH, [PANEL_ID_ANNOTATION]: '9' };

describe('boundToPanel', () => {
  test('兩個標籤都對才算綁在本 panel；panelId 在註解裡是字串', () => {
    expect(boundToPanel(BOUND, DASH, PANEL)).toBe(true);
    expect(boundToPanel(OTHER_PANEL, DASH, PANEL)).toBe(false);
    expect(boundToPanel(BOUND, 'another-dash', PANEL)).toBe(false);
  });

  test('缺註解不算綁定（不是「沒寫就通過」）', () => {
    expect(boundToPanel({}, DASH, PANEL)).toBe(false);
    expect(boundToPanel({ [DASHBOARD_UID_ANNOTATION]: DASH }, DASH, PANEL)).toBe(false);
    expect(boundToPanel({ [PANEL_ID_ANNOTATION]: '1' }, DASH, PANEL)).toBe(false);
  });
});

describe('panelRulesOf（Prometheus rules 端點形狀）', () => {
  function raw() {
    return {
      data: {
        groups: [
          {
            rules: [
              { name: 'Mine', annotations: { ...BOUND, summary: 's' } },
              { name: 'Theirs', annotations: OTHER_PANEL },
            ],
          },
          { rules: [{ name: 'MineToo', annotations: BOUND }] },
        ],
      },
    };
  }

  test('跨 group 收齊綁在本 panel 的規則，別的 panel 的濾掉', () => {
    const got = [...panelRulesOf<{ name?: string }>(raw(), DASH, PANEL)];
    expect(got.map((p) => p.rule.name)).toEqual(['Mine', 'MineToo']);
  });

  test('annotations 一併吐出，缺就是空物件（呼叫端不必再 ?? 一次）', () => {
    const got = [...panelRulesOf<{ name?: string }>(raw(), DASH, PANEL)];
    expect(got[0]!.annotations['summary']).toBe('s');
    expect(got[1]!.annotations).toEqual(BOUND);
    expect([...panelRulesOf({ data: { groups: [{ rules: [{ name: 'x' }] }] } }, DASH, PANEL)]).toEqual([]);
  });

  test('形狀不對一律跳過而不丟例外', () => {
    for (const bad of [null, undefined, 42, 'x', {}, { data: {} }, { data: { groups: null } }]) {
      expect([...panelRulesOf(bad, DASH, PANEL)]).toEqual([]);
    }
    const mixed = { data: { groups: [null, 7, { rules: null }, { rules: [null, { annotations: BOUND }] }] } };
    expect([...panelRulesOf(mixed, DASH, PANEL)]).toHaveLength(1);
  });

  test('是惰性走訪：只取第一條時不會碰到後面的 group', () => {
    // 第二個 group 的 rules 做成 getter —— 被讀到才算「攤平到那裡了」。
    let touchedSecondGroup = false;
    const lazyRaw = {
      data: {
        groups: [
          { rules: [{ name: 'Mine', annotations: BOUND }] },
          {
            get rules() {
              touchedSecondGroup = true;
              return [{ name: 'MineToo', annotations: BOUND }];
            },
          },
        ],
      },
    };

    const it = panelRulesOf<{ name?: string }>(lazyRaw, DASH, PANEL);
    expect(it.next().value).toMatchObject({ rule: { name: 'Mine' } });
    expect(touchedSecondGroup).toBe(false);

    // 繼續走才碰到後面 —— 證明上面的 false 不是「永遠不走第二個 group」。
    expect(it.next().value).toMatchObject({ rule: { name: 'MineToo' } });
    expect(touchedSecondGroup).toBe(true);
  });
});

describe('panelRulerRulesOf（ruler API 形狀）', () => {
  const raw = {
    'Augur Mascot': [
      { name: 'g', rules: [{ annotations: BOUND, grafana_alert: { title: 'A' } }, { annotations: OTHER_PANEL }] },
    ],
    Other: [{ rules: [{ annotations: BOUND, grafana_alert: { title: 'B' } }] }],
  };

  test('外層是資料夾名為鍵的物件，跨資料夾收齊', () => {
    const got = [...panelRulerRulesOf<{ grafana_alert?: { title?: string } }>(raw, DASH, PANEL)];
    expect(got.map((p) => p.rule.grafana_alert?.title)).toEqual(['A', 'B']);
  });

  test('形狀不對一律回空', () => {
    for (const bad of [null, undefined, 'x', 7, {}, { folder: null }]) {
      expect([...panelRulerRulesOf(bad, DASH, PANEL)]).toEqual([]);
    }
  });
});

/**
 * 合併的理由就是這條：Grafana 改過一次 `dashboardUID` 的欄位名，而當時比對寫了三份。
 * 現在三個 parser 共用同一個比對點，所以「換成別的 panel」必須三個同時失準 ——
 * 不會有某一份偷偷漏改還是收得到東西的情況。
 */
test('三個 parser 共用同一個綁定比對：換成別的 panel 一起收不到', () => {
  const promRaw = {
    data: {
      groups: [
        {
          rules: [
            {
              name: 'Probe',
              labels: { severity: 'critical' },
              annotations: { ...BOUND, summary: 's' },
              alerts: [{ state: 'Alerting', labels: { alertname: 'Probe', severity: 'critical' } }],
            },
          ],
        },
      ],
    },
  };
  const rulerRaw = { f: [{ rules: [{ annotations: BOUND, grafana_alert: { title: 'Probe', condition: 'C' } }] }] };

  expect(parseRulesResponse(promRaw, DASH, PANEL)).toHaveLength(1);
  expect(parseRuleTemplates(promRaw, DASH, PANEL).size).toBe(1);
  expect(parseRulerConditions(rulerRaw, DASH, PANEL).size).toBe(1);

  const OTHER = 9;
  expect(parseRulesResponse(promRaw, DASH, OTHER)).toHaveLength(0);
  expect(parseRuleTemplates(promRaw, DASH, OTHER).size).toBe(0);
  expect(parseRulerConditions(rulerRaw, DASH, OTHER).size).toBe(0);
});
