/**
 * 18 格精靈圖的**純計算層**（SP-8.1 第一列）。零圖片 import、零 DOM、零計時器，
 * 所以整支可測 —— `SpriteController` 只負責把這裡算出來的東西貼到 CSS 上。
 *
 * 這個切法的理由寫在 SP-8.1：`spriteAssets.ts` 那兩行 `import url from '*.png'`
 * 一旦被測試碰到，jest 就需要 moduleNameMapper 才跑得起來（A3-4）。
 * 把「算哪一格」與「圖在哪裡」分開，前者永遠不必等素材。
 */

// SP-8.2 硬性要求：**重用** gaze.ts 的格號→CSS 換算，不得複製一份。
// 兩張圖的格號計算是同一支函式，只是格號語意不同（directions 是視線方向，
// reactions 是反應種類）。複製一份的後果不是重複程式碼，是**兩份會各自漂移**。
import { cellToBackgroundPosition } from './gaze';
import type { Emotion } from '../core/types';

export { cellToBackgroundPosition };

// ---------------------------------------------------------------------------
// 格號語意（§3 / §4）
// ---------------------------------------------------------------------------

/**
 * directions 九格：沿用 `gaze.ts` 的 row-major 0–8，與 `SECTOR_TO_CELL` 同一套語意。
 * 這裡只列出來給人看，程式一律用 `gazeCell()` 的回傳值，不要照這張表反查。
 */
export const DIRECTION_LABELS = [
  '左上', '上', '右上',
  '左', '中性(master)', '右',
  '左下', '下', '右下',
] as const;

/**
 * reactions 九格。**格號語意與 `gaze.ts` 無關**（§4 開頭明文），
 * 只是重用同一支 `cellToBackgroundPosition`。
 */
export const ReactionCell = {
  CLICK: 0,
  WARNING: 1,
  CRITICAL: 2,
  RESOLVED: 3,
  MOUTH_HALF: 4,
  MOUTH_WIDE: 5,
  EYES_CLOSED: 6,
  EYES_HALF: 7,
  PENDING: 8,
} as const;

export const REACTION_LABELS = [
  'click', 'warning', 'critical', 'resolved',
  '半開嘴', '大開嘴', '全閉眼', '半閉眼', 'pending',
] as const;

/**
 * 情緒 → expr 格號。**calm 不佔任何一格**（SP-4.0）——
 * calm 的 expr 層是 `display:none`，因為 master frame 本身就是 calm。
 * 一個 calm 覆蓋格會是「眉窗複製底圖、嘴窗一條微彎」，
 * 而那是修補塊面積最大、出現時間最長、最容易看到接縫的一格。
 *
 * ⚠️ **情緒格號不等於情緒索引**（SP-4.0 明文要求明表），所以這裡寫成對照表而非算術。
 */
const EMOTION_TO_CELL: Record<Emotion, number | null> = {
  calm: null,
  warning: ReactionCell.WARNING,
  critical: ReactionCell.CRITICAL,
  resolved: ReactionCell.RESOLVED,
};

// ---------------------------------------------------------------------------
// expr 層：四條路徑的優先序
// ---------------------------------------------------------------------------

export interface ExprState {
  /**
   * 使用者剛點了某個 panel（約 420ms 的短暫事件）。
   *
   * ⚠️ **click 與 pending 必須是兩個獨立的欄位，不能合成一個 `reaction` 槽。**
   * 兩者會**同時成立**：alert rule 的 `for` duration 典型 1–5 分鐘，而使用者隨時可能點擊。
   * 合成一個槽的話「click 期間 pending 還在」這件事就表達不出來 ——
   * SP-4.0 的優先序「click > 非 calm 情緒 > pending」本身就預設了它們可以重疊，
   * 否則「優先序」三個字沒有意義。
   */
  clicking: boolean;
  /** alert rule 的 `for` duration 進行中。可持續數分鐘。 */
  pending: boolean;
  /** 告警表情。來自 `AvatarController.setEmotion`。 */
  emotion: Emotion;
  /** 是否正在播報。pending 不與播報同時出現。 */
  speaking: boolean;
}

/**
 * expr 層要顯示哪一格；`null` = 整層隱藏。
 *
 * 優先序 **click > 非 calm 情緒 > pending > 隱藏**，理由逐條：
 *
 * - **click 最高**：它是使用者剛剛做的動作的回饋，延遲或吞掉就失去意義。
 *   它只持續約 420ms，壓過 critical 不到半秒。
 * - **情緒次之**：critical 是這個 plugin 最重要的狀態，不能被 pending 蓋掉。
 * - **pending 最低，且只在 calm 且未播報時出現**：它是 `for` duration 期間的前驅狀態，
 *   典型 1–5 分鐘。它不該跟 critical 搶同一張臉（`AvatarController.setReaction` 的註解），
 *   也不該在播報中冒出來 —— 播報當下嘴與眉都在動，再疊一張緊繃臉只會互相打架。
 */
export function exprCell(state: ExprState): number | null {
  if (state.clicking) {
    return ReactionCell.CLICK;
  }
  const byEmotion = EMOTION_TO_CELL[state.emotion];
  if (byEmotion !== null) {
    return byEmotion;
  }
  if (state.pending && !state.speaking) {
    return ReactionCell.PENDING;
  }
  return null;
}

/**
 * 同一組狀態要送給 `AvatarController.setReaction` 的值。
 *
 * `exprCell` 回傳的是**格號**（給 sprite 用），這一支回傳的是**契約的反應種類**
 * （給目前的 `DiagnosticAvatar` 與未來的 `SpriteController` 用）。兩者共用同一組優先序，
 * 所以 click 結束時若 pending 仍成立，它會自己回到 `'pending'` 而不是 `null`。
 */
export function reactionFor(state: ExprState): 'click' | 'pending' | null {
  if (state.clicking) {
    return 'click';
  }
  if (state.pending && !state.speaking && state.emotion === 'calm') {
    return 'pending';
  }
  return null;
}

// ---------------------------------------------------------------------------
// mouth 層：幀選擇器（SP-8.9，2026-09-20 修正版）
// ---------------------------------------------------------------------------

/**
 * `setMouthOpen(v)` 的 v → mouth 層格號；`null` = 整層隱藏（露出底圖格 4 的閉嘴）。
 *
 * **這是單純的幀選擇器，不是 flap 觸發器。** 時序完全由 `flap.ts` 驅動 ——
 * 它的 `boundary()` 已經在跑 N 次張合、每次都呼叫 `setMouthOpen`；
 * 這裡再跑一層迴圈就是 N²。
 *
 * ⚠️ 門檻 0.8 是照著 `flap.ts` 實際會吐的值訂的，不是猜的：
 * `flapAmplitude` 只產生 `0.6`（charLength < 4，短詞）與 `0.95`（charLength ≥ 4，長詞），
 * 閉合幀與 `idle()` 的收尾則是 `0`。0.8 落在 0.6 與 0.95 中間，
 * 對這三個值分別給出 格4 / 格5 / 隱藏 —— 語意全部正確。
 * 規格廢除的那條反推公式會把 `0.6` 算成格 5（大開），**剛好相反**。
 */
export function mouthCell(open: number): number | null {
  if (!(open > 0)) {
    return null;
  }
  return open >= MOUTH_WIDE_THRESHOLD ? ReactionCell.MOUTH_WIDE : ReactionCell.MOUTH_HALF;
}

export const MOUTH_WIDE_THRESHOLD = 0.8;

/**
 * SP-8.10 的定速 fallback：`setMouthOpen` 從未被呼叫（引擎不觸發 boundary）時，
 * `setSpeaking(true)` 期間以這個週期在 格4 / 隱藏 之間交替。
 * 沒有它，格 4 與格 5 其中一格會變成死格。
 */
export const MOUTH_FALLBACK_PERIOD_MS = 220;

// ---------------------------------------------------------------------------
// blink 層：排程（SP-8.8）
// ---------------------------------------------------------------------------

/** 一次眨眼的三幀。直接換格不做補間 —— 45ms 的補間在 128px 上看不出來，只是多耗一次重繪。 */
export const BLINK_SEQUENCE: ReadonlyArray<{ cell: number; ms: number }> = [
  { cell: ReactionCell.EYES_HALF, ms: 45 },
  { cell: ReactionCell.EYES_CLOSED, ms: 90 },
  { cell: ReactionCell.EYES_HALF, ms: 45 },
];

export const BLINK_INTERVAL_MIN_MS = 2800;
export const BLINK_INTERVAL_MAX_MS = 6500;
export const DOUBLE_BLINK_PROBABILITY = 0.18;
export const DOUBLE_BLINK_DELAY_MS = 160;

/**
 * 下一次眨眼要等多久。`random` 注入是為了可測 —— 與 `dedup.ts` 注入時鐘同一個理由。
 *
 * `pending` 期間**間隔減半**（SP-4.9 的非靜止要求）：pending 的持續時間是 alert rule 的
 * `for` duration，典型 1–5 分鐘。一張緊繃的臉連續靜止掛三分鐘，讀起來是「卡住了」
 * 而不是「正在等」。
 */
export function blinkIntervalMs(random: () => number, pending = false): number {
  const span = BLINK_INTERVAL_MAX_MS - BLINK_INTERVAL_MIN_MS;
  const base = BLINK_INTERVAL_MIN_MS + random() * span;
  return pending ? base / 2 : base;
}

/**
 * 眨眼是否被抑制。**播報中不抑制** —— 講話時完全不眨眼比不會講話更不自然。
 *
 * click 期間抑制的理由是產權而非美學：blink 層在 expr 層**之上**，
 * 會直接蓋掉格 0 的驚訝眼，而驚訝眼正是 click 回饋的主體。
 */
export function blinkSuppressed(opts: { reducedMotion: boolean; clicking: boolean }): boolean {
  return opts.reducedMotion || opts.clicking;
}

// ---------------------------------------------------------------------------
// 尺寸（SP-1.8）
// ---------------------------------------------------------------------------

/** 來源格邊長（SP-2.13）。 */
export const CELL_PX = 512;
/** 低於此值不渲染 sprite（SP-1.8）。接線在 B2-4，本層只提供判定。 */
export const SPRITE_MIN_SIDE = 128;

export interface SpriteSizeInput {
  /** `PanelProps.width` —— 已扣掉 panel header 與 padding 的**內容區**寬度。 */
  width: number;
  /** `PanelProps.height` —— 同上。 */
  height: number;
  devicePixelRatio: number;
}

/**
 * stage 的 CSS 邊長。
 *
 * **任何情況下不得放大**（`min(256, cellPx / dpr)` 那一項就是這個約束）：
 * 實測放大 1.875× 銳利度掉 56%、3.75× 掉 84%；而縮小沒有品質成本 ——
 * 在任一固定的裝置像素尺寸下，所有未放大的來源給出完全相同的 Laplacian 數值。
 *
 * 最後一步對齊裝置像素（`round(side * dpr) / dpr`），否則在 dpr = 2 / 3 時
 * 半個裝置像素的偏移會讓 `background-position` 取到隔壁格的邊緣。
 */
export function spriteSide(input: SpriteSizeInput): number {
  const dpr = input.devicePixelRatio > 0 ? input.devicePixelRatio : 1;
  const maxSideCss = Math.min(256, CELL_PX / dpr);
  const fromPanel = Math.floor(Math.min(input.width * 0.42, input.height * 0.8));
  const side = Math.min(maxSideCss, fromPanel);
  return Math.round(side * dpr) / dpr;
}

/** SP-1.8 的下限判定。**接線留到 B2-4** —— 見 A3-5 對 DiagnosticAvatar 的說明。 */
export function shouldRenderSprite(side: number): boolean {
  return side >= SPRITE_MIN_SIDE;
}

/**
 * dead zone 必須跟著 stage 走（SP-1.10）。
 * 固定的 28px 是為 34px 量級的 `DiagnosticAvatar` 訂的；在 224px 的 stage 上
 * 它只佔直徑 25%，游標停在角色臉頰上時角色會把視線甩開自己。
 * 下限 12 是為了讓 stage 很小時 dead zone 不至於消失。
 */
export function gazeDeadZonePx(side: number): number {
  return Math.max(12, Math.round(side * 0.25));
}
