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
 * 太短的片段併進下一段（不足 16 字）：「偵測到告警：」單獨一段只是多一次請求與一次停頓；而且上下文太短時
 * 數字最容易念錯 —— 2026-10-05 實測「目前數值 91.35。」單獨成段 4 次錯 3 次，整句合成 3 次全對。
 * 原本 8 字，改 16（伺服器端 `MIN_CLAUSE_CHARS` 同值，否則合好的段落到伺服器又被切開）。
 *
 * 半形的 `, : ; ? !` 後面接數字或 `/` 時不切：`192.168.1.20:9182`、`12:30:05`、`http://`、`1,234`
 * 切開會變成兩次請求、中間多一個停頓（複審 2026-10-05 指出）。全形標點一律切。
 * 不吃掉標點後的空白，英文句子送出去時字與字之間的空格還在。
 */
export function splitClauses(text: string, minChars = 16): string[] {
  const raw = text.split(/(?<=[，：；。！？]|[,:;?!](?![\d/]))/).filter((s) => s.trim() !== '');
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
export const MOUTH_HOLD_MS = 80;
/** 等自動播放解鎖的上限。超過就當作被擋，該則降級。 */
const RESUME_WAIT_MS = 1000;

interface Fetching {
  promise: Promise<ArrayBuffer>;
  abort(reason: string): void;
}

interface Entry {
  plan: BroadcastPlan;
  clauses: string[];
  /** 逐句的音訊請求；還沒送出的是 undefined。 */
  audio: Array<Fetching | undefined>;
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
  /**
   * 正在播的那一段的收尾（停音源、清它自己的 watchdog 與 frame）。
   * ⚠️ 計時器是**每段自己的**，不是模組共用的：被 stop 掉的音源晚到的 onended
   * 若去清共用的 watchdog，會清到下一代正在播的那一段（複審 S2）。
   */
  let stopPlayback: (() => void) | null = null;
  let mouth = 0;
  /**
   * 正在由 fallback 念的那一則。回呼以 **plan 物件身分**比對：被 stop 掉的舊 utterance
   * 晚到的 onEnd／onError 帶的是舊 plan，不會被當成新那則念完（複審 S1）。
   * `suppressStart`：從第 i>0 句才降級時，這則的 onStart 早就發過了，不再發第二次（複審 F4）。
   */
  let fallbackPending: { plan: BroadcastPlan; done: (err?: string) => void; suppressStart: boolean } | null = null;

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
    onStart: (p) => {
      if (fallbackPending?.plan === p && !fallbackPending.suppressStart) {
        ev.onStart?.(p);
      }
    },
    onBoundary: (b) => {
      if (fallbackPending) {
        ev.onBoundary?.(b);
      }
    },
    onVoice: (name) => {
      fallbackVoice = name;
    },
    onEnd: (p) => {
      if (fallbackPending?.plan === p) {
        const { done } = fallbackPending;
        fallbackPending = null;
        done();
      }
    },
    onError: (e, p) => {
      // 沒帶 plan 的實作（例如面板的 unavailableSpeaker 以外的第三方）只能信任它是當前這則。
      if (fallbackPending && (p === undefined || p === fallbackPending.plan)) {
        const { done } = fallbackPending;
        fallbackPending = null;
        done(e);
      }
    },
  });

  function ensureCtx(): AudioContextLike {
    if (!ctx) {
      ctx = deps.createAudioContext();
    }
    return ctx;
  }

  /** 送出一句的請求。正常的逾時**不在這裡計** —— 見 awaitClause；這裡只有防漏的絕對上限。 */
  function startFetch(text: string): Fetching {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let reason: string | null = null;
    // 絕對上限：任何請求不論有沒有人在等，最久活這麼久。逾時從輪到該句才起算，
    // 萬一哪條路徑漏了 abort（R1 那類），這道保證請求不會永遠掛著、佔著連線。
    const ceiling = setTimeout(
      () => {
        reason ??= 'timeout';
        ac?.abort();
      },
      Math.max(60000, timeoutMs * 4)
    );
    // ⚠️ 包在 then 裡呼叫：fetchFn **同步**丟例外（沒有 fetch 的環境、URL 不合法）時，
    // 直接呼叫會從 pump() 的 try 外面炸出去，佇列停住 —— 這裡讓它變成一般的 rejection、走降級。
    const promise = Promise.resolve()
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
        // abort 會以 AbortError 落到這裡；換成我們自己記的原因（timeout／stopped）。
        throw new Error(reason ?? (e instanceof Error ? e.message : String(e)));
      })
      .finally(() => clearTimeout(ceiling));
    // 預取的那一句可能在被取用前就失敗；先掛一個空 catch，免得變成未處理的 rejection。
    promise.catch(() => undefined);
    return {
      promise,
      abort(r: string) {
        reason ??= r;
        ac?.abort();
      },
    };
  }

  function fetchFor(entry: Entry, i: number): Fetching {
    return (entry.audio[i] ??= startFetch(entry.clauses[i]!));
  }

  /**
   * 等第 i 句的音訊，逾時從**輪到它的時候**才起算。
   * 原本從送出請求就計時：預取的下一句在伺服器上要先等前一句的推論鎖，那段排隊時間也被算進
   * 逾時，冷啟動時「伺服器不慢、只是在排隊」的句子會被誤判逾時而降級（複審 F2）。
   * 用 race 而不只靠 abort：沒有 AbortController 的環境也要能逾時。
   */
  async function awaitClause(entry: Entry, i: number): Promise<ArrayBuffer> {
    const f = fetchFor(entry, i);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        f.abort('timeout');
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([f.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 預取「下一句」：同一則的下一句，或這則已是最後一句時、下一則的第一句。
   * 只預取一句：服務是單一 GPU 且推論加鎖，一次塞多句只會讓正在等的那一句排更久。
   * ⚠️ enqueue 時也要呼叫：第一則 enqueue 時立刻開播，那時第二則還沒進佇列（單元測試抓到的）。
   */
  function prefetchNext() {
    if (!current) {
      return;
    }
    const { entry, index } = current;
    if (index + 1 < entry.clauses.length) {
      fetchFor(entry, index + 1);
    } else if (queue[0]) {
      fetchFor(queue[0], 0);
    }
  }

  async function playable(c: AudioContextLike): Promise<boolean> {
    if (c.state !== 'suspended') {
      return true;
    }
    await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
    return c.state !== 'suspended';
  }

  /** 播一段已解碼的音訊，播完 resolve；watchdog 逾時 reject。stop() 經 stopPlayback 收掉它。 */
  function playBuffer(c: AudioContextLike, buf: AudioBufferLike): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = mouthEnvelope(buf);
      const src = c.createBufferSource();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let frame: number | undefined;
      const cleanup = () => {
        clearTimeout(watchdog);
        if (frame !== undefined) {
          caf(frame);
          frame = undefined;
        }
        if (stopPlayback === halt) {
          stopPlayback = null;
        }
      };
      const halt = () => {
        cleanup();
        try {
          src.stop();
        } catch {
          /* 已停 */
        }
      };
      src.buffer = buf;
      src.connect(c.destination);
      src.onended = () => {
        cleanup();
        resolve();
      };
      stopPlayback = halt;
      const t0 = c.currentTime;
      src.start();
      // onended 不觸發而永遠卡住是 Web Speech 踩過的失敗模式，這裡一樣防。
      watchdog = setTimeout(
        () => {
          halt();
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
      // 世代檢查在這裡是縱深防禦：每個呼叫 finish 的路徑上游都已檢查過，變異測試拿掉它不會轉紅（等價變異）。
      // 留著是因為下一個加呼叫點的人不一定記得先檢查。
      if (settled || myGen !== gen) {
        return;
      }
      settled = true;
      stopPlayback?.();
      setMouth(0);
      current = null;
      speaking = false;
      if (err) {
        ev.onError?.(err, entry.plan);
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
      // 這則剩下的句子改由 Web Speech 念，已送出的預取用不到了 —— 取消掉。不取消的話它們沒有人 await、
      // 也就沒有逾時計時器（逾時從輪到該句才起算），服務卡住時會一直佔著瀏覽器對同一主機的連線
      // （2026-10-05 第二輪複審 R1）。下一則第一句的預取不在 entry 裡，不受影響。
      entry.audio.forEach((f, j) => {
        if (j >= from) {
          f?.abort('degraded');
        }
      });
      const rest = from === 0 ? entry.plan : { ...entry.plan, text: entry.clauses.slice(from).join('') };
      fallbackPending = { plan: rest, done: finish, suppressStart: from > 0 };
      try {
        fallback.enqueue(rest);
      } catch (e) {
        fallbackPending = null;
        finish('fallback-throw:' + String(e));
      }
    };

    void (async () => {
      let i = 0;
      try {
        for (; i < entry.clauses.length; i++) {
          current = { entry, index: i };
          const pending = awaitClause(entry, i);
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
      // 送出去的請求一併 abort：結果反正會被世代檢查丟掉，不必讓瀏覽器等完。
      // （伺服器端已開始的推論停不下來 —— 這是 HTTP 的限制，不是這裡能管的。）
      for (const e of [...(current ? [current.entry] : []), ...queue]) {
        e.audio.forEach((f) => f?.abort('stopped'));
      }
      queue.length = 0;
      gen++;
      fallbackPending = null;
      stopPlayback?.();
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
