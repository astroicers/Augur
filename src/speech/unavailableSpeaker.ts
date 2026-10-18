/**
 * 沒有 `speechSynthesis` 的環境裡的 `Speaker`（#82 從 `MascotPanel.tsx` 搬出來）。
 *
 * 住在 `src/speech/` 的理由：吃 `SpeakerEvents`、回 `Speaker`，兩個型別都是這一層的，
 * 擺在元件裡等於讓接線層定義播報器的一種實作。
 */
import type { Speaker, SpeakerEvents } from './speaker';

/** 沒有 speechSynthesis 的環境裡，外部語音降級時的接手者：每一則都直接報錯，佇列照走。 */
export function unavailableSpeaker(ev: SpeakerEvents): Speaker {
  return {
    unlock() {},
    enqueue: (plan) => ev.onError?.('no-speech-synthesis', plan),
    pending: () => 0,
    isSpeaking: () => false,
    stop() {},
    voiceName: () => null,
    dispose() {},
  };
}
