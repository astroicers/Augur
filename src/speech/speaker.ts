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
  onError?: (err: string) => void;
}

export interface SpeakerOptions {
  /** 空字串 = 自動挑（優先 zh-TW 且為本機引擎）。 */
  preferredVoice?: string;
  lang?: string;
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
  dispose(): void;
}

/** 取得聲線清單。實測首呼必為空、單次 `voiceschanged` 於 +17ms 後給滿。 */
export function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const first = synth.getVoices();
    if (first.length) {
      resolve(first);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      synth.removeEventListener('voiceschanged', finish);
      resolve(synth.getVoices());
    };
    synth.addEventListener('voiceschanged', finish);
    // 實測 17ms 就到，2 秒是給慢機器的餘裕；逾時也回空陣列而非卡住。
    setTimeout(finish, 2000);
  });
}

/**
 * 挑聲線。順序：使用者指名 → zh-TW 且本機 → 任何 zh-TW → 任何 zh → null。
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
  }
  const zhTW = voices.filter((v) => /zh[-_]TW|Hant/i.test(v.lang));
  return zhTW.find((v) => v.localService) ?? zhTW[0] ?? voices.find((v) => /^zh/i.test(v.lang)) ?? null;
}

export function createSpeaker(synth: SpeechSynthesis, opts: SpeakerOptions = {}): Speaker {
  const queue: BroadcastPlan[] = [];
  let voice: SpeechSynthesisVoice | null = null;
  let speaking = false;
  let disposed = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const ready = loadVoices(synth).then((vs) => {
    voice = pickVoice(vs, opts.preferredVoice);
  });

  function clearWatchdog() {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  }

  function pump() {
    if (disposed || speaking) {
      return;
    }
    const plan = queue.shift();
    if (!plan) {
      return;
    }
    speaking = true;

    const u = new SpeechSynthesisUtterance(plan.text);
    if (voice) {
      u.voice = voice;
    }
    u.lang = opts.lang ?? 'zh-TW';

    let settled = false;
    const finish = (err?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearWatchdog();
      speaking = false;
      if (err) {
        opts.events?.onError?.(err);
      } else {
        opts.events?.onEnd?.(plan);
      }
      pump();
    };

    u.onstart = () => opts.events?.onStart?.(plan);
    u.onend = () => finish();
    u.onerror = (ev) => finish(String((ev as SpeechSynthesisErrorEvent).error ?? 'unknown'));
    u.onboundary = (ev) => {
      opts.events?.onBoundary?.({
        charIndex: ev.charIndex,
        // 首次 boundary 恆為 name:'sentence' 且 charLength 為 0 —— 那是句首標記不是詞，
        // 呼叫端可以用 charLength 0 判斷要不要當嘴型觸發。
        charLength: typeof ev.charLength === 'number' ? ev.charLength : 0,
      });
    };

    // watchdog：估時長的兩倍加 5 秒。實測未重現「約 15 秒截斷」，但
    // `onend` 不觸發而永遠卡住是真實存在的失敗模式，沒有它佇列會整條停住。
    // ⚠️ 必須先 cancel 再 finish —— 反過來只是把「卡住且看得出來」變成「卡住且看不出來」。
    const estMs = (plan.text.length / CHARS_PER_SEC) * 1000;
    watchdog = setTimeout(() => {
      try {
        synth.cancel();
      } catch {
        /* cancel 失敗不該再讓佇列停住 */
      }
      finish('watchdog-timeout');
    }, estMs * 2 + 5000);

    try {
      synth.speak(u);
    } catch (e) {
      finish('throw:' + String(e));
    }
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
    isSpeaking: () => speaking,
    stop() {
      queue.length = 0;
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
      this.stop();
    },
  };
}
