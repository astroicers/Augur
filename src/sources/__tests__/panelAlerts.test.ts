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
  // ⚠️ `value` 一定要有。下面那條「恢復時不得帶 value」的斷言**沒有它就不可能失敗** ——
  // 實測：把 resolved 路徑的 strip 整段拿掉，17 個測試照樣全綠。
  let rules: RuleDetail[] = [
    { alertname: 'WindowsAccountLockout', severity: 'critical', summary: '帳號被鎖定', value: 3 },
    { alertname: 'WindowsFailedLogonBurst', severity: 'warning', summary: '連續登入失敗', value: 7 },
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
  // 恢復時不得帶 value —— 那是 firing 當時的數字，念出來是錯的。
  // 先確認 firing 那邊真的有 value，否則這條斷言是空的。
  expect(first.find((a) => a.name === 'WindowsAccountLockout')!.value).toBe(3);
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

/**
 * 迴歸：`ok` 之後必須清掉 rules 快取，否則會播出一個**從來沒燒過**的告警的恢復。
 *
 * ⚠️ 這條刻意用**真實的快取窗**（10 秒，production 預設）。
 * 其餘測試一律傳 `ruleCacheSec: 0`，等於快取在測試裡 100% 關閉 ——
 * 而這個缺陷只在快取真的生效時存在。
 */
test('全部恢復之後必須清掉 rules 快取（否則會念一個沒燒過的告警的恢復）', async () => {
  const clock = { t: 1_000_000 };
  const dedup = createDedup(Number.POSITIVE_INFINITY, { startCleanup: false, now: () => clock.t });
  let detail: RuleDetail[] = [{ alertname: 'A', severity: 'critical' }];
  let fetches = 0;
  const src = createPanelAlertSource({
    panelId: PANEL,
    fetchRules: async () => {
      fetches++;
      return detail;
    },
    fallbackSeverity: 'critical',
    ruleCacheSec: 10, // ← production 預設，不是 0
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

  // A 燒起來、播報
  await tick('alerting');
  expect(spoken).toEqual(['A/firing']);

  // A 恢復
  clock.t += 1_000;
  await tick('ok');
  expect(spoken).toEqual(['A/firing', 'A/resolved']);

  // 一秒後 B 燒起來（仍在 10 秒快取窗內）。
  // 沒清快取的話這一輪拿到的是含著 A 的舊清單 —— A 會被當成又燒起來。
  clock.t += 1_000;
  detail = [{ alertname: 'B', severity: 'warning' }];
  await tick('alerting');
  expect(spoken).toEqual(['A/firing', 'A/resolved', 'B/firing']);

  // 快取到期後也不該冒出一句 A 的恢復
  clock.t += 12_000;
  await tick('alerting');
  expect(spoken).toEqual(['A/firing', 'A/resolved', 'B/firing']);
});

test('降級 episode 的 severity 跟著目前的 fallbackSeverity 走 —— 調高選項救得回被過濾的告警', async () => {
  // 2026-09-29 複審：severity 在 episode 建立當下定格，於是
  // fallbackSeverity=info + minSeverity=warning 的組合下告警被濾掉，
  // 使用者調高 fallbackSeverity 也救不回來（episode 還是舊的 info）。
  let fallback = 'info';
  const src = createPanelAlertSource({
    panelId: 7,
    fetchRules: async () => {
      throw new Error('down');
    },
    fallbackSeverity: () => fallback,
  });
  const first = await src.evaluate({ state: 'alerting', panelId: 7, dashboardUID: 'd' }, 'd');
  expect(first[0]!.severity).toBe('info');

  fallback = 'critical'; // 使用者調高選項
  const second = await src.evaluate({ state: 'alerting', panelId: 7, dashboardUID: 'd' }, 'd');
  expect(second[0]!.severity).toBe('critical'); // 同一個 episode，severity 已跟上
  expect(second[0]!.fingerprint).toBe(first[0]!.fingerprint);
  // startsAt 仍然釘死在第一次 —— 跟上的只有猜測值，不是事實欄位。
  expect(second[0]!.startsAt).toBe(first[0]!.startsAt);
});

// ---------------------------------------------------------------------------
// #69：以指定 label 當告警名與去重 key
//
// 實測依據（eks-infra#1210）：一條 Grafana 總規則查值班牆的
// `ALERTS{alertstate="firing"}`，Grafana 用**規則名覆蓋**每個 instance 的 `alertname`，
// 原名由 `label_replace(…, "wall_alertname", "$1", "alertname", "(.*)")` 留在 instance label。
//
// 這一段的 source 測試刻意讓假 fetcher **跑真的 `parseRulesResponse`**：選項要經過
// 「source 讀選項 → 帶給 fetcher → 解析時取名 → fingerprint」整條路才算接通，
// 直接餵 `RuleDetail[]` 的話把這條線接錯了測試照樣綠。
// ---------------------------------------------------------------------------

/** 值班牆的形狀：一條總規則、兩個 firing instance，alertname 都被規則名蓋掉。 */
function wallResponse(alerts?: unknown[]) {
  return {
    data: {
      groups: [
        {
          rules: [
            {
              name: 'OncallWall',
              state: 'firing',
              labels: { severity: 'warning' },
              annotations: { __dashboardUid__: UID, __panelId__: String(PANEL), summary: '總規則的摘要' },
              alerts: alerts ?? [
                {
                  state: 'Alerting',
                  labels: { alertname: 'OncallWall', wall_alertname: 'Watchdog', severity: 'info' },
                  annotations: { summary: '看門狗還活著' },
                  value: '1e+00',
                  activeAt: '2026-10-15T01:00:00Z',
                },
                {
                  state: 'Alerting',
                  labels: { alertname: 'OncallWall', wall_alertname: 'KubeletTooManyPods', severity: 'critical' },
                  annotations: { summary: 'pod 數量過多' },
                  value: '2.5e+02',
                  activeAt: '2026-10-15T02:00:00Z',
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** 跑真的解析的 source：`alertNameLabel` 由 `label()` 在每一輪評估當下讀。 */
function wallSource(
  label: () => string,
  raw: () => unknown,
  clock = { t: 1_000_000 },
  onSupersede?: (fp: string) => void
) {
  return createPanelAlertSource({
    panelId: PANEL,
    fetchRules: async (uid, panelId, alertNameLabel) => parseRulesResponse(raw(), uid, panelId, alertNameLabel),
    fallbackSeverity: 'critical',
    alertNameLabel: label,
    ruleCacheSec: 0,
    now: () => clock.t,
    ...(onSupersede ? { onSupersede } : {}),
  });
}

test('#69 AC-1：留空或填 alertname 時，解析結果與沒有這個選項時逐字相同', () => {
  const baseline = parseRulesResponse(rulesResponse(), UID, PANEL);
  expect(parseRulesResponse(rulesResponse(), UID, PANEL, '')).toEqual(baseline);
  expect(parseRulesResponse(rulesResponse(), UID, PANEL, '   ')).toEqual(baseline);
  expect(parseRulesResponse(rulesResponse(), UID, PANEL, 'alertname')).toEqual(baseline);

  // 值班牆那條總規則也一樣：留空時兩個 instance 都還是規則名（也就是現行的「只念第一則」）。
  const wall = parseRulesResponse(wallResponse(), UID, PANEL);
  expect(wall.map((d) => d.alertname)).toEqual(['OncallWall', 'OncallWall']);
  expect(parseRulesResponse(wallResponse(), UID, PANEL, 'alertname')).toEqual(wall);
});

test('#69 AC-1：留空時一條總規則底下的兩則仍共用 fingerprint（本票不改這個既有語意）', async () => {
  const s = wallSource(() => '', () => wallResponse());
  const out = await s.evaluate({ state: 'alerting' }, UID);
  expect(new Set(out.map((a) => a.fingerprint))).toEqual(new Set(['alert:OncallWall']));
  expect(s.episodeCount()).toBe(1);
});

test('#69 AC-2：指定 label → 兩個 RuleDetail，severity／summary／value 各自取自該 instance', () => {
  const out = parseRulesResponse(wallResponse(), UID, PANEL, 'wall_alertname');
  expect(out).toEqual([
    {
      alertname: 'Watchdog',
      severity: 'info',
      summary: '看門狗還活著',
      value: 1,
      activeAt: '2026-10-15T01:00:00Z',
    },
    {
      alertname: 'KubeletTooManyPods',
      severity: 'critical',
      summary: 'pod 數量過多',
      value: 250,
      activeAt: '2026-10-15T02:00:00Z',
    },
  ]);
});

test('#69 AC-2：指定 label → 兩個 ParsedAlert，name 與 fingerprint 各自成立', async () => {
  const s = wallSource(() => 'wall_alertname', () => wallResponse());
  const out = await s.evaluate({ state: 'alerting' }, UID);

  expect(out).toHaveLength(2);
  expect(out.map((a) => a.name)).toEqual(['Watchdog', 'KubeletTooManyPods']);
  expect(out.map((a) => a.fingerprint)).toEqual(['alert:Watchdog', 'alert:KubeletTooManyPods']);
  // 每一則的內容都是自己那個 instance 的，不是第一個 instance 的。
  expect(out.map((a) => a.severity)).toEqual(['info', 'critical']);
  expect(out.map((a) => a.summary)).toEqual(['看門狗還活著', 'pod 數量過多']);
  expect(out.map((a) => a.value)).toEqual([1, 250]);
  // startsAt 取各自的 activeAt（不變量 2：Grafana 給的 episode 起點比本地時鐘準）。
  expect(out.map((a) => a.startsAt)).toEqual(['2026-10-15T01:00:00Z', '2026-10-15T02:00:00Z']);
  expect(s.episodeCount()).toBe(2);
});

test('#69 AC-2：選項前後的空白不算（編輯器裡貼 label 名很容易帶到空白）', () => {
  const out = parseRulesResponse(wallResponse(), UID, PANEL, '  wall_alertname  ');
  expect(out.map((d) => d.alertname)).toEqual(['Watchdog', 'KubeletTooManyPods']);
});

test('#69 AC-3：label 不存在／空字串／只有空白的 instance 退回 alertname，可與帶 label 的並存', () => {
  const out = parseRulesResponse(
    wallResponse([
      {
        state: 'Alerting',
        labels: { alertname: 'OncallWall', wall_alertname: 'Watchdog', severity: 'info' },
        annotations: {},
      },
      // label 不存在
      { state: 'Alerting', labels: { alertname: 'LegacyRule', severity: 'warning' }, annotations: {} },
      // label 是空字串
      { state: 'Alerting', labels: { alertname: 'EmptyLabel', wall_alertname: '', severity: 'warning' }, annotations: {} },
      // label 只有空白 —— 不 trim 的話名字會是空白，fingerprint 變成 `alert:   `，
      // 播報句念成「偵測到告警：」後面一片空白（#19→#30→#39→#46 同一族的缺值坑）。
      { state: 'Alerting', labels: { alertname: 'BlankLabel', wall_alertname: '   ', severity: 'warning' }, annotations: {} },
      // 連 alertname 都沒有 → 退到規則名
      { state: 'Alerting', labels: { severity: 'warning' }, annotations: {} },
    ]),
    UID,
    PANEL,
    'wall_alertname'
  );
  expect(out.map((d) => d.alertname)).toEqual([
    'Watchdog',
    'LegacyRule',
    'EmptyLabel',
    'BlankLabel',
    'OncallWall',
  ]);
});

test('#69 AC-3：label 值前後的空白會修掉（名字與 fingerprint 都不帶空白）', async () => {
  const s = wallSource(
    () => 'wall_alertname',
    () =>
      wallResponse([
        {
          state: 'Alerting',
          labels: { alertname: 'OncallWall', wall_alertname: '  Watchdog  ', severity: 'info' },
          annotations: {},
        },
      ])
  );
  const out = await s.evaluate({ state: 'alerting' }, UID);
  expect(out.map((a) => a.name)).toEqual(['Watchdog']);
  expect(out.map((a) => a.fingerprint)).toEqual(['alert:Watchdog']);
});

test('#69：不同規則底下 label 值相同時仍共用 fingerprint（key 刻意不含規則名與 panelId）', async () => {
  const two = {
    data: {
      groups: [
        {
          rules: [
            {
              name: 'WallA',
              annotations: { __dashboardUid__: UID, __panelId__: String(PANEL) },
              alerts: [
                { state: 'Alerting', labels: { wall_alertname: 'Watchdog', severity: 'warning' }, annotations: {} },
              ],
            },
            {
              name: 'WallB',
              annotations: { __dashboardUid__: UID, __panelId__: String(PANEL) },
              alerts: [
                { state: 'Alerting', labels: { wall_alertname: 'Watchdog', severity: 'critical' }, annotations: {} },
              ],
            },
          ],
        },
      ],
    },
  };
  const s = wallSource(() => 'wall_alertname', () => two);
  const out = await s.evaluate({ state: 'alerting' }, UID);
  // 兩條規則、同一個名字 → 一個 episode、一個 fingerprint（同一個告警不念兩次）。
  // 本票把 key 從規則名換成 label 值，跨規則同名合併的語意不變 —— 寫明以免日後當 bug 重開。
  expect(new Set(out.map((a) => a.fingerprint))).toEqual(new Set(['alert:Watchdog']));
  expect(s.episodeCount()).toBe(1);
});

test('#69 AC-4：兩則之中一則恢復 → 只有那一則念恢復句，另一則照舊抑制', async () => {
  const clock = { t: 1_000_000 };
  const dedup = createDedup(Number.POSITIVE_INFINITY, { startCleanup: false, now: () => clock.t });
  let raw: unknown = wallResponse();
  const s = wallSource(() => 'wall_alertname', () => raw, clock, (fp) => dedup.forget(fp));

  const spoken: string[] = [];
  const tick = async (state: string) => {
    for (const ev of await s.evaluate({ state }, UID)) {
      if (dedup.shouldSpeak(ev)) {
        spoken.push(`${ev.name}/${ev.status}`);
      }
    }
  };

  await tick('alerting');
  expect(spoken).toEqual(['Watchdog/firing', 'KubeletTooManyPods/firing']);

  // Watchdog 恢復（不再 firing），總規則仍在燒 → alertState 還是 alerting。
  clock.t += 60_000;
  raw = wallResponse([
    {
      state: 'Alerting',
      labels: { alertname: 'OncallWall', wall_alertname: 'KubeletTooManyPods', severity: 'critical' },
      annotations: { summary: 'pod 數量過多' },
    },
  ]);
  await tick('alerting');
  // 只多了 Watchdog 的恢復句；KubeletTooManyPods 照舊被 dedup 抑制。
  expect(spoken).toEqual(['Watchdog/firing', 'KubeletTooManyPods/firing', 'Watchdog/resolved']);
  expect(s.episodeCount()).toBe(1);

  // 下一輪也不得再念一次恢復
  clock.t += 60_000;
  await tick('alerting');
  expect(spoken).toHaveLength(3);
});

test('#69：改了 alertNameLabel 之後，舊 episode 算「被取代」而不是「恢復」', async () => {
  // 使用者在編輯面板裡填上 wall_alertname 的那一刻，手上的 episode 是用舊命名算的
  // fingerprint。若當成恢復，會先聽到一句「OncallWall 已恢復」—— 而告警其實一直在燒。
  const clock = { t: 1_000_000 };
  const dedup = createDedup(Number.POSITIVE_INFINITY, { startCleanup: false, now: () => clock.t });
  const forgotten: string[] = [];
  let label = '';
  const s = wallSource(
    () => label,
    () => wallResponse(),
    clock,
    (fp) => {
      forgotten.push(fp);
      dedup.forget(fp);
    }
  );

  const spoken: string[] = [];
  const tick = async (state: string) => {
    for (const ev of await s.evaluate({ state }, UID)) {
      if (dedup.shouldSpeak(ev)) {
        spoken.push(`${ev.name}/${ev.status}`);
      }
    }
  };

  await tick('alerting');
  expect(spoken).toEqual(['OncallWall/firing']);

  label = 'wall_alertname';
  clock.t += 60_000;
  await tick('alerting');
  expect(forgotten).toEqual(['alert:OncallWall']);
  expect(spoken).toEqual(['OncallWall/firing', 'Watchdog/firing', 'KubeletTooManyPods/firing']);
  expect(s.episodeCount()).toBe(2);
});

test('#69：rules 快取連 label 一起記 —— 改了選項不必等快取到期', async () => {
  // ⚠️ 用 production 預設的 10 秒快取窗（其餘 source 測試傳 0，等於把快取關掉）。
  // 不比對 label 的話，改好選項之後那 10 秒看到的還是舊命名，使用者會以為選項沒生效。
  const clock = { t: 1_000_000 };
  const seen: Array<string | undefined> = [];
  let label = '';
  const s = createPanelAlertSource({
    panelId: PANEL,
    fetchRules: async (uid, panelId, alertNameLabel) => {
      seen.push(alertNameLabel);
      return parseRulesResponse(wallResponse(), uid, panelId, alertNameLabel);
    },
    fallbackSeverity: 'critical',
    alertNameLabel: () => label,
    ruleCacheSec: 10,
    now: () => clock.t,
  });

  await s.evaluate({ state: 'alerting' }, UID);
  clock.t += 1_000; // 仍在快取窗內
  label = 'wall_alertname';
  const out = await s.evaluate({ state: 'alerting' }, UID);

  // 留空那一輪連第三個參數都不傳（AC-1：呼叫形狀與這個選項不存在時逐字相同）。
  expect(seen).toEqual([undefined, 'wall_alertname']);
  expect(out.filter((a) => a.status === 'firing').map((a) => a.name)).toEqual(['Watchdog', 'KubeletTooManyPods']);
});

// ---------------------------------------------------------------------------
// #85：換 alertNameLabel 時只重念「名字真的變了」的那幾則
//
// #69 的作法是：只要選項字串變了，就把**所有**具名 episode 當成被取代、通通忘掉，
// 下一輪整面重念一次。本票把它收斂成「以新命名的清單對帳」—— 對帳的依據就是
// 差集迴圈本來就在算的 `stillFiring`，所以沒有新的狀態要維護（`episodes` 自己
// 就是那份 fingerprint → 名字的記錄，生命週期沿用既有的）。
// ---------------------------------------------------------------------------

/**
 * 值班牆的混合形狀：一則帶 `wall_alertname`（換 label 時名字會變）、
 * 一則沒帶（換 label 時退回 `alertname`，名字**不會**變）。
 */
function mixedWallAlerts(withLegacy = true) {
  const renamed = {
    state: 'Alerting',
    labels: { alertname: 'OncallWall', wall_alertname: 'Watchdog', severity: 'info' },
    annotations: { summary: '看門狗還活著' },
  };
  const legacy = {
    state: 'Alerting',
    labels: { alertname: 'LegacyPlain', severity: 'warning' },
    annotations: { summary: '沒帶 wall_alertname 的老規則' },
  };
  return withLegacy ? [renamed, legacy] : [renamed];
}

/**
 * #85 的共用台架：真的解析（選項走完整條路）+ 真的 dedup（「有沒有重念」要由
 * dedup 回答，不是由 source 吐了幾個事件回答）。
 */
function relabelRig(label: () => string, raw: () => unknown, clock = { t: 1_000_000 }) {
  const dedup = createDedup(Number.POSITIVE_INFINITY, { startCleanup: false, now: () => clock.t });
  const forgotten: string[] = [];
  const spoken: string[] = [];
  const s = wallSource(label, raw, clock, (fp) => {
    forgotten.push(fp);
    dedup.forget(fp);
  });
  const tick = async (state = 'alerting') => {
    for (const ev of await s.evaluate({ state }, UID)) {
      if (dedup.shouldSpeak(ev)) {
        spoken.push(`${ev.name}/${ev.status}`);
      }
    }
  };
  return { s, tick, spoken, forgotten };
}

test('#85 AC-1：留空 ↔ alertname 視為沒有變化 —— 不取代、不重念，連端點都不必再打', async () => {
  const clock = { t: 1_000_000 };
  const dedup = createDedup(Number.POSITIVE_INFINITY, { startCleanup: false, now: () => clock.t });
  const forgotten: string[] = [];
  const seen: Array<string | undefined> = [];
  let label = '';
  const s = createPanelAlertSource({
    panelId: PANEL,
    fetchRules: async (uid, panelId, alertNameLabel) => {
      seen.push(alertNameLabel);
      return parseRulesResponse(wallResponse(mixedWallAlerts()), uid, panelId, alertNameLabel);
    },
    fallbackSeverity: 'critical',
    alertNameLabel: () => label,
    // ⚠️ production 預設的 10 秒快取窗：換 label 要讓快取失效（#69 已釘住），
    // 而「等價的改法」不該讓它失效 —— 否則使用者只是把 alertname 打進去就多打一次端點。
    ruleCacheSec: 10,
    now: () => clock.t,
    onSupersede: (fp) => {
      forgotten.push(fp);
      dedup.forget(fp);
    },
  });
  const spoken: string[] = [];
  const tick = async () => {
    for (const ev of await s.evaluate({ state: 'alerting' }, UID)) {
      if (dedup.shouldSpeak(ev)) {
        spoken.push(`${ev.name}/${ev.status}`);
      }
    }
  };

  await tick();
  expect(spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing']);

  // 留空 → alertname → 前後帶空白的 alertname（編輯器裡打字打到一半）→ 回到留空。
  for (const next of ['alertname', '  alertname  ', '']) {
    label = next;
    clock.t += 1_000; // 仍在快取窗內
    await tick();
  }

  expect(forgotten).toEqual([]);
  expect(spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing']); // 一句都沒多
  expect(s.episodeCount()).toBe(2);
  // 快取鍵（正規化後的 label）從頭到尾沒變 → 端點只打了第一輪那一次。
  expect(seen).toEqual([undefined]);
});

test('#85 AC-1：parseRulesResponse 填 alertname（含前後空白）與留空的結果逐字相同', () => {
  const baseline = parseRulesResponse(wallResponse(mixedWallAlerts()), UID, PANEL);
  expect(parseRulesResponse(wallResponse(mixedWallAlerts()), UID, PANEL, '  alertname  ')).toEqual(baseline);
  expect(baseline.map((d) => d.alertname)).toEqual(['OncallWall', 'LegacyPlain']);
});

test('#85 AC-2：換成別的 label → 只有名字真的變的那則被取代，名字沒變的照常延續不重念', async () => {
  const clock = { t: 1_000_000 };
  let label = '';
  const rig = relabelRig(
    () => label,
    () => wallResponse(mixedWallAlerts()),
    clock
  );

  await rig.tick();
  expect(rig.spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing']);

  label = 'wall_alertname';
  clock.t += 60_000;
  await rig.tick();

  // OncallWall → Watchdog：名字真的變了，所以舊 fingerprint 被取代。
  // LegacyPlain 沒帶那個 label、退回 alertname：名字沒變，episode 照常延續。
  expect(rig.forgotten).toEqual(['alert:OncallWall']);
  expect(rig.spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing', 'Watchdog/firing']);
  expect(rig.s.episodeCount()).toBe(2);

  // 再下一輪也不得冒出任何句子（取代是一次性的，不會每輪重做）。
  clock.t += 60_000;
  await rig.tick();
  expect(rig.spoken).toHaveLength(3);
});

test('#85 AC-3：名字變了而仍在燒的那則以新名字念一次 firing，且不念舊名字的恢復句', async () => {
  const clock = { t: 1_000_000 };
  let label = '';
  const rig = relabelRig(
    () => label,
    () => wallResponse(mixedWallAlerts()),
    clock
  );

  await rig.tick();
  label = 'wall_alertname';
  clock.t += 60_000;
  await rig.tick();

  expect(rig.spoken).toContain('Watchdog/firing');
  expect(rig.spoken.filter((s) => s.endsWith('/resolved'))).toEqual([]);
});

test('#85 AC-3：換回留空 → 名字變回來的那則重念，沒帶 label 的那則仍然不重念', async () => {
  const clock = { t: 1_000_000 };
  let label = 'wall_alertname';
  const rig = relabelRig(
    () => label,
    () => wallResponse(mixedWallAlerts()),
    clock
  );

  await rig.tick();
  expect(rig.spoken).toEqual(['Watchdog/firing', 'LegacyPlain/firing']);

  label = '';
  clock.t += 60_000;
  await rig.tick();

  expect(rig.forgotten).toEqual(['alert:Watchdog']);
  expect(rig.spoken).toEqual(['Watchdog/firing', 'LegacyPlain/firing', 'OncallWall/firing']);
  expect(rig.s.episodeCount()).toBe(2);
});

test('#85：換 label 的那一輪取不到細節時，對帳留到真的拿到新命名的清單那一輪（中間不念假的恢復句）', async () => {
  // 端點無官方穩定性保證，「換選項的那一輪剛好掛掉」是會發生的。
  // 若在偵測到換值的當下就把旗標清掉，下一輪會把舊命名的 episode 當成恢復 ——
  // 一句「OncallWall 已恢復」，而它其實一直在燒（#69 本來就要擋這件事）。
  const clock = { t: 1_000_000 };
  let label = '';
  let raw: unknown = wallResponse(mixedWallAlerts());
  const rig = relabelRig(
    () => label,
    () => raw,
    clock
  );

  await rig.tick();
  expect(rig.spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing']);

  // 換 label 的那一輪：端點回了一份看不出任何規則的東西 → 走降級路徑。
  label = 'wall_alertname';
  raw = {};
  clock.t += 60_000;
  await rig.tick();
  expect(rig.spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing', '告警/firing']);

  // 下一輪端點回來了：這才是第一份用新 label 取好名的清單，對帳在這裡發生。
  raw = wallResponse(mixedWallAlerts());
  clock.t += 60_000;
  await rig.tick();

  expect(rig.forgotten).toEqual(['alert:OncallWall', `alert:panel:${PANEL}`]);
  expect(rig.spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing', '告警/firing', 'Watchdog/firing']);
  expect(rig.spoken.filter((s) => s.endsWith('/resolved'))).toEqual([]);
});

test('#85：換 label 的同一輪剛好不再燒的那則算「被取代」、不念恢復句（已知取捨）', async () => {
  // 手上只有一份新命名的清單，分不出「它改名了」與「它恢復了」。一律當成取代 ——
  // 行為與 #69 相同（那時候整面都當成取代），代價是少念那一句恢復。
  const clock = { t: 1_000_000 };
  let label = '';
  let raw: unknown = wallResponse(mixedWallAlerts());
  const rig = relabelRig(
    () => label,
    () => raw,
    clock
  );

  await rig.tick();
  expect(rig.spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing']);

  // 換 label 的同一輪，LegacyPlain 剛好恢復了（總規則仍在燒 → alertState 還是 alerting）。
  label = 'wall_alertname';
  raw = wallResponse(mixedWallAlerts(false));
  clock.t += 60_000;
  await rig.tick();

  expect(rig.forgotten).toEqual(['alert:OncallWall', 'alert:LegacyPlain']);
  expect(rig.spoken).toEqual(['OncallWall/firing', 'LegacyPlain/firing', 'Watchdog/firing']);
  expect(rig.s.episodeCount()).toBe(1);

  // 對照組：沒換 label 的那一輪，不再燒的那則照常念恢復（取捨只發生在換 label 的那一輪）。
  raw = wallResponse([
    {
      state: 'Alerting',
      labels: { alertname: 'OncallWall', wall_alertname: 'KubeletTooManyPods', severity: 'critical' },
      annotations: { summary: 'pod 數量過多' },
    },
  ]);
  clock.t += 60_000;
  await rig.tick();
  expect(rig.spoken).toEqual([
    'OncallWall/firing',
    'LegacyPlain/firing',
    'Watchdog/firing',
    'KubeletTooManyPods/firing',
    'Watchdog/resolved',
  ]);
});
