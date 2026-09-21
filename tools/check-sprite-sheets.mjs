#!/usr/bin/env node
/**
 * sprite sheet 機械驗收（SP-7）。`node tools/check-sprite-sheets.mjs`。
 *
 * **退出碼（SP-7.11）**：0 = 通過；1 = 素材違規；2 = 工具或格式錯誤。
 * 兩者分開是有意義的 —— 「交付了一張 colour type 2 的圖」是流程錯了不是畫錯了，
 * 報給畫師的訊息完全不同。
 *
 * **開關（SP-7.14）**：以 `src/img/sprite/sprite-manifest.json` 在不在決定。
 * 不在 → 印 `SPRITE-CHECK: NOT-DELIVERED` 並回 0。用版控的 manifest 當開關
 * 而不是「PNG 在不在」，是為了讓關閘成為一筆看得見的 diff。
 *
 * **不提供旁路（SP-7.12）**：沒有 `--force`、沒有 `--skip`。要放寬只能改 manifest 裡
 * 凍結的錨點值或容差參數，而那會被 sha256 連帶影響、視同規格變更須經 review。
 *
 * **不呼叫任何 git 指令（SP-7.13）**：會刷新 `.git/index` 的 mtime，破壞
 * `tools/asp-test.sh` 所依賴的「最後一個動作必須是寫 .asp-test-result.json」時序判定
 * （ASP hook 的判定是 `[ ! "$IDX" -nt "$TR" ]`）。素材路徑一律用常數，不用 `git ls-files`。
 *
 * **sheet 檔名是常數不是 manifest 欄位**：SP-7.15 明文「manifest 不得記錄 sheet 的路徑，
 * 只記 sha256」—— 因為 webpack 會把它們改成 hash 檔名，manifest 記路徑必然過期。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng, PngFormatError } from './lib/png.mjs';
import { encodeGif } from './lib/gif.mjs';
import {
  CELL_COUNT,
  cellView,
  checkAnchors,
  checkDownsampleReadability,
  checkFileSize,
  checkFormatAndHygiene,
  checkGazeBinding,
  checkHeadImmobility,
  checkLuminanceAndStroke,
  checkOverlayOwnership,
  windowRect,
} from './lib/spriteChecks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPRITE_DIR = path.join(ROOT, 'src', 'img', 'sprite');
const MANIFEST_PATH = path.join(SPRITE_DIR, 'sprite-manifest.json');
const SHEET_FILES = { directions: 'directions.png', reactions: 'reactions.png' };
const OUT_DIR = path.join(ROOT, '.sprite-check');
const SENTINEL = 'SPRITE-CHECK: NOT-DELIVERED';

/** Grafana 主題參考色（SP-6.3，實查 @grafana/data 的 palette.mjs）。 */
const THEMES = [
  { name: 'dark', bg: [0x18, 0x1b, 0x1f] },
  { name: 'light', bg: [0xff, 0xff, 0xff] },
];
const CONTACT_SIZES = [128, 160, 224];
const MAGENTA = [0xff, 0x00, 0xff, 0xff];

const REQUIRED_MANIFEST_KEYS = [
  'sheet',
  'anchors',
  'windows',
  'margins',
  'colours',
  'luminance',
  'stroke',
  'cells',
  'reactionOwnership',
  'budget',
  'sha256',
];

class ToolError extends Error {}

function readManifest(manifestPath) {
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new ToolError(`manifest 讀不到：${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    throw new ToolError(`manifest 不是合法 JSON：${err.message}`);
  }
  const missing = REQUIRED_MANIFEST_KEYS.filter((k) => !(k in manifest));
  if (missing.length) {
    throw new ToolError(`manifest 缺少必要欄位：${missing.join(', ')}`);
  }
  const g = manifest.sheet;
  if (g.cols * g.cellPx !== g.width || g.rows * g.cellPx !== g.height) {
    throw new ToolError(`manifest 的 sheet 幾何自相矛盾：${g.cols}×${g.cellPx} ≠ ${g.width} 或 ${g.rows}×${g.cellPx} ≠ ${g.height}`);
  }
  for (const name of Object.keys(SHEET_FILES)) {
    if (typeof manifest.sha256?.[name] !== 'string') {
      throw new ToolError(`manifest.sha256.${name} 缺少或不是字串`);
    }
  }
  if (!Array.isArray(manifest.reactionOwnership) || manifest.reactionOwnership.length !== CELL_COUNT) {
    throw new ToolError('manifest.reactionOwnership 必須是 9 個元素的陣列');
  }
  return manifest;
}

/**
 * SP-7.15：**先比對 sha256 再做像素檢查**。
 * 沒有這一步，換一張圖而不動 manifest 會全部照樣綠 ——
 * 那等於把 SP-7.12「不提供旁路」變成一句空話。
 */
function verifyDigests(manifest, spriteDir) {
  const findings = [];
  const buffers = {};
  const sizes = {};
  for (const [name, file] of Object.entries(SHEET_FILES)) {
    const p = path.join(spriteDir, file);
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch (err) {
      throw new ToolError(`manifest 存在但 ${file} 讀不到：${err.message}`);
    }
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = manifest.sha256[name].toLowerCase();
    if (actual !== expected) {
      findings.push({
        id: 'SP-7.15/sha256',
        severity: 'error',
        sheet: name,
        message: `${file} 的 sha256 為 ${actual}，manifest 記的是 ${expected} —— 換圖必須同時更新 manifest`,
      });
    }
    buffers[name] = buf;
    sizes[name] = buf.length;
  }
  return { findings, buffers, sizes };
}

// --- 產出物 ---------------------------------------------------------------

function cellBuffer(sheet, cell, manifest) {
  const { cellPx } = manifest.sheet;
  const v = cellView(sheet, cell, manifest.sheet);
  const out = new Uint8Array(cellPx * cellPx * 4);
  for (let y = 0; y < cellPx; y++) {
    const src = v.offset(0, y);
    out.set(sheet.data.subarray(src, src + cellPx * 4), y * cellPx * 4);
  }
  return out;
}

/** source-over 合成，兩邊都是同尺寸的 RGBA。 */
function composite(under, over) {
  const out = new Uint8Array(under.length);
  for (let i = 0; i < under.length; i += 4) {
    const oa = over[i + 3] / 255;
    const ua = under[i + 3] / 255;
    const a = oa + ua * (1 - oa);
    if (a === 0) {
      continue;
    }
    for (let k = 0; k < 3; k++) {
      out[i + k] = Math.round((over[i + k] * oa + under[i + k] * ua * (1 - oa)) / a);
    }
    out[i + 3] = Math.round(a * 255);
  }
  return out;
}

function downsampleSquare(buf, size, target) {
  const out = new Uint8Array(target * target * 4);
  const scale = size / target;
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const sx1 = Math.min(size, Math.floor((x + 1) * scale));
      const sy1 = Math.min(size, Math.floor((y + 1) * scale));
      for (let sy = Math.floor(y * scale); sy < sy1; sy++) {
        for (let sx = Math.floor(x * scale); sx < sx1; sx++) {
          const o = (sy * size + sx) * 4;
          const pa = buf[o + 3];
          r += buf[o] * pa;
          g += buf[o + 1] * pa;
          b += buf[o + 2] * pa;
          a += pa;
          n++;
        }
      }
      const o = (y * target + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = n > 0 ? Math.round(a / n) : 0;
    }
  }
  return out;
}

function flatten(buf, size, bg) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = buf[i + 3] / 255;
    out[i] = Math.round(buf[i] * a + bg[0] * (1 - a));
    out[i + 1] = Math.round(buf[i + 1] * a + bg[1] * (1 - a));
    out[i + 2] = Math.round(buf[i + 2] * a + bg[2] * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

class Canvas {
  constructor(width, height, bg) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = bg[0];
      this.data[i + 1] = bg[1];
      this.data[i + 2] = bg[2];
      this.data[i + 3] = 255;
    }
  }
  blit(buf, size, dx, dy) {
    for (let y = 0; y < size; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) {
        continue;
      }
      for (let x = 0; x < size; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.width) {
          continue;
        }
        const s = (y * size + x) * 4;
        const t = (ty * this.width + tx) * 4;
        this.data[t] = buf[s];
        this.data[t + 1] = buf[s + 1];
        this.data[t + 2] = buf[s + 2];
        this.data[t + 3] = 255;
      }
    }
  }
}

/**
 * SP-7.9 檢查 I — 合成聯絡表。
 *
 * 檢查 A–H 全是像素級／幾何級的不變量，**沒有一條會因為「臉太小看不懂」
 * 或「嘴巴像發條玩具」而紅**。這四張圖是唯一能擋下那類失敗的閘門 ——
 * 它不自動判定，它只負責讓人一眼看到。
 */
function writeContactSheets(sheets, manifest, outDir) {
  const { cellPx } = manifest.sheet;
  const pad = 12;
  const written = [];

  const emit = (fileName, items) => {
    // 版面：每個主題一個橫帶，帶內每個尺寸一列，列內每個項目並排
    const rowH = CONTACT_SIZES.reduce((s, n) => s + n + pad, pad);
    const width = pad + items.length * (Math.max(...CONTACT_SIZES) + pad);
    const canvas = new Canvas(width, THEMES.length * rowH, THEMES[0].bg);
    THEMES.forEach((theme, ti) => {
      const bandTop = ti * rowH;
      for (let y = bandTop; y < bandTop + rowH && y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const o = (y * canvas.width + x) * 4;
          canvas.data[o] = theme.bg[0];
          canvas.data[o + 1] = theme.bg[1];
          canvas.data[o + 2] = theme.bg[2];
        }
      }
      let top = bandTop + pad;
      for (const size of CONTACT_SIZES) {
        items.forEach((buf, i) => {
          const small = flatten(downsampleSquare(buf, cellPx, size), size, theme.bg);
          canvas.blit(small, size, pad + i * (Math.max(...CONTACT_SIZES) + pad), top);
        });
        top += size + pad;
      }
    });
    const p = path.join(outDir, fileName);
    fs.writeFileSync(p, encodePng(canvas.width, canvas.height, canvas.data));
    written.push(path.relative(ROOT, p));
  };

  const master = cellBuffer(sheets.directions, 4, manifest);
  const mouthClosed = master;

  // 1. 九個視線格 × master 情緒
  emit(
    'contact-1-gaze.png',
    Array.from({ length: CELL_COUNT }, (_, c) => cellBuffer(sheets.directions, c, manifest))
  );
  // 2. 三個情緒 × 閉口（warning=1 / critical=2 / resolved=3）
  emit(
    'contact-2-emotions.png',
    [1, 2, 3].map((r) => composite(mouthClosed, cellBuffer(sheets.reactions, r, manifest)))
  );
  // 4. pending（格 8）與 click（格 0）各一張
  emit(
    'contact-4-reactions.png',
    [8, 0].map((r) => composite(master, cellBuffer(sheets.reactions, r, manifest)))
  );

  // 3. 張口/閉口交替的 GIF。嘴型幀是 reactions 4（半開）與 5（大開）。
  //    GIF 承載不了 alpha 的抗鋸齒邊緣，所以先合成到 dark panel 底色上（見 gif.mjs 檔頭）。
  const frames = [mouthClosed, composite(master, cellBuffer(sheets.reactions, 4, manifest)), composite(master, cellBuffer(sheets.reactions, 5, manifest))]
    .map((buf) => flatten(downsampleSquare(buf, cellPx, 160), 160, THEMES[0].bg));
  const gifPath = path.join(outDir, 'contact-3-mouth.gif');
  fs.writeFileSync(gifPath, encodeGif({ width: 160, height: 160, frames: [frames[0], frames[1], frames[0], frames[2]], delayCs: 18 }));
  written.push(path.relative(ROOT, gifPath));

  return written;
}

/**
 * SP-7.10 的診斷**圖**（表在 `report()` 裡）。
 * 規格明寫「只印『不過』而不印『差多少』不符本規格」—— 圖是那句話的另一半：
 * 差異像素以洋紅標示（沿用 check_layers.py 的粉紅慣例），人才知道差在哪裡。
 */
function writeDiffImages(sheets, manifest, failedCells, outDir) {
  const { cellPx } = manifest.sheet;
  const base = cellBuffer(sheets.directions, 4, manifest);
  const E = windowRect(manifest.windows.E, cellPx);
  const written = [];
  for (const cell of failedCells) {
    const buf = cellBuffer(sheets.directions, cell, manifest);
    const out = flatten(buf, cellPx, THEMES[0].bg);
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        if (x >= E.x0 && x < E.x1 && y >= E.y0 && y < E.y1) {
          continue;
        }
        const o = (y * cellPx + x) * 4;
        const differs =
          Math.abs(base[o] - buf[o]) > 2 ||
          Math.abs(base[o + 1] - buf[o + 1]) > 2 ||
          Math.abs(base[o + 2] - buf[o + 2]) > 2 ||
          Math.abs(base[o + 3] - buf[o + 3]) > 2;
        if (differs) {
          out.set(MAGENTA, o);
        }
      }
    }
    const p = path.join(outDir, `diff-directions-${cell}.png`);
    fs.writeFileSync(p, encodePng(cellPx, cellPx, out));
    written.push(path.relative(ROOT, p));
  }
  return written;
}

// --- 報表 -----------------------------------------------------------------

function report(findings, centroids, manifest, log = console.log) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');

  const rows = [];
  for (let c = 0; c < CELL_COUNT; c++) {
    const mine = findings.filter((f) => f.cell === c);
    const cov = mine.find((f) => f.id === 'SP-7.1/覆蓋率');
    const ctr = centroids?.[c];
    rows.push({
      格: c,
      語意: `${manifest.cells.directions[c]} / ${manifest.cells.reactions[c]}`,
      覆蓋率: cov ? `${(cov.measured * 100).toFixed(1)}%` : '—',
      虹膜質心: ctr && ctr.n > 0 ? `${ctr.cx.toFixed(1)},${ctr.cy.toFixed(1)}` : '—',
      失敗: mine.filter((f) => f.severity === 'error').map((f) => f.id).join(' ') || '—',
    });
  }
  log('\n--- 逐格診斷（SP-7.10）---');
  log(renderTable(rows));

  const detail = (f) => {
    const where = [f.sheet, f.cell !== undefined ? `格${f.cell}` : null].filter(Boolean).join(' ');
    const over =
      f.measured !== undefined && f.limit !== undefined
        ? `  [實測 ${fmt(f.measured)} / 上限 ${fmt(f.limit)}；超出 ${fmt(Math.abs(f.measured - f.limit))}]`
        : '';
    return `  ${f.id.padEnd(20)} ${where.padEnd(18)} ${f.message}${over}`;
  };
  if (errors.length) {
    log(`\n--- 素材違規 ${errors.length} 項 ---`);
    errors.forEach((f) => log(detail(f)));
  }
  if (warns.length) {
    log(`\n--- 警告 ${warns.length} 項（首版僅記錄）---`);
    warns.forEach((f) => log(detail(f)));
  }
  return errors.length;
}

/** 自繪表格：`console.table` 不吃注入的 log，且中日文欄寬會亂。 */
function renderTable(rows) {
  const cols = Object.keys(rows[0]);
  const wide = (v) => [...String(v)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  const w = cols.map((c) => Math.max(wide(c), ...rows.map((r) => wide(r[c]))));
  const padTo = (v, n) => String(v) + ' '.repeat(Math.max(0, n - wide(v)));
  const line = (cells) => '  ' + cells.map((v, i) => padTo(v, w[i])).join('  ');
  return [line(cols), '  ' + w.map((n) => '-'.repeat(n)).join('  '), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

function fmt(n) {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  return Math.abs(n) >= 1000 || Number.isInteger(n) ? String(n) : n.toFixed(4);
}

// --- 主流程 ---------------------------------------------------------------

/**
 * 跑一次完整檢查，回傳 SP-7.11 的退出碼。
 *
 * **參數化 spriteDir / outDir 不是旁路**（SP-7.12）：它換的是「檢查哪一組檔案」，
 * 換不掉任何一條檢查、也放寬不了任何一個門檻。CLI 一律以 repo 內的固定路徑呼叫，
 * 沒有對應的命令列旗標；參數的唯一用途是讓 selftest 能餵合成 fixture 進來，
 * 而那正是這些檢查會不會變成裝飾品的分水嶺。
 */
export function runCheck({ spriteDir = SPRITE_DIR, outDir = OUT_DIR, log = console.log } = {}) {
  const manifestPath = path.join(spriteDir, 'sprite-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // SP-7.14：跳過本身要看得見。asp-test.sh 擷取這一行串進 .asp-test-result.json。
    log(SENTINEL);
    return 0;
  }

  const manifest = readManifest(manifestPath);
  const { findings: digestFindings, buffers, sizes } = verifyDigests(manifest, spriteDir);
  if (digestFindings.length) {
    // SP-7.15：sha256 不符就不往下做像素檢查 —— 底下每一條測的都會是「不是宣告的那張圖」。
    digestFindings.forEach((f) => log(`  ${f.id}  ${f.sheet}  ${f.message}`));
    log('\nsha256 不符，像素檢查未執行。');
    return 1;
  }

  const sheets = {};
  for (const [name, buf] of Object.entries(buffers)) {
    try {
      sheets[name] = decodePng(buf);
    } catch (err) {
      if (err instanceof PngFormatError) {
        throw new ToolError(`${SHEET_FILES[name]}：${err.message}`);
      }
      throw err;
    }
  }

  const findings = [];
  findings.push(...checkFormatAndHygiene(sheets, manifest));
  findings.push(...checkHeadImmobility(sheets.directions, manifest));
  const gaze = checkGazeBinding(sheets.directions, manifest);
  findings.push(...gaze.findings);
  findings.push(...checkOverlayOwnership(sheets, manifest));
  findings.push(...checkAnchors(sheets.directions, manifest, gaze.centroids));
  findings.push(...checkLuminanceAndStroke(sheets.directions, manifest));
  findings.push(...checkDownsampleReadability(sheets, manifest));
  findings.push(...checkFileSize(sizes, manifest));

  fs.mkdirSync(outDir, { recursive: true });
  const artefacts = [...writeContactSheets(sheets, manifest, outDir)];
  const headFails = [...new Set(findings.filter((f) => f.id === 'SP-7.2/頭部不動').map((f) => f.cell))];
  artefacts.push(...writeDiffImages(sheets, manifest, headFails, outDir));

  const errorCount = report(findings, gaze.centroids, manifest, log);
  log(`\n產出物（SP-7.9 / SP-7.10）：\n${artefacts.map((p) => `  ${p}`).join('\n')}`);
  log(errorCount === 0 ? '\nSPRITE-CHECK: PASS' : `\nSPRITE-CHECK: FAIL（${errorCount} 項素材違規）`);
  return errorCount === 0 ? 0 : 1;
}

function main() {
  return runCheck();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(err instanceof ToolError ? `SPRITE-CHECK: TOOL-ERROR  ${err.message}` : err);
    process.exit(2);
  }
}

export { main, SENTINEL, MANIFEST_PATH, SHEET_FILES, SPRITE_DIR, OUT_DIR, ToolError };
