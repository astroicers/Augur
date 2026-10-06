/**
 * Web Speech API 封裝：選聲線、排隊、逐則播、對外吐嘴型同步點。
 *
 * ADR-004 決策 4 的實作。舊架構的對應物是 `src/tts/edgeTts.ts` +
 * `web/src/avatar/AvatarStage.tsx` 的音訊圖 —— 那條路在這裡整條失效，
 * 因為 Web Speech 不吐 audio buffer，接不上 AnalyserNode。
 *
 * 全檔的常數都來自 2026-09-17 的實測（Windows 11 / Chrome 152 / Microsoft Hanhan），
 * 不是猜的。完整記錄見 `.asp-fact-check.md`。
 */
import type { BroadcastPlan } from '../core/types';

/** 實測語速：77 字 / 13.766 秒。用來估 watchdog 逾時與佇列積壓。 */
export const CHARS_PER_SEC = 5.6;

/**
 * 遠端聲線每段最多念幾秒（ADR-004 決策 4）。「約 15 秒截斷」這個 bug 歷史上與遠端聲線相關；
 * 本機聲線實測連續 90 秒未中斷，所以只對 `localService === false` 的聲線切段。
 */
export const REMOTE_CHUNK_SEC = 10;

/**
 * 把一則播報切成每段不超過 maxChars 字，盡量在標點後切；單一片段本身就超長時硬切。
 * 切出來的段落接起來必須等於原文（boundary 的位置換算靠這個）。
 */
export function splitForRemoteVoice(text: string, maxChars: number): string[] {
  // 整數、至少 1：NaN 或小數會讓下面的硬切迴圈遺失或重疊文字（複審 F6）。
  const limit = Math.max(1, Math.floor(maxChars) || 1);
  if (text.length <= limit) {
    return [text];
  }
  // 半形 `, . ; ? !` 後面接數字或 `/` 時不切：`192.168.1.20`、`91.35`、`http://`。
  // 半形 `:` 不是切點：IPv6（`fe80::1ff`）、時間（`12:30`）、路徑（`C:\`）都不切；`Alert firing: X` 靠冒號後的空白切（第二輪複審 R2）。
  // 切在數字中間會被念成兩段（複審 F1；remoteSpeaker 的 splitClauses 早有同一條，實測數值單獨成段時常念錯）。
  const pieces = text.split(/(?<=[，。！？；、\s])|(?<=[,.;?!])(?![\d/])/).filter((p) => p !== '');
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };
  for (const piece of pieces) {
    if (buf.length + piece.length <= limit) {
      buf += piece;
      continue;
    }
    flush();
    // 單一片段就超過上限（長串沒有標點）：硬切。不切在 UTF-16 代理對中間（emoji 會變成亂碼，複審 F7）。
    let i = 0;
    while (piece.length - i > limit) {
      let end = i + limit;
      const code = piece.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff && end - 1 > i) {
        end -= 1;
      }
      out.push(piece.slice(i, end));
      i = end;
    }
    buf = piece.slice(i);
  }
  flush();
  return out;
}

/** 播報生命週期事件。`boundary` 是嘴型的同步點。 */
export interface SpeakerEvents {
  onStart?: (plan: BroadcastPlan) => void;
  onEnd?: (plan: BroadcastPlan) => void;
  /**
   * 實測中文**會**觸發且為詞級：77 字句 21 次，`charLength` 介於 1–14，
   * 頻率 1.53 次/秒、相鄰間隔平均約 600ms。
   * 先前假設「中文不觸發、只能定速循環」是錯的。
   * `charLength` 給出這一組的字數 —— 長組多擺幾下、短組只擺一下。
   */
  onBoundary?: (info: { charIndex: number; charLength: number }) => void;
  /** `plan` 是出錯的那一則；外部語音的降級層靠它分辨晚到的舊回呼（ADR-005）。 */
  onError?: (err: string, plan?: BroadcastPlan) => void;
  /** 挑到（或換到）的聲線名稱；null = 沒有中文聲線、用引擎預設。給畫面顯示用。 */
  onVoice?: (name: string | null) => void;
}

export interface SpeakerOptions {
  /** 空字串 = 自動挑（優先 zh-TW 且為本機引擎）。 */
  preferredVoice?: string;
  lang?: string;
  /**
   * 音高 0–2，預設 1（MDN：`SpeechSynthesisUtterance.pitch`）。部分引擎或聲線會再限縮或忽略 ——
   * 有資料指出 Edge 不支援播放音高，所以調了沒變化時先換瀏覽器或換聲線試。
   */
  pitch?: number;
  /** 語速 0.1–10，預設 1。也會用來換算 watchdog 的預估時長。 */
  rate?: number;
  events?: SpeakerEvents;
}

export interface Speaker {
  /**
   * 解鎖。實測 `speak()` **不需要** user gesture（零點擊即發聲，且是在沙箱 iframe 內），
   * 所以這個呼叫**不應該擋住首次播報** —— 它只是為了 Chrome 自動播放政策對
   * 同一 origin 有黏性、不能排除先前互動影響而保留的保險。
   */
  unlock(): void;
  /** 排入佇列。逐則播、不疊音、不截斷。 */
  enqueue(plan: BroadcastPlan): void;
  /** 目前佇列長度（不含正在播的那則）。 */
  pending(): number;
  isSpeaking(): boolean;
  /** 清空佇列並停掉目前這則。 */
  stop(): void;
  /** 目前選到的聲線名稱；還沒載完或沒有中文聲線時是 null（引擎預設）。給畫面顯示用。 */
  voiceName(): string | null;
  dispose(): void;
}

/** 取得聲線清單。實測首呼必為空、單次 `voiceschanged` 於 +17ms 後給滿。 */
export function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    // ⚠️ **這個 executor 裡不能有任何未捕捉的 throw。**
    // 它的回傳值被 `createSpeaker` 當成 `ready`，而 `enqueue` 是
    // `void ready.then(pump)` —— ready 一旦 reject，`pump` **永遠不會被呼叫**，
    // 於是佇列只進不出：`pending()` 一路往上爬、一句話都不會念、
    // 沒有 onError、UI 上沒有任何跡象。受限環境裡 `getVoices()` 或
    // `addEventListener` 丟例外是真實存在的。
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      try {
        synth.removeEventListener('voiceschanged', finish);
      } catch {
        /* 沒有 EventTarget 介面的引擎 */
      }
      try {
        resolve(synth.getVoices());
      } catch {
        resolve([]);
      }
    };
    try {
      const first = synth.getVoices();
      if (first.length) {
        done = true;
        resolve(first);
        return;
      }
      synth.addEventListener('voiceschanged', finish);
    } catch {
      // 取不到聲線不是致命的 —— 用引擎的預設聲線照樣念得出來。
      resolve([]);
      return;
    }
    // 實測 17ms 就到，2 秒是給慢機器的餘裕；逾時也回空陣列而非卡住。
    setTimeout(finish, 2000);
  });
}

/**
 * 挑聲線。順序：使用者指名（完整名稱 → 名稱裡含這段字，不分大小寫）→ zh-TW 且本機 → 任何 zh-TW → 任何 zh → null。
 * 部分比對是為了好填：聲線全名很長（`Microsoft Zhiwei - Chinese (Traditional, Taiwan)`），填 `Zhiwei` 就好。
 *
 * 偏好**本機**（`localService`）有兩個實測理由：不依賴網路；
 * 而「約 15 秒截斷」那個 bug 歷史上與遠端聲線相關，本機 Hanhan 實測連續 90 秒未中斷。
 */
export function pickVoice(voices: SpeechSynthesisVoice[], preferred?: string): SpeechSynthesisVoice | null {
  if (preferred) {
    const named = voices.find((v) => v.name === preferred);
    if (named) {
      return named;
    }
    const needle = preferred.trim().toLowerCase();
    const partial = needle ? voices.find((v) => v.name.toLowerCase().includes(needle)) : undefined;
    if (partial) {
      return partial;
    }
  }
  const zhTW = voices.filter((v) => /zh[-_]TW|Hant/i.test(v.lang));
  return zhTW.find((v) => v.localService) ?? zhTW[0] ?? voices.find((v) => /^zh/i.test(v.lang)) ?? null;
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1);

export function createSpeaker(synth: SpeechSynthesis, opts: SpeakerOptions = {}): Speaker {
  const queue: BroadcastPlan[] = [];
  let voice: SpeechSynthesisVoice | null = null;
  let speaking = false;
  let disposed = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const ready = loadVoices(synth)
    .then((vs) => {
      voice = pickVoice(vs, opts.preferredVoice);
      opts.events?.onVoice?.(voice?.name ?? null);
    })
    // ready 若 reject，enqueue 的 `void ready.then(pump)` 就再也不會 pump。
    // 沒有聲線是可以降級的（用引擎預設），靜音不是。
    .catch(() => {
      voice = null;
    });

  /**
   * 聲線清單**不是一次到位**。Chrome 在 Windows 上會多次觸發 `voiceschanged`，
   * 而第一批可能還不含 zh-TW（或使用者指名的那一支）。原本只在 `ready` 挑一次，
   * 挑到 null 就一輩子是 null —— 整個 panel 生命週期都用引擎預設聲線念中文，
   * 而且 `preferredVoice` 找不到時什麼都不會說。
   * 播報進行中不換，避免換到一半的怪聲。
   */
  let voicesDirty = false;
  const repickVoice = () => {
    try {
      const vs = synth.getVoices();
      if (!vs.length) {
        return;
      }
      const next = pickVoice(vs, opts.preferredVoice);
      if (next && next !== voice) {
        voice = next;
        opts.events?.onVoice?.(voice.name);
      }
    } catch {
      /* 取不到就維持現狀 */
    }
  };
  const onVoicesChanged = () => {
    // ⚠️ 播報中不能**丟棄**這個事件，只能**延後**（2026-09-29 複審抓到）：
    // 中文一則實測 ~14 秒，Windows/Chrome 的補批 voiceschanged 落在播報中
    // 是常態 —— 第一版直接 return，等於把「挑到 null 就一輩子是 null」
    // 又原樣搬回來。改記 dirty，這一則 finish 之後、下一則開播之前重挑。
    if (speaking) {
      voicesDirty = true;
      return;
    }
    repickVoice();
  };
  try {
    synth.addEventListener('voiceschanged', onVoicesChanged);
  } catch {
    /* 沒有 EventTarget 介面的引擎 */
  }

  function clearWatchdog() {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  }

  /** stop() 會遞增它：被 cancel 的那一段晚到的 onend／onerror 不能再接下一段或收尾。 */
  let gen = 0;

  function pump() {
    if (disposed || speaking) {
      return;
    }
    const plan = queue.shift();
    if (!plan) {
      return;
    }
    const myGen = gen;
    const rate = clamp(opts.rate ?? 1, 0.1, 10);
    // ADR-004 決策 4：「偵測到」遠端聲線才切段，本機聲線整則一次念。
    // voice 為 null（聲線還沒載到、取不到、或沒有中文聲線，交給引擎預設）時不切：
    // 沒偵測到就不切，引擎預設實際上是不是遠端聲線無從得知（複審 F5，有測試釘住）。
    const chunks =
      voice?.localService === false
        ? splitForRemoteVoice(plan.text, Math.floor(REMOTE_CHUNK_SEC * CHARS_PER_SEC * rate))
        : [plan.text];
    let settled = false;
    const finish = (err?: string) => {
      if (settled || myGen !== gen) {
        return;
      }
      settled = true;
      clearWatchdog();
      speaking = false;
      if (voicesDirty) {
        voicesDirty = false;
        repickVoice();
      }
      if (err) {
        opts.events?.onError?.(err, plan);
      } else {
        opts.events?.onEnd?.(plan);
      }
      pump();
    };

    /** 念第 i 段。onStart 只在第一段發；onEnd 只在最後一段念完時發（由 finish 送出）。 */
    const speakChunk = (i: number, offset: number) => {
      // ⚠️ **`speaking = true` 與 utterance 的建構必須在同一個 try 裡。**
      // 原本先設旗標再建構，而只有 `synth.speak(u)` 被 try 包住 ——
      // 建構或指派 handler 的任何一步丟例外，都會留下 `speaking === true`
      // 而引擎裡沒有任何 utterance：之後每一次 `pump()` 都在第一行就 return，
      // 佇列**永遠停住**，沒有 watchdog（它還沒排上）、沒有錯誤、沒有跡象。
      try {
        const text = chunks[i]!;
        const u = new SpeechSynthesisUtterance(text);
        if (voice) {
          u.voice = voice;
        }
        u.lang = opts.lang ?? 'zh-TW';
        u.pitch = clamp(opts.pitch ?? 1, 0, 2);
        u.rate = rate;

        if (i === 0) {
          u.onstart = () => {
            if (myGen === gen) {
              opts.events?.onStart?.(plan);
            }
          };
        }
        u.onend = () => {
          if (myGen !== gen || settled) {
            return;
          }
          if (i + 1 < chunks.length) {
            clearWatchdog();
            speakChunk(i + 1, offset + text.length);
          } else {
            finish();
          }
        };
        u.onerror = (ev) => finish(String((ev as SpeechSynthesisErrorEvent).error ?? 'unknown'));
        u.onboundary = (ev) => {
          if (myGen !== gen) {
            return;
          }
          opts.events?.onBoundary?.({
            // 切段後 charIndex 是段內位置；加回前面各段的長度，呼叫端看到的仍是整則的位置。
            charIndex: offset + ev.charIndex,
            // 首次 boundary 恆為 name:'sentence' 且 charLength 為 0 —— 那是句首標記不是詞，
            // 呼叫端可以用 charLength 0 判斷要不要當嘴型觸發。
            charLength: typeof ev.charLength === 'number' ? ev.charLength : 0,
          });
        };

        // watchdog（每段各自計）：估時長的兩倍加 5 秒。實測未重現「約 15 秒截斷」，但
        // `onend` 不觸發而永遠卡住是真實存在的失敗模式，沒有它佇列會整條停住。
        // ⚠️ 必須先 cancel 再 finish —— 反過來只是把「卡住且看得出來」變成「卡住且看不出來」。
        // 語速放慢時念得久，watchdog 要跟著放寬，否則慢速設定下每則都被腰斬。
        const estMs = (text.length / (CHARS_PER_SEC * rate)) * 1000;
        watchdog = setTimeout(
          () => {
            try {
              synth.cancel();
            } catch {
              /* cancel 失敗不該再讓佇列停住 */
            }
            finish('watchdog-timeout');
          },
          estMs * 2 + 5000
        );

        speaking = true;
        synth.speak(u);
      } catch (e) {
        finish('throw:' + String(e));
      }
    };
    speakChunk(0, 0);
  }

  return {
    unlock() {
      // 只是把引擎叫醒；不 await、不擋播報。
      try {
        synth.resume();
      } catch {
        /* 有些引擎沒有 resume 或在未暫停時丟例外 */
      }
    },
    enqueue(plan: BroadcastPlan) {
      queue.push(plan);
      // 聲線還沒載完就先排著 —— 載完才 pump，避免用到錯的預設聲線。
      void ready.then(pump);
    },
    pending: () => queue.length,
    voiceName: () => voice?.name ?? null,
    isSpeaking: () => speaking,
    stop() {
      queue.length = 0;
      gen++;
      clearWatchdog();
      speaking = false;
      try {
        synth.cancel();
      } catch {
        /* 同上 */
      }
    },
    dispose() {
      disposed = true;
      try {
        synth.removeEventListener('voiceschanged', onVoicesChanged);
      } catch {
        /* 同上 */
      }
      this.stop();
    },
  };
}
