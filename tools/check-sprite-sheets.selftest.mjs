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
 * 本檔也順帶涵蓋 SP-V.1 盲測頁的出題與計分（第 7 節）。放在一起而不是另開一支，
 * 是為了不在 commit 閘門上多加一個步驟 —— 兩者都是「sprite 交付工具自身的回歸測試」。
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

import {
  average,
  AVERAGE_SPEC_VECTORS,
  decodePng,
  encodePng,
  encodeNonConformingPng,
  paeth,
  PAETH_SPEC_VECTORS,
  PngFormatError,
} from './lib/png.mjs';
import { encodeGif } from './lib/gif.mjs';
import { buildManifest, buildSheets, S, SHEET } from './lib/syntheticSheet.mjs';
import { CENTER_CELL, buildQuestions, score, verdict } from './blind-test/scoring.mjs';
import * as C from './lib/spriteChecks.mjs';
const { CELL_COUNT } = C;
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
  // ⚠️ SP-7.6 必須在這裡。它原本只會吐 warn，所以被漏掉了；2026-09-22 起它也會吐
  // `SP-7.6/眉窗為空` 這個 error（眉毛漏畫是真實的交付失誤，不是對比差）。
  f.push(...C.checkDownsampleReadability(sheets, manifest));
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

  // ⚠️ **這一段是 round trip 測不到的部分。**
  // `paeth()` 同一支函式同時供 encoder 與 decoder，encode→decode 對任何確定性
  // predictor 都是 identity，所以上面那條「五種 filter type 來回相同」對 predictor
  // 本身的錯誤 100% 隱形。實證：把 tie-break 的 `<=` 改成 `<`（違反 PNG spec §6.6）
  // 或把 Average 改成四捨五入，上面那條都照樣全綠，而外部產生的 PNG 會錯十幾個像素。
  // 下面比對的是**照 spec 虛擬碼手算**的值，不是從本檔實作產生的。
  const bad = PAETH_SPEC_VECTORS.filter(([a, b, c, want]) => paeth(a, b, c) !== want);
  ok(
    `Paeth 對 PNG spec §6.6 的 ${PAETH_SPEC_VECTORS.length} 組手算向量全部相符`,
    bad.length === 0,
    bad.map(([a, b, c, w]) => `paeth(${a},${b},${c}) 應為 ${w} 實得 ${paeth(a, b, c)}`).join('; ')
  );

  const badAvg = AVERAGE_SPEC_VECTORS.filter(([a, b, want]) => average(a, b) !== want);
  ok(
    `Average 對 PNG spec §6.5 的 ${AVERAGE_SPEC_VECTORS.length} 組手算向量全部相符（floor 不是四捨五入）`,
    badAvg.length === 0,
    badAvg.map(([a, b, w]) => `average(${a},${b}) 應為 ${w} 實得 ${average(a, b)}`).join('; ')
  );

  // 端到端合成 sheet 一律用 filterType 0，所以被 filter 過的資料列從未走過完整管線。
  // PIL / libpng / Photoshop 會自適應輸出 1/2/3/4，真實交付物一定含這些列。
  {
    let allOk = true;
    const w = 61;
    const h = 37;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) {
      rgba[i] = (i * 53 + ((i / 4) | 0) * 7) & 0xff;
    }
    for (let ft = 1; ft <= 4; ft++) {
      const back = decodePng(encodePng(w, h, rgba, ft));
      if (!Buffer.from(back.data).equals(Buffer.from(rgba))) {
        allOk = false;
      }
    }
    ok('filter type 1–4（非零）的資料列走完整解碼路徑', allOk);
  }

  // 長度：短要擋、**長也要擋**。原本只擋短，於是 IDAT 比 IHDR 多兩列會被靜默截斷接受。
  {
    const w = 8;
    const h = 8;
    const png = encodePng(w, h, new Uint8Array(w * h * 4));
    const chunks = [];
    let off = 8;
    while (off + 8 <= png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString('latin1', off + 4, off + 8);
      chunks.push({ type, start: off, end: off + 12 + len });
      off += 12 + len;
    }
    const idat = chunks.find((c) => c.type === 'IDAT');
    const zlib = await import('node:zlib');
    const rebuild = (rawBytes) => {
      const body = zlib.deflateSync(rawBytes);
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write('IDAT', 4, 'latin1');
      // CRC 用本檔 encoder 的同一套（chunk() 不 export，這裡就地算）
      const table = [];
      for (let n = 0; n < 256; n++) {
        let cc = n;
        for (let k = 0; k < 8; k++) {
          cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1;
        }
        table[n] = cc;
      }
      let crcv = -1;
      const crcBuf = Buffer.concat([head.subarray(4), body]);
      for (let i = 0; i < crcBuf.length; i++) {
        crcv = table[(crcv ^ crcBuf[i]) & 0xff] ^ (crcv >>> 8);
      }
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE((crcv ^ -1) >>> 0, 0);
      return Buffer.concat([png.subarray(0, idat.start), head, body, crc, png.subarray(idat.end)]);
    };
    const stride = w * 4 + 1;
    const tooLong = rebuild(Buffer.alloc(stride * (h + 2)));
    const tooShort = rebuild(Buffer.alloc(stride * (h - 1)));
    const threw = (b) => {
      try {
        decodePng(b);
        return false;
      } catch (e) {
        return e instanceof PngFormatError;
      }
    };
    ok('IDAT 比 IHDR 宣告的短 → 擋下', threw(tooShort));
    ok('IDAT 比 IHDR 宣告的長 → 擋下（原本靜默截斷接受）', threw(tooLong));
  }

  // IEND
  {
    const png = encodePng(8, 8, new Uint8Array(8 * 8 * 4));
    const threw = (b) => {
      try {
        decodePng(b);
        return false;
      } catch (e) {
        return e instanceof PngFormatError;
      }
    };
    ok('IEND 被截掉 → 擋下', threw(png.subarray(0, png.length - 12)));
    ok('IEND 之後有垃圾 → 擋下', threw(Buffer.concat([png, Buffer.from([1, 2, 3, 4, 5, 6, 7])])));
  }

  // IHDR 尺寸上界：不得丟 RangeError（呼叫端只認 PngFormatError）
  {
    const png = encodePng(2, 2, new Uint8Array(2 * 2 * 4));
    const huge = Buffer.from(png);
    huge.writeUInt32BE(0x7fffffff, 16); // IHDR width
    huge.writeUInt32BE(0x7fffffff, 20); // IHDR height
    // CRC 會不符 —— 先驗 CRC 擋得下來，再驗 CRC 修好之後尺寸也擋得下來
    let err = null;
    try {
      decodePng(huge);
    } catch (e) {
      err = e;
    }
    ok('宣告 2147483647×2147483647 → PngFormatError（不是 RangeError）', err instanceof PngFormatError, String(err).slice(0, 80));
  }

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
console.log('\n[1b] GIF 寫出器（先前是零覆蓋 —— 唯一的斷言是「有四個檔且其中一個是 .gif」）');
// ---------------------------------------------------------------------------
/**
 * 獨立寫的 GIF 讀取器，當 `gif.mjs` 的 oracle。
 *
 * **為什麼要自己寫一個**：先前唯一的 GIF 斷言是
 * `produced.length === 4 && produced.some(f => f.endsWith('.gif'))` ——
 * 不開檔、不數格、不讀像素。實測兩個突變都讓 selftest 維持全綠而產出任何解碼器
 * 都打不開的檔：(a) `CLEAR_EVERY` 254→255；(b) `Buffer.from([8])` 改成
 * `Buffer.from([bits])`（看起來像 cleanup，而且因為出貨呼叫點的調色盤剛好是 8-bit，
 * **依構造不可能被舊測試看見**）。
 *
 * 這裡實作的是**真正的 LZW 解碼**（含字典成長），不是針對「未壓縮」寫法的特例判讀 ——
 * 特例判讀會跟著編碼器一起錯。
 */
function readGif(buf) {
  if (buf.toString('latin1', 0, 6) !== 'GIF89a') {
    throw new Error('magic 不是 GIF89a：' + buf.toString('latin1', 0, 6));
  }
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctBits = (packed & 0x07) + 1;
  const gctSize = 1 << gctBits;
  let off = 13;
  const gct = [];
  if (hasGct) {
    for (let i = 0; i < gctSize; i++) {
      gct.push([buf[off + i * 3], buf[off + i * 3 + 1], buf[off + i * 3 + 2]]);
    }
    off += gctSize * 3;
  }
  const frames = [];
  let loop = null;
  let pendingDelay = 0;
  const subBlocks = () => {
    const parts = [];
    for (;;) {
      const n = buf[off++];
      if (n === 0) {
        break;
      }
      parts.push(buf.subarray(off, off + n));
      off += n;
    }
    return Buffer.concat(parts);
  };
  while (off < buf.length) {
    const b = buf[off];
    if (b === 0x3b) {
      off++;
      break;
    }
    if (b === 0x21) {
      const label = buf[off + 1];
      off += 2;
      if (label === 0xf9) {
        const n = buf[off];
        pendingDelay = buf.readUInt16LE(off + 2);
        off += n + 1;
        if (buf[off] === 0) {
          off++;
        }
      } else if (label === 0xff) {
        const n = buf[off];
        const app = buf.toString('latin1', off + 1, off + 1 + 11);
        off += n + 1;
        const data = subBlocks();
        if (app === 'NETSCAPE2.0' && data.length >= 3) {
          loop = data.readUInt16LE(1);
        }
      } else {
        off += buf[off] + 1;
        subBlocks();
      }
      continue;
    }
    if (b !== 0x2c) {
      throw new Error('未預期的 block 0x' + b.toString(16) + ' @ ' + off);
    }
    const fw = buf.readUInt16LE(off + 5);
    const fh = buf.readUInt16LE(off + 7);
    const lctFlag = (buf[off + 9] & 0x80) !== 0;
    off += 10;
    if (lctFlag) {
      throw new Error('本編碼器不該產出 local colour table');
    }
    const minCodeSize = buf[off++];
    const data = subBlocks();

    // --- LZW 解碼 ---
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let codeSize = minCodeSize + 1;
    let dict = [];
    const reset = () => {
      dict = [];
      for (let i = 0; i < clear; i++) {
        dict.push([i]);
      }
      dict.push(null, null);
      codeSize = minCodeSize + 1;
    };
    reset();
    let prev = null;
    const out = [];
    const clearGaps = [];
    let sinceClear = 0;
    let bitPos = 0;
    const readCode = () => {
      let v = 0;
      for (let i = 0; i < codeSize; i++) {
        const byte = data[bitPos >> 3];
        if (byte === undefined) {
          return null;
        }
        v |= ((byte >> (bitPos & 7)) & 1) << i;
        bitPos++;
      }
      return v;
    };
    for (;;) {
      const code = readCode();
      if (code === null || code === end) {
        break;
      }
      if (code === clear) {
        if (prev !== null) {
          clearGaps.push(sinceClear);
        }
        sinceClear = 0;
        reset();
        prev = null;
        continue;
      }
      let entry;
      if (code < dict.length && dict[code]) {
        entry = dict[code];
      } else if (prev) {
        entry = prev.concat(prev[0]);
      } else {
        throw new Error(`INVALID CODE ${code}（已解出 ${out.length} 個索引）`);
      }
      out.push(...entry);
      sinceClear++;
      if (prev) {
        dict.push(prev.concat(entry[0]));
        if (dict.length === 1 << codeSize && codeSize < 12) {
          codeSize++;
        }
      }
      prev = entry;
    }
    frames.push({ width: fw, height: fh, minCodeSize, indices: out, delayCs: pendingDelay, clearGaps });
  }
  return { width, height, gct, gctBits, frames, loop };
}

{
  const W = 37;
  const H = 23;
  const mk = (seed) => {
    const a = new Uint8Array(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const c = [[24, 27, 31], [240, 224, 208], [64, 80, 128], [200, 40, 40]][(p * seed) % 4];
      a[p * 4] = c[0];
      a[p * 4 + 1] = c[1];
      a[p * 4 + 2] = c[2];
      a[p * 4 + 3] = 255;
    }
    return a;
  };
  const frames = [mk(1), mk(3)];
  const gif = encodeGif({ width: W, height: H, frames, delayCs: 40 });
  let g = null;
  let err = null;
  try {
    g = readGif(gif);
  } catch (e) {
    err = e;
  }
  ok('GIF 解得開（獨立 LZW 解碼器）', g !== null, String(err));

  if (g) {
    ok('尺寸與格數正確', g.width === W && g.height === H && g.frames.length === 2,
      `${g.width}x${g.height} / ${g.frames.length} 格`);
    ok('NETSCAPE2.0 無限循環', g.loop === 0, String(g.loop));
    ok('每格延遲正確', g.frames.every((f) => f.delayCs === 40), g.frames.map((f) => f.delayCs).join(','));

    // LZW min code size：出貨呼叫點的調色盤剛好是 8-bit，所以寫成 `bits` 也會過 ——
    // 這裡用一個**只有 4 色**的輸入，bits 會是 2，把兩者分開。
    ok('LZW min code size 恆為 8（不是跟著調色盤大小走）',
      g.frames.every((f) => f.minCodeSize === 8),
      'minCodeSize=' + g.frames.map((f) => f.minCodeSize).join(',') + ' / gctBits=' + g.gctBits);

    // 逐像素：解出的索引經全域調色盤還原，必須與輸入的 RGB 逐位元組相同
    let mismatch = 0;
    g.frames.forEach((f, fi) => {
      const src = frames[fi];
      for (let p = 0; p < W * H; p++) {
        const c = g.gct[f.indices[p]] || [-1, -1, -1];
        if (c[0] !== src[p * 4] || c[1] !== src[p * 4 + 1] || c[2] !== src[p * 4 + 2]) {
          mismatch++;
        }
      }
    });
    ok('逐像素還原與輸入相同', mismatch === 0, `${mismatch} 個像素不符`);

    // clear code 節奏：解碼端字典每個碼長一格，254 是讓它永遠碰不到 512 的上限
    const gaps = g.frames.flatMap((f) => f.clearGaps);
    ok('clear code 每 254 個碼出現一次', gaps.length > 0 && gaps.every((n) => n === 254),
      '實際間隔：' + [...new Set(gaps)].join(','));
  }

  // 大圖：跨越數百次 clear。先前的測試只驗過一格 851 像素，碰不到字典成長的邊界。
  {
    const N = 400;
    const big = new Uint8Array(N * N * 4);
    for (let p = 0; p < N * N; p++) {
      const v = (p * 7) % 251;
      big[p * 4] = v;
      big[p * 4 + 1] = (v * 3) % 251;
      big[p * 4 + 2] = (v * 5) % 251;
      big[p * 4 + 3] = 255;
    }
    const gif = encodeGif({ width: N, height: N, frames: [big], delayCs: 10 });
    let bad = -1;
    try {
      const g2 = readGif(gif);
      bad = 0;
      const f = g2.frames[0];
      if (f.indices.length !== N * N) {
        bad = Math.abs(f.indices.length - N * N);
      }
    } catch (e) {
      bad = -1;
      ok('400×400（約 630 次 clear）解得開', false, String(e).slice(0, 90));
    }
    if (bad >= 0) {
      ok(`400×400（${Math.floor((N * N) / 254)} 次 clear）解出的索引數正確`, bad === 0, `差 ${bad} 個`);
    }
  }
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
  // ⬇️ 以下八條是 2026-09-22 複審抓到的缺陷，每一條都配一個變異體 ——
  //    沒有變異體的檢查等於沒驗過，而這一批當初就是這樣溜過去的。
  {
    name: 'SP-7.4 BMK 格把不透明線稿畫進眼窗 E（K 曾被當成整個安全框）',
    expect: 'SP-7.4/視窗產權',
    apply: (s) => {
      for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          put(s.reactions, 1, Math.round(0.41 * S) + dx, Math.round(0.38 * S) + dy, [0, 0, 16, 255]);
        }
      }
    },
  },
  {
    name: 'SP-6.6 覆蓋層畫在下巴以下的鎖骨（膚色，但不是臉）',
    expect: 'SP-6.6/皮膚遮罩',
    apply: (s) => {
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          put(s.reactions, 1, 256 + dx, Math.round(0.6 * S) + 43 + dy, [0, 0, 16, 255]);
        }
      }
    },
  },
  {
    name: 'SP-7.4 眨眼格被挖成棋盤狀的洞（半透的眼瞼）',
    expect: 'SP-7.4/眨眼不透明',
    apply: (s) => {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const o = ((Math.floor(6 / 3) * S + y) * SHEET + ((6 % 3) * S + x)) * 4;
          if (s.reactions.data[o + 3] === 255 && (x + y) % 2 === 0) {
            s.reactions.data[o + 3] = 0;
          }
        }
      }
    },
  },
  {
    name: 'SP-7.4 透明像素帶了顏色酬載（預乘匯出的指紋）',
    expect: 'SP-7.4/透明像素帶色',
    apply: (s) => put(s.reactions, 4, 100, 100, [255, 0, 255, 0]),
  },
  {
    name: 'SP-7.5 呆毛超過 SP-2.3 的 0.048·S 上限',
    expect: 'SP-7.5/頭頂',
    apply: (s) => {
      for (let c = 0; c < CELL_COUNT; c++) {
        for (let y = Math.round(0.02 * S); y < Math.round(0.082 * S); y++) {
          for (let x = 250; x < 262; x++) {
            put(s.directions, c, x, y, [0x9f, 0xb4, 0xcc, 255]);
          }
        }
      }
    },
  },
  {
    name: 'SP-7.5 左瞳心右移 8px（瞳距變窄，合併質心看不出來）',
    expect: 'SP-7.5/左瞳心',
    apply: (s) => {
      const iris = [0x6a, 0x4f, 0xd0];
      for (let c = 0; c < CELL_COUNT; c++) {
        const ox = (c % 3) * S;
        const oy = Math.floor(c / 3) * S;
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < 256; x++) {
            const o = ((oy + y) * SHEET + ox + x) * 4;
            const d = s.directions.data;
            if (Math.abs(d[o] - iris[0]) < 10 && Math.abs(d[o + 1] - iris[1]) < 10 && Math.abs(d[o + 2] - iris[2]) < 10) {
              d[o] = 0xf8;
              d[o + 1] = 0xf8;
              d[o + 2] = 0xf8;
            }
          }
        }
        const dx = ((c % 3) - 1) * 12;
        const dy = (Math.floor(c / 3) - 1) * 8;
        for (let y = -12; y <= 12; y++) {
          for (let x = -12; x <= 12; x++) {
            if (x * x + y * y <= 144) {
              put(s.directions, c, Math.round(0.41 * S) + 8 + dx + x, Math.round(0.38 * S) + dy + y, [...iris, 255]);
            }
          }
        }
      }
    },
  },
  {
    name: 'SP-7.6 眉窗整個透明（量測失敗，不是對比差）',
    expect: 'SP-7.6/眉窗為空',
    apply: (s) => {
      const B = { y0: Math.round(0.255 * S), y1: Math.round(0.33 * S), x0: Math.round(0.28 * S), x1: Math.round(0.72 * S) };
      for (const sheet of [s.directions, s.reactions]) {
        for (let c = 0; c < CELL_COUNT; c++) {
          for (let y = B.y0; y < B.y1; y++) {
            for (let x = B.x0; x < B.x1; x++) {
              const o = ((Math.floor(c / 3) * S + y) * SHEET + ((c % 3) * S + x)) * 4;
              sheet.data[o + 3] = 0;
            }
          }
        }
      }
    },
  },
];

/** 不該紅的情形。合規的畫稿被硬失敗，跟漏放一樣嚴重 —— 它會讓人把檢查關掉。 */
const NON_MUTANTS = [
  {
    name: 'SP-2.3 允許的呆毛（頂到 0.048·S）不得誤紅',
    forbid: 'SP-7.5/頭頂',
    apply: (s) => {
      for (let c = 0; c < CELL_COUNT; c++) {
        for (let y = Math.round(0.048 * S); y < Math.round(0.082 * S); y++) {
          for (let x = 250; x < 262; x++) {
            put(s.directions, c, x, y, [0x9f, 0xb4, 0xcc, 255]);
          }
        }
      }
    },
  },
  {
    name: '角色內部貼著邊緣的亮度帶內色不得拉高描邊量測',
    forbid: 'SP-7.7/描邊寬度',
    apply: (s) => {
      for (let c = 0; c < CELL_COUNT; c++) {
        for (let y = 100; y < 300; y++) {
          const dy = (y + 0.5 - 174.08) / 133.12;
          if (Math.abs(dy) >= 1) {
            continue;
          }
          const hw = 102.4 * Math.sqrt(1 - dy * dy);
          for (const side of [-1, 1]) {
            for (let k = 0; k < 4; k++) {
              put(s.directions, c, Math.round(256 + side * (hw - 13 - k)), y, [0x7a, 0x82, 0x90, 255]);
            }
          }
        }
      }
    },
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

for (const m of NON_MUTANTS) {
  const sheets = clone(base);
  m.apply(sheets);
  const got = ids(runAll(sheets, manifest));
  ok(`（不得誤紅）${m.name}`, !got.includes(m.forbid), `卻紅了 [${got.join(', ')}]`);
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

// ===========================================================================
console.log('\n[7] SP-V.1 盲測的出題與計分');
// ---------------------------------------------------------------------------
{
  let seed = 1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const q = buildQuestions(rnd);
  const per = {};
  q.forEach((c) => (per[c] = (per[c] || 0) + 1));
  ok('每個非中央格 4 題、共 32 題', q.length === 32 && Object.values(per).every((n) => n === 4));
  ok('中央格不出題（它沒有正確答案）', !(CENTER_CELL in per));
  ok('題序被洗過（不是逐格連排）', q.slice(0, 8).some((c, i) => i > 0 && c !== q[i - 1]));

  ok('全對 → 通過', score(q, q.slice()).passed);

  const withNulls = q.map((c, i) => (i % 2 === 0 ? null : c));
  const rNull = score(q, withNulls);
  ok('「不確定」計為答錯（SP-V.1 明文）', rNull.overallPct === 50 && !rNull.passed);
  ok('誤判去向記錄「不確定」', rNull.confusion.some((c) => c.gotLabel === '不確定'));

  // 第二條門檻存在的理由：七個方向全對、一個全錯 → 整體 87.5% 仍須未通過
  const oneBad = q.map((c) => (c === 6 ? 7 : c));
  const rBad = score(q, oneBad);
  ok('整體 87.5% 但單一方向 0% → 未通過', rBad.overallOk && !rBad.perDirectionOk && !rBad.passed,
    `整體 ${rBad.overallPct}% / 最弱 ${rBad.worst.pct}%`);
  ok('回饋說得出「被誤判成什麼」', rBad.confusion[0].wantLabel === '左下' && rBad.confusion[0].gotLabel === '正下');

  // 門檻邊界：規格寫的是「≥85%」與「低於 60%」，所以 85.0 與 60.0 都是通過
  const w = (pct) => ({ pct, label: 'x' });
  ok('整體 85.0 過 / 84.9 不過', verdict(85.0, w(100)).overallOk && !verdict(84.9, w(100)).overallOk);
  ok('單方向 60.0 過 / 59.9 不過', verdict(100, w(60.0)).perDirectionOk && !verdict(100, w(59.9)).perDirectionOk);

  let threw = false;
  try {
    score(q, q.slice(0, 5));
  } catch {
    threw = true;
  }
  ok('題數與答案數不符時丟錯而非靜默計分', threw);
}

console.log(`\n${passed} 通過 / ${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);
