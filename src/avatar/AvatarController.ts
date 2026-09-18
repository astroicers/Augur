/**
 * avatar-agnostic 契約。**繼承自 ADR-002 §2**（該 ADR 雖被 ADR-004 supersede，
 * 但這個抽象被 ADR-004 決策 5 明文保留），並依決策 5 做三項修改：
 *
 *  1. `mount(canvas: HTMLCanvasElement)` → `mount(container: HTMLElement)`。
 *     3×3 精靈圖最自然的實作是 `<div>` + `background-position` + `steps()`，
 *     不需要 canvas；綁死 canvas 是遷就舊的 3D 實作。
 *  2. `setMouth(open: number)` → `setSpeaking(boolean)`。Web Speech 不吐 audio buffer，
 *     接不上 AnalyserNode，振幅 lip-sync 整條失效。
 *  3. 新增 `setGaze(cell)`。
 *
 * 外加一個 ADR-002 沒有的**可選**成員 `setMouthOpen?`：承接幀級嘴型。
 * 它的存在是為了讓未來若有拿得到 audio buffer 的 TTS，振幅 lip-sync
 * 只要實作這個成員就能回來 —— 不必再動一次契約。
 * 目前由 `onboundary` 驅動（實測中文為詞級，`charLength` 1–14 可決定張口幅度）。
 */

/** 表情詞彙沿用 `core/types.ts` 的 Emotion，不另立一套。 */
export type { Emotion } from '../core/types';
import type { Emotion } from '../core/types';

export interface AvatarController {
  /** 給畫面上的標記用，例如 "sprite" / "diagnostic"。 */
  readonly kind: string;

  /** 建立渲染器並附著到 container。自己擁有 render loop。 */
  mount(container: HTMLElement): void;

  /** 表情。每則播報呼叫一次（來自 BroadcastPlan.emotion）。 */
  setEmotion(e: Emotion): void;

  /** 是否正在講話。不觸發 boundary 的引擎靠它跑定速嘴型。 */
  setSpeaking(speaking: boolean): void;

  /** 視線格號 0–8（見 gaze.ts）。 */
  setGaze(cell: number): void;

  /**
   * 可選：幀級張口幅度 0–1。實作了就優先於 `setSpeaking` 的定速嘴型。
   * 未來若換成拿得到 audio buffer 的 TTS，振幅 lip-sync 從這裡接回來。
   */
  setMouthOpen?(open: number): void;

  dispose(): void;
}
