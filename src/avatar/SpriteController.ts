/**
 * `AvatarController` 的第二個實作：3×3 精靈圖吉祥物（P5 / ROADMAP B2-7）。
 * 規格：`docs/sprite/sprite-sheet-spec.md` 的 §SP-1、§SP-4、§SP-8 與〈SpriteController 實作契約〉。
 *
 * **本檔只管「貼到 CSS 上」與「時序」。** 算哪一格全部來自 `spriteSheet.ts`
 * （exprCell / mouthCell / BLINK_SEQUENCE / blinkIntervalMs / blinkSuppressed /
 * cellToBackgroundPosition）—— 這裡不複製任何一條判準，改判準只改那一支。
 *
 * ## 四層疊合（SP-1.1），底圖永不切換
 *
 * stage（正方形，`MascotPanel` 定尺寸；SP-8.17）裡疊四個 `inset:0` 的 div，z 由低到高：
 *
 * | 層 | 圖 | 格 |
 * |---|---|---|
 * | base  | directions | 視線格，`setGaze` |
 * | expr  | reactions  | click 0 / 情緒 1–3 / pending 8，優先序見 `exprCell` |
 * | mouth | reactions  | 4 半開 / 5 大開，只在播報中 |
 * | blink | reactions  | 7 半閉 / 6 全閉，控制器自走 |
 *
 * base 層**任何情況下都用 directions 圖**（SP-1.2）；三個覆蓋層共用一個 reactions URL（SP-1.3）。
 * 疊合的意義是四個通道（情緒、嘴、眨眼、視線）可以同時動，而兩張圖的對齊在構造上成立。
 *
 * ## ⚠️ `setMouthOpen` 的語意與 `DiagnosticAvatar` **刻意不同**（SP-8.11）
 *
 * `DiagnosticAvatar` 的實際判準是 `if (open === 0 && this.speaking)` —— 它把 **0 當成「沒給值」**，
 * 所以播報中顯式的 `setMouthOpen(0)`（閉嘴）仍會被它的定速循環蓋過。
 * 本實作把**每一次呼叫都當成一次 boundary 同步點**：
 *  - `setMouthOpen(0)` 就是閉口，並且立刻停掉 SP-8.10 的定速 fallback；
 *  - 定速 fallback 只在「這一輪播報（自 `setSpeaking(true)` 起）還沒收到任何 `setMouthOpen`」時跑。
 *
 * 不要把這裡「修」成與 `DiagnosticAvatar` 一致：照抄 `=== 0` 會讓 `flap.ts` 每一下的閉合幀
 * 被定速循環吃掉（嘴永遠合不起來）；改寫成 `!== undefined` 則是另一種與 `DiagnosticAvatar`
 * 字面不一致的寫法，兩者都不是規格要的。
 *
 * ## 幀選擇器，不是 flap 觸發器（SP-8.9）
 *
 * 擺動次數由 `flap.ts` 依 `charLength` 決定，它每一下都呼叫 `setMouthOpen`。
 * 這裡只把 v 換成格號（`mouthCell`），**不自己跑迴圈** —— 再跑一層就是 N²。
 * 唯一的例外是 SP-8.10：從未收到 `setMouthOpen` 時以格 4 跑 220ms 定速 flap，
 * 否則 `enableTTS=false` / 引擎不吐 boundary 的路徑上，格 4 或格 5 其中一格是死格。
 *
 * ## 載入與降級（SP-8.7）—— 每一條都是預期內路徑，不是例外處理
 *
 *  1. 兩張圖都以 `new Image()` + `decode()` 解碼完成才顯示任何一層（否則第一次播報閃一格空白）。
 *  2. directions 載入失敗（含 CSP/CORS）→ 回報 `failed`，`MascotPanel` 退回 `DiagnosticAvatar` 並顯示原因。
 *  3. directions 不是可被 3 整除的正方形 → 同上。
 *  4. 兩張尺寸不一致 → 只留 base 層、停用三個覆蓋層、回報 `degraded`（`MascotPanel` 顯示 chip）。
 *
 * reactions **自己**載入失敗或幾何不合時也走第 4 條（只留 base），而不是第 2/3 條：
 * SP-3.7 明文「reactions 圖載入失敗時，只顯示 base 層仍應是一隻閉口、calm、會追視線的正常吉祥物」，
 * master frame 畫成 calm 正是為了這條退路。整個 plugin 一律沿用 ADR-004 決策 6：
 * **壞掉時少一個功能，不是整個 plugin 炸掉** —— 本檔任何路徑都不向外拋例外。
 */
import { css, keyframes } from '@emotion/css';

import type { AvatarController, Emotion } from './AvatarController';
import { CENTER_CELL } from './gaze';
import {
  BLINK_SEQUENCE,
  DOUBLE_BLINK_DELAY_MS,
  DOUBLE_BLINK_PROBABILITY,
  MOUTH_FALLBACK_PERIOD_MS,
  ReactionCell,
  blinkIntervalMs,
  blinkSuppressed,
  cellToBackgroundPosition,
  exprCell,
  mouthCell,
} from './spriteSheet';
import { DEFAULT_DIRECTIONS_URL, DEFAULT_REACTIONS_URL } from './spriteAssets';

/**
 * SP-8.12：click 反應顯示的毫秒數。`MascotPanel` 的 click 計時器用同一個常數 ——
 * 兩邊各自計時（契約寫明 click 由控制器自動回復），數字只能有一份。
 */
export const CLICK_REACTION_MS = 420;

// ---------------------------------------------------------------------------
// 載入（SP-8.7 第 1 條）
// ---------------------------------------------------------------------------

export interface LoadedSheet {
  width: number;
  height: number;
  /**
   * 解碼過的 `Image` 本身。控制器持有它到 dispose 為止 ——
   * 參照一放掉，瀏覽器可以丟棄解碼結果，第一次真的畫到該格時又得重解一次。
   */
  image?: unknown;
}

/**
 * 預設 loader：`new Image()` + `img.decode()`。
 *
 * - `decode()` 不存在（jsdom、極舊瀏覽器）時退回 `onload`。
 * - ⚠️ **不設 `crossOrigin`。** CSS `background-image` 本來就不需要 CORS；
 *   在這裡設了，沒有 CORS 標頭的外部主機會在預載時失敗，而同一張圖拿去當背景其實畫得出來。
 * - `onerror` 是獨立分支（SP-8.7 第 2 條）：跨網域被擋時幾何檢查根本跑不到。
 */
export function loadSheet(url: string): Promise<LoadedSheet> {
  return new Promise<LoadedSheet>((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const ok = () => {
      if (!settled) {
        settled = true;
        resolve({ width: img.naturalWidth, height: img.naturalHeight, image: img });
      }
    };
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(new Error('載入失敗（網路、404、被 CSP/CORS 擋下，或不是可解碼的圖）'));
      }
    };
    const canDecode = typeof img.decode === 'function';
    img.onerror = fail;
    if (!canDecode) {
      img.onload = ok;
    }
    img.decoding = 'async';
    img.src = url;
    if (canDecode) {
      img.decode().then(ok, fail);
    }
  });
}

/** SP-8.7 第 3 條的判準：正方形、邊長可被 3 整除。合規回 `null`，否則回人看得懂的原因。 */
export function sheetGeometryProblem(s: { width: number; height: number }): string | null {
  if (!(s.width > 0) || !(s.height > 0)) {
    return `尺寸 ${s.width}×${s.height} 無效`;
  }
  if (s.width !== s.height) {
    return `不是正方形（${s.width}×${s.height}）`;
  }
  if (s.width % 3 !== 0) {
    return `邊長 ${s.width} 不能被 3 整除`;
  }
  return null;
}

export type SheetResult = { ok: true; sheet: LoadedSheet } | { ok: false; error: unknown };

export type SheetVerdict =
  | { mode: 'full' }
  | { mode: 'directions-only'; reason: string }
  | { mode: 'failed'; reason: string };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 兩張圖的載入結果 → 要怎麼渲染。純函式，判定順序就是降級的嚴重度：
 * directions 壞 = 整個 sprite 不能用；reactions 壞或對不上 = 只少了表情/嘴/眨眼。
 */
export function judgeSheets(d: SheetResult, r: SheetResult): SheetVerdict {
  if (!d.ok) {
    return { mode: 'failed', reason: `directions 圖${errText(d.error)}` };
  }
  const dGeom = sheetGeometryProblem(d.sheet);
  if (dGeom) {
    return { mode: 'failed', reason: `directions 圖${dGeom}` };
  }
  if (!r.ok) {
    return { mode: 'directions-only', reason: `reactions 圖${errText(r.error)}，只保留視線層` };
  }
  const rGeom = sheetGeometryProblem(r.sheet);
  if (rGeom) {
    return { mode: 'directions-only', reason: `reactions 圖${rGeom}，只保留視線層` };
  }
  if (d.sheet.width !== r.sheet.width) {
    return {
      mode: 'directions-only',
      reason: `兩張圖尺寸不一致（directions ${d.sheet.width}、reactions ${r.sheet.width}），只保留視線層`,
    };
  }
  return { mode: 'full' };
}

// ---------------------------------------------------------------------------
// 對外型別
// ---------------------------------------------------------------------------

export type SpriteStatus =
  | { state: 'ready' }
  /** SP-8.7 第 4 條（與 SP-3.7）：只剩 base 層。sprite 仍在畫面上，`MascotPanel` 顯示 chip。 */
  | { state: 'degraded'; reason: string }
  /** SP-8.7 第 2/3 條：sprite 不能用。`MascotPanel` 退回 `DiagnosticAvatar`。 */
  | { state: 'failed'; reason: string };

/** `window.matchMedia()` 回傳值中本檔用得到的那一小塊（測試可注入）。 */
export interface MotionQuery {
  matches: boolean;
  addEventListener?(type: 'change', listener: (ev: { matches: boolean }) => void): void;
  removeEventListener?(type: 'change', listener: (ev: { matches: boolean }) => void): void;
}

export interface SpriteControllerOptions {
  /** panel option `directionsImgUrl`。空字串 / 未給 → 內建素材（SP-8.4）。 */
  directionsUrl?: string;
  /** panel option `reactionsImgUrl`。空字串 / 未給 → 內建素材。 */
  reactionsUrl?: string;
  /** 載入結果的回報出口。降級要顯示在畫面上 —— 看不見的降級等於沒有降級。 */
  onStatus?: (status: SpriteStatus) => void;
  /** 注入點：測試用。預設 `loadSheet`。 */
  loadSheet?: (url: string) => Promise<LoadedSheet>;
  /** 注入點：眨眼間隔與雙眨的亂數。預設 `Math.random`。 */
  random?: () => number;
  /** 注入點：`prefers-reduced-motion` 查詢。預設 `window.matchMedia`。 */
  matchMedia?: (query: string) => MotionQuery | null | undefined;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * 呼吸（SP-1.14）：作用在四層的**共同父容器**上，四層一起動、對位不變。
 * 振幅 ±2.0% 邊長（translateY 的百分比以元素自身高度為準，stage 是正方形 → 就是邊長）。
 * 「週期 4s」取完整一呼一吸：單程 2s × alternate。
 * pending 期間振幅 ×1.4（SP-8.8）—— 用 custom property 改振幅而不是換 animation，
 * 換 animation-name 會讓動畫從頭開始，臉會跳一下。
 * `prefers-reduced-motion: reduce` 停用（SP-1.15），這一半由 CSS 自己承接。
 */
const breathe = keyframes`
  from { transform: translateY(calc(-1 * var(--augur-breath, 2%))); }
  to { transform: translateY(var(--augur-breath, 2%)); }
`;

const STAGE_CLASS = css`
  position: relative;
  width: 100%;
  height: 100%;
  --augur-breath: 2%;
  animation: ${breathe} 2s ease-in-out infinite alternate;
  &[data-pending='true'] {
    --augur-breath: 2.8%;
  }
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

/**
 * 每一層的固定樣式。尺寸只用 `inset: 0`（SP-8.17）；不得用 transform 縮放、
 * 不加 will-change（SP-1.13）；不加 transition —— 換格是直接跳（SP-1.11）；
 * `image-rendering` 保持 auto，不得 pixelated（SP-1.17）。
 * background-size 另外以屬性賦值寫（見 `makeLayer`），好讓 implementation-contract 的 SP-1.5 斷言讀得到它。
 */
const LAYER_CSS = 'position:absolute;inset:0;background-repeat:no-repeat;image-rendering:auto;display:none;';

/** 把任意 URL 包成安全的 CSS `url("…")`：引號、反斜線、換行一律以 CSS 跳脫序列寫出。 */
function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r\f]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `)}")`;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

type LayerName = 'base' | 'expr' | 'mouth' | 'blink';

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export class SpriteController implements AvatarController {
  readonly kind = 'sprite';

  private readonly directionsUrl: string;
  private readonly reactionsUrl: string;
  private readonly opts: SpriteControllerOptions;
  private readonly random: () => number;

  // DOM
  private stage: HTMLDivElement | null = null;
  private layers: Record<LayerName, HTMLDivElement> | null = null;
  private motionQuery: MotionQuery | null = null;

  // 載入狀態
  private disposed = false;
  /**
   * - `loading`：解碼未完成，任何一層都不顯示（SP-8.7 第 1 條）。
   * - `full`：四層都可用。
   * - `directions-only`：只有 base 層（SP-8.7 第 4 條 / SP-3.7）。
   * - `failed`：sprite 不能用（SP-8.7 第 2/3 條），等 `MascotPanel` 換成 DiagnosticAvatar。
   */
  private mode: 'loading' | SheetVerdict['mode'] = 'loading';
  private sheets: LoadedSheet[] = [];

  // 契約輸入
  private emotion: Emotion = 'calm';
  private speaking = false;
  private gaze = CENTER_CELL;
  /** click 期間 base 層凍結在這一格（SP-8.12）。 */
  private frozenGaze = CENTER_CELL;
  private clicking = false;
  private pending = false;
  /** mouth 層目前的幀；`null` = 閉口（隱藏、露出底圖的閉嘴）。 */
  private mouthFrame: number | null = ReactionCell.MOUTH_HALF;
  private blinkCell: number | null = null;
  private reducedMotion = false;

  // 計時器 —— dispose 必須全部清掉
  private clickTimer: number | undefined;
  private blinkTimer: number | undefined;
  private mouthTimer: number | undefined;

  constructor(opts: SpriteControllerOptions = {}) {
    this.opts = opts;
    this.random = opts.random ?? Math.random;
    // 空字串（含只有空白）→ 內建素材。不寫死路徑字串：production 檔名是 [hash][ext]（SP-8.4）。
    this.directionsUrl = (opts.directionsUrl ?? '').trim() || DEFAULT_DIRECTIONS_URL;
    this.reactionsUrl = (opts.reactionsUrl ?? '').trim() || DEFAULT_REACTIONS_URL;
  }

  mount(container: HTMLElement): void {
    if (this.stage || this.disposed) {
      return;
    }
    const stage = document.createElement('div');
    stage.className = STAGE_CLASS;
    // SP-1.16：stage 是一張圖；四個圖層對輔助技術隱藏。
    stage.setAttribute('role', 'img');
    stage.dataset.spriteState = 'loading';
    stage.dataset.pending = 'false';

    this.layers = {
      base: this.makeLayer(stage, 'base'),
      expr: this.makeLayer(stage, 'expr'),
      mouth: this.makeLayer(stage, 'mouth'),
      blink: this.makeLayer(stage, 'blink'),
    };
    container.appendChild(stage);
    this.stage = stage;

    this.watchReducedMotion();
    this.render();
    this.load();
  }

  // ---- 契約 ----

  setEmotion(e: Emotion): void {
    this.emotion = e;
    this.render();
  }

  /**
   * `true`：mouth 層可用，並啟動 SP-8.10 的定速 fallback —— 第一個 `setMouthOpen` 會立刻停掉它。
   * `false`：立即隱藏 mouth 層、張口幀重置回格 4（契約原文）。
   */
  setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) {
      return;
    }
    this.speaking = speaking;
    this.clearMouthTimer();
    if (speaking) {
      this.startMouthFallback();
    } else {
      this.mouthFrame = ReactionCell.MOUTH_HALF;
    }
    this.render();
  }

  /** 只動 base 層的 background-position，不做額外格號換算、不加 transition。 */
  setGaze(cell: number): void {
    this.gaze = cell;
    this.render();
  }

  /** 幀選擇器（SP-8.9）。每一次呼叫都是一次同步點 —— 語意差異見檔頭 SP-8.11 段。 */
  setMouthOpen(open: number): void {
    this.clearMouthTimer();
    this.mouthFrame = mouthCell(open);
    this.render();
  }

  /**
   * click 與 pending 是兩個獨立欄位（`spriteSheet.ts` 的 `ExprState` 註解寫明原因）：
   *  - `'click'`：420ms 後自動回復；**不清掉 pending** —— click 結束時 pending 若仍成立，臉自己回到 pending。
   *  - `'pending'`：持續狀態，直到收到 `null`；同時結束進行中的 click。
   *  - `null`：兩者都清掉。
   * 播報中**不抑制** click（SP-8.12）：mouth 層在 expr 之上會蓋掉格 0 的小圓嘴，剩下眉與閃光。
   */
  setReaction(kind: 'click' | 'pending' | null): void {
    if (this.disposed) {
      return;
    }
    if (kind === 'click') {
      if (!this.clicking) {
        this.frozenGaze = this.gaze;
      }
      this.clicking = true;
      this.clearTimer('clickTimer');
      this.clickTimer = window.setTimeout(() => {
        this.clickTimer = undefined;
        this.clicking = false;
        this.render();
      }, CLICK_REACTION_MS);
      // blink 層在 expr 之上，正在眨的那一下會蓋掉格 0 的驚訝眼 —— 中止它（SP-8.8 的抑制理由）。
      if (this.blinkCell !== null) {
        this.blinkCell = null;
        this.scheduleBlink();
      }
    } else {
      this.clearTimer('clickTimer');
      this.clicking = false;
      this.pending = kind === 'pending';
    }
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer('clickTimer');
    this.clearTimer('blinkTimer');
    this.clearMouthTimer();
    this.motionQuery?.removeEventListener?.('change', this.onMotionChange);
    this.motionQuery = null;
    this.stage?.remove();
    this.stage = null;
    this.layers = null;
    // 放掉解碼結果的參照（見 LoadedSheet.image）。
    this.sheets.length = 0;
  }

  // ---- 載入 ----

  private load(): void {
    const loader = this.opts.loadSheet ?? loadSheet;
    const settle = (url: string): Promise<SheetResult> => {
      let p: Promise<LoadedSheet>;
      try {
        p = loader(url);
      } catch (error) {
        p = Promise.reject(error);
      }
      return p.then(
        (sheet): SheetResult => ({ ok: true, sheet }),
        (error: unknown): SheetResult => ({ ok: false, error })
      );
    };
    void Promise.all([settle(this.directionsUrl), settle(this.reactionsUrl)])
      .then(([d, r]) => {
        if (!this.disposed) {
          this.applyVerdict(judgeSheets(d, r), d, r);
        }
      })
      .catch((err: unknown) => {
        // 只有本檔自己的 bug 會走到這裡。照樣退回 DiagnosticAvatar，不讓它變成 unhandled rejection。
        if (!this.disposed) {
          this.fail(`精靈圖初始化失敗：${errText(err)}`);
        }
      });
  }

  private applyVerdict(v: SheetVerdict, d: SheetResult, r: SheetResult): void {
    if (v.mode === 'failed') {
      this.fail(v.reason);
      return;
    }
    const layers = this.layers;
    const stage = this.stage;
    if (!layers || !stage) {
      return;
    }
    this.sheets = [d, r].flatMap((x) => (x.ok ? [x.sheet] : []));
    this.mode = v.mode;
    // background-image 在解碼完成之後才填 —— 在這之前沒有任何一層有東西可畫（SP-8.7 第 1 條）。
    layers.base.style.backgroundImage = cssUrl(this.directionsUrl);
    if (v.mode === 'full') {
      const url = cssUrl(this.reactionsUrl);
      layers.expr.style.backgroundImage = url;
      layers.mouth.style.backgroundImage = url;
      layers.blink.style.backgroundImage = url;
      stage.dataset.spriteState = 'ready';
      this.scheduleBlink();
    } else {
      stage.dataset.spriteState = 'degraded';
      // 沒有覆蓋層可畫，定速 fallback 也沒有意義。
      this.clearMouthTimer();
    }
    this.render();
    this.emit(v.mode === 'full' ? { state: 'ready' } : { state: 'degraded', reason: v.reason });
  }

  private fail(reason: string): void {
    this.mode = 'failed';
    this.blinkCell = null;
    this.clearTimer('blinkTimer');
    this.clearMouthTimer();
    if (this.stage) {
      this.stage.dataset.spriteState = 'failed';
      this.stage.title = reason;
    }
    this.render();
    this.emit({ state: 'failed', reason });
  }

  private emit(status: SpriteStatus): void {
    try {
      this.opts.onStatus?.(status);
    } catch {
      // 回報端自己的錯不該讓控制器停在半套狀態；畫面已經是正確的降級結果。
    }
  }

  // ---- 渲染 ----

  private makeLayer(stage: HTMLElement, name: LayerName): HTMLDivElement {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.dataset.layer = name;
    el.style.cssText = LAYER_CSS;
    // SP-1.5：只能是 300% 300%（auto / cover / contain / px 值都會跨格滲色或取錯格）。
    el.style.backgroundSize = '300% 300%';
    stage.appendChild(el);
    return el;
  }

  /** 由狀態整份重算四層。冪等 —— 任何輸入改變後呼叫一次即可。 */
  private render(): void {
    const stage = this.stage;
    const layers = this.layers;
    if (!stage || !layers) {
      return;
    }
    stage.setAttribute('aria-label', `吉祥物：${this.emotion}${this.speaking ? '，正在播報' : ''}`);
    if (this.mode === 'loading' || this.mode === 'failed') {
      show(layers.base, null);
      show(layers.expr, null);
      show(layers.mouth, null);
      show(layers.blink, null);
      stage.dataset.pending = 'false';
      return;
    }
    show(layers.base, this.clicking ? this.frozenGaze : this.gaze);
    const full = this.mode === 'full';
    const expr = full
      ? exprCell({ clicking: this.clicking, pending: this.pending, emotion: this.emotion, speaking: this.speaking })
      : null;
    show(layers.expr, expr);
    show(layers.mouth, full && this.speaking ? this.mouthFrame : null);
    show(layers.blink, full ? this.blinkCell : null);
    stage.dataset.pending = String(expr === ReactionCell.PENDING);
  }

  // ---- 嘴（SP-8.10 的定速 fallback）----

  private startMouthFallback(): void {
    // loading 期間照跑：圖解碼完成的那一刻嘴已經在動，不會從閉口才開始。
    if (this.disposed || (this.mode !== 'loading' && this.mode !== 'full')) {
      return;
    }
    const half = MOUTH_FALLBACK_PERIOD_MS / 2;
    const tick = (open: boolean) => {
      this.mouthFrame = open ? ReactionCell.MOUTH_HALF : null;
      this.render();
      this.mouthTimer = window.setTimeout(() => tick(!open), half);
    };
    tick(true);
  }

  private clearMouthTimer(): void {
    this.clearTimer('mouthTimer');
  }

  // ---- 眨眼（SP-8.8）----

  /** pending 的臉正顯示在畫面上時間隔減半 —— 一張靜止的緊繃臉掛三分鐘讀起來是「卡住了」。 */
  private pendingShown(): boolean {
    return (
      this.mode === 'full' &&
      exprCell({ clicking: this.clicking, pending: this.pending, emotion: this.emotion, speaking: this.speaking }) ===
        ReactionCell.PENDING
    );
  }

  private scheduleBlink(): void {
    this.clearTimer('blinkTimer');
    if (this.disposed || this.mode !== 'full') {
      return;
    }
    this.blinkTimer = window.setTimeout(() => this.startBlink(true), blinkIntervalMs(this.random, this.pendingShown()));
  }

  /** 到點時才判抑制：被抑制就跳過這一次、照常排下一次（不累積、不補眨）。 */
  private startBlink(allowDouble: boolean): void {
    this.blinkTimer = undefined;
    if (blinkSuppressed({ reducedMotion: this.reducedMotion, clicking: this.clicking })) {
      this.scheduleBlink();
      return;
    }
    this.blinkFrame(0, allowDouble);
  }

  private blinkFrame(i: number, allowDouble: boolean): void {
    const frame = BLINK_SEQUENCE[i];
    if (!frame) {
      this.blinkCell = null;
      this.render();
      if (allowDouble && this.random() < DOUBLE_BLINK_PROBABILITY) {
        this.blinkTimer = window.setTimeout(() => this.startBlink(false), DOUBLE_BLINK_DELAY_MS);
      } else {
        this.scheduleBlink();
      }
      return;
    }
    // 直接換格，不做補間（SP-8.8）。
    this.blinkCell = frame.cell;
    this.render();
    this.blinkTimer = window.setTimeout(() => this.blinkFrame(i + 1, allowDouble), frame.ms);
  }

  // ---- prefers-reduced-motion（SP-1.15：停呼吸與眨眼，嘴保留）----

  private watchReducedMotion(): void {
    const mm: ((query: string) => MotionQuery | null | undefined) | undefined =
      this.opts.matchMedia ??
      (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? (q: string) => window.matchMedia(q)
        : undefined);
    const mq = mm?.(REDUCED_MOTION_QUERY);
    if (!mq) {
      return;
    }
    this.reducedMotion = Boolean(mq.matches);
    mq.addEventListener?.('change', this.onMotionChange);
    this.motionQuery = mq;
  }

  private onMotionChange = (ev: { matches: boolean }): void => {
    this.reducedMotion = ev.matches;
  };

  private clearTimer(key: 'clickTimer' | 'blinkTimer' | 'mouthTimer'): void {
    const h = this[key];
    if (h !== undefined) {
      window.clearTimeout(h);
      this[key] = undefined;
    }
  }
}

function show(el: HTMLElement, cell: number | null): void {
  if (cell === null) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  el.style.backgroundPosition = cellToBackgroundPosition(cell);
}
