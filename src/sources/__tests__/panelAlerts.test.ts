import { createPanelAlertSource, parseRulesResponse, type RuleDetail } from '../panelAlerts';
import { createDedup } from '../../core/dedup';
import { meetsMin } from '../../core/severity';
import { buildBroadcastPlan } from '../../core/format';

const UID = 'augur-poc';
const PANEL = 1;

/** 實測回應的形狀（見 .asp-fact-check.md）。 */
function rulesResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    data: {
      groups: [
        {
          rules: [
            {
              name: 'PocAlwaysFiring',
              state: 'firing',
              labels: { severity: 'critical' },
              annotations: { __dashboardUid__: UID, __panelId__: '1', summary: '測試用' },
              alerts: [
                {
                  state: 'Alerting',
                  labels: { alertname: 'PocAlwaysFiring', severity: 'critical' },
                  annotations: { __dashboardUid__: UID, __panelId__: '1', summary: '測試用' },
                  value: '1e+00',
                  activeAt: '2026-09-17T01:38:00Z',
                },
              ],
              ...overrides,
            },
          ],
        },
      ],
    },
  };
}

function mkSource(fetchRules: () => Promise<RuleDetail[]>, clock = { t: 1_000_000 }) {
  return createPanelAlertSource({
    panelId: PANEL,
    fetchRules,
    fallbackSeverity: 'critical',
    ruleCacheSec: 0,
    now: () => clock.t,
  });
}

const DETAIL: RuleDetail[] = [
  {
    alertname: 'PocAlwaysFiring',
    severity: 'critical',
    summary: '測試用',
    value: 1,
    activeAt: '2026-09-17T01:38:00Z',
  },
];

test('parseRulesResponse：攤平成 RuleDetail，value 的字串科學記號轉成數字', () => {
  const out = parseRulesResponse(rulesResponse(), UID, PANEL);
  expect(out).toHaveLength(1);
  expect(out[0]).toEqual({
    alertname: 'PocAlwaysFiring',
    severity: 'critical',
    summary: '測試用',
    value: 1,
    activeAt: '2026-09-17T01:38:00Z',
  });
});

test('parseRulesResponse：別的 panel 的規則要濾掉（過濾參數被忽略時的第二道防線）', () => {
  const resp = rulesResponse({ annotations: { __dashboardUid__: UID, __panelId__: '99' } });
  expect(parseRulesResponse(resp, UID, PANEL)).toHaveLength(0);
});

test('parseRulesResponse：只取 state=Alerting 的 alert，Pending 不算', () => {
  const resp = rulesResponse();
  resp.data.groups[0]!.rules[0]!.alerts[0]!.state = 'Pending';
  expect(parseRulesResponse(resp, UID, PANEL)).toHaveLength(0);
});

test('parseRulesResponse：形狀不對時回空陣列而不是丟例外', () => {
  expect(parseRulesResponse(null, UID, PANEL)).toEqual([]);
  expect(parseRulesResponse({ data: {} }, UID, PANEL)).toEqual([]);
});

test('alerting → 建立 episode；持續 alerting 回同一個事件（fingerprint 與 startsAt 不漂移）', async () => {
  const clock = { t: 1_000_000 };
  const s = mkSource(async () => DETAIL, clock);
  const first = await s.evaluate({ state: 'alerting' }, UID);
  clock.t += 30_000;
  const second = await s.evaluate({ state: 'alerting' }, UID);

  expect(first).toHaveLength(1);
  expect(first[0]!.status).toBe('firing');
  expect(first[0]!.fingerprint).toBe('alert:PocAlwaysFiring');
  expect(first[0]!.severity).toBe('critical');
  // 不變量 2：時鐘走了 30 秒，startsAt 不能跟著動。
  expect(second[0]!.startsAt).toBe(first[0]!.startsAt);
  expect(second[0]!.fingerprint).toBe(first[0]!.fingerprint);
});

test('ok → 由記住的 episode 複製出 resolved，fingerprint 與 startsAt 逐字相同', async () => {
  const s = mkSource(async () => DETAIL);
  const firing = (await s.evaluate({ state: 'alerting' }, UID))[0]!;
  const resolved = (await s.evaluate({ state: 'ok' }, UID))[0]!;

  expect(resolved.status).toBe('resolved');
  // dedup 的 resolved 綁狀態只靠 fingerprint；startsAt 一起釘住是不變量 2。
  expect(resolved.fingerprint).toBe(firing.fingerprint);
  expect(resolved.startsAt).toBe(firing.startsAt);
  expect(resolved.name).toBe(firing.name);
  expect(s.episodeCount()).toBe(0);
});

test('resolved 不帶 value —— format.ts 會把它念成「目前數值 N」，而恢復時那已不是目前', async () => {
  const s = mkSource(async () => DETAIL);
  const firing = (await s.evaluate({ state: 'alerting' }, UID))[0]!;
  const resolved = (await s.evaluate({ state: 'ok' }, UID))[0]!;

  expect(firing.value).toBe(1);
  expect(resolved).not.toHaveProperty('value');
  expect(buildBroadcastPlan(resolved, 'zh').text).not.toContain('目前數值');
});

test('沒燒過就 ok → 不產生任何事件（不會憑空報恢復）', async () => {
  const s = mkSource(async () => DETAIL);
  expect(await s.evaluate({ state: 'ok' }, UID)).toEqual([]);
});

test('pending 不產生事件 —— 先播 pending 會讓真的燒起來那一刻被 dedup 吞掉', async () => {
  const s = mkSource(async () => DETAIL);
  expect(await s.evaluate({ state: 'pending' }, UID)).toEqual([]);
  expect(s.episodeCount()).toBe(0);
});

test('未知狀態不產生事件，也不清掉既有 episode', async () => {
  const s = mkSource(async () => DETAIL);
  await s.evaluate({ state: 'alerting' }, UID);
  expect(await s.evaluate({ state: 'no_data' }, UID)).toEqual([]);
  expect(await s.evaluate(undefined, UID)).toEqual([]);
  expect(s.episodeCount()).toBe(1);
});

test('rules 端點失敗 → 仍然播泛用句，不是沉默', async () => {
  const s = mkSource(async () => {
    throw new Error('endpoint gone');
  });
  const out = await s.evaluate({ state: 'alerting' }, UID);
  expect(out).toHaveLength(1);
  expect(out[0]!.fingerprint).toBe(`alert:panel:${PANEL}`);
  expect(out[0]!.severity).toBe('critical');
});

test('多條規則綁同一個 panel → 各自獨立的 fingerprint', async () => {
  const two: RuleDetail[] = [
    { alertname: 'RuleA', severity: 'warning' },
    { alertname: 'RuleB', severity: 'critical' },
  ];
  const s = mkSource(async () => two);
  const out = await s.evaluate({ state: 'alerting' }, UID);
  expect(out.map((a) => a.fingerprint)).toEqual(['alert:RuleA', 'alert:RuleB']);
});

/**
 * 這條等價於已刪除的 `test/server.test.ts:84`。
 * 它驗的是「過濾 → 去重 → 播報」三件事在**真正的處理迴圈**裡有生效，
 * 而不是各自的單元行為 —— 那是整個專案最有價值的一條測試。
 */
test('整合：過濾 info、持續 firing 只播一次、恢復播一次、孤兒 resolved 吞掉', async () => {
  const clock = { t: 5_000_000 };
  const detail: RuleDetail[] = [
    { alertname: 'Noisy', severity: 'info' },
    { alertname: 'Real', severity: 'critical' },
  ];
  const s = mkSource(async () => detail, clock);
  const dedup = createDedup(Number.POSITIVE_INFINITY, { startCleanup: false, now: () => clock.t });

  const spoken: string[] = [];
  async function tick(state: string) {
    for (const a of await s.evaluate({ state }, UID)) {
      if (a.status === 'firing' && !meetsMin(a.severity, 'warning')) {
        continue;
      }
      if (!dedup.shouldSpeak(a)) {
        continue;
      }
      spoken.push(buildBroadcastPlan(a, 'zh').text);
    }
  }

  await tick('alerting');
  clock.t += 30_000;
  await tick('alerting'); // 持續燒：不該再念
  clock.t += 30_000;
  await tick('ok'); // 恢復：念一次
  clock.t += 30_000;
  await tick('ok'); // 孤兒 resolved：吞掉

  expect(spoken).toHaveLength(2);
  expect(spoken[0]).toContain('偵測到告警：Real');
  expect(spoken[0]).toContain('嚴重度 critical');
  expect(spoken[1]).toBe('告警已恢復：Real。');
  // info 的那條從頭到尾沒被念過
  expect(spoken.join('')).not.toContain('Noisy');
});

test('一個 panel 綁多條規則時，部分恢復要當場播報而不是等到全部恢復', async () => {
  // A5-4 把 3 條效能規則綁 panel 4、5 條安全規則綁 panel 5 之後，這條路徑才會被走到。
  // 情境：兩條同時燒 → 其中一條恢復，但 panel 的 alertState 仍是 alerting
  //（因為還有另一條在燒），所以 resolvedAll() 不會被呼叫。
  let rules: RuleDetail[] = [
    { alertname: 'WindowsAccountLockout', severity: 'critical', summary: '帳號被鎖定' },
    { alertname: 'WindowsFailedLogonBurst', severity: 'warning', summary: '連續登入失敗' },
  ];
  const src = createPanelAlertSource({
    panelId: 5,
    fetchRules: async () => rules,
    fallbackSeverity: 'critical',
    ruleCacheSec: 0,
  });
  const alerting = { state: 'alerting', panelId: 5, dashboardUID: 'd' };

  const first = await src.evaluate(alerting, 'd');
  expect(first.map((a) => a.name).sort()).toEqual(['WindowsAccountLockout', 'WindowsFailedLogonBurst']);
  expect(first.every((a) => a.status === 'firing')).toBe(true);

  // 帳號解鎖，但另一條還在燒 —— alertState 依然是 alerting
  rules = [{ alertname: 'WindowsFailedLogonBurst', severity: 'warning', summary: '連續登入失敗' }];
  const second = await src.evaluate(alerting, 'd');
  const resolved = second.filter((a) => a.status === 'resolved');
  expect(resolved).toHaveLength(1);
  expect(resolved[0]!.name).toBe('WindowsAccountLockout');
  // 恢復時不得帶 value —— 那是 firing 當時的數字，念出來是錯的
  expect(resolved[0]).not.toHaveProperty('value');
  // 還在燒的那條照常吐（抑制交給 dedup）
  expect(second.filter((a) => a.status === 'firing').map((a) => a.name)).toEqual(['WindowsFailedLogonBurst']);

  // 已恢復的那條不得再被恢復一次
  const third = await src.evaluate(alerting, 'd');
  expect(third.filter((a) => a.status === 'resolved')).toHaveLength(0);
});

test('降級路徑留下的泛用 episode 在細節回來時被取代而非「恢復」', async () => {
  let rules: RuleDetail[] = [];
  const src = createPanelAlertSource({
    panelId: 4,
    fetchRules: async () => rules,
    fallbackSeverity: 'critical',
    ruleCacheSec: 0,
  });
  const alerting = { state: 'alerting', panelId: 4, dashboardUID: 'd' };

  // rules 端點取不到 → 泛用事件
  const degraded = await src.evaluate(alerting, 'd');
  expect(degraded).toHaveLength(1);
  expect(degraded[0]!.name).toBe('告警');

  // 端點恢復了 → 拿到真細節。泛用那筆是被**取代**，不該念一句「告警 已恢復」。
  rules = [{ alertname: 'WindowsHighCPU', severity: 'warning' }];
  const recovered = await src.evaluate(alerting, 'd');
  expect(recovered.filter((a) => a.status === 'resolved')).toHaveLength(0);
  expect(recovered.map((a) => a.name)).toEqual(['WindowsHighCPU']);
});

/**
 * 迴歸：泛用 episode 被取代之後，降級路徑**不得永久靜音**。
 *
 * 上一條測的是「取代時不念『已恢復』」，它在 source 這一層就驗完了。
 * 但 source 只刪自己的 `episodes`，dedup 的 `lastFiring` 不會跟著清 ——
 * 而預設 `repeatFiringMin: 0` 會讓窗變成 `Infinity`（見 MascotPanel 的映射），
 * 於是 `t - last < Infinity` 恆真，同一個 fingerprint 再也播不出來。
 *
 * 症狀是**告警真的在燒而面板一聲不吭**，而且不留任何錯誤訊息 ——
 * 所以必須把 source 與 dedup 串起來測，只測 source 看不到這件事。
 */
test('端點恢復讓泛用 episode 被取代後，下一次降級仍然播得出來', async () => {
  const clock = { t: 1_000_000 };
  const dedup = createDedup(Number.POSITIVE_INFINITY, { startCleanup: false, now: () => clock.t });

  let endpointDown = true;
  let detail: RuleDetail[] = [];
  const src = createPanelAlertSource({
    panelId: PANEL,
    fetchRules: async () => {
      if (endpointDown) {
        throw new Error('rules endpoint down');
      }
      return detail;
    },
    fallbackSeverity: 'critical',
    ruleCacheSec: 0,
    now: () => clock.t,
    onSupersede: (fp) => dedup.forget(fp),
  });

  const spoken: string[] = [];
  const tick = async (state: string) => {
    for (const ev of await src.evaluate({ state }, UID)) {
      if (dedup.shouldSpeak(ev)) {
        spoken.push(`${ev.name}/${ev.status}`);
      }
    }
  };

  // 1) 端點掛掉而 alertState=alerting → 泛用「告警」播出，dedup 記下 alert:panel:N
  await tick('alerting');
  expect(spoken).toEqual(['告警/firing']);

  // 2) 端點恢復、拿到具名規則 → 泛用被取代（無聲），具名的播出
  endpointDown = false;
  detail = [{ alertname: 'WindowsHighCPU', severity: 'warning' }];
  clock.t += 60_000;
  await tick('alerting');
  expect(spoken).toEqual(['告警/firing', 'WindowsHighCPU/firing']);

  // 3) 全部恢復
  clock.t += 60_000;
  await tick('ok');

  // 4) 端點又掛了，而且真的有告警 —— 這一句非播不可。
  //    沒有 onSupersede → dedup 仍記著 alert:panel:N → 這裡會是沉默。
  endpointDown = true;
  clock.t += 60_000;
  await tick('alerting');
  expect(spoken.filter((s) => s === '告警/firing')).toHaveLength(2);
});
