#!/usr/bin/env node
/**
 * `tools/check-sprite-sheets.mjs` 的自測。`node tools/check-sprite-sheets.selftest.mjs`。
 *
 * **為什麼不寫成 jest**：`testMatch` 只涵蓋 `src/**`，寫進去不會被執行；
 * 而把影像檢查塞進 `src/` 會讓交付物驗收寄生在產品碼樹裡（SP-7.13 明文禁止）。
 *
 * **測法**：先造一組**會全綠**的合成素材當基準，再逐條做壞一處，
 * 斷言**紅的正好是那一條**。只驗「壞素材會紅」是不夠的 ——
 * 那連「每一條都恆紅」這種壞掉的檢查都分辨不出來。
 *
 * 其中「行列顛倒」那一組是規格 SP-7.3 自己點名的失敗模式：
 * 身體相同、格 4 中性、兩兩相異全部滿足，A/B/D 全綠，但吉祥物看反方向。
 * 它是這支腳本存在的主要理由，所以額外斷言另外三條**維持綠**。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng, encodeNonConformingPng, PngFormatError } from './lib/png.mjs';
import { buildManifest, buildSheets, S, SHEET } from './lib/syntheticSheet.mjs';
import * as C from './lib/spriteChecks.mjs';
import { runCheck, SENTINEL, ToolError } from './check-sprite-sheets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function runAll(sheets, manifest) {
  const f = [];
  f.push(...C.checkFormatAndHygiene(sheets, manifest));
  f.push(...C.checkHeadImmobility(sheets.directions, manifest));
  const g = C.checkGazeBinding(sheets.directions, manifest);
  f.push(...g.findings);
  f.push(...C.checkOverlayOwnership(sheets, manifest));
  f.push(...C.checkAnchors(sheets.directions, manifest, g.centroids));
  f.push(...C.checkLuminanceAndStroke(sheets.directions, manifest));
  return f.filter((x) => x.severity === 'error');
}

const ids = (errs) => [...new Set(errs.map((e) => e.id))];

function clone(sheets) {
  return {
    directions: { ...sheets.directions, data: Uint8Array.from(sheets.directions.data) },
    reactions: { ...sheets.reactions, data: Uint8Array.from(sheets.reactions.data) },
  };
}

function put(sheet, cell, x, y, rgba) {
  const ox = (cell % 3) * S;
  const oy = Math.floor(cell / 3) * S;
  const o = ((oy + y) * SHEET + (ox + x)) * 4;
  sheet.data.set(rgba, o);
}

// ===========================================================================
console.log('\n[1] PNG 解碼器（驗收 b —— 原訂的 A1 cutout fixture 已退出版控，改用合成圖）');
// ---------------------------------------------------------------------------
{
  let allSame = true;
  for (const [w, h] of [[1, 1], [7, 3], [37, 23], [256, 129]]) {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) {
      rgba[i] = (i * 31 + (i % 7) * 97) & 0xff;
    }
    for (let ft = 0; ft <= 4; ft++) {
      const back = decodePng(encodePng(w, h, rgba, ft));
      if (!Buffer.from(back.data).equals(Buffer.from(rgba))) {
        allSame = false;
      }
    }
  }
  ok('五種 filter type × 四種尺寸（含奇數寬）來回逐位元組相同', allSame);

  const rejects = (opts) => {
    try {
      decodePng(encodeNonConformingPng(opts));
      return false;
    } catch (e) {
      return e instanceof PngFormatError;
    }
  };
  ok('colour type 2 被擋下', rejects({ width: 8, height: 8, colourType: 2 }));
  ok('interlace = 1 被擋下', rejects({ width: 8, height: 8, colourType: 6, interlace: 1 }));
  ok('bit depth 16 被擋下', rejects({ width: 8, height: 8, colourType: 6, bitDepth: 16 }));
}

// ===========================================================================
console.log('\n[2] 基準：合成素材必須全綠');
// ---------------------------------------------------------------------------
const manifest = buildManifest();
const base = buildSheets();
{
  const errs = runAll(base, manifest);
  ok('基準素材 0 項素材違規', errs.length === 0, ids(errs).join(', '));
}

// ===========================================================================
console.log('\n[3] 變異體：做壞一處，紅的必須是那一條');
// ---------------------------------------------------------------------------
const mutants = [
  {
    name: 'SP-7.1 外緣透明帶被畫到',
    expect: 'SP-7.1/透明帶',
    apply: (s) => put(s.directions, 0, 3, 3, [255, 0, 0, 255]),
  },
  {
    name: 'SP-7.1 黑邊 matte（預乘 alpha 的指紋）',
    expect: 'SP-7.1/黑邊matte',
    apply: (s) => {
      for (let y = 200; y < 260; y++) {
        for (let x = 200; x < 260; x++) {
          put(s.directions, 0, x, y, [0, 0, 0, 128]);
        }
      }
    },
  },
  {
    name: 'SP-7.1 兩格逐位元組相同',
    expect: 'SP-7.1/重複格',
    apply: (s) => {
      for (let y = 0; y < S; y++) {
        const src = (y * SHEET + S) * 4;
        s.directions.data.copyWithin((y * SHEET + 2 * S) * 4, src, src + S * 4);
      }
    },
  },
  {
    name: 'SP-7.2 眼窗外有一個像素動了',
    expect: 'SP-7.2/頭部不動',
    apply: (s) => put(s.directions, 0, 256, 400, [255, 0, 0, 255]),
  },
  {
    name: 'SP-7.3 純水平格帶了垂直漂移',
    expect: 'SP-7.3/殘差Y',
    sheets: () =>
      buildSheets({
        perCellGaze: [[-12, -8], [0, -8], [12, -8], [-12, 4], [0, 0], [12, 0], [-12, 8], [0, 8], [12, 8]],
      }),
  },
  {
    name: 'SP-7.4 嘴型幀畫出了嘴窗 M',
    expect: 'SP-7.4/視窗產權',
    apply: (s) => put(s.reactions, 4, 256, 220, [0, 0, 16, 255]),
  },
  {
    name: 'SP-6.6 覆蓋層畫到斗篷上',
    expect: 'SP-6.6/皮膚遮罩',
    apply: (s) => put(s.reactions, 1, 150, 400, [0, 0, 16, 255]),
  },
  {
    name: 'SP-7.4 眨眼吃到眉窗 B',
    expect: 'SP-7.4/眨眼吃眉',
    apply: (s) => put(s.reactions, 6, 256, 150, [226, 200, 177, 255]),
  },
  {
    name: 'SP-7.4 眨眼修補塊半透明',
    expect: 'SP-7.4/眨眼不透明',
    apply: (s) => {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const o = ((Math.floor(6 / 3) * S + y) * SHEET + ((6 % 3) * S + x)) * 4;
          if (s.reactions.data[o + 3] === 255) {
            s.reactions.data[o + 3] = 200;
          }
        }
      }
    },
  },
  {
    name: 'SP-7.5 整個角色橫移 6px（錨點）',
    expect: 'SP-7.5/臉中軸',
    apply: (s) => {
      for (let y = SHEET - 1; y >= 0; y--) {
        const row = s.directions.data.subarray(y * SHEET * 4, (y + 1) * SHEET * 4);
        row.copyWithin(6 * 4, 0, (SHEET - 6) * 4);
        row.fill(0, 0, 6 * 4);
      }
    },
  },
  {
    name: 'SP-7.7 斗篷暗到掉出亮度夾制下限',
    expect: 'SP-7.7/亮度夾制',
    apply: (s) => {
      const d = s.directions.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === 0x40 && d[i + 1] === 0x50 && d[i + 2] === 0x80) {
          // 刻意**不用**接近線稿色的暗色。線稿豁免的容差是 ±24 RGB，
          // `#101018` 落在 `#000010` 的容差內會被合法豁免 —— 那會讓這個變異體
          // 測不到亮度夾制，而是測到豁免清單。`#0A2A0A` 的 L = 0.017，
          // 一樣低於下限 0.047，但離線稿色 42 個階，不在任何豁免範圍內。
          d[i] = 0x0a;
          d[i + 1] = 0x2a;
          d[i + 2] = 0x0a;
        }
      }
    },
  },
  {
    name: 'SP-7.7 描邊只畫了一半寬',
    expect: 'SP-7.7/描邊寬度',
    sheets: () => buildSheets({ strokePx: 0.008 * S }),
  },
];

for (const m of mutants) {
  const sheets = m.sheets ? m.sheets() : clone(base);
  if (m.apply) {
    m.apply(sheets);
  }
  const got = ids(runAll(sheets, manifest));
  ok(m.name, got.includes(m.expect), `實際紅的是 [${got.join(', ') || '（全綠 —— 這條檢查無效）'}]`);
}

// ===========================================================================
console.log('\n[4] 驗收 (d)：行列顛倒 —— A/B/D 全綠而 C 必須紅');
// ---------------------------------------------------------------------------
{
  const gx = 12;
  const gy = 8;
  const transposed = buildSheets({
    // 格 (r,c) 拿到 (c,r) 的內容：身體相同、格 4 仍中性、九格兩兩相異，
    // 檢查 A / B / D 一條都不會紅 —— 但吉祥物看反方向。
    perCellGaze: Array.from({ length: 9 }, (_, i) => {
      const r = Math.floor(i / 3);
      const c = i % 3;
      return [(r - 1) * gx, (c - 1) * gy];
    }),
  });
  const errs = runAll(transposed, manifest);
  const got = ids(errs);
  ok('SP-7.3 抓到方向錯誤', got.some((id) => id.startsWith('SP-7.3/')), got.join(', '));
  ok('SP-7.1 維持綠（兩兩相異仍成立）', !got.some((id) => id.startsWith('SP-7.1/')), got.join(', '));
  ok('SP-7.2 維持綠（身體相同仍成立）', !got.some((id) => id.startsWith('SP-7.2/')), got.join(', '));
  ok('SP-7.4 維持綠（覆蓋層未動）', !got.some((id) => id.startsWith('SP-7.4/')), got.join(', '));
}

// ===========================================================================
console.log('\n[5] CLI 與退出碼分級（SP-7.11 / SP-7.14 / SP-7.15）');
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-selftest-'));
const quiet = () => {};

function materialise(dir, sheets, patch = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const name of ['directions', 'reactions']) {
    const buf = encodePng(SHEET, SHEET, sheets[name].data);
    fs.writeFileSync(path.join(dir, `${name}.png`), buf);
    files[name] = crypto.createHash('sha256').update(buf).digest('hex');
  }
  const m = { ...buildManifest(), sha256: files, ...patch };
  fs.writeFileSync(path.join(dir, 'sprite-manifest.json'), JSON.stringify(m, null, 2));
  return m;
}

{
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const lines = [];
  const code = runCheck({ spriteDir: empty, outDir: path.join(tmp, 'out'), log: (s) => lines.push(s) });
  ok('驗收 (a) 未交付 → 印 sentinel 且 exit 0', code === 0 && lines.join('\n').includes(SENTINEL));
}
{
  const dir = path.join(tmp, 'green');
  materialise(dir, base);
  const code = runCheck({ spriteDir: dir, outDir: path.join(tmp, 'out-green'), log: quiet });
  ok('合規素材 → exit 0', code === 0);
  const produced = fs.readdirSync(path.join(tmp, 'out-green'));
  ok('SP-7.9 產出四張聯絡表（含 GIF）', produced.length === 4 && produced.some((f) => f.endsWith('.gif')), produced.join(', '));
}
{
  const dir = path.join(tmp, 'tampered');
  materialise(dir, base);
  const p = path.join(dir, 'directions.png');
  const buf = fs.readFileSync(p);
  buf[buf.length - 20] ^= 0x01; // 改一個位元組而不更新 manifest
  fs.writeFileSync(p, buf);
  const code = runCheck({ spriteDir: dir, outDir: path.join(tmp, 'out-t'), log: quiet });
  ok('驗收 (e) 換圖不更新 manifest → exit 1', code === 1);
}
{
  const dir = path.join(tmp, 'badformat');
  fs.mkdirSync(dir, { recursive: true });
  const bad = encodeNonConformingPng({ width: SHEET, height: SHEET, colourType: 2 });
  fs.writeFileSync(path.join(dir, 'directions.png'), bad);
  const good = encodePng(SHEET, SHEET, base.reactions.data);
  fs.writeFileSync(path.join(dir, 'reactions.png'), good);
  const m = {
    ...buildManifest(),
    sha256: {
      directions: crypto.createHash('sha256').update(bad).digest('hex'),
      reactions: crypto.createHash('sha256').update(good).digest('hex'),
    },
  };
  fs.writeFileSync(path.join(dir, 'sprite-manifest.json'), JSON.stringify(m));
  let code = 0;
  try {
    runCheck({ spriteDir: dir, outDir: path.join(tmp, 'out-b'), log: quiet });
  } catch (e) {
    code = e instanceof ToolError ? 2 : -1;
  }
  ok('驗收 (c) colour type 2 → ToolError（CLI 對應 exit 2）', code === 2);
}
{
  const dir = path.join(tmp, 'oversize');
  materialise(dir, base, { budget: { perSheetBytes: 1024, totalBytes: 2048 } });
  const code = runCheck({ spriteDir: dir, outDir: path.join(tmp, 'out-o'), log: quiet });
  ok('SP-7.8 體積超標 → exit 1', code === 1);
}
{
  const dir = path.join(tmp, 'badmanifest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sprite-manifest.json'), '{ not json');
  let code = 0;
  try {
    runCheck({ spriteDir: dir, outDir: path.join(tmp, 'out-m'), log: quiet });
  } catch (e) {
    code = e instanceof ToolError ? 2 : -1;
  }
  ok('manifest 壞掉 → ToolError（CLI 對應 exit 2）', code === 2);
}
fs.rmSync(tmp, { recursive: true, force: true });

// ===========================================================================
console.log('\n[6] SP-7.12 / SP-7.13 的負向要求');
// ---------------------------------------------------------------------------
{
  // ⚠️ **剝掉註解再驗**，這是對原驗收條件的刻意偏離。
  // 計畫原本寫「腳本內 `grep -- '--force|--skip'` 零命中、`grep '\bgit\b'` 零命中」，
  // 但這幾支檔案的檔頭正是在**說明**為什麼不提供旁路、為什麼不能呼叫 git。
  // 照字面驗，唯一的通過方式是把規則的理由從檔案裡刪掉 ——
  // 那會讓下一個維護者看不到「不呼叫 git」是為了保住 asp-test.sh 的 mtime 時序判定，
  // 然後理直氣壯地加一行 `git ls-files` 找素材。要驗的是**行為**不是字面。
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const code = ['tools/check-sprite-sheets.mjs', 'tools/lib/png.mjs', 'tools/lib/gif.mjs', 'tools/lib/spriteChecks.mjs']
    .map((f) => strip(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    .join('\n');
  ok('SP-7.12 程式碼中沒有 --force / --skip 旁路', !/--force|--skip/.test(code), '（已剝除註解）');
  ok('SP-7.13 沒有 child_process / 任何外部指令呼叫', !/child_process|execSync|spawnSync|\bexecFile\b/.test(code));
  ok('SP-7.13 程式碼中不出現 git 指令字串', !/['\"`]\s*git[\s'\"`]/.test(code));
  // process.argv 只允許用於「是否被當成進入點執行」的判定，不得用來解析旗標
  const argvUses = (code.match(/process\.argv/g) || []).length;
  ok('process.argv 只被用在進入點判定（2 處）', argvUses <= 2, `實際 ${argvUses} 處`);
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);
