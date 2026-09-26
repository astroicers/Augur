/**
 * 嘴型擺動驅動：把一次 `onboundary` 換成 N 次張合。
 *
 * **為什麼不是振幅。** ADR-004 決策 4 與 `docs/handoff/P2-handoff.md` §四 寫的都是
 * 「`charLength` 決定**擺動次數**」。先前的實作把它做成振幅
 * （`setMouthOpen(0.35 + charLength / 14)`），那有兩個問題：
 *  1. 與已 Accepted 的 ADR 不符。
 *  2. 那條公式**永遠到不了閉口** —— 最小值 0.35 + 1/14 ≈ 0.42，嘴一路半開到底。
 *
 * 實測依據（`.asp-fact-check.md`）：中文 boundary 為詞級，`charLength` 介於 1–14，
 * 相鄰事件間隔 200–1950ms、平均約 600ms。所以擺動必須在下一個 boundary 之前跑完，
 * 且次數要跟這一組真的有幾個字掛鉤 —— 固定週期自走會讓擺動量與字數完全脫鉤。
 */

/** 一次 boundary 要擺幾下。上限 5：600ms 的平均間隔塞不下更多。 */
export function flapCount(charLength: number): number {
  if (!Number.isFinite(charLength)) {
    return 1;
  }
  return Math.max(1, Math.min(5, Math.round(charLength)));
}

/**
 * 張口幅度：兩段而非連續。門檻 4 來自實測中位數
 * （77 字 / 20 個詞級 boundary，平均 3.85）。
 */
export function flapAmplitude(charLength: number): number {
  return charLength >= 4 ? 0.95 : 0.6;
}

export interface FlapDriverOptions {
  /** 單次張口或閉口的毫秒數。張 + 閉 = 一下。 */
  halfMs?: number;
  /** 沒有 boundary 事件可用時的定速週期（見 ADR-004 決策 4 保留的 fallback）。 */
  idleMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (h: number) => void;
}

export interface FlapDriver {
  /** 收到一次 boundary。會取消尚未跑完的上一輪 —— 語音已經走到下一個詞了。 */
  boundary(charLength: number): void;
  /** 沒有 boundary 可用時的定速擺動。`speaking` 轉 false 要呼叫 `stop()`。 */
  idle(): void;
  stop(): void;
}

/**
 * @param setOpen 張口幅度 0–1 的接收端（通常是 `AvatarController.setMouthOpen`）
 */
export function createFlapDriver(setOpen: (open: number) => void, opts: FlapDriverOptions = {}): FlapDriver {
  const halfMs = opts.halfMs ?? 110;
  const idleMs = opts.idleMs ?? 220;
  const setT = opts.setTimeoutFn ?? ((f, ms) => setTimeout(f, ms) as unknown as number);
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));

  let timer: number | undefined;
  let idling = false;

  function clear() {
    if (timer !== undefined) {
      clearT(timer);
      timer = undefined;
    }
  }

  /** 跑 remaining 下張合，跑完閉口停住。 */
  function run(remaining: number, amp: number) {
    if (remaining <= 0) {
      setOpen(0);
      timer = undefined;
      return;
    }
    setOpen(amp);
    timer = setT(() => {
      setOpen(0);
      timer = setT(() => run(remaining - 1, amp), halfMs);
    }, halfMs);
  }

  return {
    boundary(charLength: number) {
      idling = false;
      clear();
      run(flapCount(charLength), flapAmplitude(charLength));
    },
    idle() {
      if (idling) {
        return;
      }
      idling = true;
      clear();
      const tick = (open: boolean) => {
        setOpen(open ? 0.6 : 0);
        timer = setT(() => tick(!open), idleMs / 2);
      };
      tick(true);
    },
    stop() {
      idling = false;
      clear();
      setOpen(0);
    },
  };
}
