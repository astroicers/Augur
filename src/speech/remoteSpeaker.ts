/**
 * 外部語音服務（OpenAI 相容 `POST /v1/audio/speech`）的播報器。ADR-005 的實作。
 *
 * 對外是同一個 `Speaker` 介面，面板不必知道走的是哪一條路。語意沿用 `speaker.ts`：
 * 逐則播、不疊音、不截斷、有 watchdog、任何一步丟例外都不能讓佇列停住。
 *
 * 任何一則失敗（連不上、非 2xx、逾時、解不開、瀏覽器擋自動播放）就把**那一則**交給
 * Web Speech 念（ADR-005 決策 3），念完回來接下一則。不做熔斷：告警稀疏，熔斷的狀態
 * 反而會讓服務恢復後還在念機器人聲。
 *
 * 播放一律走 Web Audio，不用 `<audio>` + blob 網址：Grafana 的 CSP 模板含
 * `media-src 'none'`，啟用 CSP 的站台會擋 `<audio>`；Web Audio 只受 `connect-src` 管
 * （ADR-005 決策 5、待驗風險 1）。
 */
import type { BroadcastPlan } from '../core/types';
import type { Speaker, SpeakerEvents } from './speaker';

/** ADR-005 決策 3：實測一般 3–8 秒、離群值 32 秒；15 秒是「寧可降級也不要讓告警晚半分鐘」。 */
export const DEFAULT_TIMEOUT_MS = 15000;

export interface RemoteSpeakerEvents extends SpeakerEvents {
  /** 幀級張口幅度 0／0.5／1，只在數值改變時呼叫。接 `AvatarController.setMouthOpen`。 */
  onMouth?: (open: number) => void;
}

export interface RemoteSpeakerOptions {
  /** 服務位址。可以只填主機（`http://gpu:8080`），也可以填到 `/v1` 或完整的 `/v1/audio/speech`。 */
  endpoint: string;
  timeoutMs?: number;
  /** 送給服務的 `speed`。播放端不再變速，免得套兩次。 */
  rate?: number;
  events?: RemoteSpeakerEvents;
}

/** 只用到 Web Audio 的這幾個成員；測試用假物件替換。 */
export interface AudioBufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(ch: number): Float32Array;
}
export interface BufferSourceLike {
  buffer: AudioBufferLike | null;
  onended: ((ev: Event) => void) | null;
  connect(dest: unknown): unknown;
  start(): void;
  stop(): void;
}
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBufferSource(): BufferSourceLike;
}

export interface RemoteSpeakerDeps {
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  createAudioContext: () => AudioContextLike;
  /** 降級用的 Web Speech 播報器。events 由本模組包一層，好知道它何時念完。 */
  createFallback: (events: SpeakerEvents) => Speaker;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (h: number) => void;
}

/** 補上 `/v1/audio/speech`。已經寫到那一層的照用。 */
export function speechUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (/\/audio\/speech$/.test(base)) {
    return base;
  }
  return /\/v1$/.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`;
}

/** 給聲線標籤看的短名：主機與埠。解析失敗就原樣。 */
export function endpointLabel(endpoint: string): string {
  try {
    return new URL(endpoint.trim()).host || endpoint.trim();
  } catch {
    return endpoint.trim();
  }
}

/** 包絡的取樣間距（秒）。約 23ms，比一幀（16ms）粗、比一個音節（~150ms）細。 */
export const ENVELOPE_HOP_SEC = 512 / 22050;

/**
 * 從整段音訊算嘴型包絡，回傳每個 hop 的張口值 0／0.5／1。
 *
 * 為什麼不用 AnalyserNode 即時算：同一個服務的兩段輸出音量差到 3 倍（2026-10-05 實測：
 * 一段 RMS p90 0.162、另一段 0.048），固定門檻一定有一段整句閉嘴或整句全開。
 * 解碼後整段都在手上，拿**這一段自己的** p90 當基準就沒有這個問題，而且是純函式、測得到。
 *
 * 門檻：相對 p90 低於 0.2 閉嘴、低於 0.7 半開、其餘全開（`spriteSheet.ts` 的
 * `MOUTH_WIDE_THRESHOLD` 是 0.8，所以全開給 1、半開給 0.5）。
 */
export function mouthEnvelope(buf: AudioBufferLike, hopSec = ENVELOPE_HOP_SEC): number[] {
  const data = buf.getChannelData(0);
  const hop = Math.max(1, Math.round(buf.sampleRate * hopSec));
  const rms: number[] = [];
  for (let i = 0; i < data.length; i += hop) {
    const end = Math.min(data.length, i + hop * 2);
    let sum = 0;
    for (let j = i; j < end; j++) {
      sum += data[j]! * data[j]!;
    }
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const voiced = rms.filter((r) => r > 1e-3).sort((a, b) => a - b);
  if (!voiced.length) {
    return rms.map(() => 0);
  }
  const ref = voiced[Math.min(voiced.length - 1, Math.floor(voiced.length * 0.9))]!;
  return rms.map((r) => {
    const level = r / ref;
    return level < 0.2 ? 0 : level < 0.7 ? 0.5 : 1;
  });
}

/**
 * 把一則播報切成短句，逐句向服務要音訊（ADR-005 決策 3 的延遲對策）。
 *
 * 為什麼在 client 切：服務產語音的時間約等於語音長度（2026-10-05 實測，RTX 4070：
 * 語言模型 ~90 token/s、50 token = 1 秒語音），而一則告警念出來 10–25 秒。整則要完才播，
 * 就是整則的時間都在空等 —— 實測 30 則 p50 15.5 秒、最慢 36.8 秒。逐句要、第一句回來就播、
 * 播的同時要下一句，開口等待只剩第一句的 2–4 秒；生成比播放快，後面接得上。
 *
 * 太短的片段併進下一段：「偵測到告警：」單獨一段只是多一次請求與一次停頓。
 */
export function splitClauses(text: string, minChars = 8): string[] {
  const raw = text.split(/(?<=[，,：:；;。！？!?])\s*/).filter((s) => s.trim() !== '');
  const out: string[] = [];
  let buf = '';
  for (const piece of raw) {
    buf += piece;
    if (buf.replace(/\s/g, '').length >= minChars) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) {
    if (out.length) {
      out[out.length - 1] += buf;
    } else {
      out.push(buf);
    }
  }
  return out.length ? out : [text];
}

/** 嘴型每一格至少停留這麼久，免得 23ms 一跳變成閃爍。 */
const MOUTH_HOLD_MS = 80;
/** 等自動播放解鎖的上限。超過就當作被擋，該則降級。 */
const RESUME_WAIT_MS = 1000;

interface Entry {
  plan: BroadcastPlan;
  clauses: string[];
  /** 逐句的音訊請求；還沒送出的是 undefined。 */
  audio: Array<Promise<ArrayBuffer> | undefined>;
}

export function createRemoteSpeaker(deps: RemoteSpeakerDeps, opts: RemoteSpeakerOptions): Speaker {
  const ev = opts.events ?? {};
  const url = speechUrl(opts.endpoint);
  const remoteLabel = `外部語音（${endpointLabel(opts.endpoint)}）`;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const raf = deps.requestFrame ?? ((cb: () => void) => setTimeout(cb, 16) as unknown as number);
  const caf = deps.cancelFrame ?? ((h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));

  const queue: Entry[] = [];
  /** 正在播（或正在等服務）的那一則；預取下一句時要看它。 */
  let current: { entry: Entry; index: number } | null = null;
  let speaking = false;
  let disposed = false;
  /** stop() 會遞增它；非同步步驟回來時比對，不是同一代就放手。 */
  let gen = 0;
  let label: string = remoteLabel;
  let fallbackVoice: string | null = null;
  let ctx: AudioContextLike | null = null;
  let source: BufferSourceLike | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let mouth = 0;
  /** 正在由 fallback 念的那一則念完時要呼叫的收尾。 */
  let fallbackDone: ((err?: string) => void) | null = null;

  const setLabel = (next: string) => {
    if (next !== label) {
      label = next;
      ev.onVoice?.(label);
    }
  };
  const setMouth = (v: number) => {
    if (v !== mouth) {
      mouth = v;
      ev.onMouth?.(v);
    }
  };

  const fallback = deps.createFallback({
    onStart: (p) => ev.onStart?.(p),
    onBoundary: (b) => ev.onBoundary?.(b),
    onVoice: (name) => {
      fallbackVoice = name;
    },
    onEnd: () => {
      const done = fallbackDone;
      fallbackDone = null;
      done?.();
    },
    onError: (e) => {
      const done = fallbackDone;
      fallbackDone = null;
      done?.(e);
    },
  });

  function ensureCtx(): AudioContextLike {
    if (!ctx) {
      ctx = deps.createAudioContext();
    }
    return ctx;
  }

  function startFetch(text: string): Promise<ArrayBuffer> {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ac?.abort(), timeoutMs);
    // ⚠️ 包在 then 裡呼叫：fetchFn **同步**丟例外（沒有 fetch 的環境、URL 不合法）時，
    // 直接呼叫會從 pump() 的 try 外面炸出去，佇列停住 —— 這裡讓它變成一般的 rejection、走降級。
    const p = Promise.resolve()
      .then(() =>
        deps.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'tts-1',
            input: text,
            voice: 'default',
            speed: opts.rate ?? 1,
            response_format: 'wav',
          }),
          ...(ac ? { signal: ac.signal } : {}),
        })
      )
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.arrayBuffer();
      })
      .catch((e: unknown) => {
        // 逾時的 abort 會以 AbortError 落到這裡；換成看得懂的字。
        throw new Error(ac?.signal.aborted ? 'timeout' : e instanceof Error ? e.message : String(e));
      })
      .finally(() => clearTimeout(timer));
    // 預取的那一句可能在被取用前就失敗；先掛一個空 catch，免得變成未處理的 rejection。
    p.catch(() => undefined);
    return p;
  }

  function audioFor(entry: Entry, i: number): Promise<ArrayBuffer> {
    return (entry.audio[i] ??= startFetch(entry.clauses[i]!));
  }

  /**
   * 預取「下一句」：同一則的下一句，或這則已是最後一句時、下一則的第一句。
   * 只預取一句：服務是單一 GPU 且推論加鎖，一次塞多句只會讓正在等的那一句排更久、更容易逾時。
   * ⚠️ enqueue 時也要呼叫：第一則 enqueue 時立刻開播，那時第二則還沒進佇列（單元測試抓到的）。
   */
  function prefetchNext() {
    if (!current) {
      return;
    }
    const { entry, index } = current;
    if (index + 1 < entry.clauses.length) {
      void audioFor(entry, index + 1);
    } else if (queue[0]) {
      void audioFor(queue[0], 0);
    }
  }

  async function playable(c: AudioContextLike): Promise<boolean> {
    if (c.state !== 'suspended') {
      return true;
    }
    await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
    return c.state !== 'suspended';
  }

  function clearTimers() {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
    if (frame !== undefined) {
      caf(frame);
      frame = undefined;
    }
  }

  /** 播一段已解碼的音訊，播完 resolve；watchdog 逾時 reject。 */
  function playBuffer(c: AudioContextLike, buf: AudioBufferLike): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = mouthEnvelope(buf);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.onended = () => {
        clearTimers();
        resolve();
      };
      source = src;
      const t0 = c.currentTime;
      src.start();
      // onended 不觸發而永遠卡住是 Web Speech 踩過的失敗模式，這裡一樣防。
      watchdog = setTimeout(
        () => {
          try {
            src.stop();
          } catch {
            /* 已停 */
          }
          clearTimers();
          reject(new Error('watchdog-timeout'));
        },
        buf.duration * 1000 + 3000
      );
      let heldUntil = 0;
      const tick = () => {
        const t = (c.currentTime - t0) * 1000;
        const v = env[Math.floor(t / 1000 / ENVELOPE_HOP_SEC)] ?? 0;
        if (v !== mouth && t >= heldUntil) {
          setMouth(v);
          heldUntil = t + MOUTH_HOLD_MS;
        }
        frame = raf(tick);
      };
      frame = raf(tick);
    });
  }

  function pump() {
    if (disposed || speaking) {
      return;
    }
    const entry = queue.shift();
    if (!entry) {
      return;
    }
    speaking = true;
    const myGen = gen;
    let settled = false;
    current = { entry, index: 0 };

    const finish = (err?: string) => {
      if (settled || myGen !== gen) {
        return;
      }
      settled = true;
      clearTimers();
      setMouth(0);
      source = null;
      current = null;
      speaking = false;
      if (err) {
        ev.onError?.(err);
      } else {
        ev.onEnd?.(entry.plan);
      }
      pump();
    };

    /** 從第 from 句起改由 Web Speech 念完。已經念過的句子不重念。 */
    const degrade = (reason: string, from: number) => {
      if (settled || myGen !== gen) {
        return;
      }
      setLabel(`${fallbackVoice ?? '引擎預設'}（外部語音失敗：${reason}，已降級）`);
      fallbackDone = finish;
      const rest = from === 0 ? entry.plan : { ...entry.plan, text: entry.clauses.slice(from).join('') };
      try {
        fallback.enqueue(rest);
      } catch (e) {
        fallbackDone = null;
        finish('fallback-throw:' + String(e));
      }
    };

    void (async () => {
      let i = 0;
      try {
        for (; i < entry.clauses.length; i++) {
          current = { entry, index: i };
          const pending = audioFor(entry, i);
          prefetchNext();
          const data = await pending;
          if (myGen !== gen) {
            return;
          }
          const c = ensureCtx();
          if (!(await playable(c))) {
            throw new Error('autoplay-blocked');
          }
          const buf = await c.decodeAudioData(data);
          if (myGen !== gen) {
            return;
          }
          if (i === 0) {
            setLabel(remoteLabel);
            ev.onStart?.(entry.plan);
          }
          await playBuffer(c, buf);
          if (myGen !== gen) {
            return;
          }
          setMouth(0);
        }
        finish();
      } catch (e) {
        degrade(e instanceof Error ? e.message : String(e), i);
      }
    })();
  }

  // 面板的聲線標籤一開始就要寫明走外部服務，不然在第一則之前會顯示「引擎預設」。
  ev.onVoice?.(label);

  return {
    unlock() {
      // 使用者手勢裡建立／喚醒 AudioContext，之後的播放才不會被自動播放政策擋。
      try {
        void ensureCtx()
          .resume()
          .catch(() => undefined);
      } catch {
        /* 沒有 Web Audio 的環境：每則都會降級，不是致命 */
      }
      fallback.unlock();
    },
    enqueue(plan: BroadcastPlan) {
      const clauses = splitClauses(plan.text);
      queue.push({ plan, clauses, audio: clauses.map(() => undefined) });
      pump();
      prefetchNext();
    },
    pending: () => queue.length,
    isSpeaking: () => speaking,
    voiceName: () => label,
    stop() {
      queue.length = 0;
      gen++;
      clearTimers();
      fallbackDone = null;
      try {
        source?.stop();
      } catch {
        /* 已停 */
      }
      source = null;
      current = null;
      speaking = false;
      setMouth(0);
      fallback.stop();
    },
    dispose() {
      disposed = true;
      this.stop();
      fallback.dispose();
      void ctx?.close().catch(() => undefined);
      ctx = null;
    },
  };
}
