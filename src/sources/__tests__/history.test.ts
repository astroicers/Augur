/**
 * ADR-006：播報紀錄。測資取自 2026-10-13 Grafana 12.4.12 實測回傳的形狀（ADR-006 V-2／V-4）。
 */
import { buildBroadcastPlan } from '../../core/format';
import { parseSeverityAliases } from '../../core/severityAliases';
import { createPanelAlertSource } from '../panelAlerts';
import {
  HISTORY_DISPLAY_LIMIT,
  HISTORY_FETCH_LIMIT,
  historyBackendFrom,
  historyBackendProblem,
  parseRulerConditions,
  historyToEntries,
  parseAnnotationText,
  parseRuleTemplates,
  renderSummary,
  type RuleTemplate,
} from '../history';

const DASH = 'augur-mascot-trial';
const PANEL = 1;

/** 12.4.12 實測：`<規則名> {k=v, k=v} - A=…, B=…` */
const MEM_TEXT =
  'MerakContainerMemoryHigh {alertname=MerakContainerMemoryHigh, augur_mascot=true, class=resource, container=app, env=prod, grafana_folder=Augur Mascot, namespace=merak-prod, pod=api-7f9c, severity=warning} - A=0.934211, B=0.934211';

const MEM_TEMPLATE = 'merak-prod {{ $labels.pod }}/{{ $labels.container }} 記憶體 > 90% limit（10m）';

function templates(extra: Record<string, RuleTemplate> = {}): Map<string, RuleTemplate> {
  return new Map(Object.entries({ MerakContainerMemoryHigh: { severity: 'warning', summary: MEM_TEMPLATE }, ...extra }));
}

function ann(over: Record<string, unknown>) {
  return {
    id: 1,
    alertName: 'MerakContainerMemoryHigh',
    dashboardUID: DASH,
    panelId: PANEL,
    prevState: 'Normal',
    newState: 'Alerting',
    time: Date.UTC(2026, 9, 13, 9, 0, 0),
    text: MEM_TEXT,
    data: { values: { A: 0.934211, B: 0.934211 } },
    ...over,
  };
}

describe('parseAnnotationText', () => {
  test('拆出規則名與 instance labels（label 值可以含空白）', () => {
    expect(parseAnnotationText(MEM_TEXT)).toEqual({
      title: 'MerakContainerMemoryHigh',
      labels: {
        alertname: 'MerakContainerMemoryHigh',
        augur_mascot: 'true',
        class: 'resource',
        container: 'app',
        env: 'prod',
        grafana_folder: 'Augur Mascot',
        namespace: 'merak-prod',
        pod: 'api-7f9c',
        severity: 'warning',
      },
    });
  });

  test('值區段是空的（selftest 實測：`… } - `）也拆得出來', () => {
    expect(parseAnnotationText('AugurMascotSelfTest {alertname=AugurMascotSelfTest, severity=warning} - ')?.labels).toEqual({
      alertname: 'AugurMascotSelfTest',
      severity: 'warning',
    });
  });

  test('格式不認得就回 null，不猜', () => {
    expect(parseAnnotationText('something else entirely')).toBeNull();
    expect(parseAnnotationText('Rule {not-a-pair} - A=1')).toBeNull();
  });
});

describe('renderSummary', () => {
  test('填入 {{ $labels.X }}（含與不含空白兩種寫法）', () => {
    expect(renderSummary(MEM_TEMPLATE, { pod: 'api-7f9c', container: 'app' })).toBe(
      'merak-prod api-7f9c/app 記憶體 > 90% limit（10m）'
    );
    expect(renderSummary('pod={{$labels.pod}}', { pod: 'p1' })).toBe('pod=p1');
  });

  test('沒有樣板語法就原樣回傳', () => {
    expect(renderSummary('純文字摘要', {})).toBe('純文字摘要');
  });

  test('{{ $value }} 不支援 —— Grafana 會渲染成 [ var=A … ] 字串，前端重現不了（ADR-006 決策 3 更正）', () => {
    expect(renderSummary('目前 {{ $value }}', {})).toBeUndefined();
  });

  test('其他 Go template 語法：不帶摘要，不猜', () => {
    expect(renderSummary('{{ if $labels.pod }}x{{ end }}', { pod: 'p' })).toBeUndefined();
  });

  /**
   * 2026-10-13 於 12.4.12 實測（LabelProbe 規則）：Grafana 渲染摘要時的 `$labels` 只有
   * 查詢結果的 label ＋ alertname ＋ grafana_folder；**規則層的 label（severity 等）與不存在的 label
   * 一律渲染成 `[no value]`**。紀錄字串裡卻全都有 —— 照填就和念出來的不一樣（G-ADR006-2 實測抓到）。
   */
  test('與 Grafana 的渲染逐字相同：規則層 label 與缺的 label 填 [no value]', () => {
    const tpl =
      'an={{ $labels.alertname }}|sev={{ $labels.severity }}|folder={{ $labels.grafana_folder }}|am={{ $labels.augur_mascot }}|pod={{ $labels.pod }}|none={{ $labels.nonexistent }}';
    const instance = { alertname: 'LabelProbe', augur_mascot: 'true', grafana_folder: 'Augur Mascot', pod: 'pod-xyz', severity: 'warning' };
    expect(renderSummary(tpl, instance, ['augur_mascot', 'severity'])).toBe(
      'an=LabelProbe|sev=[no value]|folder=Augur Mascot|am=[no value]|pod=pod-xyz|none=[no value]'
    );
  });
});

describe('parseRuleTemplates', () => {
  test('取 rule-level 的嚴重度與摘要樣板，只收綁在本 panel 的規則（含沒在燒的）', () => {
    const raw = {
      data: {
        groups: [
          {
            rules: [
              {
                name: 'MerakContainerMemoryHigh',
                labels: { severity: 'warning' },
                annotations: { summary: MEM_TEMPLATE, __dashboardUid__: DASH, __panelId__: '1' },
                alerts: [],
              },
              {
                name: 'OtherPanelRule',
                labels: { severity: 'critical' },
                annotations: { summary: 'x', __dashboardUid__: DASH, __panelId__: '9' },
              },
            ],
          },
        ],
      },
    };
    expect(parseRuleTemplates(raw, DASH, PANEL)).toEqual(
      new Map([['MerakContainerMemoryHigh', { severity: 'warning', summary: MEM_TEMPLATE, ruleLabels: ['severity'] }]])
    );
  });
});

describe('historyToEntries', () => {
  const opts = { minSeverity: '', lang: 'zh' as const };

  test('→ Alerting 是「偵測到」：規則名、嚴重度、A 的數值、填好的摘要', () => {
    const [e] = historyToEntries([ann({})], templates(), opts).entries;
    expect(e!.text).toBe(
      '偵測到告警：MerakContainerMemoryHigh，嚴重度 warning，目前數值 0.93，merak-prod api-7f9c/app 記憶體 > 90% limit（10m）。'
    );
    expect(e!.time).toBe(Date.UTC(2026, 9, 13, 9, 0, 0));
  });

  test('Alerting → Normal (NoData) 是「已恢復」，不帶數值（恢復時那已不是「目前」）', () => {
    const [e] = historyToEntries([ann({ prevState: 'Alerting', newState: 'Normal (NoData)' })], templates(), opts).entries;
    expect(e!.text).toBe('告警已恢復：MerakContainerMemoryHigh，merak-prod api-7f9c/app 記憶體 > 90% limit（10m）。');
  });

  test('Pending、NoData↔Normal 不列 —— 吉祥物本來就不念', () => {
    const out = historyToEntries(
      [
        ann({ id: 1, prevState: 'Normal', newState: 'Pending' }),
        ann({ id: 2, prevState: 'Pending', newState: 'Normal' }),
        ann({ id: 3, prevState: 'Normal', newState: 'Normal (NoData)' }),
      ],
      templates(),
      opts
    );
    expect(out.entries).toEqual([]);
  });

  test('最低嚴重度門檻與播報一致：firing 與它的 resolved 一起被濾掉', () => {
    const out = historyToEntries(
      [ann({ id: 1 }), ann({ id: 2, prevState: 'Alerting', newState: 'Normal' })],
      templates(),
      { minSeverity: 'critical', lang: 'zh' }
    );
    expect(out.entries).toEqual([]);
  });

  test('labels 解析失敗：仍列出，只是不帶摘要；嚴重度退回規則層的值', () => {
    const [e] = historyToEntries([ann({ text: 'garbled' })], templates(), opts).entries;
    expect(e!.text).toBe('偵測到告警：MerakContainerMemoryHigh，嚴重度 warning，目前數值 0.93。');
  });

  test('摘要用到規則層 label 時照 Grafana 填 [no value]（不是紀錄裡的真值）', () => {
    const t = templates({
      MerakContainerMemoryHigh: { severity: 'warning', summary: '{{ $labels.pod }}（{{ $labels.severity }}）', ruleLabels: ['severity', 'env'] },
    });
    const [e] = historyToEntries([ann({})], t, opts).entries;
    expect(e!.text).toBe('偵測到告警：MerakContainerMemoryHigh，嚴重度 warning，目前數值 0.93，api-7f9c（[no value]）。');
  });

  test('規則已刪除（樣板查不到）：嚴重度用紀錄自己的 label，沒有摘要', () => {
    const [e] = historyToEntries([ann({})], new Map(), opts).entries;
    expect(e!.text).toBe('偵測到告警：MerakContainerMemoryHigh，嚴重度 warning，目前數值 0.93。');
  });

  test('新的在上；超過顯示上限時截斷並回報', () => {
    const many = Array.from({ length: HISTORY_DISPLAY_LIMIT + 5 }, (_, i) => ann({ id: i + 1, time: 1000 + i }));
    const out = historyToEntries(many, templates(), opts);
    expect(out.entries).toHaveLength(HISTORY_DISPLAY_LIMIT);
    expect(out.truncated).toBe('display');
    expect(out.entries[0]!.time).toBe(1000 + HISTORY_DISPLAY_LIMIT + 4);
  });

  test('搜尋字串含句子與 labels，篩選框可以用主機／pod 名找', () => {
    const [e] = historyToEntries([ann({})], templates(), opts).entries;
    expect(e!.search).toContain('api-7f9c');
    expect(e!.search).toContain('偵測到告警');
  });

  test('回應不是陣列：當成失敗丟出，讓 panel 可見地降級（ADR-006 決策 7）', () => {
    expect(() => historyToEntries({ message: 'Permission denied' }, templates(), opts)).toThrow();
  });
});

/**
 * G-ADR006-2 的單元層：**同一個事件，紀錄句與播報句逐字相同**。
 * 播報句走真的即時管線（createPanelAlertSource → buildBroadcastPlan），
 * rules 端點給的是 Grafana 渲染好的摘要；紀錄句則由樣板＋紀錄 labels 在前端填。
 */
test('紀錄句與播報句逐字相同（firing 與 resolved）', async () => {
  const rendered = 'merak-prod api-7f9c/app 記憶體 > 90% limit（10m）';
  const source = createPanelAlertSource({
    panelId: PANEL,
    fallbackSeverity: 'critical',
    ruleCacheSec: 0,
    fetchRules: async () => [
      { alertname: 'MerakContainerMemoryHigh', severity: 'warning', summary: rendered, value: 0.934211 },
    ],
  });
  const [liveFiring] = await source.evaluate({ state: 'alerting' }, DASH);
  const [liveResolved] = await source.evaluate({ state: 'ok' }, DASH);

  const hist = historyToEntries(
    [ann({ id: 2, time: 2, prevState: 'Alerting', newState: 'Normal (NoData)' }), ann({ id: 1, time: 1 })],
    templates(),
    { minSeverity: '', lang: 'zh' }
  ).entries;

  expect(hist.map((e) => e.text)).toEqual([
    buildBroadcastPlan(liveResolved!, 'zh').text,
    buildBroadcastPlan(liveFiring!, 'zh').text,
  ]);
});

/**
 * ADR-006 決策 7：backend 不是 annotations 時，`/api/annotations` 回的是**空清單**而不是錯誤 ——
 * 不先檢查的話，panel 會把「歷史存在別處」顯示成「這段時間沒有紀錄」，那是靜默失效。
 * backend 取自前端設定 `unifiedAlerting.alertStateHistoryBackend`（12.4.12 實測存在、Viewer 可讀）。
 */
describe('historyBackendProblem', () => {
  test('annotations 與 multiple 讀得到；設定不存在（較舊版本）時不擋', () => {
    expect(historyBackendProblem('annotations')).toBeNull();
    expect(historyBackendProblem('multiple')).toBeNull();
    expect(historyBackendProblem(undefined)).toBeNull();
  });

  test('loki、prometheus 等其他 backend：回報原因並點名 backend', () => {
    expect(historyBackendProblem('loki')).toContain('loki');
    expect(historyBackendProblem('prometheus')).toContain('prometheus');
  });
});

describe('複審修正（reality-checker 2026-10-13）', () => {
  const opts = { minSeverity: '', lang: 'zh' as const };

  /**
   * M1（12.4.12 實測）：rules 端點的 `alerts[].value` 是**條件那一欄**的值。條件是 C（reduce→threshold）時
   * 念的是「目前數值 1」，紀錄若取 A（0.93）就對不上。條件欄名取自 ruler API。
   */
  test('數值取條件那一欄（C），不是 A', () => {
    const t = templates({ MerakContainerMemoryHigh: { severity: 'warning', summary: MEM_TEMPLATE, condition: 'C' } });
    const [e] = historyToEntries([ann({ data: { values: { A: 0.934211, B: 0.934211, C: 1 } } })], t, opts).entries;
    expect(e!.text).toContain('目前數值 1，');
  });

  test('不知道條件欄、各欄數值又不同時不念數值（寧缺勿錯）；各欄相同時照用', () => {
    const differing = historyToEntries([ann({ data: { values: { A: 0.93, C: 1 } } })], templates(), opts).entries[0]!;
    expect(differing.text).not.toContain('目前數值');
    const same = historyToEntries([ann({ data: { values: { A: 0.93, B: 0.93 } } })], templates(), opts).entries[0]!;
    expect(same.text).toContain('目前數值 0.93');
  });

  test('只換 reason 的 Alerting (NoData)→Alerting 不是新的「偵測到」', () => {
    const out = historyToEntries([ann({ prevState: 'Alerting (NoData)', newState: 'Alerting' })], templates(), opts);
    expect(out.entries).toEqual([]);
  });

  test('Recovering→Normal（keep_firing_for）是「已恢復」', () => {
    const [e] = historyToEntries([ann({ prevState: 'Recovering', newState: 'Normal' })], templates(), opts).entries;
    expect(e!.text.startsWith('告警已恢復：')).toBe(true);
  });

  test('嚴重度：紀錄自己的 label 優先於規則層（與播報端 instance labels 優先一致）', () => {
    const t = templates({ MerakContainerMemoryHigh: { severity: 'critical', summary: MEM_TEMPLATE } });
    const [e] = historyToEntries([ann({})], t, opts).entries;
    expect(e!.text).toContain('嚴重度 warning');
  });

  test('原始紀錄拿滿上限時，截斷原因是 fetch（不是「只顯示 200 條」）', () => {
    const raw = Array.from({ length: HISTORY_FETCH_LIMIT }, (_, i) => ann({ id: i, newState: 'Pending' }));
    raw[0] = ann({ id: 999999 });
    const out = historyToEntries(raw, templates(), opts);
    expect(out.entries).toHaveLength(1);
    expect(out.truncated).toBe('fetch');
  });

  test('沒有截斷時是 null', () => {
    expect(historyToEntries([ann({})], templates(), opts).truncated).toBeNull();
  });
});

/** M2：`alertStateHistoryBackend` 在 @grafana/data 型別裡已被標為棄用，優先讀 `stateHistory.backend`。 */
describe('historyBackendFrom', () => {
  test('優先 stateHistory.backend，退回已棄用的 alertStateHistoryBackend', () => {
    expect(historyBackendFrom({ stateHistory: { backend: 'loki' }, alertStateHistoryBackend: 'annotations' })).toBe('loki');
    expect(historyBackendFrom({ alertStateHistoryBackend: 'loki' })).toBe('loki');
    expect(historyBackendFrom(undefined)).toBeUndefined();
  });
});

describe('parseRulerConditions', () => {
  test('取綁在本 panel 的規則的條件欄名（ruler API 形狀，12.4.12 實測）', () => {
    const raw = {
      'Augur Mascot': [
        {
          name: 'g',
          rules: [
            { annotations: { __dashboardUid__: DASH, __panelId__: '1' }, grafana_alert: { title: 'ThresholdProbe', condition: 'C' } },
            { annotations: { __dashboardUid__: DASH, __panelId__: '9' }, grafana_alert: { title: 'Other', condition: 'B' } },
          ],
        },
      ],
    };
    expect(parseRulerConditions(raw, DASH, PANEL)).toEqual(new Map([['ThresholdProbe', 'C']]));
  });

  test('形狀不對就回空表', () => {
    expect(parseRulerConditions(null, DASH, PANEL)).toEqual(new Map());
  });
});

/**
 * #51:紀錄清單與播報吃同一張別名表。兩邊判得不一樣的話,會出現
 * 「念過但紀錄裡沒有」(或反之)——紀錄的門檻本來就刻意與播報同一個 `meetsMin`。
 */
describe('historyToEntries 的嚴重度別名', () => {
  // severity 取自 annotation text 的 label（它贏過 template 的值），所以改那裡。
  const p1Ann = () => ann({ text: MEM_TEXT.replace('severity=warning', 'severity=P1') });

  test('沒給別名表時 P1 走 unknown,被 warning 門檻擋掉（與先前完全相同）', () => {
    const out = historyToEntries([p1Ann()], templates(), { minSeverity: 'warning', lang: 'zh' });
    expect(out.entries).toHaveLength(0);
  });

  test('給了別名表,P1 過得了門檻、表情是 critical,而句子裡還是原始 label', () => {
    const aliases = parseSeverityAliases('p1 = CRITICAL').aliases;
    const out = historyToEntries([p1Ann()], templates(), { minSeverity: 'warning', lang: 'zh', aliases });
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]!.plan.emotion).toBe('critical');
    expect(out.entries[0]!.text).toContain('嚴重度 p1');
  });
});
