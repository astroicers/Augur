/**
 * `createSpeaker` 的行為測試。
 *
 * **為什麼補**：2026-09-28 的全專案變異測試顯示 `src/speech/speaker.ts`
 * 是整個 repo 最大的單一破洞 —— 語句覆蓋 5.61%、**分支 0%、函式 0%**，
 * 因為唯一會走到它的測試（`MascotPanel.test.tsx`）把 `createSpeaker` 整支 mock 掉了。
 * 對它下的 5 個變異體**全部存活**，其中兩個會讓面板永久靜音：
 *
 *  - `pump()` 的 `if (disposed || speaking)` 改成 `if (disposed)` → 疊音，
 *    「逐則播、不疊音」這個佇列的核心保證消失
 *  - `finish()` 不再呼叫 `pump()` → 念完第一則之後佇列永遠停住
 *  - watchdog 的逾時改成 1ms / `CHARS_PER_SEC` 改成 0.1 → 每則都被腰斬 / 逾時形同關閉
 *
 * 邊界只有一個：`SpeechSynthesis`。這裡用假的，其餘全跑真的。
 */
import { createSpeaker, pickVoice, loadVoices, CHARS_PER_SEC } from '../speaker';
import type { BroadcastPlan } from '../../core/types';

class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onboundary: ((ev: unknown) => void) | null = null;
  voice: unknown = null;
  lang = '';
  pitch = 1;
  rate = 1;
  constructor(public text: string) {}
}

type Listener = () => void;

class FakeSynth {
  spoken: FakeUtterance[] = [];
  cancelled = 0;
  resumed = 0;
  voices: Array<{ name: string; lang: string; localService: boolean }> = [];
  private listeners = new Map<string, Listener[]>();
  /** 讓測試模擬「getVoices 在受限環境丟例外」。 */
  throwOnGetVoices = false;

  getVoices() {
    if (this.throwOnGetVoices) {
      throw new Error('blocked');
    }
    return this.voices as unknown as SpeechSynthesisVoice[];
  }
  addEventListener(type: string, fn: Listener) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn)
    );
  }
  emit(type: string) {
    [...(this.listeners.get(type) ?? [])].forEach((f) => f());
  }
  /** 目前在引擎裡的 utterance —— cancel 要對它發事件。 */
  current: FakeUtterance | null = null;
  speak(u: FakeUtterance) {
    this.spoken.push(u);
    this.current = u;
  }
  cancel() {
    // ⚠️ 真引擎的 cancel 會**非同步**對 in-flight utterance 觸發
    // error('interrupted')（規格行為）。第一版的假引擎只加計數器 ——
    // 於是 settled 守門與「先 cancel 再 finish」這兩個與 cancel 交互的
    // 保證整個測不到（2026-09-29 變異測試：兩個對應變異體都存活）。
    this.cancelled++;
    const u = this.current;
    this.current = null;
    if (u) {
      queueMicrotask(() => u.onerror?.({ error: 'interrupted' }));
    }
  }
  resume() {
    this.resumed++;
  }
}

function plan(text: string): BroadcastPlan {
  return { text, emotion: 'critical' } as unknown as BroadcastPlan;
}

/** 讓 `void ready.then(pump)` 的微任務鏈跑完。 */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeAll(() => {
  (global as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance;
});

function mk(over: Partial<FakeSynth> = {}) {
  const synth = new FakeSynth();
  synth.voices = [{ name: 'Hanhan', lang: 'zh-TW', localService: true }];
  Object.assign(synth, over);
  return synth;
}

test('逐則播、不疊音：第二則要等第一則 onend 才會進引擎', async () => {
  const synth = mk();
  const sp = createSpeaker(synth as unknown as SpeechSynthesis);
  sp.enqueue(plan('第一則'));
  sp.enqueue(plan('第二則'));
  await settle();

  // 疊音的變異體（拿掉 `|| speaking`）會讓這裡變成 2。
  expect(synth.spoken.map((u) => u.text)).toEqual(['第一則']);
  expect(sp.pending()).toBe(1);
  expect(sp.isSpeaking()).toBe(true);

  synth.spoken[0]!.onend!();
  await settle();
  expect(synth.spoken.map((u) => u.text)).toEqual(['第一則', '第二則']);
});

test('念完會接著念下一則：finish() 不呼叫 pump() 的話佇列會永遠停在第一則', async () => {
  const synth = mk();
  const sp = createSpeaker(synth as unknown as SpeechSynthesis);
  ['一', '二', '三'].forEach((t) => sp.enqueue(plan(t)));
  await settle();

  for (let i = 0; i < 3; i++) {
    expect(synth.spoken).toHaveLength(i + 1);
    synth.spoken[i]!.onend!();
    await settle();
  }
  expect(synth.spoken.map((u) => u.text)).toEqual(['一', '二', '三']);
  expect(sp.pending()).toBe(0);
  expect(sp.isSpeaking()).toBe(false);
});

test('watchdog 逾時會 cancel 並讓佇列往前走，逾時長度隨字數成長', async () => {
  jest.useFakeTimers();
  try {
    const synth = mk();
    const errors: string[] = [];
    const sp = createSpeaker(synth as unknown as SpeechSynthesis, {
      events: { onError: (e) => errors.push(e) },
    });
    const text = '一'.repeat(56); // 56 / 5.6 = 10s → watchdog = 10*2+5 = 25s
    sp.enqueue(plan(text));
    sp.enqueue(plan('下一則'));
    await settle();
    expect(synth.spoken).toHaveLength(1);

    // 還沒到就不該動它 —— 這一半擋的是「逾時被改成 1ms」那種變異體。
    jest.advanceTimersByTime(24_000);
    await settle();
    expect(synth.cancelled).toBe(0);
    expect(synth.spoken).toHaveLength(1);

    jest.advanceTimersByTime(2_000);
    await settle();
    expect(synth.cancelled).toBe(1);
    // 恰好一條，而且是 watchdog 那條 —— cancel 引發的 interrupted 事件
    // 必須被 settled 守門吃掉。守門拿掉的話這裡會是兩條。
    expect(errors).toEqual(['watchdog-timeout']);
    // 卡住的那則被放掉之後，佇列必須繼續。
    expect(synth.spoken.map((u) => u.text)).toEqual([text, '下一則']);

    const estMs = (text.length / CHARS_PER_SEC) * 1000;
    expect(estMs * 2 + 5000).toBe(25_000);
  } finally {
    jest.useRealTimers();
  }
});

test('onend 之後不會再被 watchdog 誤殺（settled 只結算一次）', async () => {
  jest.useFakeTimers();
  try {
    const synth = mk();
    const ended: string[] = [];
    const sp = createSpeaker(synth as unknown as SpeechSynthesis, {
      events: { onEnd: (p) => ended.push(p.text) },
    });
    sp.enqueue(plan('短句'));
    await settle();
    synth.spoken[0]!.onend!();
    await settle();

    jest.advanceTimersByTime(600_000);
    await settle();
    expect(synth.cancelled).toBe(0);
    expect(ended).toEqual(['短句']);
  } finally {
    jest.useRealTimers();
  }
});

test('getVoices 丟例外時仍然念得出來 —— ready 不可以 reject', async () => {
  // ready 一旦 reject，`enqueue` 的 `void ready.then(pump)` 就永遠不會 pump：
  // 佇列只進不出、沒有 onError、UI 上沒有任何跡象。
  const synth = mk({ throwOnGetVoices: true });
  const sp = createSpeaker(synth as unknown as SpeechSynthesis);
  sp.enqueue(plan('降級也要出聲'));
  await settle();
  expect(synth.spoken.map((u) => u.text)).toEqual(['降級也要出聲']);
  expect(synth.spoken[0]!.voice).toBeNull();
});

test('第一批聲線沒有 zh-TW 時，後續的 voiceschanged 會補挑到', async () => {
  const synth = mk();
  synth.voices = [{ name: 'David', lang: 'en-US', localService: true }];
  const sp = createSpeaker(synth as unknown as SpeechSynthesis);
  await settle();

  // Chrome 在 Windows 上會多次觸發 voiceschanged，第一批可能不含中文。
  synth.voices = [
    { name: 'David', lang: 'en-US', localService: true },
    { name: 'Hanhan', lang: 'zh-TW', localService: true },
  ];
  synth.emit('voiceschanged');
  sp.enqueue(plan('中文'));
  await settle();
  expect((synth.spoken[0]!.voice as { name: string }).name).toBe('Hanhan');
});

test('播報中到達的 voiceschanged 延後到則間生效 —— 不換到一半、也不丟棄', async () => {
  const synth = mk();
  const sp = createSpeaker(synth as unknown as SpeechSynthesis);
  sp.enqueue(plan('進行中'));
  sp.enqueue(plan('下一則'));
  await settle();
  expect((synth.spoken[0]!.voice as { name: string }).name).toBe('Hanhan');
  expect(sp.isSpeaking()).toBe(true);

  // 播報中來一次 voiceschanged。兩個都是錯的：立刻換（念到一半換聲）、
  // 直接丟棄（第一版 —— 首批沒有 zh-TW 時「null 就一輩子是 null」原樣回歸，
  // 而中文一則實測 ~14 秒，補批落在播報中是常態）。正解是延後到 finish。
  synth.voices = [{ name: '補批', lang: 'zh-TW', localService: true }];
  synth.emit('voiceschanged');
  // 正在念的這一則不受影響（utterance 已交給引擎）。
  expect((synth.spoken[0]!.voice as { name: string }).name).toBe('Hanhan');

  synth.spoken[0]!.onend!();
  await settle();
  // 則間重挑：第二則用補批的聲線。丟棄式守門會讓這裡還是 Hanhan。
  expect((synth.spoken[1]!.voice as { name: string }).name).toBe('補批');
});

test('首批沒有中文聲線、補批落在播報中 —— 第二則仍要挑到 zh-TW', async () => {
  const synth = mk();
  synth.voices = [{ name: 'David', lang: 'en-US', localService: true }];
  const sp = createSpeaker(synth as unknown as SpeechSynthesis);
  sp.enqueue(plan('第一則'));
  sp.enqueue(plan('第二則'));
  await settle();
  expect(synth.spoken[0]!.voice).toBeNull(); // 沒得挑，用引擎預設

  synth.voices = [
    { name: 'David', lang: 'en-US', localService: true },
    { name: 'Hanhan', lang: 'zh-TW', localService: true },
  ];
  synth.emit('voiceschanged'); // 播報中到達 —— 丟棄式守門在這裡把它扔掉
  synth.spoken[0]!.onend!();
  await settle();
  expect((synth.spoken[1]!.voice as { name: string }).name).toBe('Hanhan');
});

test('utterance 建構丟例外時，那一則報錯、佇列繼續 —— 不卡死', async () => {
  // 2026-09-29 變異測試：把 pump() 還原成修復前結構（speaking 先設、
  // try 只包 synth.speak）之後 78/78 全綠 —— 「speaking 與建構必須在同一個
  // try」的整個修復沒有任何測試能讓它失敗。這一條就是那個測試：
  // 修復前結構下，建構 throw 讓 speaking 卡在 true，第二則永遠不播。
  const synth = mk();
  const errors: string[] = [];
  const sp = createSpeaker(synth as unknown as SpeechSynthesis, {
    events: { onError: (e) => errors.push(e) },
  });
  const Real = (global as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance;
  let boom = 1;
  (global as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class extends FakeUtterance {
    constructor(t: string) {
      if (boom-- > 0) {
        throw new Error('ctor-boom');
      }
      super(t);
    }
  };
  try {
    sp.enqueue(plan('會爆的'));
    sp.enqueue(plan('接著播的'));
    await settle();
  } finally {
    (global as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = Real;
  }
  expect(errors.some((e) => e.startsWith('throw:'))).toBe(true);
  expect(synth.spoken.map((u) => u.text)).toEqual(['接著播的']);
  expect(sp.isSpeaking()).toBe(true); // 第二則正在播 —— 佇列沒有卡死
});

test('dispose 之後不再有任何 utterance 進引擎', async () => {
  const synth = mk();
  const sp = createSpeaker(synth as unknown as SpeechSynthesis);
  sp.enqueue(plan('一'));
  await settle();
  sp.dispose();
  expect(synth.cancelled).toBe(1);

  sp.enqueue(plan('二'));
  await settle();
  expect(synth.spoken.map((u) => u.text)).toEqual(['一']);
});

test('pickVoice 的優先序：指名 → zh-TW 本機 → 任何 zh-TW → 任何 zh → null', () => {
  const v = (name: string, lang: string, localService = false) =>
    ({ name, lang, localService }) as unknown as SpeechSynthesisVoice;

  expect(pickVoice([v('A', 'en-US'), v('B', 'zh-TW')], 'A')!.name).toBe('A');
  // 指名找不到時不可以整個放棄，要往下走。
  expect(pickVoice([v('A', 'en-US'), v('B', 'zh-TW')], '不存在')!.name).toBe('B');
  expect(pickVoice([v('B', 'zh-TW'), v('C', 'zh-TW', true)])!.name).toBe('C');
  expect(pickVoice([v('D', 'zh-CN'), v('E', 'en-US')])!.name).toBe('D');
  expect(pickVoice([v('E', 'en-US')])).toBeNull();
  expect(pickVoice([])).toBeNull();
});

test('loadVoices：首呼為空時等 voiceschanged，且逾時回空陣列而不是卡住', async () => {
  jest.useFakeTimers();
  try {
    const empty = new FakeSynth();
    const p = loadVoices(empty as unknown as SpeechSynthesis);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(2000);
    await settle();
    expect(settled).toBe(true);
    await expect(p).resolves.toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('音高與語速套到每一句，超出範圍會夾住；非數字退回 1', async () => {
  const synth = mk();
  createSpeaker(synth as unknown as SpeechSynthesis, { pitch: 1.6, rate: 1.2 }).enqueue(plan('一'));
  await settle();
  expect([synth.spoken[0]!.pitch, synth.spoken[0]!.rate]).toEqual([1.6, 1.2]);

  const synth2 = mk();
  createSpeaker(synth2 as unknown as SpeechSynthesis, { pitch: 5, rate: 0 }).enqueue(plan('一'));
  await settle();
  expect([synth2.spoken[0]!.pitch, synth2.spoken[0]!.rate]).toEqual([2, 0.1]);

  const synth3 = mk();
  createSpeaker(synth3 as unknown as SpeechSynthesis, { pitch: Number.NaN }).enqueue(plan('一'));
  await settle();
  expect([synth3.spoken[0]!.pitch, synth3.spoken[0]!.rate]).toEqual([1, 1]);
});

test('語速放慢時 watchdog 跟著放寬 —— 否則慢速設定下每一則都被腰斬', async () => {
  jest.useFakeTimers();
  try {
    const synth = mk();
    const errors: string[] = [];
    const sp = createSpeaker(synth as unknown as SpeechSynthesis, {
      rate: 0.5,
      events: { onError: (e) => errors.push(e) },
    });
    sp.enqueue(plan('一'.repeat(56))); // 原速 10s → 0.5 倍速 20s → watchdog = 20*2+5 = 45s
    await settle();
    jest.advanceTimersByTime(30_000); // 原速的 25s 早就過了
    await settle();
    expect(errors).toEqual([]);
    jest.advanceTimersByTime(16_000);
    await settle();
    expect(errors).toEqual(['watchdog-timeout']);
  } finally {
    jest.useRealTimers();
  }
});

test('指名聲線可以只填名稱的一段（不分大小寫）；onVoice 回報挑到的名稱，voiceName() 讀得到', async () => {
  const v = (name: string, lang: string, localService = false) =>
    ({ name, lang, localService }) as unknown as SpeechSynthesisVoice;
  const voices = [
    v('Microsoft Hanhan - Chinese (Traditional, Taiwan)', 'zh-TW', true),
    v('Microsoft Zhiwei - Chinese (Traditional, Taiwan)', 'zh-TW', true),
  ];
  expect(pickVoice(voices, 'zhiwei')!.name).toContain('Zhiwei');
  // 完整名稱優先於部分比對
  expect(pickVoice([v('Zhi', 'zh-TW'), v('Zhiwei', 'zh-TW')], 'Zhiwei')!.name).toBe('Zhiwei');
  // 空白不當成「全部都符合」
  expect(pickVoice(voices, '   ')!.name).toContain('Hanhan');

  const synth = mk();
  synth.voices = voices as unknown as FakeSynth['voices'];
  const seen: Array<string | null> = [];
  const sp = createSpeaker(synth as unknown as SpeechSynthesis, {
    preferredVoice: 'Zhiwei',
    events: { onVoice: (n) => seen.push(n) },
  });
  await settle();
  expect(seen).toEqual(['Microsoft Zhiwei - Chinese (Traditional, Taiwan)']);
  expect(sp.voiceName()).toBe('Microsoft Zhiwei - Chinese (Traditional, Taiwan)');
});
