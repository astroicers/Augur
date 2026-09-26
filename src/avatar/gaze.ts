/**
 * 視線方向計算：把「滑鼠相對於吉祥物中心的位移」換成 3×3 精靈圖的格號。
 *
 * 格號採 row-major 0–8，4 是正中（不看任何方向）：
 * ```
 *   0 1 2      ↖ ↑ ↗
 *   3 4 5      ← ·  →
 *   6 7 8      ↙ ↓ ↘
 * ```
 *
 * 兩層防抖，缺一個都會抖：
 *  - **dead zone**：滑鼠離中心太近時角度會因為幾像素的移動而狂轉 → 一律回中央格。
 *  - **角度遲滯**：離開 dead zone 之後，在兩個方向的交界處仍會來回跳。
 *    要換格必須**越過交界一段角度**，而不是剛好跨過就換。
 */

/** 8 個方向的中心角（度，0 = 右，逆時針為正，與 atan2 一致）對應的格號。 */
const SECTOR_TO_CELL: readonly number[] = [
  5, // 0°   右
  2, // 45°  右上
  1, // 90°  上
  0, // 135° 左上
  3, // 180° 左
  6, // 225° 左下
  7, // 270° 下
  8, // 315° 右下
];

export const CENTER_CELL = 4;

export interface GazeOptions {
  /** 小於這個距離（px）一律回中央格。 */
  deadZonePx: number;
  /** 要換格必須越過交界多少度。0 = 不遲滯。 */
  hysteresisDeg: number;
}

export const DEFAULT_GAZE: GazeOptions = {
  // 吉祥物本身的尺寸量級。太小會在角色身上抖，太大會變成「不太看人」。
  deadZonePx: 28,
  // 45° 的扇區，給 8° 遲滯 ≈ 交界兩側各 4° 的緩衝。
  hysteresisDeg: 8,
};

/**
 * @param dx 滑鼠 x 減吉祥物中心 x
 * @param dy 滑鼠 y 減吉祥物中心 y（螢幕座標，**向下為正**）
 * @param current 目前的格號，用來做遲滯。第一次傳 CENTER_CELL。
 */
export function gazeCell(dx: number, dy: number, current: number, opts: GazeOptions = DEFAULT_GAZE): number {
  const dist = Math.hypot(dx, dy);
  if (dist < opts.deadZonePx) {
    return CENTER_CELL;
  }

  // 螢幕 y 向下為正，數學角度 y 向上為正 → 取負號，讓 90° 真的是「上」。
  let deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (deg < 0) {
    deg += 360;
  }

  const sector = Math.round(deg / 45) % 8;
  const candidate = SECTOR_TO_CELL[sector]!;
  if (candidate === current || current === CENTER_CELL) {
    return candidate;
  }

  // 遲滯：只有在明確進入新扇區「內部」才換。剛好落在交界附近就維持原狀。
  const sectorCenter = sector * 45;
  let delta = Math.abs(deg - sectorCenter);
  if (delta > 180) {
    delta = 360 - delta;
  }
  return delta <= 22.5 - opts.hysteresisDeg ? candidate : current;
}

/** 格號 → CSS `background-position`，給 3×3 精靈圖用（每格佔 50%）。 */
export function cellToBackgroundPosition(cell: number): string {
  const c = Math.max(0, Math.min(8, Math.trunc(cell)));
  const col = c % 3;
  const row = Math.trunc(c / 3);
  return `${col * 50}% ${row * 50}%`;
}
