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
  async resume() {
    if (this.resumeUnlocks) {
      this.state = 'running';
    }
  }
  async close() {
    this.closed = true;
  }
  async decodeAudioData() {
    return fakeBuffer();
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
      this.ev.onError?.(err);
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
