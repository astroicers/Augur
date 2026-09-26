import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flapAmplitude } from '../flap';
import { cellToBackgroundPosition as fromGaze } from '../gaze';
import {
  BLINK_INTERVAL_MAX_MS,
  BLINK_INTERVAL_MIN_MS,
  BLINK_SEQUENCE,
  ReactionCell,
  blinkIntervalMs,
  blinkSuppressed,
  cellToBackgroundPosition,
  exprCell,
  gazeDeadZonePx,
  mouthCell,
  shouldRenderSprite,
  spriteSide,
} from '../spriteSheet';

test('SP-8.2：cellToBackgroundPosition 是 gaze.ts 的那一支，不是複製品', () => {
  // 同一個函式參考 —— 比對行為只能證明「現在一樣」，比對參考才能證明「不會各自漂移」。
  expect(cellToBackgroundPosition).toBe(fromGaze);

  const source = readFileSync(join(__dirname, '..', 'spriteSheet.ts'), 'utf8');
  expect(source).toMatch(/import \{ cellToBackgroundPosition \} from '\.\/gaze'/);
  // 重新實作的指紋：算 col/row 再拼 50%。出現即代表有人複製了一份。
  expect(source).not.toMatch(/col \* 50/);
});

test('SP-8.9 嘴型幀選擇器：用 flap.ts 實際會吐的值', () => {
  // ⚠️ 測試點必須是 flapAmplitude 真的會產生的值。
  // 原計畫給的 0.35 / 0.5 / 1.0 一個都不會出現 —— 那種測試必定全綠而接線是壞的。
  expect(flapAmplitude(1)).toBe(0.6);
  expect(flapAmplitude(4)).toBe(0.95);

  expect(mouthCell(0)).toBeNull(); // 閉合幀與 idle 收尾 → 隱藏 mouth 層，露出底圖的閉嘴
  expect(mouthCell(flapAmplitude(1))).toBe(ReactionCell.MOUTH_HALF); // 0.6 短詞 → 半開
  expect(mouthCell(flapAmplitude(4))).toBe(ReactionCell.MOUTH_WIDE); // 0.95 長詞 → 大開

  // 廢除的反推公式會把 0.6 算成大開（round((0.6−0.35)×14) = 4 → 格5），剛好相反。
  expect(mouthCell(0.6)).not.toBe(ReactionCell.MOUTH_WIDE);

  // 邊界與髒輸入
  expect(mouthCell(0.79)).toBe(ReactionCell.MOUTH_HALF);
  expect(mouthCell(0.8)).toBe(ReactionCell.MOUTH_WIDE);
  expect(mouthCell(-1)).toBeNull();
  expect(mouthCell(NaN)).toBeNull();
});

test('SP-4.0 expr 優先序：click > 非 calm 情緒 > pending > 隱藏', () => {
  const s = (reaction: 'click' | 'pending' | null, emotion: 'calm' | 'warning' | 'critical' | 'resolved', speaking = false) =>
    exprCell({ clicking: reaction === 'click', pending: reaction === 'pending', emotion, speaking });

  // 路徑 1：click 壓過一切，含 critical
  expect(s('click', 'critical')).toBe(ReactionCell.CLICK);
  expect(s('click', 'calm')).toBe(ReactionCell.CLICK);

  // 路徑 2：非 calm 情緒。格號不等於情緒索引，逐一釘住
  expect(s(null, 'warning')).toBe(ReactionCell.WARNING);
  expect(s(null, 'critical')).toBe(ReactionCell.CRITICAL);
  expect(s(null, 'resolved')).toBe(ReactionCell.RESOLVED);
  expect(s('pending', 'critical')).toBe(ReactionCell.CRITICAL); // pending 不與 critical 搶臉

  // 路徑 3：pending —— 只在 calm 且未播報
  expect(s('pending', 'calm')).toBe(ReactionCell.PENDING);
  expect(s('pending', 'calm', true)).toBeNull();

  // 路徑 4：隱藏。calm 不佔任何一格（SP-4.0）
  expect(s(null, 'calm')).toBeNull();
});

test('SP-8.8 眨眼：序列、間隔、抑制條件', () => {
  // ⚠️ **常數本身要斷言。** 原本只驗了「random 回 0 得到 MIN、回 1 得到 MAX」——
  // 那對常數值零鑑別力：把 2800/6500 改成 500/900（吉祥物每 0.5–0.9 秒眨一次，
  // 肉眼是抽搐，直接牴觸 SP-8.8 的「間隔於 2.8–6.5 秒間隨機」）測試照樣全綠。
  expect(BLINK_INTERVAL_MIN_MS).toBe(2800);
  expect(BLINK_INTERVAL_MAX_MS).toBe(6500);

  expect(BLINK_SEQUENCE.map((f) => f.cell)).toEqual([
    ReactionCell.EYES_HALF,
    ReactionCell.EYES_CLOSED,
    ReactionCell.EYES_HALF,
  ]);
  expect(BLINK_SEQUENCE.map((f) => f.ms)).toEqual([45, 90, 45]);

  expect(blinkIntervalMs(() => 0)).toBe(BLINK_INTERVAL_MIN_MS);
  expect(blinkIntervalMs(() => 1)).toBe(BLINK_INTERVAL_MAX_MS);
  // pending 期間減半 —— 靜止三分鐘讀起來是「卡住了」
  expect(blinkIntervalMs(() => 0, true)).toBe(BLINK_INTERVAL_MIN_MS / 2);

  expect(blinkSuppressed({ reducedMotion: true, clicking: false })).toBe(true);
  expect(blinkSuppressed({ reducedMotion: false, clicking: true })).toBe(true);
  // 播報中不抑制：講話時完全不眨眼比不會講話更不自然
  expect(blinkSuppressed({ reducedMotion: false, clicking: false })).toBe(false);
});

test('SP-1.8 side：四檔尺寸與「不得放大」', () => {
  const at = (width: number, height: number, dpr = 1) =>
    spriteSide({ width, height, devicePixelRatio: dpr });

  expect(at(300, 400)).toBe(126); // < 128
  expect(shouldRenderSprite(at(300, 400))).toBe(false);
  // ⚠️ **下限那一格要釘住。** 原本只驗 305→128，而 `Math.floor` 被拿掉時
  // 304 會從 127 變成 128，渲染門檻整個下移一個 CSS 像素而測試全綠。
  expect(at(304, 400)).toBe(127);
  expect(shouldRenderSprite(at(304, 400))).toBe(false);
  expect(at(305, 400)).toBe(128); // 規格說「實際生效門檻約 width ≥ 305」——這一行就是它
  expect(shouldRenderSprite(at(305, 400))).toBe(true);
  expect(at(381, 400)).toBe(160);
  expect(at(534, 400)).toBe(224);

  // 高度才是瓶頸時由高度決定
  expect(at(1000, 200)).toBe(160);

  // 不得放大：再大的 panel 也停在 256（dpr 1）
  expect(at(4000, 4000)).toBe(256);
  // dpr 3 時來源只有 512/3 = 170.67 CSS px 可用，上限跟著降
  expect(at(4000, 4000, 3)).toBeCloseTo(170.667, 2);
  // ⚠️ **對齊裝置像素這一步要在「真的會動到值」的地方斷言。**
  // 原本寫的是「dpr 2 下結果必為 0.5 的倍數」—— 那在 dpr 2 下恆成立（floor 已經給整數），
  // 所以把整行 `Math.round(side * dpr) / dpr` 刪掉、改成 `return side`，測試照樣 6/6 全綠。
  // dpr 1.5 才會真的咬到：floor 給的整數未必落在 1/1.5 的格點上。
  // dpr 1.5 且 floor 給出**奇數**時，`side * dpr` 不是整數，對齊步驟才真的會改動數值。
  // w=398 → floor(min(167.16, 320)) = 167（奇數）→ 167×1.5 = 250.5 → Math.round 給 251
  // （JS 對正數的 .5 是向上）→ 251/1.5 = 167.3333。
  // 把 `Math.round(side * dpr) / dpr` 整行刪掉的話，這一條會得到 167 而紅。
  expect(at(398, 400, 1.5)).toBeCloseTo(167.3333, 4);
  expect(at(399, 400, 1.5)).toBeCloseTo(167.3333, 4);
  expect(at(400, 400, 1.5)).toBe(168); // floor 給 168（偶數），對齊不動它
  // 不論哪一組，對齊之後乘上 dpr 都必須是整數 —— 那才是「對齊裝置像素」的定義。
  for (const [w, h, dpr] of [
    [398, 400, 1.5],
    [399, 400, 1.5],
    [400, 400, 1.5],
    [403, 400, 1.5],
    [517, 900, 2.5],
    [333, 400, 2],
  ] as const) {
    const v = at(w, h, dpr);
    expect(Math.abs(v * dpr - Math.round(v * dpr))).toBeLessThan(1e-9);
  }

  expect(at(300, 400, 0)).toBe(126); // dpr 為 0 時當 1，不得回 Infinity
});

test('SP-1.10 dead zone 跟著 stage 走', () => {
  expect(gazeDeadZonePx(224)).toBe(56);
  expect(gazeDeadZonePx(128)).toBe(32);
  // 下限 12：stage 很小時 dead zone 不該消失
  expect(gazeDeadZonePx(30)).toBe(12);
});
