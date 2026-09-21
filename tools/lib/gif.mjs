/**
 * 零依賴 GIF89a 寫出（SP-7.9 的「張口/閉口交替的 GIF」）。
 *
 * **為什麼用「未壓縮 LZW」**：GIF 的影像資料規定要走 LZW，但編碼端沒有義務真的建字典。
 * 只要每 254 個碼重發一次 clear code，解碼端的字典永遠長不到需要加寬碼長的地步，
 * 於是可以用固定 9-bit 碼直接輸出每個位元組。產出的檔比真 LZW 大約 12%，
 * 換到的是**不必寫一個會錯的字典編碼器** —— 而這個檔是 `.sprite-check/` 下的
 * 診斷產出物，不進版控也不出貨，體積無所謂。
 *
 * 真 LZW 的風險在於它沒有對稱的自測：本 repo 沒有 GIF 解碼器，寫錯了只會在
 * 某個人用瀏覽器打開時才發現，而那時素材驗收已經過了。未壓縮版的正確性
 * 只依賴「clear code 的語意」一件事，可以在 selftest 裡用結構斷言釘住。
 *
 * **alpha**：GIF 只有單一透明索引，承載不了 sprite 的抗鋸齒邊緣。
 * 呼叫端必須先把 frame 合成到背景色上再進來 —— 本檔一律當作不透明處理。
 */

const CLEAR_EVERY = 254;

/** LSB-first 位元寫入器，最後切成 GIF 的 ≤255 bytes 子區塊。 */
class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.bits = 0;
  }
  write(code, width) {
    this.acc |= code << this.bits;
    this.bits += width;
    while (this.bits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.bits -= 8;
    }
  }
  finish() {
    if (this.bits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.bits = 0;
    }
    const out = [];
    for (let i = 0; i < this.bytes.length; i += 255) {
      const slice = this.bytes.slice(i, i + 255);
      out.push(slice.length, ...slice);
    }
    out.push(0);
    return Buffer.from(out);
  }
}

function lzwUncompressed(indices) {
  const w = new BitWriter();
  const width = 9;
  w.write(256, width);
  let since = 0;
  for (let i = 0; i < indices.length; i++) {
    w.write(indices[i], width);
    if (++since >= CLEAR_EVERY) {
      w.write(256, width);
      since = 0;
    }
  }
  w.write(257, width);
  return w.finish();
}

/**
 * 建調色盤。相異色 ≤256 時用精確盤（平塗畫風的常況）；
 * 超過時退回 6×6×6 = 216 色立方體最近鄰 —— 診斷圖不需要更好的量化，
 * 而 median cut 是另一段沒有自測的程式碼。
 */
function buildPalette(frames) {
  const seen = new Map();
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 4) {
      const key = (frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2];
      if (!seen.has(key)) {
        seen.set(key, seen.size);
        if (seen.size > 256) {
          return { exact: null };
        }
      }
    }
  }
  const table = new Uint8Array(768);
  for (const [key, index] of seen) {
    table[index * 3] = (key >> 16) & 0xff;
    table[index * 3 + 1] = (key >> 8) & 0xff;
    table[index * 3 + 2] = key & 0xff;
  }
  return { exact: seen, table, size: seen.size };
}

function cubePalette() {
  const table = new Uint8Array(768);
  for (let i = 0; i < 216; i++) {
    table[i * 3] = Math.round((Math.floor(i / 36) % 6) * 51);
    table[i * 3 + 1] = Math.round((Math.floor(i / 6) % 6) * 51);
    table[i * 3 + 2] = Math.round((i % 6) * 51);
  }
  return { exact: null, table, size: 216 };
}

function toIndices(frame, palette) {
  const out = new Uint8Array(frame.length / 4);
  for (let i = 0, p = 0; i < frame.length; i += 4, p++) {
    if (palette.exact) {
      out[p] = palette.exact.get((frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2]);
    } else {
      const r = Math.min(5, Math.round(frame[i] / 51));
      const g = Math.min(5, Math.round(frame[i + 1] / 51));
      const b = Math.min(5, Math.round(frame[i + 2] / 51));
      out[p] = r * 36 + g * 6 + b;
    }
  }
  return out;
}

function paletteBits(size) {
  let bits = 1;
  while (1 << bits < size) {
    bits++;
  }
  return Math.min(8, Math.max(1, bits));
}

/**
 * `frames` 是等尺寸的 RGBA `Uint8Array` 陣列（alpha 被忽略，見檔頭）。
 * `delayCs` 為每格延遲，單位 1/100 秒。回傳完整的 GIF89a buffer。
 */
export function encodeGif({ width, height, frames, delayCs = 50 }) {
  if (!frames.length) {
    throw new Error('encodeGif: 至少要一格');
  }
  for (const frame of frames) {
    if (frame.length !== width * height * 4) {
      throw new Error(`encodeGif: frame 長度 ${frame.length} 與 ${width}×${height}×4 不符`);
    }
  }
  let palette = buildPalette(frames);
  if (!palette.table) {
    palette = cubePalette();
  }
  const bits = paletteBits(palette.size);
  const tableSize = 1 << bits;
  const table = Buffer.alloc(tableSize * 3);
  Buffer.from(palette.table.subarray(0, Math.min(palette.size, tableSize) * 3)).copy(table);

  const header = Buffer.from('GIF89a', 'latin1');
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | (bits - 1); // global colour table present，解析度位元不重要
  lsd[5] = 0;
  lsd[6] = 0;

  // NETSCAPE2.0 無限循環
  const loop = Buffer.from([
    0x21, 0xff, 0x0b,
    ...Buffer.from('NETSCAPE2.0', 'latin1'),
    0x03, 0x01, 0x00, 0x00, 0x00,
  ]);

  const parts = [header, lsd, table, loop];
  for (const frame of frames) {
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = 0x00; // 無 transparency、disposal = 不指定
    gce.writeUInt16LE(delayCs, 4);
    gce[6] = 0;
    gce[7] = 0x00;
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1);
    desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(width, 5);
    desc.writeUInt16LE(height, 7);
    desc[9] = 0; // 無 local colour table
    parts.push(gce, desc, Buffer.from([8]), lzwUncompressed(toIndices(frame, palette)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
