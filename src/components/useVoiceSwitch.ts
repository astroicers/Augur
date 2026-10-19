/**
 * 語音開關（ADR-007）的狀態、同步與補念觸發，收成一個 hook。
 *
 * #83 從 `MascotPanel.tsx` 搬出來。搬之前這幾件事由元件裡的兩個 ref、兩個 state、
 * 一個 effect 與兩個 callback 拼起來，而其中**按下開關時「補念並解鎖語音引擎」那一段
 * 的時序**（先叫醒引擎 → 認下被擋的聲線標籤 → 清錯誤訊息 → 依序補念 → 更新佇列長度）
 * 只寫在元件裡，測不到也看不出來。現在它是這一支裡的一個函式。
 *
 * ADR-007 的三項決策，各自住在哪裡：
 *
 * 1. **每瀏覽器靜音** —— 儲存與同頁／跨分頁同步在 `src/speech/muteStore.ts`（#82），
 *    本檔只接線：初始值 `readMuted()`、切換後 `publishMuted()`、訂閱 `watchMuted()`。
 *    **沒有替身**：本 hook 直接呼叫那三支，所以它的測試走的是真的 `localStorage`。
 * 2. **10 分鐘內按一下補念** —— 時限與修剪在 `src/speech/blockedQueue.ts`（純模組、注入時鐘）。
 * 3. **同一則只補最後狀態** —— 同上，同一支純模組。
 *
 * 本檔不碰 avatar、不碰 feed、不碰導播：要停嘴型／歸零 speaking 時呼叫 `onSilenced`，
 * 要更新佇列長度時呼叫 `onPending`。元件因此不必為了「誰先誰後」而排 effect 的宣告順序。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BroadcastPlan } from '../core/types';
import { createBlockedQueue } from '../speech/blockedQueue';
import { publishMuted, readMuted, watchMuted } from '../speech/muteStore';
import type { Speaker } from '../speech/speaker';

/** 外部語音被自動播放政策擋下時，`remoteSpeaker` 寫在聲線標籤裡的原因字串。 */
export const AUTOPLAY_BLOCKED = 'autoplay-blocked';

export interface VoiceSwitchHost {
  /**
   * 取目前的播報器。**交付當下才讀**：換語音選項會把它整個重建，
   * 掛載時抓一次的話按下開關停的是上一個（已 dispose）的那一個。
   */
  speaker: () => Speaker | null;
  /** 播報器回報的聲線名稱（`onVoice`）。外部語音降級時原因就寫在這個標籤裡。 */
  voiceName: string | null;
  /** 最近一次播報錯誤。`'not-allowed'` ＝ 瀏覽器在使用者互動前不准發聲。 */
  speechErr: string | null;
  /**
   * 切到靜音時元件那一側的收尾：停嘴型驅動、嘴型歸零、speaking 歸零。
   * 播報器自己的 `stop()` 由本 hook 呼叫（`stop()` 之後不會再有 `onEnd`，複審 F1）。
   */
  onSilenced: () => void;
  /** 佇列長度變了（切到靜音、補念送出）。 */
  onPending: (pending: number) => void;
  /** 補念要開始了：把畫面上那一行錯誤訊息清掉（補念之前，不是之後）。 */
  onReplay: () => void;
}

export interface VoiceSwitch {
  /** 給畫面用的靜音狀態。 */
  muted: boolean;
  /**
   * 開著、但瀏覽器擋著（使用者還沒在頁面上互動過）。按鈕要邀請「啟用」，
   * 不能讓人一按就變靜音 —— 那正是 EKS 實測（2026-10-14）踩到的症狀。
   */
  blocked: boolean;
  /** 靜音狀態的**同步**讀法，給導播的 `muted()` 用（不等 React 重繪）。 */
  isMuted: () => boolean;
  /** 被瀏覽器擋下的告警句進補念佇列。試聽不收 —— 那由呼叫端以物件身分判斷（F7）。 */
  recordBlocked: (plan: BroadcastPlan) => void;
  /** 聲線標籤變了。標籤一旦不再是「被擋」就把「已確認」清掉，之後再被擋會再提示（N1）。 */
  noteVoiceName: (name: string | null) => void;
  /** 按下開關。被擋時是「叫醒 + 補念」，否則是「切換靜音」。 */
  toggle: () => void;
}

/**
 * 「開著但被擋」的判定。外部語音（ADR-005）被自動播放政策擋下時**不會丟錯誤**，
 * 而是降級並把原因寫進聲線標籤；喚醒 `AudioContext` 一樣要在使用者手勢裡呼叫 `unlock`，
 * 所以那也算「被擋」（複審 F3）。
 *
 * `autoplayAck` 是使用者已經為某個聲線標籤按過一次的紀錄：標籤要等**下一次外部語音成功**
 * 才會改回，不記下來的話按鈕會一直停在「點一下啟用語音」、按不到靜音（第二輪複審 N1）。
 */
export function voiceBlockedBy(s: {
  muted: boolean;
  speechErr: string | null;
  voiceName: string | null;
  autoplayAck: string | null;
}): boolean {
  return (
    !s.muted &&
    (s.speechErr === 'not-allowed' || ((s.voiceName ?? '').includes(AUTOPLAY_BLOCKED) && s.voiceName !== s.autoplayAck))
  );
}

export function useVoiceSwitch({
  speaker,
  voiceName,
  speechErr,
  onSilenced,
  onPending,
  onReplay,
}: VoiceSwitchHost): VoiceSwitch {
  // 靜音：state 給畫面，ref 給**交付當下**讀（導播的 `muted()`、同頁同步的早退判斷）。
  // 同頁同步是在同一個 click 事件裡同步派送的，兩個 panel 的 applyMuted 在同一個 tick 裡
  // 跑完 —— 等 React 重繪才更新的話，第二個 panel 會看到舊值而把開關再翻回去。
  const [muted, setMuted] = useState<boolean>(readMuted);
  const mutedRef = useRef(muted);
  // 使用者已經為「外部語音被擋」按過一次的那個聲線標籤（見 voiceBlockedBy）。
  const [autoplayAck, setAutoplayAck] = useState<string | null>(null);
  // D10：補念佇列是**有狀態**的物件，不能每輪重建（重建就等於清空）。
  // `useState` 的初始值只在掛載時算一次，StrictMode 重跑 render 也不會換掉它。
  const [queue] = useState(createBlockedQueue);

  const isMuted = useCallback(() => mutedRef.current, []);

  const recordBlocked = useCallback((plan: BroadcastPlan) => queue.record(plan), [queue]);

  const noteVoiceName = useCallback((name: string | null) => {
    if (!(name ?? '').includes(AUTOPLAY_BLOCKED)) {
      setAutoplayAck(null);
    }
  }, []);

  // 套用靜音狀態（本 panel 的按鈕、同頁其他 panel、或其他分頁都會走這裡）。
  // 切到靜音：停掉正在念與排隊中的、嘴型驅動也停、嘴型歸零（stop 之後不會再有 onEnd，複審 F1）。
  // 切回開：叫醒引擎。同頁同步是在同一個 click 事件裡同步派送，仍算使用者手勢。
  const applyMuted = useCallback(
    (next: boolean) => {
      if (mutedRef.current === next) {
        return;
      }
      mutedRef.current = next;
      setMuted(next);
      const sp = speaker();
      if (next) {
        queue.clear();
        sp?.stop();
        onSilenced();
        onPending(sp?.pending() ?? 0);
      } else {
        sp?.unlock();
      }
    },
    [onPending, onSilenced, queue, speaker]
  );

  // 同頁其他吉祥物 panel 按了開關，或另一個分頁改了本機儲存：跟著同步
  //（訂閱與「不是我們那個鍵」的過濾條件都在 muteStore）。
  useEffect(() => watchMuted(applyMuted), [applyMuted]);

  const blocked = voiceBlockedBy({ muted, speechErr, voiceName, autoplayAck });

  const toggle = useCallback(() => {
    const sp = speaker();
    if (blocked) {
      // 瀏覽器擋著：這一下是使用者手勢，叫醒引擎、補念被擋的句子，狀態維持「開」（不是切成靜音）。
      // 補念只取最近 10 分鐘內的；同一則告警只留最後的狀態（被擋期間已恢復的就只念恢復句）
      //（複審 F2；兩條規則都在 blockedQueue）。
      sp?.unlock();
      if ((voiceName ?? '').includes(AUTOPLAY_BLOCKED)) {
        setAutoplayAck(voiceName);
      }
      // ⚠️ 清錯誤訊息排在補念**之前**（搬出來之前就是這個順序）：補念那幾則若又被擋，
      // 它們的 onError 要蓋得過這一清，而不是被它清掉。
      onReplay();
      queue.take().forEach((plan) => sp?.enqueue(plan));
      onPending(sp?.pending() ?? 0);
      return;
    }
    const next = !mutedRef.current;
    applyMuted(next);
    // 寫本機 + 通知同頁其他吉祥物 panel（鍵名、事件名與寫入失敗的退路都在 muteStore）。
    publishMuted(next);
  }, [applyMuted, blocked, onPending, onReplay, queue, speaker, voiceName]);

  return { muted, blocked, isMuted, recordBlocked, noteVoiceName, toggle };
}
