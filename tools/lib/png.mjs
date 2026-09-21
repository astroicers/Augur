/**
 * 零依賴 PNG 編解碼（SP-7.0）。
 *
 * **為什麼手寫而不是 `sharp`**：`sharp` 是原生二進位（約 30 MB、自帶傳遞相依），
 * 與 P2-handoff 記的「有漏洞的套件不會隨 plugin 出貨 —— 乾淨是靠架構不是靠運氣」
 * 直接衝突；而本 repo 從未宣告過 Python 依賴，Pillow 那條路同樣不通。
 *
 * 手寫 defilter 的風險（Paeth 是最容易寫錯的一段）由兩件事緩解：
 *  1. SP-2.13 把交付格式收斂成單一組合（8-bit / colour type 6 / 非交錯），解碼器只剩一條路徑；
 *  2. 本檔同時提供 encoder，`check-sprite-sheets.selftest.mjs` 以
 *     **五種 filter type 各自編碼同一張圖、解回來必須逐位元組相同** 來釘住它。
 *     沒有 encoder 就只能拿現成圖片測，而那只會走到圖片自己用的那一種 filter。
 *
 * 不支援的格式一律丟 `PngFormatError` —— 呼叫端把它對應到 SP-7.11 的 exit 2
 * （工具或格式錯誤），與 exit 1（素材違規）分開。這個分野是有意義的：
 * 「交付了一張 colour type 2 的圖」是流程錯了，不是畫錯了。
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 格式不受支援／檔案壞掉。呼叫端對應 SP-7.11 的 exit 2。 */
export class PngFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PngFormatError';
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/**
 * 逐塊切開 PNG。回傳 `[{ type, data }]`，不含 CRC 驗證以外的解讀。
 * CRC 不符即丟錯 —— 交付物是二進位資產，靜默吃掉損毀比紅一次糟得多。
 */
function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngFormatError('不是 PNG（簽章不符）');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new PngFormatError(`chunk ${type} 長度 ${length} 超出檔案尾端`);
    }
    const data = buf.subarray(dataStart, dataEnd);
    const expected = buf.readUInt32BE(dataEnd);
    const actual = crc32(buf.subarray(offset + 4, dataEnd));
    if (expected !== actual) {
      throw new PngFormatError(`chunk ${type} 的 CRC 不符`);
    }
    chunks.push({ type, data });
    offset = dataEnd + 4;
    if (type === 'IEND') {
      break;
    }
  }
  return chunks;
}

/** Paeth predictor（PNG spec 9.4）。三者相等時取 a，與 spec 的 tie-break 一致。 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/**
 * 反 filter。`raw` 是 inflate 之後的緩衝區，每列開頭一個 filter type byte。
 * 就地寫進 `out`（RGBA，無 filter byte）。
 */
function defilter(raw, width, height, out) {
  const bpp = 4;
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new PngFormatError(`IDAT 解壓後只有 ${raw.length} bytes，需要 ${expected}`);
  }
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0;
      let recon;
      switch (type) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + a;
          break;
        case 2:
          recon = value + b;
          break;
        case 3:
          recon = value + ((a + b) >> 1);
          break;
        case 4:
          recon = value + paeth(a, b, c);
          break;
        default:
          throw new PngFormatError(`第 ${y} 列的 filter type 為 ${type}（僅支援 0–4）`);
      }
      out[dst + x] = recon & 0xff;
    }
  }
}

/**
 * 解碼一張 PNG 成 RGBA。
 *
 * 只接受 SP-2.13 宣告的單一組合：8-bit / colour type 6 / compression 0 / filter 0 / interlace 0。
 * 其餘一律 `PngFormatError`。刻意不做 palette 展開與 16-bit 降位 ——
 * 支援它們等於容許交付物偏離宣告格式，而那正是這支檢查要擋的東西。
 */
export function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) {
    throw new PngFormatError('缺少 IHDR 或長度不正確');
  }
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colourType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlace = ihdr.data[12];

  if (width === 0 || height === 0) {
    throw new PngFormatError(`尺寸不合法：${width}×${height}`);
  }
  if (bitDepth !== 8) {
    throw new PngFormatError(`bit depth 為 ${bitDepth}，本規格只接受 8（SP-7.1）`);
  }
  if (colourType !== 6) {
    throw new PngFormatError(`colour type 為 ${colourType}，本規格只接受 6 = RGBA（SP-7.1）`);
  }
  if (compression !== 0 || filterMethod !== 0) {
    throw new PngFormatError(`compression/filter method 為 ${compression}/${filterMethod}，只接受 0/0`);
  }
  if (interlace !== 0) {
    throw new PngFormatError(`interlace 為 ${interlace}，本規格只接受 0（SP-7.1）`);
  }

  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (idat.length === 0) {
    throw new PngFormatError('沒有 IDAT');
  }
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    throw new PngFormatError(`IDAT 解壓失敗：${err.message}`);
  }

  const data = new Uint8Array(width * height * 4);
  defilter(raw, width, height, data);
  return { width, height, bitDepth, colourType, interlace, data };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * 編碼 RGBA 成 PNG。`filterType` 固定套用於每一列（0–4）。
 *
 * 產品路徑上只用 0（診斷圖與聯絡表不在乎體積）；其餘四種存在的理由是
 * selftest 要拿它們來驗 decoder 的 defilter —— 見本檔檔頭第 2 點。
 */
export function encodePng(width, height, rgba, filterType = 0) {
  if (rgba.length !== width * height * 4) {
    throw new PngFormatError(`緩衝區長度 ${rgba.length} 與 ${width}×${height}×4 不符`);
  }
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = filterType;
    const src = y * stride;
    const up = src - stride;
    for (let x = 0; x < stride; x++) {
      const value = rgba[src + x];
      const a = x >= bpp ? rgba[src + x - bpp] : 0;
      const b = y > 0 ? rgba[up + x] : 0;
      const c = x >= bpp && y > 0 ? rgba[up + x - bpp] : 0;
      let out;
      switch (filterType) {
        case 0:
          out = value;
          break;
        case 1:
          out = value - a;
          break;
        case 2:
          out = value - b;
          break;
        case 3:
          out = value - ((a + b) >> 1);
          break;
        case 4:
          out = value - paeth(a, b, c);
          break;
        default:
          throw new PngFormatError(`不支援的 filter type ${filterType}`);
      }
      raw[dst + 1 + x] = out & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 只給 selftest 用：造一張**宣告格式之外**的 PNG（例如 colour type 2 或 interlace 1），
 * 用來驗證 decoder 真的擋得下來。產品路徑不呼叫。
 */
export function encodeNonConformingPng({ width, height, colourType, interlace = 0, bitDepth = 8 }) {
  const channels = colourType === 2 ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = (x * 7 + y * 13) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  ihdr[12] = interlace;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
