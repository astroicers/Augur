#!/usr/bin/env node
/**
 * 把生成式繪圖工具產的「1 張母圖 + 17 張局部變體」組成兩張精靈圖。
 * `node tools/sprite-gen/assemble.mjs [來源目錄]`（預設 `assets/sprite-src/`，不進版控，SP-9.11）
 *
 * 為什麼不直接把 18 張圖縮小拼起來：生成工具每次出圖都會飄（線條、髮絲、衣褶），
 * 而精靈圖要求頭完全不動（SP-3.6）、覆蓋格只能畫在各自的視窗與臉上（SP-4、SP-6.6）。
 * 這支工具只取每張變體**與母圖不同、且落在該格允許範圍內**的像素，其餘一律用母圖 ——
 * 頭不動、修補塊不出界、閉眼蓋滿九個方向（SP-4.7）都由這裡保證，不靠生成工具做到像素級一致。
 *
 * 來源目錄：
 *   master.png                     母圖（正面、平視、閉嘴、純色背景）
 *   gaze-0..8.png                  視線 9 格（gaze-4 可省略 = 母圖）
 *   react-0..8.png                 反應 9 格（可在 align.json 的 empty 宣告留空，目前只允許 7）
 *   align.json                     {
 *     "leftPupil": [x, y], "rightPupil": [x, y],   母圖上兩眼瞳孔中心（畫面左邊那隻是 left）
 *     "colours": { "iris": "#…", "skin": "#…", "hair": "#…", "lineart": "#…" },   manifest 用
 *     "bgTolerance": 40, "diffThreshold": 28, "empty": [7], "stroke": true
 *   }
 * 圖檔可以是 PNG / JPEG / WebP（用 headless Chromium 解碼）。
 *
 * `--probe`：只對齊母圖，輸出 `.sprite-check/assemble-probe.png`（標出錨點與三個視窗）
 * 並印出幾個位置的取樣色，給填 align.json 的 colours 用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng } from '../lib/png.mjs';
import { skinMask } from '../lib/spriteChecks.mjs';
import { S, SHEET, HEM_TOP, featherAndBleed, hemFade, compose } from './post.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const NO_WRITE = args.includes('--dry-run');
const SRC = path.resolve(ROOT, args.find((a) => !a.startsWith('--')) ?? 'assets/sprite-src');
const OUT_DIR = path.join(ROOT, 'src/img/sprite');
const CHECK_DIR = path.join(ROOT, '.sprite-check');
const MANIFEST_TMPL = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/sprite/sprite-manifest.example.json'), 'utf8'));

const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'align.json'), 'utf8'));
const BG_TOL = cfg.bgTolerance ?? 40;
const DIFF_T = cfg.diffThreshold ?? 28;
// 最小模式（SP-0.10）：features.gaze = false 不收視線格（九格都用母圖）；
// features.expressions = false 不收點擊／情緒／pending 五格（反應格 0、1、2、3、8 宣告留空）。
const GAZE = cfg.features?.gaze !== false;
const EXPRESSIONS = cfg.features?.expressions !== false;
const EXPRESSION_CELLS = [0, 1, 2, 3, 8];
const EMPTY = new Set([...(cfg.empty ?? []), ...(EXPRESSIONS ? [] : EXPRESSION_CELLS)]);
const STROKE_W = 0.016 * S;
const STROKE_RGB = [0x6e, 0x76, 0x81];

const win = (k) => {
  const w = MANIFEST_TMPL.windows[k];
  return { x0: Math.round(w.x0 * S), x1: Math.round(w.x1 * S), y0: Math.round(w.y0 * S), y1: Math.round(w.y1 * S) };
};
const W = { E: win('E'), B: win('B'), M: win('M') };
const inWin = (w, x, y) => x >= w.x0 && x < w.x1 && y >= w.y0 && y < w.y1;
const hex = (rgb) =>
  '#' +
  rgb
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
const fail = (msg) => {
  console.error(`ASSEMBLE: ${msg}`);
  process.exit(2);
};

// ---------------------------------------------------------------------------
// 讀圖（任何瀏覽器吃得下的格式）
// ---------------------------------------------------------------------------
async function decodeAll(files) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = {};
  for (const [key, file] of Object.entries(files)) {
    const b64 = fs.readFileSync(file).toString('base64');
    const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : 'image/png';
    out[key] = await page
      .evaluate(
        async ({ b64, mime }) => {
          const img = new Image();
          img.src = `data:${mime};base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          // 轉回 PNG 交給 Node 解碼：比把幾百萬個數字序列化過 CDP 快一個量級
          return c.toDataURL('image/png').split(',')[1];
        },
        { b64, mime }
      )
      .then((png) => {
        const d = decodePng(Buffer.from(png, 'base64'));
        return { w: d.width, h: d.height, data: Uint8ClampedArray.from(d.data) };
      });
  }
  await browser.close();
  return out;
}

// ---------------------------------------------------------------------------
// 去背：從上、左、右三邊泛洪（不從下邊 —— 身體被格底切掉，白色前襟會連著下邊被吃掉）
// ---------------------------------------------------------------------------
function removeBackground(img) {
  const { w, h, data } = img;
  if (cfg.background === 'alpha') {
    return img;
  }
  // 背景色：上緣與左右兩緣像素的中位數
  const border = [];
  for (let x = 0; x < w; x++) {
    border.push(x * 4);
  }
  for (let y = 0; y < h; y++) {
    border.push(y * w * 4, (y * w + w - 1) * 4);
  }
  const med = [0, 1, 2].map((k) => {
    const v = border.map((o) => data[o + k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  const dist = (o) =>
    Math.max(Math.abs(data[o] - med[0]), Math.abs(data[o + 1] - med[1]), Math.abs(data[o + 2] - med[2]));
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (const o of border) {
    const i = o / 4;
    if (!bg[i] && dist(o) <= BG_TOL) {
      bg[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
        continue;
      }
      const j = yy * w + xx;
      if (!bg[j] && dist(j * 4) <= BG_TOL) {
        bg[j] = 1;
        stack.push(j);
      }
    }
  }
  const out = Uint8ClampedArray.from(data);
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) {
      out[i * 4 + 3] = 0;
    }
  }
  // 邊緣反混合：生成圖的抗鋸齒邊緣是「角色色 × 背景色」的混色（等於對白底 matte 過，SP-2.13）。
  // 離背景 ≤ 2px 的像素，用內側 3px 處的實色 q 反推：α = 投影 (p−bg)·(q−bg)/|q−bg|²，RGB 改成 q。
  const db = new Uint8Array(w * h).fill(255);
  let ring = [];
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) {
      db[i] = 0;
      ring.push(i);
    }
  }
  for (let d = 1; d <= 3; d++) {
    const next = [];
    for (const i of ring) {
      const x = i % w;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j >= 0 && j < w * h && Math.abs((j % w) - x) <= 1 && db[j] === 255) {
          db[j] = d;
          next.push(j);
        }
      }
    }
    ring = next;
  }
  for (let i = 0; i < w * h; i++) {
    if (db[i] !== 1 && db[i] !== 2) {
      continue;
    }
    const x = i % w;
    const y = (i / w) | 0;
    let q = -1;
    let best = Infinity;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
          continue;
        }
        const j = yy * w + xx;
        if (db[j] >= 3 && dx * dx + dy * dy < best) {
          best = dx * dx + dy * dy;
          q = j;
        }
      }
    }
    if (q < 0) {
      continue;
    }
    const o = i * 4;
    const qo = q * 4;
    let num = 0;
    let den = 0;
    for (let k = 0; k < 3; k++) {
      const pq = data[qo + k] - med[k];
      num += (data[o + k] - med[k]) * pq;
      den += pq * pq;
    }
    if (den < 300) {
      continue; // 角色色太接近背景色，分不開，維持原樣
    }
    const a = Math.min(1, Math.max(0, num / den));
    out[o] = data[qo];
    out[o + 1] = data[qo + 1];
    out[o + 2] = data[qo + 2];
    out[o + 3] = Math.round(a * 255);
  }
  return { w, h, data: out, bgColour: med };
}

// ---------------------------------------------------------------------------
// 對齊：等比縮放＋平移，讓兩眼瞳孔落在 (0.41, 0.38)·S 與 (0.59, 0.38)·S
// ---------------------------------------------------------------------------
const A = MANIFEST_TMPL.anchors;
const [L, R] = [cfg.leftPupil, cfg.rightPupil];
if (!L || !R) {
  fail('align.json 要有 leftPupil 與 rightPupil（母圖上兩眼瞳孔中心的像素座標）');
}
const scale = ((A.pupilRightX - A.pupilLeftX) * S) / Math.hypot(R[0] - L[0], R[1] - L[1]);
const tx = A.faceAxisX * S - ((L[0] + R[0]) / 2) * scale;
const ty = A.eyeLineY * S - ((L[1] + R[1]) / 2) * scale;

/** 超取樣（預乘 alpha、雙線性）把來源畫到 S×S 格。縮小時每個目標像素平均 k×k 個子樣本。 */
function align(img) {
  const { w, h, data } = img;
  const k = Math.max(2, Math.ceil(1 / scale) + 1);
  const out = new Uint8Array(S * S * 4);
  for (let v = 0; v < S; v++) {
    for (let u = 0; u < S; u++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (let j = 0; j < k; j++) {
        const y = (v + (j + 0.5) / k - ty) / scale - 0.5;
        const y0 = Math.floor(y);
        const fy = y - y0;
        for (let i = 0; i < k; i++) {
          const x = (u + (i + 0.5) / k - tx) / scale - 0.5;
          const x0 = Math.floor(x);
          const fx = x - x0;
          for (let n = 0; n < 4; n++) {
            const xx = x0 + (n & 1);
            const yy = y0 + (n >> 1);
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
              continue;
            }
            const wt = (n & 1 ? fx : 1 - fx) * (n >> 1 ? fy : 1 - fy);
            const o = (yy * w + xx) * 4;
            const a = (data[o + 3] / 255) * wt;
            r += data[o] * a;
            g += data[o + 1] * a;
            b += data[o + 2] * a;
            al += a;
          }
        }
      }
      const o = (v * S + u) * 4;
      if (al > 0) {
        out[o] = Math.round(r / al);
        out[o + 1] = Math.round(g / al);
        out[o + 2] = Math.round(b / al);
      }
      out[o + 3] = Math.round((al / (k * k)) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 遮罩工具
// ---------------------------------------------------------------------------
function dilate(mask, r) {
  const out = new Uint8Array(S * S);
  const R = Math.ceil(r);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!mask[y * S + x]) {
        continue;
      }
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (dx * dx + dy * dy <= r * r && xx >= 0 && yy >= 0 && xx < S && yy < S) {
            out[yy * S + xx] = 1;
          }
        }
      }
    }
  }
  return out;
}
const erode = (mask, r) => {
  const inv = mask.map((v) => (v ? 0 : 1));
  return dilate(inv, r).map((v) => (v ? 0 : 1));
};
const and = (a, b) => a.map((v, i) => (v && b[i] ? 1 : 0));
const or = (a, b) => a.map((v, i) => (v || b[i] ? 1 : 0));

/** 去掉面積 < n 的 4-連通小塊（生成圖的雜訊差異）。 */
function dropSpecks(mask, n) {
  const seen = new Uint8Array(S * S);
  const out = Uint8Array.from(mask);
  for (let i = 0; i < S * S; i++) {
    if (!mask[i] || seen[i]) {
      continue;
    }
    const comp = [i];
    seen[i] = 1;
    for (let q = 0; q < comp.length; q++) {
      const j = comp[q];
      const x = j % S;
      for (const k of [j - 1, j + 1, j - S, j + S]) {
        if (k < 0 || k >= S * S || seen[k] || !mask[k] || Math.abs((k % S) - x) > 1) {
          continue;
        }
        seen[k] = 1;
        comp.push(k);
      }
    }
    if (comp.length < n) {
      for (const j of comp) {
        out[j] = 0;
      }
    }
  }
  return out;
}

/** 對齊後的變體與母圖不同的像素（預乘後任一通道差 > DIFF_T）。 */
function diffMask(a, b) {
  const m = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    const pa = a[o + 3] / 255;
    const pb = b[o + 3] / 255;
    let d = Math.abs(a[o + 3] - b[o + 3]);
    for (let k = 0; k < 3; k++) {
      d = Math.max(d, Math.abs(a[o + k] * pa - b[o + k] * pb));
    }
    m[i] = d > DIFF_T ? 1 : 0;
  }
  return dilate(dropSpecks(m, 6), 2);
}

/** 遮罩的柔邊權重（σ≈1.5 的盒狀三次近似）。 */
function softWeights(mask) {
  let w = Float32Array.from(mask);
  for (let pass = 0; pass < 3; pass++) {
    const t = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let s = 0;
        let n = 0;
        for (let d = -1; d <= 1; d++) {
          const xx = x + d;
          if (xx >= 0 && xx < S) {
            s += w[y * S + xx];
            n++;
          }
        }
        t[y * S + x] = s / n;
      }
    }
    const u = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let s = 0;
        let n = 0;
        for (let d = -1; d <= 1; d++) {
          const yy = y + d;
          if (yy >= 0 && yy < S) {
            s += t[yy * S + x];
            n++;
          }
        }
        u[y * S + x] = s / n;
      }
    }
    w = u;
  }
  return w;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const files = { master: path.join(SRC, cfg.master ?? 'master.png') };
const findFile = (base) =>
  ['.png', '.jpg', '.jpeg', '.webp'].map((e) => path.join(SRC, base + e)).find((f) => fs.existsSync(f));
if (!PROBE) {
  for (let c = 0; c < 9; c++) {
    const g = GAZE ? findFile(`gaze-${c}`) : null;
    if (g) {
      files[`gaze-${c}`] = g;
    } else if (GAZE && c !== 4) {
      fail(`缺 gaze-${c}（視線格不能留空；不做視線就在 align.json 設 features.gaze = false）`);
    }
    const r = EMPTY.has(c) ? null : findFile(`react-${c}`);
    if (r) {
      files[`react-${c}`] = r;
    } else if (!EMPTY.has(c)) {
      fail(`缺 react-${c}（半閉眼可在 align.json 的 empty 宣告留空；不做表情就設 features.expressions = false）`);
    }
  }
}
for (const c of cfg.empty ?? []) {
  if (c !== 7) {
    fail(`empty 只允許 7（SP-4.8）；要整組不做表情請用 features.expressions = false，收到 ${c}`);
  }
}

const raw = await decodeAll(files);
const master0 = removeBackground(raw.master);
const sameSize = (img) => {
  if (img.w === master0.w && img.h === master0.h) {
    return img;
  }
  fail(`變體尺寸 ${img.w}×${img.h} 與母圖 ${master0.w}×${master0.h} 不同 —— 生成工具改了畫布大小，請以相同尺寸重出`);
};
const master = align(master0);
console.log(
  `對齊：縮放 ${scale.toFixed(3)}，平移 (${tx.toFixed(1)}, ${ty.toFixed(1)})；背景色 ${hex(master0.bgColour ?? [0, 0, 0])}`
);

// 剪影的上緣、左右寬（SP-2.1 外緣帶 0.02·S、SP-7.5 頭頂 0.048–0.08）—— 早報，免得跑完才被驗收擋
{
  let top = S;
  let xl = S;
  let xr = -1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (master[(y * S + x) * 4 + 3] >= 128) {
        top = Math.min(top, y);
        xl = Math.min(xl, x);
        xr = Math.max(xr, x);
      }
    }
  }
  const margin = 0.02 * S + (cfg.stroke === false ? 0 : STROKE_W) + 3;
  console.log(`剪影：頂 ${(top / S).toFixed(3)}·S，左右 ${(xl / S).toFixed(3)}–${(xr / S).toFixed(3)}·S`);
  if (top < margin || xl < margin || xr > S - margin) {
    console.error(`  ⚠️ 剪影離格邊不到 ${margin.toFixed(0)}px（外緣透明帶＋描邊）—— 母圖四周要多留白，或頭部比例太大`);
  }
}

if (PROBE) {
  fs.mkdirSync(CHECK_DIR, { recursive: true });
  const vis = Uint8Array.from(master);
  const mark = (x, y, rgb) => {
    for (let d = -6; d <= 6; d++) {
      for (const [xx, yy] of [
        [x + d, y],
        [x, y + d],
      ]) {
        if (xx >= 0 && yy >= 0 && xx < S && yy < S) {
          vis.set([...rgb, 255], (Math.round(yy) * S + Math.round(xx)) * 4);
        }
      }
    }
  };
  for (const w of Object.values(W)) {
    for (let x = w.x0; x < w.x1; x++) {
      mark(x, w.y0, [255, 0, 255]);
    }
  }
  mark(A.pupilLeftX * S, A.eyeLineY * S, [255, 0, 0]);
  mark(A.pupilRightX * S, A.eyeLineY * S, [255, 0, 0]);
  mark(S / 2, A.chinY * S, [0, 160, 255]);
  mark(S / 2, A.crownY * S, [0, 160, 255]);
  fs.writeFileSync(path.join(CHECK_DIR, 'assemble-probe.png'), encodePng(S, S, vis, 4));
  const at = (fx, fy) => {
    const o = (Math.round(fy * S) * S + Math.round(fx * S)) * 4;
    return hex([master[o], master[o + 1], master[o + 2]]);
  };
  console.log('取樣色（填 align.json 的 colours 前請目視確認）：');
  console.log(`  臉頰 skin? ${at(0.36, 0.47)} / ${at(0.64, 0.47)}`);
  console.log(`  虹膜 iris? ${at(A.pupilLeftX, A.eyeLineY + 0.012)} / ${at(A.pupilRightX, A.eyeLineY + 0.012)}`);
  console.log(`  頭頂 hair/hood? ${at(0.5, 0.12)}`);
  console.log(`→ .sprite-check/assemble-probe.png`);
  process.exit(0);
}

const aligned = {};
for (const [k, img] of Object.entries(raw)) {
  if (k !== 'master') {
    aligned[k] = align(removeBackground(sameSize(img)));
  }
}

// 臉部皮膚遮罩（SP-6.6）：用驗收工具同一支函式量，兩邊的定義才一致
const colours = cfg.colours ?? {};
for (const k of ['iris', 'skin', 'hair', 'lineart']) {
  if (!colours[k]) {
    fail(`align.json 的 colours.${k} 沒填（先跑 --probe 看取樣色）`);
  }
}
const manifest = JSON.parse(JSON.stringify(MANIFEST_TMPL));
Object.assign(manifest.colours, colours);
manifest.stroke.colour = hex(STROKE_RGB);
const probeSheet = { width: SHEET, height: SHEET, data: compose(Array.from({ length: 9 }, () => master)) };
const skin = skinMask(probeSheet, manifest, {});

const allowedFor = (owners) => {
  const m = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const inE = inWin(W.E, x, y);
      const inB = inWin(W.B, x, y);
      const inM = inWin(W.M, x, y);
      const ok =
        (owners.includes('E') && inE) ||
        (owners.includes('B') && inB) ||
        (owners.includes('M') && inM) ||
        (owners.includes('K') && !inE && !inB && !inM);
      m[y * S + x] = ok && skin[y * S + x] ? 1 : 0;
    }
  }
  return erode(m, 2); // 柔邊留在允許範圍內
};

const report = [];
const drift = (name, diff, allowed) => {
  let out = 0;
  let all = 0;
  for (let i = 0; i < S * S; i++) {
    if (diff[i]) {
      all++;
      if (!allowed[i]) {
        out++;
      }
    }
  }
  report.push({ name, changed: all, dropped: out });
};

// 視線格：母圖 + 變體在眼窗內改動的部分
const Eallowed = (() => {
  const m = new Uint8Array(S * S);
  for (let y = W.E.y0 + 3; y < W.E.y1 - 3; y++) {
    for (let x = W.E.x0 + 3; x < W.E.x1 - 3; x++) {
      m[y * S + x] = 1;
    }
  }
  return m;
})();
let gazeUnion = new Uint8Array(S * S);
const dirCells = [];
for (let g = 0; g < 9; g++) {
  const v = aligned[`gaze-${g}`];
  if (!v) {
    dirCells.push(Uint8Array.from(master));
    continue;
  }
  const diff = diffMask(v, master);
  drift(`gaze-${g}`, diff, Eallowed);
  const m = and(diff, Eallowed);
  gazeUnion = or(gazeUnion, m);
  const w = softWeights(m);
  const cell = Uint8Array.from(master);
  for (let i = 0; i < S * S; i++) {
    const t = w[i] * Eallowed[i];
    if (t <= 0) {
      continue;
    }
    for (let k = 0; k < 4; k++) {
      cell[i * 4 + k] = Math.round(master[i * 4 + k] * (1 - t) + v[i * 4 + k] * t);
    }
  }
  dirCells.push(cell);
}

// 外描邊（SP-6.4）：剪影外一圈 0.016·S 的描邊色；下襬漸隱帶不描（SP-6.5）
if (cfg.stroke !== false) {
  const sil = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) {
    sil[i] = master[i * 4 + 3] >= 128 ? 1 : 0;
  }
  const ring = dilate(sil, STROKE_W);
  for (const cell of dirCells) {
    for (let i = 0; i < S * S; i++) {
      if (!ring[i] || Math.floor(i / S) >= HEM_TOP - 4) {
        continue;
      }
      const a = cell[i * 4 + 3] / 255;
      for (let k = 0; k < 3; k++) {
        cell[i * 4 + k] = Math.round(cell[i * 4 + k] * a + STROKE_RGB[k] * (1 - a));
      }
      cell[i * 4 + 3] = 255;
    }
  }
}

// 反應格：只有變體改動、且落在該格產權 ∩ 臉部皮膚內的像素
const reaCells = [];
for (let c = 0; c < 9; c++) {
  const v = aligned[`react-${c}`];
  if (!v) {
    reaCells.push(new Uint8Array(S * S * 4));
    continue;
  }
  const owners = manifest.reactionOwnership[c];
  const allowed = allowedFor(owners);
  let m = diffMask(v, master);
  drift(`react-${c}`, m, allowed);
  // 會蓋眼睛的格要連九個視線格的眼睛一起蓋（SP-4.7）。點擊、全閉眼：整隻眼；
  // 半閉眼（SP-4.8）只蓋眼皮線以上 —— 下半隻眼要露出底圖、跟著視線走，蓋滿反而讓虹膜出現在眼瞼核心裡。
  if (owners.includes('E') && [0, 6].includes(c)) {
    m = or(m, dilate(gazeUnion, 2));
  }
  const cut = new Int32Array(S).fill(-1);
  if (owners.includes('E') && c === 7) {
    for (let y = W.E.y0; y < W.E.y1; y++) {
      for (let x = W.E.x0; x < W.E.x1; x++) {
        if (m[y * S + x]) {
          cut[x] = y;
        }
      }
    }
    const up = dilate(gazeUnion, 2).map((val, i) => (val && i / S < cut[i % S] ? 1 : 0));
    m = or(m, up);
  }
  // 再外擴 3px：柔邊落在沒改動的皮膚上，半透明像素才會跟最近的實色一致（SP-2.15 / SP-7.1）
  m = and(dilate(m, 3), allowed);
  if (c === 7) {
    // 外擴不得越過眼皮線往下（否則眼瞼核心裡會出現虹膜，SP-7.4/眨眼不透明）
    m = m.map((val, i) =>
      val && !(inWin(W.E, i % S, (i / S) | 0) && cut[i % S] >= 0 && i / S > cut[i % S] + 1) ? 1 : 0
    );
  }
  const cell = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    if (m[i]) {
      cell.set(v.subarray(i * 4, i * 4 + 3), i * 4);
      cell[i * 4 + 3] = v[i * 4 + 3];
    }
  }
  reaCells.push(cell);
}

console.log('變體差異（丟掉的是落在該格允許範圍外的改動 —— 太多代表生成工具改到了不該改的地方）：');
for (const r of report) {
  const pct = r.changed ? (100 * r.dropped) / r.changed : 0;
  console.log(
    `  ${r.name.padEnd(8)} 改動 ${String(r.changed).padStart(6)} px，丟掉 ${String(r.dropped).padStart(6)} px（${pct.toFixed(0)}%）${pct > 50 ? '  ⚠️' : ''}`
  );
}

const dirSheet = compose(dirCells.map((c) => hemFade(featherAndBleed(c))));
const reaSheet = compose(reaCells.map((c) => featherAndBleed(c)));
const dirPng = encodePng(SHEET, SHEET, dirSheet, 4);
const reaPng = encodePng(SHEET, SHEET, reaSheet, 4);
manifest._note =
  cfg.note ??
  '由 tools/sprite-gen/assemble.mjs 從生成式繪圖工具的母圖與變體組成；出處見 docs/asset-provenance.md 與 docs/sprite/SOURCE-PROMPTS.md。';
delete manifest._example_empty;
delete manifest.irisCentroids;
if (EMPTY.size) {
  manifest.intentionally_empty = [...EMPTY].sort().map((cell) => ({ sheet: 'reactions', cell }));
}
if (!GAZE || !EXPRESSIONS) {
  manifest.features = { gaze: GAZE, expressions: EXPRESSIONS };
}
manifest.sha256.directions = crypto.createHash('sha256').update(dirPng).digest('hex');
manifest.sha256.reactions = crypto.createHash('sha256').update(reaPng).digest('hex');
if (NO_WRITE) {
  console.log(
    `（--dry-run）directions ${(dirPng.length / 1024).toFixed(0)} KB, reactions ${(reaPng.length / 1024).toFixed(0)} KB，未寫檔`
  );
  process.exit(0);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'directions.png'), dirPng);
fs.writeFileSync(path.join(OUT_DIR, 'reactions.png'), reaPng);
fs.writeFileSync(path.join(OUT_DIR, 'sprite-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `directions ${(dirPng.length / 1024).toFixed(0)} KB, reactions ${(reaPng.length / 1024).toFixed(0)} KB → ${path.relative(ROOT, OUT_DIR)}`
);
console.log('下一步：node tools/check-sprite-sheets.mjs');
