/**
 * 零依賴 PNG 編解碼（SP-7.0）。
 *
 * **為什麼手寫而不是 `sharp`**：`sharp` 是原生二進位（約 30 MB、自帶傳遞相依），
 * 與 P2-handoff 記的「有漏洞的套件不會隨 plugin 出貨 —— 乾淨是靠架構不是靠運氣」
 * 直接衝突；而本 repo 從未宣告過 Python 依賴，Pillow 那條路同樣不通。
 *
 * 手寫 defilter 的風險由兩件事**部分**緩解：
 *  1. SP-2.13 把交付格式收斂成單一組合（8-bit / colour type 6 / 非交錯），解碼器只剩一條路徑；
 *  2. 本檔同時提供 encoder，selftest 以「五種 filter type 各自編碼同一張圖、解回來必須
 *     逐位元組相同」來測。
 *
 * ⚠️ **但那條 round trip 測不到 Paeth。** 檔頭先前寫著它「釘住」手寫 Paeth 的風險 ——
 * 那句話是錯的，2026-09-22 的複審用兩個突變證明了：
 *   - Paeth 的 tie-break 由 `<=` 改成 `<`（直接違反 PNG spec §6.6）→ selftest 43/0 全綠，
 *     但外部產生的 PNG 解出來 81 個像素錯 15 個。
 *   - Average 的 `(a+b)>>1` 改成四捨五入 → selftest 43/0 全綠，外部 PNG 錯 18/81。
 * 原因是結構性的：`paeth()` 同一支函式**同時**供 decoder(:132) 與 encoder(:242) 使用，
 * 而 encode→decode 對**任何**確定性 predictor 都是 identity。共用或鏡像抄寫的錯誤
 * 在這條測試下 100% 隱形。
 *
 * **round trip 真正釘住的是**：chunk framing、CRC32、zlib 來回、stride 算術、
 * `& 0xff` 的 wrap、以及**非對稱**的 defilter 錯誤（只改單邊就會紅）。
 * **射程外的是**：predictor 本身算錯。那一段由下面 `PAETH_SPEC_VECTORS` 的
 * 手算向量承接 —— 它對照的是 PNG spec 的虛擬碼，不是本檔的 encoder。
 *
 * 不支援的格式一律丟 `PngFormatError` —— 呼叫端把它對應到 SP-7.11 的 exit 2
 * （工具或格式錯誤），與 exit 1（素材違規）分開。這個分野是有意義的：
 * 「交付了一張 colour type 2 的圖」是流程錯了，不是畫錯了。
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 解碼後 RGBA 緩衝區的上限（256 MiB = 8192×8192）。見 `decodePng` 的尺寸檢查。 */
export const MAX_RGBA_BYTES = 256 * 1024 * 1024;

/**
 * Paeth predictor 的 spec 對照向量：`[a, b, c, 期望值]`。
 *
 * **它存在的唯一理由是 round trip 測不到 predictor 本身**（見檔頭）。
 * 這些值是照 PNG spec §6.6 的虛擬碼手算的，**不是**從本檔的實作產生的 ——
 * 從實作產生的「期望值」對實作的錯誤永遠是零鑑別力。
 *
 * 前四組是平凡情形；其餘專挑 tie-break。spec 的判定是
 * `if (pa <= pb && pa <= pc) a; else if (pb <= pc) b; else c`。
 *
 * ⚠️ **「把任何一個 `<=` 改成 `<` 都會翻掉」是錯的，這裡逐條說清楚**（2026-09-24 實測）：
 *
 * | 突變 | 本表翻掉幾組 |
 * |---|---|
 * | `pa <= pb` → `pa < pb` | **0 / 11** |
 * | `pa <= pc` → `pa < pc` | 1 / 11 |
 * | `pb <= pc` → `pb < pc` | 1 / 11 |
 *
 * 第一列不是覆蓋缺口，是**數學上不可觀測**：窮舉全部 256³ = 16,777,216 組
 * （其中 98,048 組滿足 `pa === pb`），改成 `<` 之後結果不同的組數是 **0** ——
 * `pa === pb` 時必然 `a === b`，選哪一個都一樣。
 * 所以本表對這個位置**不可能**有鑑別力，而不是漏了幾組沒寫。
 *
 * 表的長度是 **11**（註解原本寫「四 + 六 = 十」，數錯了）。
 * 這種註解比沒有更危險：它讓下一個人以為某幾列是承重的，
 * 於是重構時放心地刪掉它們。
 */
export const PAETH_SPEC_VECTORS = [
  // 平凡情形（三個距離互不相同）
  [0, 0, 0, 0],
  [10, 20, 30, 10],
  [200, 100, 50, 200],
  [1, 2, 3, 1],
  [10, 10, 10, 10],
  [15, 5, 10, 10],
  [255, 0, 128, 128],
  [0, 255, 128, 128],
  [128, 128, 255, 128],
  // ⬇️ 這兩組是整張表存在的理由：各自鑑別一個 tie-break 的等號。
  // pa === pc（都是 15）、pb = 30。spec 取 a；把 `pa <= pc` 改成 `<` 會變成 100。
  [70, 115, 100, 70],
  // pb === pc（都是 20）、pa = 40。spec 取 b；把 `pb <= pc` 改成 `<` 會變成 100。
  [120, 60, 100, 60],
];

/**
 * ⚠️ **`pa <= pb` 的等號在數學上不可觀測，所以上表不試圖涵蓋它。**
 *
 * 推導：`pa = |b−c|`、`pb = |a−c|`。若 `pa === pb` 且 `a ≠ b`，則 `b−c = −(a−c)`，
 * 也就是 `a + b = 2c`，於是 `pc = |a+b−2c| = 0`。pc 既然是 0，`pa <= pc` 必為 false
 * （除非 pa 也是 0，那就是 a===b 的退化情形），流程一定走到 `pb <= pc` 且同樣為 false，
 * 答案恆為 c —— 不論第一個比較用的是 `<` 還是 `<=`。
 *
 * 這不是測試寫得不夠好，是那個等號沒有可觀測的後果。把它寫下來，
 * 免得下一個人以為這裡漏了一組而去補一組其實不鑑別任何東西的向量。
 */

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
  // ⚠️ 先正規化成 Buffer。呼叫端傳純 `Uint8Array` 時 `.equals()` 不存在，
  // 丟的會是 `TypeError` 而不是 `PngFormatError` —— CLI 會把它當成 CRASH
  // 而不是 SP-7.11 的 exit 2（「工具或格式錯誤」），分級整個錯掉。
  // 目前九個呼叫點都傳 Buffer，所以這是潛伏的，但入口便宜。
  if (!Buffer.isBuffer(buf)) {
    if (!(buf instanceof Uint8Array)) {
      throw new PngFormatError(`decodePng 需要 Buffer 或 Uint8Array，收到 ${typeof buf}`);
    }
    buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  }
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
      // IEND 之後不得有任何位元組。允許的話，「IEND 後追加垃圾」與
      // 「IEND 被垃圾取代」兩種損毀都會被靜默接受 —— 與本函式上面那句
      // 「靜默吃掉損毀比紅一次糟得多」直接矛盾。
      if (offset !== buf.length) {
        throw new PngFormatError(`IEND 之後還有 ${buf.length - offset} bytes`);
      }
      return chunks;
    }
  }
  // 走到這裡代表沒看到 IEND：檔案被截斷，或 IEND 被覆寫成別的東西。
  throw new PngFormatError('缺少 IEND（檔案被截斷或尾端損毀）');
}

/**
 * Average predictor 的整數運算（PNG spec §6.5）：`floor((a + b) / 2)`。
 *
 * **抽成函式的兩個理由**：(1) 原本 `(a + b) >> 1` 在 decoder 與 encoder **手抄了兩份**，
 * 兩份各自漂移不會被 round trip 看見；(2) 它需要一張 spec 對照表，而 round trip 測不到它 ——
 * 實測把它改成 `Math.round((a + b) / 2)`，selftest 照樣全綠，但外部產生的 PNG 會錯十幾個像素。
 *
 * ⚠️ spec 要的是 **floor**，不是四捨五入。兩者只在 `a + b` 為奇數時不同，
 * 而真實影像裡奇數和遍地都是。
 */
export function average(a, b) {
  return (a + b) >> 1;
}

/** Average predictor 的 spec 對照向量：`[a, b, 期望值]`。奇數和是唯一會分岔的地方。 */
export const AVERAGE_SPEC_VECTORS = [
  [0, 0, 0],
  [2, 4, 3],
  [255, 255, 255],
  // ⬇️ 以下每一組的 a+b 都是奇數：spec 的 floor 給左邊，四捨五入會給大一的值。
  [1, 2, 1],
  [0, 1, 0],
  [10, 11, 10],
  [254, 255, 254],
  [7, 100, 53],
  [131, 88, 109],
];

/**
 * Paeth predictor（PNG spec §6.6 / 9.4）。三者相等時取 a，與 spec 的 tie-break 一致。
 *
 * **export 出來是為了讓 selftest 直接對 `PAETH_SPEC_VECTORS` 比對。** 經 round trip
 * 間接測它是沒有用的 —— 同一支函式同時供 encoder 與 decoder，encode→decode 對任何
 * 確定性 predictor 都是 identity。
 */
export function paeth(a, b, c) {
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
  // ⚠️ `!==` 而非 `<`。原本只擋短不擋長，於是「IDAT 比 IHDR 宣告多兩列」的檔案會被
  // 接受、多的列靜默丟棄 —— 一個與自己的 IHDR 不符的交付物通過了正為此存在的格式閘。
  if (raw.length !== expected) {
    throw new PngFormatError(
      `IDAT 解壓後為 ${raw.length} bytes，IHDR 宣告的 ${width}×${height} 需要 ${expected}`
    );
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
          recon = value + average(a, b);
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
  // 尺寸上界。沒有它，一個宣告 2147483647×2147483647 的檔案會在下面配置緩衝區時
  // 丟 `RangeError`，而呼叫端只認 `PngFormatError`、其餘 re-throw ——
  // 操作者拿到的是裸 stack trace，看不出是哪一張 sheet 壞了。
  // 上限取 256 MiB 的 RGBA（= 8192×8192），遠大於任何 sprite sheet（1536×1536 = 9 MiB）。
  if (width * height * 4 > MAX_RGBA_BYTES) {
    throw new PngFormatError(
      `尺寸 ${width}×${height} 需要 ${width * height * 4} bytes，超過上限 ${MAX_RGBA_BYTES}`
    );
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
  const expectedRaw = (width * 4 + 1) * height;
  try {
    // ⚠️ **必須給 maxOutputLength。** 沒有它，配置大小由**壓縮資料**決定而不是由已知的
    // IHDR 尺寸決定：實測一個 305 KB、宣告 2×2 的檔案解出 314 MB（RSS +614 MB）並被接受；
    // 放大到約 3 MB 輸入時 RSS 6.2 GB，在 4 GiB 上限下是 exit 133（signal）,
    // 而不是 SP-7.11 約定的 exit 2。
    //
    // 上限取 `expectedRaw + 1` 而不是 `expectedRaw`：多一個位元組讓「只多了一點點」的
    // IDAT 仍然解得開，於是會撞到下面 defilter 的 `!==` 並拿到**說得清楚**的長度訊息；
    // 真正的 bomb 則在這裡就被擋住，配置有界。
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expectedRaw + 1 });
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
          out = value - average(a, b);
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
