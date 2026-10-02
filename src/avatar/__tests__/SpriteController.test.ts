/**
 * `SpriteController` 的單元測試（ROADMAP B2-7；規格 SP-1 / SP-4 / SP-8）。
 *
 * - **不得 import `spriteAssets.ts`**（SP-8.1）。它經 `SpriteController` 間接載入，
 *   png 由根 `jest.config.js` 的 moduleNameMapper 換成 `tools/jest/fileMock.js`
 *   （值是 `'sprite-sheet-stub.png'`）—— 所以「空字串 → 內建圖」驗得到 URL 有被填進去。
 * - 位置字串一律**寫死**而不是呼叫 `cellToBackgroundPosition` 算 —— 拿受測的函式算期望值，
 *   函式壞掉時兩邊一起壞，測試照樣綠。
 * - 載入走注入的 `loadSheet`（jsdom 不解碼圖）；預設 loader 另以假 `Image` 測。
 */
import {
  CLICK_REACTION_MS,
  SpriteController,
  judgeSheets,
  loadSheet,
  sheetGeometryProblem,
  type LoadedSheet,
  type MotionQuery,
  type SpriteControllerOptions,
  type SpriteStatus,
} from '../SpriteController';
import { BLINK_INTERVAL_MAX_MS, BLINK_INTERVAL_MIN_MS, DOUBLE_BLINK_DELAY_MS } from '../spriteSheet';

/** 格號 → background-position（row-major，每格 50%）。寫死，理由見檔頭。 */
const POS = ['0% 0%', '50% 0%', '100% 0%', '0% 50%', '50% 50%', '100% 50%', '0% 100%', '50% 100%', '100% 100%'];
const SHEET: LoadedSheet = { width: 1536, height: 1536 };
const LAYERS = ['base', 'expr', 'mouth', 'blink'] as const;
/** random() 固定 0.5 時的眨眼間隔：2800 + 0.5 × 3700 = 4650ms。 */
const INTERVAL = BLINK_INTERVAL_MIN_MS + 0.5 * (BLINK_INTERVAL_MAX_MS - BLINK_INTERVAL_MIN_MS);

async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

async function rig(over: Partial<SpriteControllerOptions> = {}, { ready = true } = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const statuses: SpriteStatus[] = [];
  const c = new SpriteController({
    loadSheet: () => Promise.resolve(SHEET),
    random: () => 0.5,
    matchMedia: () => ({ matches: false }),
    onStatus: (s) => statuses.push(s),
    ...over,
  });
  c.mount(host);
  if (ready) {
    await flush();
  }
  const layer = (n: string) => host.querySelector<HTMLElement>(`[data-layer="${n}"]`)!;
  return {
    c,
    host,
    statuses,
    layer,
    stage: () => host.querySelector<HTMLElement>('[role="img"]')!,
    shown: (n: string) => layer(n).style.display !== 'none',
    pos: (n: string) => layer(n).style.backgroundPosition,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// SP-1：渲染契約
// ---------------------------------------------------------------------------

test('四層 z 序 base → expr → mouth → blink，全部 300% 300% / no-repeat / aria-hidden；stage 是 role=img', async () => {
  const r = await rig();
  const names = Array.from(r.stage().children).map((e) => (e as HTMLElement).dataset.layer);
  expect(names).toEqual([...LAYERS]);
  for (const n of LAYERS) {
    const el = r.layer(n);
    expect(el.style.backgroundSize).toBe('300% 300%');
    expect(el.style.backgroundRepeat).toBe('no-repeat');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    // SP-1.11：換格是直接跳，不得有連續補間。
    expect(el.style.transition).toBe('');
  }
  expect(r.stage().getAttribute('aria-label')).toBe('吉祥物：calm');
  r.c.setEmotion('critical');
  r.c.setSpeaking(true);
  expect(r.stage().getAttribute('aria-label')).toBe('吉祥物：critical，正在播報');
});

test('空字串 URL → spriteAssets 的內建圖；自訂 URL 原樣使用（去頭尾空白），base 只用 directions', async () => {
  const asked: string[] = [];
  const r = await rig({
    directionsUrl: '',
    reactionsUrl: '   ',
    loadSheet: (u) => {
      asked.push(u);
      return Promise.resolve(SHEET);
    },
  });
  expect(asked).toEqual(['sprite-sheet-stub.png', 'sprite-sheet-stub.png']);
  for (const n of LAYERS) {
    expect(r.layer(n).style.backgroundImage).toContain('sprite-sheet-stub.png');
  }

  const r2 = await rig({ directionsUrl: ' https://cdn.example/d.png ', reactionsUrl: 'public/plugins/x/r.png' });
  // SP-1.2：base 層任何情況下都不換成 reactions 圖。
  expect(r2.layer('base').style.backgroundImage).toContain('https://cdn.example/d.png');
  expect(r2.layer('base').style.backgroundImage).not.toContain('r.png');
  for (const n of ['expr', 'mouth', 'blink']) {
    expect(r2.layer(n).style.backgroundImage).toContain('public/plugins/x/r.png');
  }
});

// ---------------------------------------------------------------------------
// 視線 / 表情
// ---------------------------------------------------------------------------

test('視線格 → base 層 background-position，九格逐一對照', async () => {
  const r = await rig();
  expect(r.pos('base')).toBe(POS[4]);
  for (let c = 0; c < 9; c++) {
    r.c.setGaze(c);
    expect(r.pos('base')).toBe(POS[c]);
  }
});

test('情緒 → expr 格：calm 隱藏、warning 1、critical 2、resolved 3（明表，不是情緒索引）', async () => {
  const r = await rig();
  expect(r.shown('expr')).toBe(false);
  r.c.setEmotion('warning');
  expect([r.shown('expr'), r.pos('expr')]).toEqual([true, POS[1]]);
  r.c.setEmotion('critical');
  expect(r.pos('expr')).toBe(POS[2]);
  r.c.setEmotion('resolved');
  expect(r.pos('expr')).toBe(POS[3]);
  r.c.setEmotion('calm');
  expect(r.shown('expr')).toBe(false);
});

// ---------------------------------------------------------------------------
// SP-8.8：眨眼
// ---------------------------------------------------------------------------

test('眨眼序列：格 7(45ms) → 格 6(90ms) → 格 7(45ms) → 隱藏，再等一個間隔', async () => {
  const r = await rig();
  jest.advanceTimersByTime(INTERVAL - 1);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(1);
  expect([r.shown('blink'), r.pos('blink')]).toEqual([true, POS[7]]);
  jest.advanceTimersByTime(45);
  expect(r.pos('blink')).toBe(POS[6]);
  jest.advanceTimersByTime(90);
  expect(r.pos('blink')).toBe(POS[7]);
  jest.advanceTimersByTime(45);
  expect(r.shown('blink')).toBe(false);
  // random 0.5 ≥ 0.18 → 不補第二次；下一次在一整個間隔之後。
  jest.advanceTimersByTime(INTERVAL - 1);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(1);
  expect(r.shown('blink')).toBe(true);
});

test('雙眨：random < 0.18 時於 160ms 後補第二次，第二次之後不再補', async () => {
  const seq = [0.5, 0.1, 0.5]; // 間隔、雙眨判定（命中）、下一個間隔
  let i = 0;
  const r = await rig({ random: () => seq[Math.min(i++, seq.length - 1)]! });
  jest.advanceTimersByTime(INTERVAL + 180);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(DOUBLE_BLINK_DELAY_MS - 1);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(1);
  expect([r.shown('blink'), r.pos('blink')]).toEqual([true, POS[7]]);
  jest.advanceTimersByTime(180);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(DOUBLE_BLINK_DELAY_MS);
  expect(r.shown('blink')).toBe(false);
});

test('prefers-reduced-motion: reduce → 不眨；change 事件即時生效', async () => {
  let onChange: ((ev: { matches: boolean }) => void) | undefined;
  const mq: MotionQuery = {
    matches: true,
    addEventListener: (_t, l) => {
      onChange = l;
    },
    removeEventListener: () => {},
  };
  const r = await rig({ matchMedia: () => mq });
  jest.advanceTimersByTime(INTERVAL);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(INTERVAL);
  expect(r.shown('blink')).toBe(false);
  onChange!({ matches: false });
  jest.advanceTimersByTime(INTERVAL);
  expect(r.shown('blink')).toBe(true);
});

test('click 期間不眨，且 click 會中止正在進行的那一下；播報中照常眨', async () => {
  const r = await rig();
  // 到點時 click 正在顯示 → 跳過這一次。
  jest.advanceTimersByTime(INTERVAL - 10);
  r.c.setReaction('click');
  jest.advanceTimersByTime(10);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(CLICK_REACTION_MS);
  expect(r.shown('blink')).toBe(false);
  // 跳過之後照常排下一次（從跳過的那一刻起算）。
  jest.advanceTimersByTime(INTERVAL - CLICK_REACTION_MS);
  expect(r.shown('blink')).toBe(true);
  // 正在眨的那一下被 click 中止 —— blink 層在 expr 之上，會蓋掉格 0 的驚訝眼。
  r.c.setReaction('click');
  expect(r.shown('blink')).toBe(false);
  expect(r.pos('expr')).toBe(POS[0]);

  // 播報中不抑制。中止的同時已排下一次（從中止那一刻起算一個間隔）。
  jest.advanceTimersByTime(CLICK_REACTION_MS);
  r.c.setSpeaking(true);
  jest.advanceTimersByTime(INTERVAL - CLICK_REACTION_MS - 1);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(1);
  expect(r.shown('blink')).toBe(true);
});

test('pending 顯示中：眨眼間隔減半、data-pending 讓呼吸振幅 ×1.4；pending 被情緒蓋過時不加速', async () => {
  const r = await rig({}, { ready: false });
  r.c.setReaction('pending');
  await flush();
  expect(r.stage().dataset.pending).toBe('true');
  jest.advanceTimersByTime(INTERVAL / 2 - 1);
  expect(r.shown('blink')).toBe(false);
  jest.advanceTimersByTime(1);
  expect(r.shown('blink')).toBe(true);

  const r2 = await rig({}, { ready: false });
  r2.c.setEmotion('critical');
  r2.c.setReaction('pending');
  await flush();
  expect(r2.stage().dataset.pending).toBe('false');
  jest.advanceTimersByTime(INTERVAL / 2);
  expect(r2.shown('blink')).toBe(false);
  jest.advanceTimersByTime(INTERVAL / 2);
  expect(r2.shown('blink')).toBe(true);
});

// ---------------------------------------------------------------------------
// SP-8.9 / SP-8.10 / SP-8.11：嘴
// ---------------------------------------------------------------------------

test('setMouthOpen 是幀選擇器：0.6 → 格 4、0.8 / 0.95 → 格 5、0 → 閉口；不自己跑迴圈', async () => {
  const r = await rig();
  r.c.setSpeaking(true);
  r.c.setMouthOpen(0.6);
  expect([r.shown('mouth'), r.pos('mouth')]).toEqual([true, POS[4]]);
  // 不自走：flap.ts 才是時序來源，這裡停在最後一幀。
  jest.advanceTimersByTime(1000);
  expect([r.shown('mouth'), r.pos('mouth')]).toEqual([true, POS[4]]);
  r.c.setMouthOpen(0.95);
  expect(r.pos('mouth')).toBe(POS[5]);
  r.c.setMouthOpen(0.8);
  expect(r.pos('mouth')).toBe(POS[5]);
  // SP-8.11：顯式的 0 就是閉口（DiagnosticAvatar 會把它當「沒給值」而被定速循環蓋過）。
  r.c.setMouthOpen(0);
  expect(r.shown('mouth')).toBe(false);
  jest.advanceTimersByTime(1000);
  expect(r.shown('mouth')).toBe(false);
});

test('mouth 層只在播報中顯示；setSpeaking(false) 立即隱藏', async () => {
  const r = await rig();
  r.c.setMouthOpen(0.95);
  expect(r.shown('mouth')).toBe(false);
  r.c.setSpeaking(true);
  r.c.setMouthOpen(0.95);
  expect(r.shown('mouth')).toBe(true);
  r.c.setSpeaking(false);
  expect(r.shown('mouth')).toBe(false);
});

test('SP-8.10：本輪從未收到 setMouthOpen → 格 4 以 220ms 週期定速 flap；收到第一個就停；下一輪重新判定', async () => {
  const r = await rig();
  r.c.setSpeaking(true);
  expect([r.shown('mouth'), r.pos('mouth')]).toEqual([true, POS[4]]);
  jest.advanceTimersByTime(110);
  expect(r.shown('mouth')).toBe(false);
  jest.advanceTimersByTime(110);
  expect([r.shown('mouth'), r.pos('mouth')]).toEqual([true, POS[4]]);
  jest.advanceTimersByTime(110);
  expect(r.shown('mouth')).toBe(false);

  r.c.setMouthOpen(0.95);
  jest.advanceTimersByTime(1000);
  expect([r.shown('mouth'), r.pos('mouth')]).toEqual([true, POS[5]]);

  r.c.setSpeaking(false);
  expect(r.shown('mouth')).toBe(false);
  r.c.setSpeaking(true);
  expect([r.shown('mouth'), r.pos('mouth')]).toEqual([true, POS[4]]);
  jest.advanceTimersByTime(110);
  expect(r.shown('mouth')).toBe(false);
});

// ---------------------------------------------------------------------------
// SP-8.12 / SP-8.13：click 與 pending
// ---------------------------------------------------------------------------

test('click：格 0 顯示 420ms，期間凍結視線；到期後跳到最新的視線格', async () => {
  const r = await rig();
  r.c.setGaze(2);
  r.c.setReaction('click');
  expect([r.shown('expr'), r.pos('expr')]).toEqual([true, POS[0]]);
  r.c.setGaze(6);
  expect(r.pos('base')).toBe(POS[2]);
  jest.advanceTimersByTime(CLICK_REACTION_MS - 1);
  expect(r.pos('base')).toBe(POS[2]);
  expect(r.pos('expr')).toBe(POS[0]);
  jest.advanceTimersByTime(1);
  expect(r.pos('base')).toBe(POS[6]);
  expect(r.shown('expr')).toBe(false);
});

test('click 不被播報抑制、且優先於 critical；結束後回到 critical', async () => {
  const r = await rig();
  r.c.setEmotion('critical');
  r.c.setSpeaking(true);
  r.c.setReaction('click');
  expect(r.pos('expr')).toBe(POS[0]);
  jest.advanceTimersByTime(CLICK_REACTION_MS);
  expect(r.pos('expr')).toBe(POS[2]);
});

test('pending：calm 且未播報 → 格 8；播報中與非 calm 情緒時讓位；null 清除', async () => {
  const r = await rig();
  r.c.setReaction('pending');
  expect([r.shown('expr'), r.pos('expr')]).toEqual([true, POS[8]]);
  r.c.setSpeaking(true);
  expect(r.shown('expr')).toBe(false);
  r.c.setSpeaking(false);
  expect(r.pos('expr')).toBe(POS[8]);
  r.c.setEmotion('warning');
  expect(r.pos('expr')).toBe(POS[1]);
  r.c.setEmotion('calm');
  expect(r.pos('expr')).toBe(POS[8]);
  r.c.setReaction(null);
  expect(r.shown('expr')).toBe(false);
});

test('click 結束時 pending 若仍成立，臉自己回到 pending —— 不需要再呼叫一次 setReaction', async () => {
  const r = await rig();
  r.c.setReaction('pending');
  r.c.setReaction('click');
  expect(r.pos('expr')).toBe(POS[0]);
  jest.advanceTimersByTime(CLICK_REACTION_MS);
  expect([r.shown('expr'), r.pos('expr')]).toEqual([true, POS[8]]);
});

// ---------------------------------------------------------------------------
// SP-8.7：載入與降級（四條各一）
// ---------------------------------------------------------------------------

test('SP-8.7 ①：兩張都解碼完成前任何一層都不顯示、不填圖、不排眨眼；完成後一次到位', async () => {
  const resolvers: Record<string, (s: LoadedSheet) => void> = {};
  const r = await rig(
    {
      directionsUrl: 'd.png',
      reactionsUrl: 'r.png',
      loadSheet: (u) => new Promise((res) => (resolvers[u] = res)),
    },
    { ready: false }
  );
  r.c.setEmotion('critical');
  r.c.setGaze(3);
  for (const n of LAYERS) {
    expect(r.shown(n)).toBe(false);
    expect(r.layer(n).style.backgroundImage).toBe('');
  }
  expect(r.stage().dataset.spriteState).toBe('loading');
  expect(jest.getTimerCount()).toBe(0);

  resolvers['d.png']!(SHEET);
  await flush();
  expect(r.shown('base')).toBe(false); // 只到一張不算數

  resolvers['r.png']!(SHEET);
  await flush();
  expect([r.shown('base'), r.pos('base')]).toEqual([true, POS[3]]);
  expect([r.shown('expr'), r.pos('expr')]).toEqual([true, POS[2]]);
  expect(r.stage().dataset.spriteState).toBe('ready');
  expect(r.statuses).toEqual([{ state: 'ready' }]);
  expect(jest.getTimerCount()).toBe(1); // 眨眼排程到這時才開始
});

test('SP-8.7 ②：directions 載入失敗（onerror，含 CSP/CORS）→ failed，不拋例外、不留任何一層與計時器', async () => {
  const r = await rig({
    directionsUrl: 'https://blocked.example/d.png',
    loadSheet: (u) => (u.includes('blocked') ? Promise.reject(new Error('載入失敗')) : Promise.resolve(SHEET)),
  });
  expect(r.statuses).toEqual([{ state: 'failed', reason: expect.stringContaining('directions') }]);
  expect(r.stage().dataset.spriteState).toBe('failed');
  for (const n of LAYERS) {
    expect(r.shown(n)).toBe(false);
  }
  expect(jest.getTimerCount()).toBe(0);
  // 失敗後到被 MascotPanel 換掉之前，契約呼叫照樣不得拋例外、不得重新啟動嘴的計時器。
  expect(() => {
    r.c.setGaze(1);
    r.c.setEmotion('critical');
    r.c.setSpeaking(true);
    r.c.setMouthOpen(0.6);
  }).not.toThrow();
  expect(jest.getTimerCount()).toBe(0);
  for (const n of LAYERS) {
    expect(r.shown(n)).toBe(false);
  }
});

test('SP-8.7 ③：幾何不合（非正方形、邊長不能被 3 整除）→ failed', async () => {
  const a = await rig({ loadSheet: () => Promise.resolve({ width: 1536, height: 1024 }) });
  expect(a.statuses).toEqual([{ state: 'failed', reason: expect.stringContaining('不是正方形') }]);
  expect(a.shown('base')).toBe(false);

  const b = await rig({ loadSheet: () => Promise.resolve({ width: 1000, height: 1000 }) });
  expect(b.statuses).toEqual([{ state: 'failed', reason: expect.stringContaining('不能被 3 整除') }]);
  expect(b.shown('base')).toBe(false);

  expect(sheetGeometryProblem({ width: 1536, height: 1536 })).toBeNull();
  expect(sheetGeometryProblem({ width: 0, height: 0 })).toMatch(/無效/);
});

test('SP-8.7 ④：兩張尺寸不一致 → 只留 base 層（視線仍活著）、三個覆蓋層停用、回報 degraded', async () => {
  const r = await rig({
    directionsUrl: 'd.png',
    reactionsUrl: 'r.png',
    loadSheet: (u) => Promise.resolve(u === 'd.png' ? SHEET : { width: 1152, height: 1152 }),
  });
  expect(r.statuses).toEqual([{ state: 'degraded', reason: expect.stringContaining('尺寸不一致') }]);
  expect(r.stage().dataset.spriteState).toBe('degraded');
  expect(r.shown('base')).toBe(true);
  expect(r.layer('base').style.backgroundImage).toContain('d.png');
  expect(jest.getTimerCount()).toBe(0); // 沒有 blink 層就不排眨眼

  r.c.setEmotion('critical');
  r.c.setSpeaking(true);
  r.c.setMouthOpen(0.95);
  r.c.setReaction('pending');
  jest.advanceTimersByTime(BLINK_INTERVAL_MAX_MS * 2);
  for (const n of ['expr', 'mouth', 'blink']) {
    expect(r.shown(n)).toBe(false);
    expect(r.layer(n).style.backgroundImage).toBe('');
  }
  r.c.setGaze(7);
  expect(r.pos('base')).toBe(POS[7]);
});

test('reactions 自己載入失敗 → 同第 ④ 條只留 base（SP-3.7：directions 自成完整的 calm 角色）', async () => {
  const r = await rig({
    reactionsUrl: 'broken-r.png',
    loadSheet: (u) => (u === 'broken-r.png' ? Promise.reject(new Error('載入失敗')) : Promise.resolve(SHEET)),
  });
  expect(r.statuses).toEqual([{ state: 'degraded', reason: expect.stringContaining('reactions') }]);
  expect(r.shown('base')).toBe(true);
  r.c.setEmotion('warning');
  expect(r.shown('expr')).toBe(false);
});

test('judgeSheets 的判定順序：directions 壞 > directions 幾何 > reactions 壞 > reactions 幾何 > 尺寸不一致', () => {
  const ok = { ok: true as const, sheet: SHEET };
  const bad = { ok: false as const, error: new Error('x') };
  const odd = { ok: true as const, sheet: { width: 10, height: 10 } };
  expect(judgeSheets(bad, bad).mode).toBe('failed');
  expect(judgeSheets(odd, bad).mode).toBe('failed');
  expect(judgeSheets(ok, bad).mode).toBe('directions-only');
  expect(judgeSheets(ok, odd).mode).toBe('directions-only');
  expect(judgeSheets(ok, { ok: true, sheet: { width: 768, height: 768 } }).mode).toBe('directions-only');
  expect(judgeSheets(ok, ok).mode).toBe('full');
});

// ---------------------------------------------------------------------------
// 預設 loader：new Image() + decode()
// ---------------------------------------------------------------------------

type Behaviour = 'decode-ok' | 'decode-reject' | 'onload' | 'onerror';

function installFakeImage(behaviour: Behaviour, size = { w: 1536, h: 1536 }) {
  const original = window.Image;
  const srcs: string[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = 'auto';
    naturalWidth = 0;
    naturalHeight = 0;
    decode?: () => Promise<void>;
    constructor() {
      if (behaviour === 'decode-ok') {
        this.decode = () => {
          this.naturalWidth = size.w;
          this.naturalHeight = size.h;
          return Promise.resolve();
        };
      } else if (behaviour === 'decode-reject') {
        this.decode = () => Promise.reject(new Error('EncodingError'));
      }
    }
    set src(v: string) {
      srcs.push(v);
      if (behaviour === 'onload') {
        setTimeout(() => {
          this.naturalWidth = size.w;
          this.naturalHeight = size.h;
          this.onload?.();
        }, 0);
      } else if (behaviour === 'onerror') {
        setTimeout(() => this.onerror?.(), 0);
      }
    }
  }
  Object.defineProperty(window, 'Image', { value: FakeImage, configurable: true, writable: true });
  return {
    srcs,
    restore: () => Object.defineProperty(window, 'Image', { value: original, configurable: true, writable: true }),
  };
}

test('預設 loader：用 decode() 等解碼完成；decode 不存在時退回 onload；onerror 與 decode 失敗都是 reject', async () => {
  const cases: Array<[Behaviour, 'ok' | 'reject']> = [
    ['decode-ok', 'ok'],
    ['onload', 'ok'],
    ['decode-reject', 'reject'],
    ['onerror', 'reject'],
  ];
  for (const [behaviour, want] of cases) {
    const fake = installFakeImage(behaviour, { w: 999, h: 999 });
    try {
      const p = loadSheet('x.png');
      jest.advanceTimersByTime(0);
      if (want === 'ok') {
        await expect(p).resolves.toMatchObject({ width: 999, height: 999 });
      } else {
        await expect(p).rejects.toThrow('載入失敗');
      }
      expect(fake.srcs).toEqual(['x.png']);
    } finally {
      fake.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

test('dispose 清掉所有計時器、DOM 與 matchMedia 監聽；之後的呼叫都是 no-op、不再排計時器', async () => {
  const removeEventListener = jest.fn();
  const r = await rig({ matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener }) });
  r.c.setSpeaking(true); // 嘴的定速 fallback
  r.c.setReaction('click'); // click 計時器
  expect(jest.getTimerCount()).toBe(3); // + 眨眼

  r.c.dispose();
  expect(jest.getTimerCount()).toBe(0);
  expect(r.host.childElementCount).toBe(0);
  expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));

  // ⚠️ **每一次呼叫後各查一次。** 先前是整串呼叫完才查一次 getTimerCount()，
  // 而 setSpeaking(true) 排的嘴計時器會被下一個 setMouthOpen 清掉、setReaction('click') 的
  // 計時器會被下一個 setReaction('pending') 清掉 —— 拿掉 disposed 守門照樣綠（複審實測）。
  const calls = [
    () => r.c.setGaze(1),
    () => r.c.setEmotion('critical'),
    () => r.c.setSpeaking(false),
    () => r.c.setSpeaking(true),
    () => r.c.setMouthOpen(0.6),
    () => r.c.setReaction('click'),
    () => r.c.setReaction('pending'),
  ];
  for (const call of calls) {
    expect(call).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  }
});

// ⚠️ reject 那一支不能省。resolve 路徑在 applyVerdict 會被「layers 已經是 null」擋下，
// 那一層把 load() 裡的 disposed 守門遮住了；失敗路徑走 fail() → emit()，不看 layers。
// 真實情境：使用者改 URL 選項時每次按鍵都換一個 controller，舊的那個晚到的 404
// 會蓋掉目前這組 URL 的降級狀態。
test.each(['resolve', 'reject'] as const)('dispose 之後才到的載入結果（%s）被丟棄：不回報、不碰 DOM、不排眨眼', async (outcome) => {
  const pending: Array<{ res: (s: LoadedSheet) => void; rej: (e: Error) => void }> = [];
  const r = await rig(
    { loadSheet: () => new Promise((res, rej) => pending.push({ res, rej })) },
    { ready: false }
  );
  r.c.dispose();
  for (const p of pending) {
    if (outcome === 'resolve') {
      p.res(SHEET);
    } else {
      p.rej(new Error('404'));
    }
  }
  await flush();
  expect(r.statuses).toEqual([]);
  expect(r.host.childElementCount).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});
