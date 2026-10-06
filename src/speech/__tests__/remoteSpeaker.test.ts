/**
 * `createRemoteSpeaker`（ADR-005）的行為測試。
 *
 * 邊界有三個：`fetch`、Web Audio、降級用的 Web Speech 播報器。三者都用假的，其餘跑真的。
 * 釘住的是 ADR-005 決策 3／5 的保證：逐則播不疊音、失敗只降級那一則且佇列繼續、
 * 預取下一則、嘴型來自音訊包絡且只在改變時送出。
 */
import {
  createRemoteSpeaker,
  mouthEnvelope,
  speechUrl,
  endpointLabel,
  splitClauses,
  ENVELOPE_HOP_SEC,
  MOUTH_HOLD_MS,
  type AudioBufferLike,
  type AudioContextLike,
  type BufferSourceLike,
} from '../remoteSpeaker';
import type { Speaker, SpeakerEvents } from '../speaker';
import type { BroadcastPlan } from '../../core/types';

const plan = (text: string): BroadcastPlan => ({
  text,
  severity: 'warning',
  emotion: 'warning',
  name: text,
  status: 'firing',
});

/** 一段 1 秒的假音訊：前半有聲（0.5 振幅）、後半靜音。 */
function fakeBuffer(seconds = 1, sampleRate = 22050): AudioBufferLike {
  const data = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < data.length / 2; i++) {
    data[i] = i % 2 ? 0.5 : -0.5;
  }
  return { duration: seconds, sampleRate, numberOfChannels: 1, getChannelData: () => data };
}

class FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: ((ev: Event) => void) | null = null;
  started = false;
  stopped = false;
  connect() {
    return undefined;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  end() {
    this.onended?.({} as Event);
  }
}

class FakeCtx implements AudioContextLike {
  state = 'running';
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  closed = false;
  resumeUnlocks = true;
  /** 測試可換掉解碼行為（延遲、失敗、改時長）。 */
  decodeImpl: () => Promise<AudioBufferLike> = async () => fakeBuffer();
  async resume() {
    if (this.resumeUnlocks) {
      this.state = 'running';
    }
  }
  async close() {
    this.closed = true;
  }
  decodeCount = 0;
  decodeAudioData() {
    this.decodeCount++;
    return this.decodeImpl();
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

class FakeFallback implements Speaker {
  spoken: BroadcastPlan[] = [];
  stopped = 0;
  constructor(private ev: SpeakerEvents) {}
  unlock() {}
  enqueue(p: BroadcastPlan) {
    this.spoken.push(p);
    this.ev.onStart?.(p);
  }
  /** 讓測試決定 fallback 何時念完。 */
  finishCurrent(err?: string) {
    if (err) {
      this.ev.onError?.(err, this.spoken[this.spoken.length - 1]);
    } else {
      this.ev.onEnd?.(this.spoken[this.spoken.length - 1]!);
    }
  }
  pending = () => 0;
  isSpeaking = () => false;
  stop() {
    this.stopped++;
  }
  voiceName = () => 'Hanhan';
  dispose() {}
}

const okResponse = () =>
  ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Response;
/** 讓 fetch → decode → 播放這串非同步步驟跑完。用 macrotask 而不是數微任務：數幾個 tick 會隨實作的 Promise 層數變。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(fetchImpl?: (url: string, init: RequestInit) => Promise<Response>) {
  const ctx = new FakeCtx();
  let fb!: FakeFallback;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const log: string[] = [];
  const mouth: number[] = [];
  const voices: Array<string | null> = [];
  const frames: Array<() => void> = [];
  const sp = createRemoteSpeaker(
    {
      fetchFn: (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return fetchImpl ? fetchImpl(url, init) : Promise.resolve(okResponse());
      },
      createAudioContext: () => ctx,
      createFallback: (ev) => (fb = new FakeFallback(ev)),
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => undefined,
    },
    {
      endpoint: 'http://gpu.local:8090',
      timeoutMs: 50,
      rate: 1.2,
      events: {
        onStart: (p) => log.push('start:' + p.text),
        onEnd: (p) => log.push('end:' + p.text),
        onError: (e) => log.push('err:' + e),
        onBoundary: (b) => log.push('boundary:' + b.charLength),
        onVoice: (n) => voices.push(n),
        onMouth: (v) => mouth.push(v),
      },
    }
  );
  return { sp, ctx, fb: () => fb, calls, log, mouth, voices, frames };
}

describe('speechUrl / endpointLabel', () => {
  it('只填主機就補 /v1/audio/speech；填到 /v1 或完整路徑的照用', () => {
    expect(speechUrl('http://h:8090')).toBe('http://h:8090/v1/audio/speech');
    expect(speechUrl('http://h:8090/')).toBe('http://h:8090/v1/audio/speech');
    expect(speechUrl('http://h:8090/v1')).toBe('http://h:8090/v1/audio/speech');
    expect(speechUrl(' http://h/v1/audio/speech ')).toBe('http://h/v1/audio/speech');
  });
  it('標籤取主機與埠，解析不了就原樣', () => {
    expect(endpointLabel('http://gpu.local:8090/v1')).toBe('gpu.local:8090');
    expect(endpointLabel('not a url')).toBe('not a url');
  });
});

describe('mouthEnvelope', () => {
  it('有聲段開口、靜音段閉口', () => {
    const env = mouthEnvelope(fakeBuffer());
    const half = Math.floor(env.length / 2);
    expect(env.slice(0, half - 2).every((v) => v === 1)).toBe(true);
    expect(env.slice(half + 2).every((v) => v === 0)).toBe(true);
  });
  it('以這一段自己的音量為基準：整段音量縮小 3 倍，結果不變', () => {
    const loud = fakeBuffer();
    const quietData = Float32Array.from(loud.getChannelData(0), (x) => x / 3);
    const quiet: AudioBufferLike = { ...loud, getChannelData: () => quietData };
    expect(mouthEnvelope(quiet)).toEqual(mouthEnvelope(loud));
  });
  it('全靜音整段閉口', () => {
    const silent: AudioBufferLike = { ...fakeBuffer(), getChannelData: () => new Float32Array(22050) };
    expect(mouthEnvelope(silent).every((v) => v === 0)).toBe(true);
  });
  it('每格約一個 hop', () => {
    expect(mouthEnvelope(fakeBuffer()).length).toBe(Math.ceil(22050 / Math.round(22050 * ENVELOPE_HOP_SEC)));
  });
});

describe('createRemoteSpeaker', () => {
  it('一建立就回報走外部服務的聲線標籤', () => {
    const { voices } = setup();
    expect(voices).toEqual(['外部語音（gpu.local:8090）']);
  });

  it('送 OpenAI 相容請求，播完才接下一則（不疊音）', async () => {
    const { sp, ctx, calls, log } = setup();
    sp.enqueue(plan('一'));
    sp.enqueue(plan('二'));
    await flush();
    expect(calls[0]).toEqual({
      url: 'http://gpu.local:8090/v1/audio/speech',
      body: { model: 'tts-1', input: '一', voice: 'default', speed: 1.2, response_format: 'wav' },
    });
    expect(log).toEqual(['start:一']);
    expect(ctx.sources).toHaveLength(1);
    expect(sp.isSpeaking()).toBe(true);
    ctx.sources[0]!.end();
    await flush();
    expect(log).toEqual(['start:一', 'end:一', 'start:二']);
  });

  it('播第一則時就預取第二則', async () => {
    const { sp, calls } = setup();
    sp.enqueue(plan('一'));
    sp.enqueue(plan('二'));
    await flush();
    sp.enqueue(plan('三'));
    expect(calls.map((c) => c.body.input)).toEqual(['一', '二']);
  });

  it('服務回 500：那一則交給 Web Speech，念完回來接下一則', async () => {
    let n = 0;
    const { sp, ctx, fb, log, voices } = setup(async () =>
      n++ === 0 ? ({ ok: false, status: 500 } as Response) : okResponse()
    );
    sp.enqueue(plan('一'));
    sp.enqueue(plan('二'));
    await flush();
    expect(fb().spoken.map((p) => p.text)).toEqual(['一']);
    expect(voices[voices.length - 1]).toBe('引擎預設（外部語音失敗：HTTP 500，已降級）');
    expect(ctx.sources).toHaveLength(0);
    fb().finishCurrent();
    await flush();
    expect(log).toEqual(['start:一', 'end:一', 'start:二']);
    // 外部服務恢復，標籤跟著回來。
    expect(voices[voices.length - 1]).toBe('外部語音（gpu.local:8090）');
  });

  it('逾時：abort 後降級，原因寫明 timeout', async () => {
    const { sp, fb, voices } = setup(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new Error('AbortError')));
        })
    );
    sp.enqueue(plan('一'));
    await new Promise((r) => setTimeout(r, 80));
    await flush();
    expect(fb().spoken).toHaveLength(1);
    expect(voices[voices.length - 1]).toContain('timeout');
  });

  it('連不上（fetch reject）也降級，不讓佇列停住', async () => {
    const { sp, fb, log } = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    sp.enqueue(plan('一'));
    await flush();
    fb().finishCurrent('synthesis-failed');
    await flush();
    expect(log).toEqual(['start:一', 'err:synthesis-failed']);
    expect(sp.isSpeaking()).toBe(false);
  });

  it('瀏覽器擋自動播放（resume 解不開）：該則降級', async () => {
    const t = setup();
    t.ctx.state = 'suspended';
    t.ctx.resumeUnlocks = false;
    t.sp.enqueue(plan('一'));
    await new Promise((r) => setTimeout(r, 1100));
    await flush();
    expect(t.fb().spoken).toHaveLength(1);
    expect(t.voices[t.voices.length - 1]).toContain('autoplay-blocked');
  });

  it('嘴型跟著包絡走、只在改變時送出，結束時閉口', async () => {
    const { sp, ctx, mouth, frames } = setup();
    sp.enqueue(plan('一'));
    await flush();
    const run = () => frames.splice(0).forEach((f) => f());
    ctx.currentTime = 0.1;
    run();
    ctx.currentTime = 0.12;
    run();
    expect(mouth).toEqual([1]);
    ctx.currentTime = 0.8;
    run();
    expect(mouth).toEqual([1, 0]);
    ctx.sources[0]!.end();
    await flush();
    expect(mouth).toEqual([1, 0]);
  });

  it('stop()：清空佇列、停掉正在播的、通知 fallback 也停', async () => {
    const { sp, ctx, fb, log } = setup();
    sp.enqueue(plan('一'));
    sp.enqueue(plan('二'));
    await flush();
    sp.stop();
    expect(ctx.sources[0]!.stopped).toBe(true);
    expect(sp.pending()).toBe(0);
    expect(sp.isSpeaking()).toBe(false);
    expect(fb().stopped).toBe(1);
    // 被停掉那一則的 onended 晚到，不能再觸發 onEnd 或接下一則。
    ctx.sources[0]!.end();
    await flush();
    expect(log).toEqual(['start:一']);
  });

  it('dispose() 關掉 AudioContext', async () => {
    const { sp, ctx } = setup();
    sp.enqueue(plan('一'));
    await flush();
    sp.dispose();
    await flush();
    expect(ctx.closed).toBe(true);
  });
});

describe('fetch 同步丟例外', () => {
  it('不從 enqueue 炸出去，改走降級', async () => {
    const { sp, fb } = setup(() => {
      throw new ReferenceError('fetch is not defined');
    });
    expect(() => sp.enqueue(plan('一'))).not.toThrow();
    // 第二則會走**預取**：那是同步呼叫，沒包的話例外直接從 enqueue 炸出去（變異測試抓到）。
    expect(() => sp.enqueue(plan('二'))).not.toThrow();
    await flush();
    expect(fb().spoken).toHaveLength(1);
  });
});

describe('splitClauses', () => {
  it('在標點後切，太短的片段併進下一段', () => {
    expect(splitClauses('偵測到告警：WindowsHighCPU，嚴重度 warning，目前數值 91.35。')).toEqual([
      '偵測到告警：WindowsHighCPU，',
      '嚴重度 warning，',
      '目前數值 91.35。',
    ]);
  });
  it('結尾剩下的短片段併回最後一段', () => {
    expect(splitClauses('主機 CPU 使用率過高，請檢查。')).toEqual(['主機 CPU 使用率過高，請檢查。']);
    expect(splitClauses('告警已恢復：WindowsLowDisk，受影響對象 C:。')).toEqual([
      '告警已恢復：WindowsLowDisk，',
      '受影響對象 C:。',
    ]);
  });
  it('沒有標點就整句一段；空字串原樣', () => {
    expect(splitClauses('嗨')).toEqual(['嗨']);
    expect(splitClauses('')).toEqual(['']);
  });
});

describe('逐句管線', () => {
  const LONG = '偵測到告警：WindowsHighCPU，嚴重度 warning，目前數值 91.35。';

  it('逐句要音訊、預取下一句；onStart／onEnd 各一次', async () => {
    const { sp, ctx, calls, log } = setup();
    sp.enqueue(plan(LONG));
    await flush();
    // 第一句在播，第二句已預取，第三句還沒送。
    expect(calls.map((c) => c.body.input)).toEqual(['偵測到告警：WindowsHighCPU，', '嚴重度 warning，']);
    expect(log).toEqual(['start:' + LONG]);
    ctx.sources[0]!.end();
    await flush();
    expect(calls).toHaveLength(3);
    ctx.sources[1]!.end();
    await flush();
    ctx.sources[2]!.end();
    await flush();
    expect(ctx.sources).toHaveLength(3);
    expect(log).toEqual(['start:' + LONG, 'end:' + LONG]);
  });

  it('最後一句在播時預取下一則的第一句', async () => {
    const { sp, ctx, calls } = setup();
    sp.enqueue(plan('一'));
    sp.enqueue(plan('二'));
    await flush();
    expect(calls.map((c) => c.body.input)).toEqual(['一', '二']);
    ctx.sources[0]!.end();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('播到一半失敗：已念過的不重念，剩下的交給 Web Speech', async () => {
    let n = 0;
    const { sp, ctx, fb, log } = setup(async () =>
      n++ === 1 ? ({ ok: false, status: 503 } as Response) : okResponse()
    );
    sp.enqueue(plan(LONG));
    await flush();
    ctx.sources[0]!.end();
    await flush();
    expect(fb().spoken.map((p) => p.text)).toEqual(['嚴重度 warning，目前數值 91.35。']);
    fb().finishCurrent();
    await flush();
    expect(log.at(-1)).toBe('end:' + LONG);
  });
});

/** 手動控制的 Promise：測試決定它何時、以什麼結果落地。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('splitClauses：數字裡的半形標點不切', () => {
  it('IP:埠、時間、小數、千分位、網址留在同一段', () => {
    expect(splitClauses('受影響對象 192.168.1.20:9182，時間 12:30:05，數量 1,234。')).toEqual([
      '受影響對象 192.168.1.20:9182，',
      '時間 12:30:05，',
      '數量 1,234。',
    ]);
    expect(splitClauses('see http://grafana.local/d/x please')).toEqual(['see http://grafana.local/d/x please']);
  });
  it('英文句子保留標點後的空格', () => {
    expect(splitClauses('Alert firing: WindowsHighCPU, severity warning.')).toEqual([
      'Alert firing:',
      ' WindowsHighCPU,',
      ' severity warning.',
    ]);
  });
});

describe('世代：stop() 之後晚到的非同步步驟一律放手', () => {
  const LONG = '偵測到告警：WindowsHighCPU，嚴重度 warning，目前數值 91.35。';

  it('多句播到一半 stop：舊音源晚到的 onended 不會接下一句、不會 onEnd', async () => {
    const { sp, ctx, calls, log } = setup();
    sp.enqueue(plan(LONG));
    await flush();
    sp.stop();
    ctx.sources[0]!.end();
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(calls).toHaveLength(2); // 只有當時那句與預取那句
    expect(log).toEqual(['start:' + LONG]);
  });

  it('等服務回音訊時 stop：音訊晚到也不開播、不 onStart', async () => {
    const d = deferred<Response>();
    const { sp, ctx, log } = setup(() => d.promise);
    sp.enqueue(plan('一'));
    await flush();
    sp.stop();
    d.resolve(okResponse());
    await flush();
    // 連解碼都不該做 —— 解碼後還有一道世代檢查擋得住播放，但那是浪費且掩蓋了這一道（變異測試抓到）。
    expect(ctx.decodeCount).toBe(0);
    expect(ctx.sources).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it('解碼中 stop：解碼晚到也不開播', async () => {
    const { sp, ctx, log } = setup();
    const d = deferred<AudioBufferLike>();
    ctx.decodeImpl = () => d.promise;
    sp.enqueue(plan('一'));
    await flush();
    sp.stop();
    d.resolve(fakeBuffer());
    await flush();
    expect(ctx.sources).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it('降級中 stop，下一則也降級：舊那則晚到的 fallback onEnd 不會把新那則提早收掉', async () => {
    const { sp, fb, log } = setup(() => Promise.resolve({ ok: false, status: 500 } as Response));
    sp.enqueue(plan('舊'));
    await flush();
    const oldPlan = fb().spoken[0]!;
    sp.stop();
    sp.enqueue(plan('新'));
    await flush();
    expect(fb().spoken.map((p) => p.text)).toEqual(['舊', '新']);
    // 舊 utterance 被 cancel 後晚到的回呼，帶的是舊 plan。
    (fb() as unknown as { ev: SpeakerEvents }).ev.onEnd?.(oldPlan);
    (fb() as unknown as { ev: SpeakerEvents }).ev.onError?.('interrupted', oldPlan);
    await flush();
    expect(sp.isSpeaking()).toBe(true);
    expect(log).toEqual(['start:舊', 'start:新']);
    fb().finishCurrent();
    await flush();
    expect(log).toEqual(['start:舊', 'start:新', 'end:新']);
  });
});

describe('錯誤路徑', () => {
  it('從第 i>0 句降級：onStart 只發一次（不帶後半段文字再發一次）', async () => {
    const LONG = '偵測到告警：WindowsHighCPU，嚴重度 warning，目前數值 91.35。';
    let n = 0;
    const { sp, ctx, fb, log } = setup(async () =>
      n++ === 1 ? ({ ok: false, status: 503 } as Response) : okResponse()
    );
    sp.enqueue(plan(LONG));
    await flush();
    ctx.sources[0]!.end();
    await flush();
    fb().finishCurrent();
    await flush();
    expect(log).toEqual(['start:' + LONG, 'end:' + LONG]);
  });

  it('解碼失敗：降級，原因寫明', async () => {
    const { sp, ctx, fb, voices } = setup();
    ctx.decodeImpl = () => Promise.reject(new Error('EncodingError'));
    sp.enqueue(plan('一'));
    await flush();
    expect(fb().spoken).toHaveLength(1);
    expect(voices.at(-1)).toContain('EncodingError');
  });

  it('fallback.enqueue 丟例外：這則以錯誤收尾，佇列繼續', async () => {
    let n = 0;
    const { sp, ctx, fb, log } = setup(async () =>
      n++ === 0 ? ({ ok: false, status: 500 } as Response) : okResponse()
    );
    fb().enqueue = () => {
      throw new Error('boom');
    };
    sp.enqueue(plan('一'));
    sp.enqueue(plan('二'));
    await flush();
    expect(log[0]).toMatch(/^err:fallback-throw:/);
    expect(log[1]).toBe('start:二');
    expect(ctx.sources).toHaveLength(1);
  });

  it('onended 永遠不來：watchdog 在 時長 + 3 秒後收掉並降級', async () => {
    jest.useFakeTimers();
    try {
      const { sp, ctx, fb, voices } = setup();
      ctx.decodeImpl = async () => ({ ...fakeBuffer(), duration: 0.5 });
      sp.enqueue(plan('一'));
      await jest.advanceTimersByTimeAsync(10);
      expect(ctx.sources[0]!.started).toBe(true);
      await jest.advanceTimersByTimeAsync(3400);
      expect(fb().spoken).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(200);
      expect(ctx.sources[0]!.stopped).toBe(true);
      expect(voices.at(-1)).toContain('watchdog-timeout');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('逾時從輪到那一句才起算', () => {
  it('預取的下一句在服務端排隊比逾時還久，但輪到它之後很快就到：不降級', async () => {
    // 逾時 50ms。第 0 句立刻到；第 1 句在送出後 120ms 才到（排隊），而第 0 句播到 100ms 才結束。
    // 從送出起算會在 50ms 誤判逾時；從輪到它（100ms）起算只等 20ms。
    const LONG = '偵測到告警：WindowsHighCPU，嚴重度 warning。';
    let n = 0;
    const { sp, ctx, fb, log } = setup(() =>
      n++ === 0 ? Promise.resolve(okResponse()) : new Promise((r) => setTimeout(() => r(okResponse()), 120))
    );
    sp.enqueue(plan(LONG));
    await flush();
    await new Promise((r) => setTimeout(r, 100));
    ctx.sources[0]!.end();
    await new Promise((r) => setTimeout(r, 60));
    await flush();
    expect(fb().spoken).toHaveLength(0);
    expect(ctx.sources).toHaveLength(2);
    ctx.sources[1]!.end();
    await flush();
    expect(log).toEqual(['start:' + LONG, 'end:' + LONG]);
  });
});

describe('嘴型停留', () => {
  it(`每一格至少停 ${MOUTH_HOLD_MS}ms，包絡每 23ms 跳一次也不會跟著閃`, async () => {
    const { sp, ctx, mouth, frames } = setup();
    // 每兩個 hop 交替有聲／無聲（包絡視窗是兩個 hop，每 hop 交替會被平均成常數）。
    const hop = Math.round(22050 * ENVELOPE_HOP_SEC);
    const data = new Float32Array(22050);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.floor(i / hop / 2) % 2 ? 0 : i % 2 ? 0.5 : -0.5;
    }
    ctx.decodeImpl = async () => ({ duration: 1, sampleRate: 22050, numberOfChannels: 1, getChannelData: () => data });
    sp.enqueue(plan('一'));
    await flush();
    const changes: number[] = [];
    for (let t = 0; t < 400; t += 5) {
      ctx.currentTime = t / 1000;
      const before = mouth.length;
      frames.splice(0).forEach((f) => f());
      if (mouth.length > before) {
        changes.push(t);
      }
    }
    expect(changes.length).toBeGreaterThan(1);
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i]! - changes[i - 1]!).toBeGreaterThanOrEqual(MOUTH_HOLD_MS);
    }
  });
});

describe('降級中 stop', () => {
  it('stop 之後，被 cancel 的 Web Speech 晚到的 boundary 不再驅動嘴型', async () => {
    const { sp, fb, log } = setup(() => Promise.resolve({ ok: false, status: 500 } as Response));
    sp.enqueue(plan('一'));
    await flush();
    const ev = (fb() as unknown as { ev: SpeakerEvents }).ev;
    ev.onBoundary?.({ charIndex: 0, charLength: 2 });
    sp.stop();
    ev.onBoundary?.({ charIndex: 2, charLength: 3 });
    ev.onError?.('interrupted');
    await flush();
    expect(log).toEqual(['start:一', 'boundary:2']);
  });
});

/** 會理會 AbortSignal 的假 fetch：記錄每個請求是否被 abort，回應由測試決定。 */
function abortableFetch() {
  const reqs: Array<{ input: string; aborted: boolean; settle: (r: Response) => void }> = [];
  const impl = (_u: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const r = { input: JSON.parse(String(init.body)).input as string, aborted: false, settle: resolve };
      init.signal?.addEventListener('abort', () => {
        r.aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
      reqs.push(r);
    });
  return { reqs, impl };
}

describe('第二輪複審：取消與世代', () => {
  const LONG = '偵測到告警：WindowsHighCPU，嚴重度 warning，目前數值 91.35。';

  it('R1：第 0 句失敗而降級時，這則已預取的下一句被取消', async () => {
    const af = abortableFetch();
    const { sp, fb } = setup(af.impl);
    sp.enqueue(plan(LONG));
    await flush();
    expect(af.reqs.map((r) => r.input)).toEqual(['偵測到告警：WindowsHighCPU，', '嚴重度 warning，']);
    af.reqs[0]!.settle({ ok: false, status: 500 } as Response);
    await flush();
    expect(fb().spoken).toHaveLength(1);
    expect(af.reqs[1]!.aborted).toBe(true);
  });

  it('R2：請求進行中 stop：請求被 abort，而 abort 造成的失敗不會觸發降級、不改標籤', async () => {
    const af = abortableFetch();
    const { sp, fb, voices, log } = setup(af.impl);
    sp.enqueue(plan('一'));
    await flush();
    sp.stop();
    await flush();
    expect(af.reqs[0]!.aborted).toBe(true);
    expect(fb().spoken).toHaveLength(0);
    expect(voices).toEqual(['外部語音（gpu.local:8090）']);
    expect(log).toEqual([]);
  });

  it('R3（S2）：舊音源晚到的 onended 不會清掉新一代正在播的那段的嘴型與 watchdog', async () => {
    const { sp, ctx, mouth, frames } = setup();
    sp.enqueue(plan('舊'));
    await flush();
    sp.stop();
    sp.enqueue(plan('新'));
    await flush();
    expect(ctx.sources).toHaveLength(2);
    // 新那段開播，嘴型迴圈在跑。
    ctx.currentTime = 0.1;
    frames.splice(0).forEach((f) => f());
    expect(mouth.at(-1)).toBe(1);
    // 舊音源的 onended 晚到。
    ctx.sources[0]!.end();
    await flush();
    // 新那段的嘴型迴圈還在：有排下一幀，且推進到靜音段時嘴會閉上。
    expect(frames.length).toBeGreaterThan(0);
    ctx.currentTime = 0.8;
    frames.splice(0).forEach((f) => f());
    expect(mouth.at(-1)).toBe(0);
    expect(ctx.sources[1]!.stopped).toBe(false);
    expect(sp.isSpeaking()).toBe(true);
    // 而且 stop() 仍停得掉新那段 —— 舊 onended 若把共用的收尾指標清掉，這裡會停不到。
    sp.stop();
    expect(ctx.sources[1]!.stopped).toBe(true);
  });
});
