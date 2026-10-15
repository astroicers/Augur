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
