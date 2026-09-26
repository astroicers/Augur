#!/usr/bin/env node
/**
 * 產生編號假 sheet，用來驗**盲測頁本身**（不是驗素材）。
 * `node tools/blind-test/make-fixture.mjs` → `.sprite-check/blind-test-fixture.png`。
 *
 * 每格印兩樣東西：**格號數字**與**指向該方向的箭頭**。
 * 兩樣都畫是有理由的 —— 數字驗「頁面取到的是不是這一格」，
 * 箭頭讓人可以實際跑完一輪並預期得到 100%。若跑出來不是 100%，
 * 錯的是頁面的格號對映或出題邏輯，不是眼睛。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, '.sprite-check', 'blind-test-fixture.png');
const S = 512;
const SHEET = S * 3;

/** 3×5 點陣字，只要 0–8。 */
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
};

const buf = new Uint8Array(SHEET * SHEET * 4);

/**
 * ⚠️ **座標必須取整**。typed array 對小數索引是**靜默丟棄**，不丟錯、不警告 ——
 * 第一版的 `gy = oy + S * 0.1` 是 51.2，九格的數字一個都沒被寫進去，
 * 而產出的 PNG 完全合法、尺寸正確、箭頭也都在。這種錯只有把圖看一眼才會發現。
 */
function px(x, y, rgb) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= SHEET || y >= SHEET) {
    return;
  }
  const o = (y * SHEET + x) * 4;
  buf[o] = rgb[0];
  buf[o + 1] = rgb[1];
  buf[o + 2] = rgb[2];
  buf[o + 3] = 255;
}

function disc(cx, cy, r, rgb) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        px(x, y, rgb);
      }
    }
  }
}

for (let cell = 0; cell < 9; cell++) {
  const ox = (cell % 3) * S;
  const oy = Math.trunc(cell / 3) * S;
  const col = (cell % 3) - 1;
  const row = Math.trunc(cell / 3) - 1;

  // 數字：3×5 放大 32 倍（160px 高），置於格子上方。
  // 用琥珀色而非白色 —— 白色在透明底上等於隱形，把 PNG 丟進任何白底預覽器
  // （包括 review 時）就看不見數字，而看不見的驗證資訊等於沒有。
  const scale = 32;
  const g = GLYPHS[cell];
  const gx = ox + S / 2 - (3 * scale) / 2;
  const gy = oy + S * 0.1;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      if (g[r][c] !== '1') {
        continue;
      }
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          px(gx + c * scale + dx, gy + r * scale + dy, [0xe8, 0xb4, 0x4a]);
        }
      }
    }
  }

  // 箭頭：由格子下半的中心往該方向拉一條粗線，末端一顆大圓當箭頭
  const cx = ox + S / 2;
  const cy = oy + S * 0.72;
  if (col !== 0 || row !== 0) {
    const len = Math.hypot(col, row);
    const ux = col / len;
    const uy = row / len;
    for (let t = 0; t <= 110; t++) {
      disc(cx + ux * t, cy + uy * t, 9, [0x6a, 0x9f, 0xe0]);
    }
    disc(cx + ux * 118, cy + uy * 118, 26, [0x6a, 0x9f, 0xe0]);
  } else {
    disc(cx, cy, 26, [0x80, 0x84, 0x8c]); // 中央格：沒有方向
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePng(SHEET, SHEET, buf));
console.log(`編號假 sheet：${path.relative(ROOT, OUT)}（${SHEET}×${SHEET}）`);
console.log('用法：node tools/blind-test/serve.mjs → 開 http://localhost:8787/ → 點「編號假 sheet」');
console.log('預期：照箭頭作答應得 100%。不是 100% 就是頁面的格號對映或出題邏輯有錯。');
