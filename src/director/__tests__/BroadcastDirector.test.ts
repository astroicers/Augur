/**
 * 導播的單元測試（#58）。
 *
 * **不 render 任何東西**（AC-5）：整條管線由一個假 source 與一個假 sink 驅動，
 * 時鐘也是注入的。檔尾有一支測試機械地釘住這件事 —— 本檔與 `BroadcastDirector.ts`
 * 都不得 import `react` 或 `@testing-library/*`。
 *
 * 每一條原本靠 **effect 宣告順序**維持的導播不變量，在這裡各有一支測試
 * （AC-3；原註解的位置與對應測試名的逐條對照寫在 `.asp/pr/58.md`）。
 * `dedup` / `severity` / `severityAliases` / `format` 全部跑真的 ——
 * mock 掉它們就等於自己接線自己斷言。
 */
import * as fs from 'fs';
import * as path from 'path';

import type { BroadcastPlan, ParsedAlert } from '../../core/types';
import {
  createBroadcastDirector,
  windowSecFor,
  type BroadcastRound,
  type BroadcastSink,
  type DirectorSettings,
  type SourceHooks,
} from '../BroadcastDirector';

/** panel 預設選項那一組（`repeatFiringMin: 0` = 永不重播，窗是 Infinity）。 */
const BASE: DirectorSettings = {
  minSeverity: 'warning',
  repeatFiringMin: 0,
  fallbackSeverity: 'critical',
  alertLang: 'zh',
  severityAliasSpec: '',
};

function alert(over: Partial<ParsedAlert> = {}): ParsedAlert {
  return {
    status: 'firing',
    source: 'test',
    name: 'CPU',
    severity: 'critical',
    summary: 'CPU 過高',
    value: 93,
    startsAt: '2026-10-15T00:00:00.000Z',
    fingerprint: 'fp-cpu',
    ...over,
  };
}

interface Harness {
  /** 跑一輪：這一輪 source 要回 `alerts`，設定是 `BASE` 疊上 `over`。 */
  run(alerts: ParsedAlert[], over?: Partial<DirectorSettings>): Promise<BroadcastRound>;
  /** 交給 sink 的 plan（照交付順序）。 */
  spoken: BroadcastPlan[];
  /** source 被建立過幾次。導播不該有「只重建 source」的入口。 */
  sourceCreated(): number;
  /** 每一輪 source 讀到的 `fallbackSeverity`（評估當下才讀）。 */
  fallbackSeen: string[];
  /** 每一輪傳給 source 的兩個參數。 */
  sourceCalls: Array<{ alertState: unknown; dashboardUid: string | undefined }>;
  hooks(): SourceHooks;
  setClock(ms: number): void;
  setMuted(muted: boolean): void;
  setSink(sink: BroadcastSink | null): void;
  /** 讓下一輪的 source 卡住，回傳放開它的函式。 */
  stall(): () => void;
  dispose(): void;
}

function harness(): Harness {
  let created = 0;
  let hooks: SourceHooks | null = null;
  let queue: ParsedAlert[] = [];
  let clock = 1_000_000;
  let muted = false;
  let stalled: Promise<void> | null = null;
  const fallbackSeen: string[] = [];
  const sourceCalls: Array<{ alertState: unknown; dashboardUid: string | undefined }> = [];
  const spoken: BroadcastPlan[] = [];

  let sink: BroadcastSink | null = {
    enqueue: (plan) => void spoken.push(plan),
    pending: () => spoken.length,
  };

  const director = createBroadcastDirector({
    createSource: (h) => {
      created++;
      hooks = h;
      return {
        async evaluate(alertState, dashboardUid) {
          sourceCalls.push({ alertState, dashboardUid });
          fallbackSeen.push(h.fallbackSeverity());
          if (stalled) {
            await stalled;
          }
          return queue;
        },
      };
    },
    speaker: () => sink,
    muted: () => muted,
    now: () => clock,
  });

  return {
    run(alerts, over = {}) {
      queue = alerts;
      return director.evaluate({ alertState: { state: 'alerting' }, dashboardUid: 'dash-1' }, { ...BASE, ...over });
    },
    spoken,
    sourceCreated: () => created,
    fallbackSeen,
    sourceCalls,
    hooks: () => hooks!,
    setClock: (ms) => void (clock = ms),
    setMuted: (next) => void (muted = next),
    setSink: (next) => void (sink = next),
    stall() {
      let release!: () => void;
      stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        stalled = null;
        release();
      };
    },
    dispose: () => director.dispose(),
  };
}

const texts = (plans: BroadcastPlan[]) => plans.map((p) => p.text).join(' | ');

// ---------------------------------------------------------------------------
// 不變量 1：改設定後的下一次 evaluate 讀到的是新設定
// （原本靠「同步設定的 effect 要排在導播管線之前」維持）
// ---------------------------------------------------------------------------

test('不變量1：改門檻後的下一次 evaluate 讀到新門檻', async () => {
  const h = harness();
  // minSeverity = critical 時這則 warning 進不來。
  await h.run([alert({ severity: 'warning', fingerprint: 'fp-w' })], { minSeverity: 'critical' });
  expect(h.spoken).toHaveLength(0);

  // 同一則、同一個 fingerprint，只有門檻變了 —— 下一輪必須放行。
  await h.run([alert({ severity: 'warning', fingerprint: 'fp-w' })], { minSeverity: 'warning' });
  expect(h.spoken).toHaveLength(1);
});

test('不變量1：改別名後的下一次 evaluate，門檻與表情都套到新別名', async () => {
  const h = harness();
  await h.run([alert({ severity: 'P1', fingerprint: 'fp-p1' })]);
  expect(h.spoken).toHaveLength(0); // 沒有別名 → 排名 0 → 被 warning 門檻擋下

  await h.run([alert({ severity: 'P1', fingerprint: 'fp-p1' })], { severityAliasSpec: 'P1=critical' });
  expect(h.spoken).toHaveLength(1);
  expect(h.spoken[0]!.emotion).toBe('critical');
  // 念出來的仍是原始 label（別名只影響判斷，不改字）。
  expect(h.spoken[0]!.severity).toBe('p1');
});

test('不變量1：改語言後的下一次 evaluate 用新語言組句', async () => {
  const h = harness();
  await h.run([alert({ fingerprint: 'fp-zh' })], { alertLang: 'zh' });
  await h.run([alert({ fingerprint: 'fp-en' })], { alertLang: 'en' });
  expect(h.spoken).toHaveLength(2);
  expect(h.spoken[0]!.text).toContain('嚴重度');
  expect(h.spoken[1]!.text).toContain('severity');
});

test('不變量1：來源層讀到的 fallbackSeverity 是最近一次套用的設定', async () => {
  const h = harness();
  await h.run([], { fallbackSeverity: 'critical' });
  await h.run([], { fallbackSeverity: 'warning' });
  expect(h.fallbackSeen).toEqual(['critical', 'warning']);
});

// ---------------------------------------------------------------------------
// 不變量 2：source 與 dedup 同生同死
// （原本靠「兩個 effect 的 deps 必須一致」維持）
// ---------------------------------------------------------------------------

test('不變量2：改 fallbackSeverity 不重建來源層 —— 恢復與再次 firing 都還播得出來', async () => {
  const h = harness();
  const firing = () => alert({ fingerprint: 'fp-a' });
  const resolved = () => alert({ fingerprint: 'fp-a', status: 'resolved' });

  await h.run([firing()]);
  expect(h.spoken).toHaveLength(1);

  // 舊缺陷：改這個選項只重建 source → episodes 空了而 lastFiring 還記得
  // → resolved 不播、key 不刪 → 預設窗是 Infinity → 這個 fingerprint 從此靜音。
  await h.run([resolved()], { fallbackSeverity: 'warning' });
  expect(h.spoken).toHaveLength(2);
  expect(h.spoken[1]!.emotion).toBe('resolved');

  await h.run([firing()], { fallbackSeverity: 'warning' });
  expect(h.spoken).toHaveLength(3);
  // 來源層只被建立過一次 —— 導播沒有「只重建 source」的入口。
  expect(h.sourceCreated()).toBe(1);
});

test('不變量2：來源層的 onSupersede 接在導播自己那份去重狀態上', async () => {
  const h = harness();
  await h.run([alert({ fingerprint: 'fp-generic' })]);
  expect(h.spoken).toHaveLength(1);

  // 泛用 episode 被具名規則取代（不是恢復）：dedup 要忘掉它，否則
  // 預設窗是 Infinity → 降級路徑永久靜音。
  h.hooks().onSupersede('fp-generic');
  await h.run([alert({ fingerprint: 'fp-generic' })]);
  expect(h.spoken).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// 不變量 3：換去重視窗而不重建
// ---------------------------------------------------------------------------

test('不變量3：換去重視窗不清掉 lastFiring —— 正在燒的告警不會再念一次', async () => {
  const h = harness();
  await h.run([alert()], { repeatFiringMin: 0 });
  expect(h.spoken).toHaveLength(1);

  // 重建式實作會在這裡清掉 lastFiring → 同一則立刻被重播。
  await h.run([alert()], { repeatFiringMin: 1 });
  expect(h.spoken).toHaveLength(1);
});

test('不變量3：換窗之後新的窗真的生效（setWindow 不是空殼）', async () => {
  const h = harness();
  await h.run([alert()], { repeatFiringMin: 0 });
  expect(h.spoken).toHaveLength(1);

  await h.run([alert()], { repeatFiringMin: 1 });
  expect(h.spoken).toHaveLength(1);

  // 61 秒後：60 秒的新窗已過 → 必須重播。沒套用新窗的話窗還是 Infinity，永不重播。
  h.setClock(1_000_000 + 61_000);
  await h.run([alert()], { repeatFiringMin: 1 });
  expect(h.spoken).toHaveLength(2);
});

test('windowSecFor：0 分鐘 = 永不重播（Infinity），其餘換成秒', () => {
  expect(windowSecFor(0)).toBe(Number.POSITIVE_INFINITY);
  expect(windowSecFor(1)).toBe(60);
  expect(windowSecFor(10)).toBe(600);
});

// ---------------------------------------------------------------------------
// 不變量 4：一輪評估是原子的
// ---------------------------------------------------------------------------

test('不變量4：前一輪還沒結束時，第二次 evaluate 被擋下且不改設定', async () => {
  const h = harness();
  const release = h.stall();

  const first = h.run([alert()], { fallbackSeverity: 'critical' });
  await Promise.resolve();

  const second = await h.run([alert({ fingerprint: 'fp-other' })], { fallbackSeverity: 'warning' });
  expect(second.evaluated).toBe(false);
  expect(second.items).toHaveLength(0);
  // 被擋下的那一輪連來源層都沒碰到，更不可能把設定換掉。
  expect(h.sourceCalls).toHaveLength(1);
  expect(h.fallbackSeen).toEqual(['critical']);
  // 「不改設定」要在來源層**之後**讀到才算數：真實的 source 在 await rules() 之後才讀
  // fallbackSeverity，被擋下的那一輪若先套了設定，這裡會讀到 warning。
  expect(h.hooks().fallbackSeverity()).toBe('critical');

  release();
  const round = await first;
  expect(round.evaluated).toBe(true);
  expect(h.spoken).toHaveLength(1);
});

test('不變量4：dispose 時正在 await 的那一輪，放行後不交付、回 evaluated:false', async () => {
  // React StrictMode 會 mount → unmount → mount；panel id 改變時也會換掉導播。
  // 舊導播被 dispose 時若正停在 await，放行後不得再把結果交給（已換成新的）播報器 ——
  // 否則同一則告警會被新舊兩個導播各交付一次。
  const h = harness();
  const release = h.stall();
  const inflight = h.run([alert()]);
  await Promise.resolve();

  h.dispose();
  release();
  const round = await inflight;

  expect(round.evaluated).toBe(false);
  expect(round.items).toHaveLength(0);
  expect(h.spoken).toHaveLength(0);
});

test('不變量4：dispose 之後不再評估', async () => {
  const h = harness();
  h.dispose();
  const round = await h.run([alert()]);
  expect(round.evaluated).toBe(false);
  expect(h.sourceCalls).toHaveLength(0);
  expect(h.spoken).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 管線次序：過濾 → 防洪 → 組句
// ---------------------------------------------------------------------------

test('次序：被門檻擋下的告警不進去重狀態 —— 門檻放寬後它照樣念得出來', async () => {
  const h = harness();
  // 擋下（minSeverity = critical）。若順序反了，這一則會先被記成「播過」。
  await h.run([alert({ severity: 'warning', fingerprint: 'fp-w' })], { minSeverity: 'critical' });
  expect(h.spoken).toHaveLength(0);

  // 門檻放寬：預設窗是 Infinity，進過 dedup 的 fingerprint 從此不會出聲。
  await h.run([alert({ severity: 'warning', fingerprint: 'fp-w' })], { minSeverity: '' });
  expect(h.spoken).toHaveLength(1);
});

test('次序：被門檻擋下的告警恢復時不會冒出一句「已恢復」', async () => {
  const h = harness();
  await h.run([alert({ severity: 'info', fingerprint: 'fp-i' })], { minSeverity: 'warning' });
  await h.run([alert({ severity: 'info', fingerprint: 'fp-i', status: 'resolved' })], { minSeverity: 'warning' });
  // 使用者從來沒聽過它燒起來，就不該聽到它恢復。
  expect(h.spoken).toHaveLength(0);
});

test('次序：resolved 不受嚴重度門檻影響 —— 播過 firing 就播得到恢復', async () => {
  const h = harness();
  await h.run([alert({ severity: 'warning', fingerprint: 'fp-w' })], { minSeverity: 'warning' });
  expect(h.spoken).toHaveLength(1);

  // 門檻之後被調到 critical，那則 warning 的恢復句照樣要播。
  await h.run([alert({ severity: 'warning', fingerprint: 'fp-w', status: 'resolved' })], { minSeverity: 'critical' });
  expect(h.spoken).toHaveLength(2);
  expect(h.spoken[1]!.emotion).toBe('resolved');
});

test('次序：resolved 只念一次', async () => {
  const h = harness();
  const resolved = () => alert({ fingerprint: 'fp-a', status: 'resolved' });
  await h.run([alert({ fingerprint: 'fp-a' })]);
  await h.run([resolved()]);
  expect(h.spoken).toHaveLength(2);

  // 第二次 resolved：先前的 key 已經在播出恢復時刪掉了 —— 孤兒 resolved 吞掉。
  await h.run([resolved()]);
  expect(h.spoken).toHaveLength(2);
  expect(texts(h.spoken)).not.toMatch(/恢復.*恢復/s);
});

test('交付項目：帶著組好的 BroadcastPlan，與來源層給的同一個 ParsedAlert 物件', async () => {
  const h = harness();
  const given = alert({ severity: 'warning', fingerprint: 'fp-w' });
  const round = await h.run([given]);
  expect(round.items).toHaveLength(1);
  expect(round.items[0]!.plan.emotion).toBe('warning');
  expect(round.items[0]!.plan.text).toContain('CPU');
  // 來源事件原封不動一起帶出來（呼叫端組 feed 的 key 要用它）。
  expect(round.items[0]!.alert).toBe(given);
  expect(round.items[0]!.at).toBe(1_000_000);
});

// ---------------------------------------------------------------------------
// 交付：時間順序、靜音、沒有播報器
// ---------------------------------------------------------------------------

test('交付：一次來多則時照時間順序交付，items[0] 是最早的那一則', async () => {
  const h = harness();
  const round = await h.run([
    alert({ name: 'First', fingerprint: 'fp-1', summary: '第一則' }),
    alert({ name: 'Second', severity: 'warning', fingerprint: 'fp-2', summary: '第二則' }),
  ]);
  expect(h.spoken.map((p) => p.name)).toEqual(['First', 'Second']);
  expect(round.items[0]!.plan.name).toBe('First');
  expect(round.pending).toBe(2);
});

test('交付：靜音時照樣評估、照樣回 items，只是不交給播報器', async () => {
  const h = harness();
  h.setMuted(true);
  const round = await h.run([alert()]);
  expect(round.evaluated).toBe(true);
  expect(round.items).toHaveLength(1);
  expect(round.pending).toBeNull();
  expect(h.spoken).toHaveLength(0);
});

test('交付：這一刻沒有播報器（語音關掉）時不交付，但 items 照回', async () => {
  const h = harness();
  h.setSink(null);
  const round = await h.run([alert()]);
  expect(round.items).toHaveLength(1);
  expect(round.pending).toBeNull();
});

test('交付：本輪無事時 evaluated 為 true 而 pending 為 null', async () => {
  const h = harness();
  const round = await h.run([]);
  expect(round.evaluated).toBe(true);
  expect(round.items).toHaveLength(0);
  expect(round.pending).toBeNull();
});

test('輸入原樣交給來源層（alertState 的形狀由來源層判讀）', async () => {
  const h = harness();
  await h.run([]);
  expect(h.sourceCalls[0]).toEqual({ alertState: { state: 'alerting' }, dashboardUid: 'dash-1' });
});

// ---------------------------------------------------------------------------
// AC-1 / AC-5：不依賴 React、不碰 DOM
// ---------------------------------------------------------------------------

test('AC-1：導播不 import react、不碰 DOM', () => {
  const file = path.resolve(__dirname, '..', 'BroadcastDirector.ts');
  // 先拿掉註解：檔頭的說明會提到 react / DOM，那是散文不是相依。
  const code = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const sources = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
  expect(sources).toEqual([
    '../core/types',
    '../core/severity',
    '../core/severityAliases',
    '../core/dedup',
    '../core/format',
    '../sources/panelAlerts',
  ]);
  for (const token of [/\breact\b/i, /\bwindow\b/, /\bdocument\b/, /\bnavigator\b/, /\blocalStorage\b/]) {
    expect(code).not.toMatch(token);
  }
});

test('AC-5：導播的測試不 render React', () => {
  const code = fs.readFileSync(path.resolve(__dirname, 'BroadcastDirector.test.ts'), 'utf8');
  const sources = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
  expect(sources.filter((s) => /react|testing-library/i.test(s))).toEqual([]);
});

// ---------------------------------------------------------------------------
// 值班靜音時段（#63）—— 全部以**注入的時鐘**驅動，不必等到真的半夜。
// 時段的解析與端點規則由 `quietHours.test.ts` 單獨釘住；這一段看的是導播的交付閘門。
// ---------------------------------------------------------------------------

/** 本地時間的建構式 → 不論 jest 的 `TZ` 設成什麼，這些時刻都落在預期的那一分鐘。 */
const at = (day: number, hours: number, minutes: number) => new Date(2026, 9, day, hours, minutes).getTime();
const NIGHT = '22:00-07:00';
const LUNCH = '12:00-13:00';

test('#63 AC-2：時段內照樣回 items、pending 為 null，但一句都不交給播報器', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  const round = await h.run([alert()], { quietHours: NIGHT });
  // 語意與 ADR-007 的每瀏覽器靜音完全相同：清單與表情照常更新。
  expect(round.evaluated).toBe(true);
  expect(round.items).toHaveLength(1);
  expect(round.items[0]!.plan.emotion).toBe('critical');
  expect(round.pending).toBeNull();
  expect(h.spoken).toHaveLength(0);
});

test('#63 AC-2：時段外照常交付（同一個設定、只有時刻不同）', async () => {
  const h = harness();
  h.setClock(at(15, 12, 30));
  const round = await h.run([alert()], { quietHours: NIGHT });
  expect(h.spoken).toHaveLength(1);
  expect(round.pending).toBe(1);
});

test('#63 AC-2：跨午夜 —— 凌晨 3 點仍在 22:00-07:00 內，07:00 整就恢復出聲（終點不含）', async () => {
  const h = harness();
  h.setClock(at(16, 3, 0));
  await h.run([alert({ fingerprint: 'fp-night' })], { quietHours: NIGHT });
  expect(h.spoken).toHaveLength(0);

  h.setClock(at(16, 7, 0));
  await h.run([alert({ fingerprint: 'fp-morning' })], { quietHours: NIGHT });
  expect(h.spoken).toHaveLength(1);
});

test('#63 AC-2：不跨午夜 —— 12:00 整開始安靜，13:00 整恢復出聲（起點含、終點不含）', async () => {
  const h = harness();
  h.setClock(at(15, 12, 0));
  await h.run([alert({ fingerprint: 'fp-noon' })], { quietHours: LUNCH });
  expect(h.spoken).toHaveLength(0);

  h.setClock(at(15, 13, 0));
  await h.run([alert({ fingerprint: 'fp-after' })], { quietHours: LUNCH });
  expect(h.spoken).toHaveLength(1);
});

test('#63 AC-2：時段內的告警照樣經過 dedup —— 時段結束時不會一口氣補念出來', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  // 第一輪：過了 dedup（回得到 items），只是沒交付。
  expect((await h.run([alert()], { quietHours: NIGHT })).items).toHaveLength(1);

  // 同一則、同一個時段內再評估一次：dedup 已經把它記成「播過」。
  h.setClock(at(15, 22, 40));
  expect((await h.run([alert()], { quietHours: NIGHT })).items).toHaveLength(0);

  // 時段結束之後它還在燒：`repeatFiringMin: 0` = 永不重播 → 沒有補念，一句都沒有。
  h.setClock(at(16, 7, 30));
  const after = await h.run([alert()], { quietHours: NIGHT });
  expect(after.items).toHaveLength(0);
  expect(h.spoken).toHaveLength(0);
});

test('#63 AC-3：quietAllowCritical 開著時，時段內的 critical firing 照常交付', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  const round = await h.run([alert()], { quietHours: NIGHT, quietAllowCritical: true });
  expect(h.spoken).toHaveLength(1);
  expect(h.spoken[0]!.emotion).toBe('critical');
  expect(round.pending).toBe(1);
});

test('#63 AC-3：quietAllowCritical 開著時，同一輪的非 critical 仍然不交付（items 照回兩則）', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  const round = await h.run(
    [
      alert({ name: 'Disk', severity: 'warning', fingerprint: 'fp-w', summary: '磁碟快滿' }),
      alert({ name: 'CPU', severity: 'critical', fingerprint: 'fp-c' }),
    ],
    { quietHours: NIGHT, quietAllowCritical: true }
  );
  expect(round.items).toHaveLength(2);
  expect(h.spoken.map((p) => p.name)).toEqual(['CPU']);
});

test('#63 AC-3：quietAllowCritical 關著（預設）時，時段內的 critical 也不念', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  // BASE 沒有這個鍵（= 舊 dashboard 的 JSON），等同 false。
  await h.run([alert({ fingerprint: 'fp-a' })], { quietHours: NIGHT });
  expect(h.spoken).toHaveLength(0);

  await h.run([alert({ fingerprint: 'fp-b' })], { quietHours: NIGHT, quietAllowCritical: false });
  expect(h.spoken).toHaveLength(0);
});

test('#63 AC-3：破靜音的嚴重度判斷會套別名（P1 要有別名才破得了）', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  // minSeverity 留空 → P1 過得了門檻、進得到交付閘門；但沒有別名時它的排名是 0。
  await h.run([alert({ severity: 'P1', fingerprint: 'fp-p1' })], {
    minSeverity: '',
    quietHours: NIGHT,
    quietAllowCritical: true,
  });
  expect(h.spoken).toHaveLength(0);

  await h.run([alert({ severity: 'P1', fingerprint: 'fp-p1b' })], {
    minSeverity: '',
    quietHours: NIGHT,
    quietAllowCritical: true,
    severityAliasSpec: 'P1=critical',
  });
  expect(h.spoken).toHaveLength(1);
  // 念出來的仍是原始 label（別名只影響判斷）。
  expect(h.spoken[0]!.severity).toBe('p1');
});

test('#63 AC-3：critical 的 resolved 不破靜音 —— 時段內恢復不出聲，但 items 照回', async () => {
  const h = harness();
  // 時段外先把 firing 念出來。
  h.setClock(at(15, 12, 0));
  await h.run([alert({ fingerprint: 'fp-a' })], { quietHours: NIGHT, quietAllowCritical: true });
  expect(h.spoken).toHaveLength(1);

  // 時段內恢復：半夜只有需要有人起來處理的事才出聲，恢復不需要。
  h.setClock(at(15, 23, 0));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], {
    quietHours: NIGHT,
    quietAllowCritical: true,
  });
  expect(round.items).toHaveLength(1);
  expect(round.items[0]!.plan.emotion).toBe('resolved');
  expect(h.spoken).toHaveLength(1);
});

test('#63 AC-6：每瀏覽器靜音勝過 quietAllowCritical —— 觀看者按了靜音，critical 也不念', async () => {
  const h = harness();
  h.setMuted(true);
  h.setClock(at(15, 22, 30));
  const round = await h.run([alert()], { quietHours: NIGHT, quietAllowCritical: true });
  expect(round.items).toHaveLength(1);
  expect(h.spoken).toHaveLength(0);
});

test('#63 AC-1 / AC-4：留空或格式錯誤時照常交付（不靜音）', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  for (const [i, spec] of ['', '   ', '亂寫', '25:00-07:00', '22:00-22:00'].entries()) {
    await h.run([alert({ fingerprint: `fp-${i}` })], { quietHours: spec });
  }
  expect(h.spoken).toHaveLength(5);
});

test('#63：改時段設定後的下一次 evaluate 讀到新設定（不變量 1 的延伸）', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-a' })], { quietHours: NIGHT });
  expect(h.spoken).toHaveLength(0);

  // 同一個時刻、同一台播報器，只有設定變了 —— 解析有一格快取，換字串就要換結果。
  await h.run([alert({ fingerprint: 'fp-b' })], { quietHours: LUNCH });
  expect(h.spoken).toHaveLength(1);
  await h.run([alert({ fingerprint: 'fp-c' })], { quietHours: NIGHT });
  expect(h.spoken).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// #84：破靜音念過的 critical，恢復時也念
//
// 全部以**注入的時鐘**驅動。`ALLOW` 是「功能開著」那一組設定 ——
// 每一支都要同時設 `quietHours` 與 `quietAllowCritical`，少一個就測到別的東西。
// ---------------------------------------------------------------------------

/** 功能開著的那一組設定（#84 只在這一組底下有新行為）。 */
const ALLOW: Partial<DirectorSettings> = { quietHours: NIGHT, quietAllowCritical: true };

test('#84 AC-4：兩段時段之間一輪都沒跑 —— 昨晚念過的 critical 撐到今晚才恢復，恢復句不破今晚的靜音', async () => {
  // 清空原本只發生在「某一輪跑在時段外」：dashboard 沒開 auto-refresh、主機休眠時根本沒有那一輪。
  // 記錄帶寫入時刻、超過一段時段長度就作廢，才不靠那一輪。
  const h = harness();
  const over = { quietHours: NIGHT, quietAllowCritical: true };
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-x' })], over);
  expect(h.spoken).toHaveLength(1);
  h.setClock(at(16, 23, 0)); // 隔天晚上，中間沒有任何一輪
  const round = await h.run([alert({ fingerprint: 'fp-x', status: 'resolved' })], over);
  expect(round.items[0]!.suppressed).toBe('quiet');
  expect(h.spoken).toHaveLength(1);
});

test('#84 AC-1：同一輪裡補念的 critical firing 與它自己的恢復同時出現 —— 恢復句一樣破靜音', async () => {
  // 抖動抑制解除時補念 firing、同一輪來源層又吐出同一個 fingerprint 的 resolved：
  // 記錄要等交付後才寫，所以閘門判 resolved 時還看不到它；同一輪已放行的 firing 也要算數。
  const h = harness();
  const over = { flappingThreshold: 5, flappingWindowMin: 10, quietHours: NIGHT, quietAllowCritical: true };
  await flipRounds(h, 7, over, at(15, 22, 0)); // 第 7 輪（firing）被抖動抑制
  const before = h.spoken.length;
  h.setClock(at(15, 22, 16));
  const round = await h.run([alert({ fingerprint: 'fp-flap', status: 'resolved' })], over);
  expect(h.spoken.slice(before).map((p) => p.status)).toEqual(['firing', 'resolved']);
  expect(round.items.every((it) => it.suppressed === undefined)).toBe(true);
});

test('#84 AC-1：時段內破靜音念出的 critical，同一段時段內恢復也念得出來', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  expect(h.spoken.map((p) => p.emotion)).toEqual(['critical']);

  // 被叫醒的人聽得到結局 —— 不必起身去看螢幕。
  h.setClock(at(16, 3, 0));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken.map((p) => p.emotion)).toEqual(['critical', 'resolved']);
  expect(round.items).toHaveLength(1);
  expect(round.items[0]!.suppressed).toBeUndefined();
  expect(round.pending).toBe(2);
});

test('#84 AC-1：恢復念完就忘掉那一筆 —— 同一個 fingerprint 後來以 warning 再燒起來，恢復不念', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  h.setClock(at(15, 22, 40));
  await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(2);

  // 同一段時段、同一個 fingerprint，這次只是 warning：破不了靜音（沒人被叫醒），
  // 所以它的恢復也不該借用前一輪那筆已經結案的記錄。
  h.setClock(at(15, 22, 50));
  await h.run([alert({ fingerprint: 'fp-a', severity: 'warning' })], ALLOW);
  h.setClock(at(15, 23, 0));
  await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(2);
});

test('#84 AC-2：時段內被擋下的非 critical，恢復時照舊不念（items 照回並標 quiet）', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  await h.run([alert({ severity: 'warning', fingerprint: 'fp-w' })], ALLOW);
  expect(h.spoken).toHaveLength(0);

  h.setClock(at(15, 23, 30));
  const round = await h.run([alert({ severity: 'warning', fingerprint: 'fp-w', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(0);
  expect(round.items).toHaveLength(1);
  expect(round.items[0]!.suppressed).toBe('quiet');
  expect(round.pending).toBeNull();
});

test('#84 AC-2：firing 被擋下時功能是關的 —— 之後才打開，那一則的恢復仍然不念', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  // 功能關著：critical 的 firing 一樣不出聲，所以沒有人被叫醒。
  await h.run([alert({ fingerprint: 'fp-a' })], { quietHours: NIGHT, quietAllowCritical: false });
  expect(h.spoken).toHaveLength(0);

  h.setClock(at(15, 23, 0));
  await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(0);
});

test('#84 AC-1：記錄的鍵是**實際交付** —— 觀看者按了靜音的那台，解除後不念那句恢復', async () => {
  // ADR-007 的每瀏覽器靜音排在交付之前：這台判定得出「破得了靜音」卻一句都沒出聲，
  // 記下「念過了」的話，解除靜音後會冒出一句它從沒聽過前文的「已恢復」，
  // 而同一面牆上沒按靜音的那台行為還不一樣。
  const h = harness();
  h.setMuted(true);
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  expect(h.spoken).toHaveLength(0);

  h.setMuted(false);
  h.setClock(at(15, 23, 0));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(0);
  expect(round.items[0]!.suppressed).toBe('quiet');
});

test('#84 AC-1：記錄的鍵是**實際交付** —— 那一刻沒有播報器時同樣不記', async () => {
  const h = harness();
  h.setSink(null);
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);

  h.setSink({ enqueue: () => void 0, pending: () => 0 });
  h.setClock(at(15, 23, 0));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(round.items[0]!.suppressed).toBe('quiet');
  expect(round.pending).toBeNull();
});

test('#84 AC-2：恢復句被每瀏覽器靜音擋下 —— 那一筆通行證要消掉，後來那個破不了靜音的 episode 不借它出聲', async () => {
  // QA 回合補：寫入那一側等「實際交付」是對的，**消除**那一側等交付則會留下一筆過期的
  // 通行證。恢復句被 ADR-007 的靜音鈕擋下時它不會再回到靜音閘門（dedup 已經收下），
  // 而 fingerprint 不含 severity（來源層是 `alert:${名字}`），所以同一個名字之後那個
  // 只有 warning 的 episode 恢復時會拿它破靜音 —— 使用者聽到一句從沒聽過前文的「已恢復」。
  const h = harness();
  h.setClock(at(15, 22, 0));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  expect(h.spoken).toHaveLength(1);

  // 被叫醒的人按下標題列的靜音鈕：這一句恢復一個字都沒出聲。
  h.setMuted(true);
  h.setClock(at(15, 22, 10));
  await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(1);

  // 解除靜音；同一段時段內同一個名字再燒起來，這次只有 warning → 破不了靜音，沒人被叫醒。
  h.setMuted(false);
  h.setClock(at(15, 22, 20));
  expect((await h.run([alert({ fingerprint: 'fp-a', severity: 'warning' })], ALLOW)).items[0]!.suppressed).toBe(
    'quiet'
  );

  // 它恢復：照 AC-2 照舊不念。
  h.setClock(at(15, 22, 30));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved', severity: 'warning' })], ALLOW);
  expect(h.spoken).toHaveLength(1);
  expect(round.items[0]!.suppressed).toBe('quiet');
});

test('#84 AC-2：恢復句那一輪沒有播報器 —— 同樣消掉通行證，之後的 warning episode 恢復不念', async () => {
  const h = harness();
  h.setClock(at(15, 22, 0));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  expect(h.spoken).toHaveLength(1);

  h.setSink(null);
  h.setClock(at(15, 22, 10));
  await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);

  const spoken: BroadcastPlan[] = [];
  h.setSink({ enqueue: (plan) => void spoken.push(plan), pending: () => spoken.length });
  h.setClock(at(15, 22, 20));
  await h.run([alert({ fingerprint: 'fp-a', severity: 'warning' })], ALLOW);
  h.setClock(at(15, 22, 30));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved', severity: 'warning' })], ALLOW);
  expect(spoken).toHaveLength(0);
  expect(round.items[0]!.suppressed).toBe('quiet');
});

test('#84 AC-3：時段**外**念出的 firing，恢復落在時段內仍然不念', async () => {
  const h = harness();
  // 中午念出來：那個人沒有被吵醒，不需要在半夜被告知結局。
  h.setClock(at(15, 12, 0));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  expect(h.spoken).toHaveLength(1);

  h.setClock(at(15, 23, 0));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(1);
  expect(round.items[0]!.suppressed).toBe('quiet');
});

test('#84 AC-4：記錄不殘留到下一段時段 —— 昨晚念過的 critical，今晚才恢復時不念', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  expect(h.spoken).toHaveLength(1);

  // 白天的那一輪**沒有任何告警要播**（最常見的情形）—— 清空不能排在「這一輪無事」的早退之後。
  h.setClock(at(16, 7, 30));
  expect((await h.run([], ALLOW)).items).toHaveLength(0);

  // 隔天晚上才恢復：那是另一段時段，昨晚那次叫醒不該讓今晚出聲。
  h.setClock(at(16, 23, 0));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(1);
  expect(round.items[0]!.suppressed).toBe('quiet');
});

test('#84 AC-4：功能關掉的那一輪就清空 —— 關了再開，先前念過的那則恢復不念', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  expect(h.spoken).toHaveLength(1);

  // 同一段時段內把開關關掉再打開（編輯 dashboard）：記錄跟著那一輪清掉。
  h.setClock(at(15, 22, 40));
  await h.run([], { quietHours: NIGHT, quietAllowCritical: false });

  h.setClock(at(15, 23, 0));
  await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(1);
});

test('#84 AC-4：來源層取代 episode（onSupersede）時連記錄一起忘', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  await h.run([alert({ fingerprint: 'fp-a' })], ALLOW);
  expect(h.spoken).toHaveLength(1);

  // 取代 = 這個 fingerprint 底下換成**另一則**告警（dedup 與抖動狀態同一條路徑）。
  h.hooks().onSupersede('fp-a');

  // 新 episode 只是 warning：破不了靜音，所以它的恢復不該拿前一則 critical 當通行證。
  h.setClock(at(15, 22, 50));
  await h.run([alert({ fingerprint: 'fp-a', severity: 'warning' })], ALLOW);
  h.setClock(at(15, 23, 10));
  const round = await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], ALLOW);
  expect(h.spoken).toHaveLength(1);
  expect(round.items[0]!.suppressed).toBe('quiet');
});

test('#84 AC-4：dispose() 的本體把記錄清掉（dispose 之後導播永久擋下，只驗得到原始碼）', () => {
  // 清空本身在外面觀察不到：`dispose()` 之後每一輪都回 `BLOCKED_ROUND`，
  // 而導播不開內部狀態的後門（dedup 與抖動狀態同樣沒有）。記錄這一面的四個出口裡
  // 另外三個都有上面的行為測試；這一條只能機械比對，與檔尾那支 import 清單的測試同一種做法。
  const code = fs.readFileSync(path.resolve(__dirname, '../BroadcastDirector.ts'), 'utf8');
  const body = /dispose\(\) \{\n([\s\S]*?)\n    \},/.exec(code)?.[1] ?? '';
  // 先去掉註解：本體裡有一行註解提到 `dedup.close()`，不去掉的話刪了那個呼叫這條照樣綠。
  const live = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(live).toContain('dedup.close()');
  expect(live).toContain('quietBreaks.clear()');
});

test('#84 AC-5：quietAllowCritical 關著時，恢復側與沒有這個功能時完全相同', async () => {
  const h = harness();
  // 時段外念出 firing（照常），時段內恢復：BASE 沒有 quietAllowCritical 這個鍵。
  h.setClock(at(15, 12, 0));
  await h.run([alert({ fingerprint: 'fp-a' })], { quietHours: NIGHT });
  h.setClock(at(15, 23, 0));
  await h.run([alert({ fingerprint: 'fp-a', status: 'resolved' })], { quietHours: NIGHT });
  expect(h.spoken.map((p) => p.emotion)).toEqual(['critical']);

  // 沒設時段時整條路徑照舊：firing 與 resolved 都念。
  h.setClock(at(16, 23, 0));
  await h.run([alert({ fingerprint: 'fp-b' })], {});
  await h.run([alert({ fingerprint: 'fp-b', status: 'resolved' })], {});
  expect(h.spoken.map((p) => p.emotion)).toEqual(['critical', 'critical', 'resolved']);
});

// ---------------------------------------------------------------------------
// #71：speakValue 隨每一輪的設定帶進來（不變量 1 的同一條：設定不經 ref）

test('#71 AC-1：不帶 speakValue 的設定（既有 fixture）念出的句子含數值子句', async () => {
  const h = harness();
  await h.run([alert()]);
  expect(h.spoken[0]!.text).toContain('目前數值 93');
});

test('#71 AC-2：speakValue: false 的那一輪不念數值子句，其餘子句不變', async () => {
  const h = harness();
  await h.run([alert({ fingerprint: 'fp-on' })]);
  await h.run([alert({ fingerprint: 'fp-off' })], { speakValue: false });
  expect(h.spoken).toHaveLength(2);
  expect(h.spoken[0]!.text).toBe('偵測到告警：CPU，嚴重度 critical，目前數值 93，CPU 過高。');
  expect(h.spoken[1]!.text).toBe('偵測到告警：CPU，嚴重度 critical，CPU 過高。');
  // 撥回去的下一輪又念 —— 設定隨呼叫帶進來，沒有被記在任何 ref 裡。
  await h.run([alert({ fingerprint: 'fp-back' })], { speakValue: true });
  expect(h.spoken[2]!.text).toContain('目前數值 93');
  // plan 的 value 欄位不受影響（feed／除錯讀的是它）。
  expect(h.spoken[1]!.value).toBe(93);
});

// ---------------------------------------------------------------------------
// 告警名稱取自哪個 label（#69）—— 導播只是**原樣轉給來源層**，不解析也不判斷。
// 名字與 fingerprint 是來源層的職責（`sources/panelAlerts.ts` 的 `alertNameOf`），
// 這裡要釘住的只有一件事：來源層在**評估當下**讀到的是本輪設定帶進來的值。
// ---------------------------------------------------------------------------

test('#69：來源層讀到的 alertNameLabel 是本輪設定的值，且不必為了換它重建 source', async () => {
  const h = harness();
  await h.run([alert()], { alertNameLabel: 'wall_alertname' });
  expect(h.hooks().alertNameLabel()).toBe('wall_alertname');

  // 換值：source 不得重建（重建會清空 episodes —— 第 2 條不變量擋的就是這件事）。
  await h.run([alert()], { alertNameLabel: 'other_label' });
  expect(h.hooks().alertNameLabel()).toBe('other_label');
  expect(h.sourceCreated()).toBe(1);

  // 缺鍵（舊 dashboard 存下來的 panel JSON 沒有這一欄）= 空字串 = 照舊用 alertname。
  await h.run([alert()]);
  expect(h.hooks().alertNameLabel()).toBe('');
  h.dispose();
});

// ---------------------------------------------------------------------------
// 抖動抑制（#64）—— 同樣全部以**注入的時鐘**驅動，不必真的等 10 分鐘。
// 解析與狀態機由 `flapping.test.ts` 單獨釘住；這一段看的是導播的閘門本身，
// 以及它與 dedup、嚴重度門檻、兩種靜音的互動（AC-5 與 collaborator 留言的兩件事）。
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
/** 票文那句例子：10 分鐘內翻 4 次就先不念，穩定 10 分鐘後恢復。 */
const FLAPPING: Partial<DirectorSettings> = { flappingThreshold: 4, flappingWindowMin: 10 };

/**
 * 從 `t0` 起每分鐘餵一輪，狀態從 firing 開始交替（第 1 輪 firing、第 2 輪 resolved…），
 * 所以 `rounds` 輪 = `rounds - 1` 次翻轉。回傳每一輪的結果。
 */
async function flipRounds(
  h: Harness,
  rounds: number,
  over: Partial<DirectorSettings>,
  t0 = 1_000_000,
  alertOver: Partial<ParsedAlert> = { fingerprint: 'fp-flap' }
): Promise<BroadcastRound[]> {
  const out: BroadcastRound[] = [];
  for (let i = 0; i < rounds; i++) {
    h.setClock(t0 + i * MINUTE);
    out.push(await h.run([alert({ ...alertOver, status: i % 2 === 0 ? 'firing' : 'resolved' })], over));
  }
  return out;
}

test('#64 AC-1：門檻缺鍵、0、負數，或窗長 0（設定無效）時翻幾次就念幾次，沒有任何一則被標 suppressed', async () => {
  for (const over of [
    {}, // 舊 dashboard 的 JSON 沒有這兩個鍵
    { flappingThreshold: 0, flappingWindowMin: 10 },
    { flappingThreshold: 4, flappingWindowMin: 0 },
    { flappingThreshold: -1, flappingWindowMin: 10 },
  ]) {
    const h = harness();
    const rounds = await flipRounds(h, 6, over);
    expect(h.spoken).toHaveLength(6);
    expect(rounds.flatMap((r) => r.items).filter((item) => item.suppressed !== undefined)).toEqual([]);
  }
});

test('#64 AC-2：達到門檻之後的翻轉不交給播報器，但 items 照回並標 suppressed: flapping', async () => {
  const h = harness();
  const rounds = await flipRounds(h, 6, FLAPPING);
  // 第 4 次翻轉（第 5 輪）是最後一次出聲；第 5 次（第 6 輪）起不念。
  expect(h.spoken).toHaveLength(5);
  const last = rounds[5]!;
  expect(last.evaluated).toBe(true);
  expect(last.items).toHaveLength(1);
  expect(last.items[0]!.suppressed).toBe('flapping');
  // 清單與表情照常更新 —— 與靜音時完全相同的語意。
  expect(last.items[0]!.plan.emotion).toBe('resolved');
  expect(last.pending).toBeNull();
});

test('#64 AC-2：未達門檻時一句都不少（門檻 4、只翻 3 次）', async () => {
  const h = harness();
  const rounds = await flipRounds(h, 4, FLAPPING);
  expect(h.spoken).toHaveLength(4);
  expect(rounds.flatMap((r) => r.items).filter((item) => item.suppressed !== undefined)).toEqual([]);
});

test('#64 AC-3：穩定滿窗後解除，念的是當下的實際狀態 —— 最後其實已經恢復', async () => {
  const h = harness();
  await flipRounds(h, 6, FLAPPING); // 第 6 輪（T0+5min、resolved）起被抑制
  expect(h.spoken).toHaveLength(5);
  expect(h.spoken[4]!.status).toBe('firing'); // 抑制前最後念出去的是「還在燒」

  // 之後沒有再翻轉：resolved 的 episode 不會再有事件，所以這一輪 source 什麼都沒給 ——
  // 「等下一次狀態變化」就是永遠不念那句恢復，AC-3 末段明文禁止的事。
  h.setClock(1_000_000 + 15 * MINUTE);
  const round = await h.run([], FLAPPING);
  expect(h.spoken).toHaveLength(6);
  expect(h.spoken[5]!.status).toBe('resolved');
  expect(h.spoken[5]!.text).toContain('已恢復');
  expect(round.items).toHaveLength(1);
  expect(round.items[0]!.suppressed).toBeUndefined();
  expect(round.pending).toBe(6);
});

test('#64 AC-3 / AC-5：解除時仍在燒就念 firing，而且不被 dedup 的防洪窗擋住', async () => {
  const h = harness();
  // 門檻 5：第 5 次翻轉（第 6 輪、resolved）是達標那一次（照念），第 7 輪的 firing 被抑制 ——
  // 於是「最後念出去的是已恢復，而它其實還在燒」。
  const over = { flappingThreshold: 5, flappingWindowMin: 10 };
  const rounds = await flipRounds(h, 7, over);
  expect(h.spoken).toHaveLength(6);
  expect(h.spoken[5]!.status).toBe('resolved');
  expect(rounds[6]!.items[0]!.suppressed).toBe('flapping');

  // 它一直燒著（每輪照樣回同一則 firing）。`repeatFiringMin: 0` → dedup 的窗是 Infinity，
  // 而抑制期間那一次 firing 已經被 dedup 記成「播過」—— 沒有解除時的對帳
  // （`forget()` + 重新記），這一句會永遠不出聲（AC-5 第二項）。
  h.setClock(1_000_000 + 16 * MINUTE);
  const round = await h.run([alert({ fingerprint: 'fp-flap' })], over);
  expect(h.spoken).toHaveLength(7);
  expect(h.spoken[6]!.status).toBe('firing');
  // 同一輪不會念兩次：補念那一則已經把 dedup 重新記成「剛剛播過」。
  expect(round.items).toHaveLength(1);
});

test('#64 AC-5：被嚴重度門檻擋下的告警不計入翻轉次數', async () => {
  const h = harness();
  // warning 的 firing 被門檻擋下，它的 resolved 則因為「從沒播過 firing」被 dedup 吞掉 ——
  // 兩者都到不了抖動判斷。門檻 2 的話，翻 5 次早就該讓它閉嘴了。
  const over = { flappingThreshold: 2, flappingWindowMin: 10, minSeverity: 'critical' };
  const low: Partial<ParsedAlert> = { fingerprint: 'fp-low', severity: 'warning' };
  const rounds = await flipRounds(h, 6, over, 1_000_000, low);
  expect(h.spoken).toHaveLength(0);
  expect(rounds.flatMap((r) => r.items)).toEqual([]);

  // 門檻放寬之後的第一則照常念（翻轉次數是 0，不是 5）。
  h.setClock(1_000_000 + 6 * MINUTE);
  const after = await h.run([alert(low)], { ...over, minSeverity: '' });
  expect(h.spoken).toHaveLength(1);
  expect(after.items[0]!.suppressed).toBeUndefined();
});

test('#64 AC-5：靜音（每瀏覽器）時照樣計數 —— 解除靜音不會讓抑制失效', async () => {
  const h = harness();
  h.setMuted(true);
  const rounds = await flipRounds(h, 6, FLAPPING);
  expect(h.spoken).toHaveLength(0); // 靜音：一句都沒交付
  expect(rounds[5]!.items[0]!.suppressed).toBe('flapping'); // 但翻轉照樣計數

  h.setMuted(false);
  h.setClock(1_000_000 + 6 * MINUTE);
  const round = await h.run([alert({ fingerprint: 'fp-flap' })], FLAPPING);
  expect(round.items[0]!.suppressed).toBe('flapping');
  expect(h.spoken).toHaveLength(0);
});

test('#64：被靜音時段擋下的項目標 suppressed: quiet —— 與抖動用不同的標記', async () => {
  const h = harness();
  h.setClock(at(15, 22, 30));
  const round = await h.run([alert()], { quietHours: NIGHT });
  expect(round.items[0]!.suppressed).toBe('quiet');
  expect(h.spoken).toHaveLength(0);
});

test('#64：每瀏覽器靜音不改變 quiet 標記（標的是「落在時段內」，不是誰按了鈕）', async () => {
  const h = harness();
  h.setMuted(true);
  h.setClock(at(15, 22, 30));
  const round = await h.run([alert()], { quietHours: NIGHT });
  expect(round.items[0]!.suppressed).toBe('quiet');
  // 破得了靜音的那一則不標 quiet（它沒有被時段擋下，是被靜音鈕擋下的）。
  const breaking = await h.run([alert({ fingerprint: 'fp-c' })], { quietHours: NIGHT, quietAllowCritical: true });
  expect(breaking.items[0]!.suppressed).toBeUndefined();
  expect(h.spoken).toHaveLength(0);
});

test('#64：抖動抑制在靜音閘門之前 —— 兩者同時成立時標記是 flapping，quietAllowCritical 也救不回來', async () => {
  const h = harness();
  const over = { flappingThreshold: 5, flappingWindowMin: 10, quietHours: NIGHT, quietAllowCritical: true };
  // 22:00 起每分鐘翻一次，全程落在靜音時段內。
  const rounds = await flipRounds(h, 7, over, at(15, 22, 0));
  // critical 的 firing 破靜音（第 1／3／5 輪）；**#84 起**它們的 resolved（第 2／4／6 輪）
  // 也跟著破 —— 被叫醒的人聽得到結局，所以前六輪都出得了聲（破靜音記錄的鍵是實際交付）。
  expect(h.spoken.map((p) => p.status)).toEqual(['firing', 'resolved', 'firing', 'resolved', 'firing', 'resolved']);
  expect(rounds[5]!.items[0]!.suppressed).toBeUndefined();
  // 第 7 輪是 critical 的 firing（本來破得了靜音），但它正被抖動抑制 → 標 flapping、不出聲。
  // 這才是本支要釘的事：抖動抑制在靜音閘門之前，#84 的恢復側語意同樣越不過它。
  expect(rounds[6]!.items[0]!.alert.status).toBe('firing');
  expect(rounds[6]!.items[0]!.suppressed).toBe('flapping');
  expect(h.spoken).toHaveLength(6);
});

test('#64：抑制中的一則落在靜音時段內、而且破不了靜音 —— 標記是 flapping，不是 quiet', async () => {
  // 主管層補的要求：兩者同時成立時以 flapping 為準。這裡沒有 quietAllowCritical，
  // 所以第 7 輪若沒有被抖動抑制，本來會被靜音時段標成 quiet —— 兩個標記真的在競爭。
  const h = harness();
  const over = { flappingThreshold: 5, flappingWindowMin: 10, quietHours: NIGHT };
  const rounds = await flipRounds(h, 7, over, at(15, 22, 0));
  expect(rounds[5]!.items[0]!.suppressed).toBe('quiet');
  expect(rounds[6]!.items[0]!.suppressed).toBe('flapping');
  expect(h.spoken).toHaveLength(0);
});

test('#64：被取代的 fingerprint 連抖動狀態一起忘掉 —— 解除時不補念一則已不存在的告警', async () => {
  const h = harness();
  await flipRounds(h, 6, FLAPPING); // 第 6 輪（resolved）被抑制；抑制前最後念出去的是 firing
  expect(h.spoken).toHaveLength(5);
  // 來源層取代了這個 episode（例：降級的泛用 episode 在 rules 端點恢復後被具名告警取代）。
  h.hooks().onSupersede('fp-flap');
  h.setClock(1_000_000 + 16 * MINUTE);
  await h.run([], FLAPPING);
  expect(h.spoken).toHaveLength(5);
});

test('#64：抑制中關掉抖動抑制，而當下狀態與最後念出去的相同 —— 不補念（不重複念使用者聽過的話）', async () => {
  const h = harness();
  await flipRounds(h, 7, FLAPPING); // 第 6、7 輪被抑制；第 7 輪 firing ＝ 抑制前最後念出去的 firing
  expect(h.spoken).toHaveLength(5);
  h.setClock(1_000_000 + 7 * MINUTE);
  await h.run([alert({ fingerprint: 'fp-flap' })], { ...FLAPPING, flappingThreshold: 0 });
  expect(h.spoken).toHaveLength(5);
});

test('#64 × #71：解除抑制時補念的那一句同樣吃 speakValue —— 關了數值子句就不念數值', async () => {
  // 補念走 `deliverReleased()` 自己組句，那是 #71 寫成時還不存在的路徑；
  // 沒把 speakValue 帶進去的話，關掉數值子句後只有補念那一句仍會念出「目前數值」。
  const h = harness();
  const over = { flappingThreshold: 5, flappingWindowMin: 10, speakValue: false };
  await flipRounds(h, 7, over); // 第 7 輪（firing）被抑制；抑制前最後念出去的是 resolved
  expect(h.spoken).toHaveLength(6);
  h.setClock(1_000_000 + 16 * MINUTE);
  await h.run([], over);
  expect(h.spoken).toHaveLength(7);
  expect(h.spoken[6]!.status).toBe('firing');
  expect(h.spoken[6]!.text).toBe('偵測到告警：CPU，嚴重度 critical，CPU 過高。');
});

test('#64：抑制中（最後是 firing）被取代 —— 解除時不補念，之後同一個 fingerprint 再燒起來念得出來', async () => {
  // 來源層正常只會取代「還在 episodes 裡」的那幾則，也就是最後吐的是 firing 的那幾則。
  const h = harness();
  const over = { flappingThreshold: 5, flappingWindowMin: 10 };
  await flipRounds(h, 7, over); // 第 7 輪（firing）被抑制；抑制前最後念出去的是 resolved
  expect(h.spoken).toHaveLength(6);
  h.hooks().onSupersede('fp-flap');
  h.setClock(1_000_000 + 16 * MINUTE);
  await h.run([], over);
  expect(h.spoken).toHaveLength(6); // 不補念一則已被取代的告警
  // 沒有連抖動狀態一起忘的話，上一輪的補念會把 dedup 記回「播過 firing」，這一輪就被擋下。
  h.setClock(1_000_000 + 17 * MINUTE);
  await h.run([alert({ fingerprint: 'fp-flap' })], over);
  expect(h.spoken).toHaveLength(7);
  expect(h.spoken[6]!.status).toBe('firing');
});

test('#64：抑制中關掉抖動抑制 —— 最後仍在燒而沒念過的那一則立刻補念，不會整段燒的過程都沒聲音', async () => {
  const h = harness();
  const over = { flappingThreshold: 5, flappingWindowMin: 10 };
  await flipRounds(h, 7, over); // 第 7 輪（firing）被抑制；抑制前最後念出去的是 resolved
  expect(h.spoken).toHaveLength(6);
  h.setClock(1_000_000 + 7 * MINUTE);
  await h.run([alert({ fingerprint: 'fp-flap' })], { ...over, flappingThreshold: 0 });
  expect(h.spoken).toHaveLength(7);
  expect(h.spoken[6]!.status).toBe('firing');
});

test('#64：抑制中關掉抖動抑制 —— 最後其實已經恢復的那一則立刻補念「已恢復」', async () => {
  const h = harness();
  await flipRounds(h, 6, FLAPPING); // 第 6 輪（resolved）被抑制；抑制前最後念出去的是 firing
  expect(h.spoken).toHaveLength(5);
  h.setClock(1_000_000 + 6 * MINUTE);
  await h.run([], { ...FLAPPING, flappingThreshold: 0 });
  expect(h.spoken).toHaveLength(6);
  expect(h.spoken[5]!.status).toBe('resolved');
});

test('#64：不同 fingerprint 互不影響 —— 一則被抑制時同一輪的另一則照常交付', async () => {
  const h = harness();
  await flipRounds(h, 6, FLAPPING);
  h.setClock(1_000_000 + 6 * MINUTE);
  const round = await h.run(
    [alert({ fingerprint: 'fp-flap' }), alert({ fingerprint: 'fp-calm', name: 'Disk', summary: '磁碟快滿' })],
    FLAPPING
  );
  expect(round.items).toHaveLength(2);
  expect(round.items[0]!.suppressed).toBe('flapping');
  expect(round.items[1]!.suppressed).toBeUndefined();
  expect(h.spoken).toHaveLength(6);
  expect(h.spoken[5]!.name).toBe('Disk');
});

test('#64 AC-4：改窗長之後的下一輪就讀到新窗長（同一個時刻，只有設定不同）', async () => {
  const h = harness();
  await flipRounds(h, 6, FLAPPING); // 最後一次翻轉在 T0+5min，當下是 resolved
  h.setClock(1_000_000 + 7 * MINUTE);
  expect((await h.run([], FLAPPING)).items).toHaveLength(0); // 窗 10 分鐘：還沒穩定滿窗
  expect(h.spoken).toHaveLength(5);

  const released = await h.run([], { ...FLAPPING, flappingWindowMin: 1 }); // 窗 1 分鐘：已滿窗
  expect(released.items).toHaveLength(1);
  expect(h.spoken).toHaveLength(6);
  expect(h.spoken[5]!.status).toBe('resolved');
});

test('#64 AC-4：改門檻之後的下一輪就讀到新門檻', async () => {
  const h = harness();
  const loose = { flappingThreshold: 10, flappingWindowMin: 10 };
  await flipRounds(h, 5, loose); // 翻 4 次，門檻 10 → 全念
  expect(h.spoken).toHaveLength(5);

  h.setClock(1_000_000 + 5 * MINUTE);
  const reaching = await h.run([alert({ fingerprint: 'fp-flap', status: 'resolved' })], {
    ...loose,
    flappingThreshold: 2,
  });
  expect(reaching.items[0]!.suppressed).toBeUndefined(); // 達標那一次照念
  h.setClock(1_000_000 + 6 * MINUTE);
  const after = await h.run([alert({ fingerprint: 'fp-flap' })], { ...loose, flappingThreshold: 2 });
  expect(after.items[0]!.suppressed).toBe('flapping');
  expect(h.spoken).toHaveLength(6);
});

test('#64 AC-1：抖動抑制關掉之後，先前的翻轉次數不再生效', async () => {
  const h = harness();
  await flipRounds(h, 6, FLAPPING);
  expect(h.spoken).toHaveLength(5);

  // 關掉（門檻 0）：抑制中被吞掉的「已恢復」先補念（審查 F3：關閉 = 立刻解除），
  // 然後這一輪的 firing 照常念。主管層修正前這裡只念 firing（6 句），
  // 使用者因此從沒聽過它在第 6 輪其實恢復過。
  h.setClock(1_000_000 + 6 * MINUTE);
  await h.run([alert({ fingerprint: 'fp-flap' })], { ...FLAPPING, flappingThreshold: 0 });
  expect(h.spoken.slice(5).map((p) => p.status)).toEqual(['resolved', 'firing']);

  // 再開回來：翻轉次數從零開始算，所以下一次翻轉照常念。
  h.setClock(1_000_000 + 7 * MINUTE);
  const back = await h.run([alert({ fingerprint: 'fp-flap', status: 'resolved' })], FLAPPING);
  expect(back.items[0]!.suppressed).toBeUndefined();
  expect(h.spoken).toHaveLength(8);
});

test('#64：解除補念之後，重播間隔從補念的那一刻重新起算 —— 不會隔一分鐘又念一次', async () => {
  const h = harness();
  // `repeatFiringMin: 30` → dedup 的防洪窗是 30 分鐘（不是 Infinity），而且**比抖動的窗長**，
  // 所以補念那一刻有沒有把 dedup 的時間戳對回來，差別看得見。
  const over = { flappingThreshold: 5, flappingWindowMin: 10, repeatFiringMin: 30 };
  await flipRounds(h, 7, over); // 第 7 輪（T0+6min、firing）被抑制
  expect(h.spoken).toHaveLength(6);

  h.setClock(1_000_000 + 16 * MINUTE);
  await h.run([alert({ fingerprint: 'fp-flap' })], over);
  expect(h.spoken).toHaveLength(7);
  expect(h.spoken[6]!.status).toBe('firing');

  // 補念的那一刻 dedup 被重新記成「剛剛播過」—— 沒有這一步的話，它記著的還是抑制期間
  // 那次 firing 的時間戳（T0+6min），於是這一輪（距離補念才 21 分鐘）又念一次。
  h.setClock(1_000_000 + 37 * MINUTE);
  const round = await h.run([alert({ fingerprint: 'fp-flap' })], over);
  expect(h.spoken).toHaveLength(7);
  expect(round.items).toHaveLength(0);
});

test('#64 AC-5：解除補念被嚴重度門檻擋下時也要 forget() —— 門檻調回來之後不會永久靜音', async () => {
  const h = harness();
  // 門檻 5：第 7 輪（T0+6min、firing）被抑制，而抑制前最後念出去的是「已恢復」。
  // 抑制期間那一次 firing 照樣進了 dedup（記成「播過」），但它其實一句都沒出聲。
  const over = { flappingThreshold: 5, flappingWindowMin: 10 };
  const low: Partial<ParsedAlert> = { fingerprint: 'fp-flap', severity: 'warning' };
  await flipRounds(h, 7, over, 1_000_000, low);
  expect(h.spoken).toHaveLength(6);
  expect(h.spoken[5]!.status).toBe('resolved');

  // 解除的那一輪門檻被調高到 critical（這則是 warning）→ 補念要被擋下，不出聲。
  h.setClock(1_000_000 + 16 * MINUTE);
  const blocked = await h.run([alert(low)], { ...over, minSeverity: 'critical' });
  expect(h.spoken).toHaveLength(6);
  expect(blocked.items).toEqual([]);

  // 門檻調回來，而它**仍在燒**：沒有上面那次 forget() 的話，dedup 記著抑制期間
  // 那次 firing 的時間戳，預設窗是 Infinity → 這一則永久靜音（告警在燒而面板不吭聲）。
  h.setClock(1_000_000 + 17 * MINUTE);
  const after = await h.run([alert(low)], over);
  expect(h.spoken).toHaveLength(7);
  expect(h.spoken[6]!.status).toBe('firing');
  expect(after.items).toHaveLength(1);
  expect(after.items[0]!.suppressed).toBeUndefined();
});
