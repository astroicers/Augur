/**
 * 合成一組**會通過 SP-7 全部檢查**的假素材，供 selftest 使用。
 *
 * **為什麼需要它**：SP-7 的檢查有十幾條，每一條都可能寫成「永遠不紅」。
 * 唯一能分辨「檢查有效」與「檢查是裝飾」的方法，是先造一組全綠的基準，
 * 再逐條做壞一處、確認**紅的正好是那一條**。沒有基準就只能驗「壞素材會紅」，
 * 而那連「全部都紅」這種壞掉的檢查都分辨不出來。
 *
 * 角色是一個刻意極簡的幾何人偶（橢圓頭 + 梯形身 + 兩隻眼 + 一道眉 + 一張嘴），
 * 但**錨點、視窗、色票、描邊寬度全部照規格取值** —— 它不好看，但每一個
 * 會被量測的數字都落在規格宣告的位置上。
 *
 * ⚠️ 本檔只被 selftest 引用，不在產品路徑上。
 */

export const S = 512;
export const SHEET = S * 3;

const PALETTE = {
  skin: [0xe2, 0xc8, 0xb1], // SP-6.2 明文指定的合規膚色，L = 0.607
  hair: [0x9f, 0xb4, 0xcc], // L = 0.444
  capelet: [0x40, 0x50, 0x80], // SP-6.0 實測值，L = 0.084
  top: [0x60, 0x60, 0x70], // SP-6.0 實測值，L = 0.120
  lineart: [0x00, 0x00, 0x10], // 豁免
  iris: [0x6a, 0x4f, 0xd0], // 豁免
  sclera: [0xf8, 0xf8, 0xf8], // L ≥ 0.85，SP-6.2 明文豁免
  stroke: [0x6e, 0x76, 0x81], // SP-6.4 參考色，L = 0.179
};

const hex = (rgb) => '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');


/**
 * SP-2.12 的建議記號位置 —— **與規格同一份數字**。
 *
 * ⚠️ 這個常數存在的理由：規格原本建議汗滴 (0.70, 0.26)、怒紋 (0.74, 0.17)，
 * 而那兩個位置在 SP-2.9 的顱骨與 SP-2.10 的瀏海之下**畫不出來**
 * （實測落在 SP-6.6 皮膚遮罩內 14.9% 與 0%，而上限是 0 個越界像素）。
 * 本檔當初是**默默改用別的座標**讓基準通過的 —— 問題被發現過，但修的是 fixture 不是規格，
 * 於是規格繼續對畫師建議一組畫不出來的位置。收成一份共用常數，
 * 並由 selftest 斷言它們的皮膚覆蓋率是 100%，讓這種漂移不會再無聲發生。
 */
export const SP_2_12_MARKS = {
  sweat: { cx: 0.645, cy: 0.293, rx: 9, ry: 13 },
  anger: { x0: 0.629, x1: 0.668, y0: 0.258, y1: 0.266 },
};

export function buildManifest(overrides = {}) {
  const m = {
    version: 1,
    sheet: { width: SHEET, height: SHEET, cellPx: S, cols: 3, rows: 3 },
    anchors: {
      faceAxisX: 0.5,
      crownY: 0.08,
      chinY: 0.6,
      eyeLineY: 0.38,
      pupilLeftX: 0.41,
      pupilRightX: 0.59,
      mouthCentreY: 0.53,
      shoulderY: 0.85,
      headWidth: 0.4,
      // SP-2.3「髮／呆毛最高點 ≥ 0.048·S」與 SP-2.9「剪影最寬處 ≤ 0.840·S」。
      // 它們讓 SP-7.5 的頭頂／頭寬可以用**區間**比對 —— 因為量測法量到的是
      // 含髮的 bbox，而 crownY/headWidth 描述的是顱骨。兩個數字規格都已凍結。
      hairTopMinY: 0.048,
      maxSilhouetteWidth: 0.84,
    },
    anchorToleranceS: 0.004,
    windows: {
      E: { x0: 0.28, x1: 0.72, y0: 0.33, y1: 0.445 },
      B: { x0: 0.28, x1: 0.72, y0: 0.255, y1: 0.33 },
      M: { x0: 0.395, x1: 0.605, y0: 0.475, y1: 0.585 },
    },
    margins: { opaqueFree: 0.02, featherOuter: 0.04, silhouetteBox: [0.04, 0.96] },
    colours: {
      lineart: hex(PALETTE.lineart),
      iris: hex(PALETTE.iris),
      irisToleranceRgb: 40,
      skin: hex(PALETTE.skin),
      skinToleranceRgb: 24,
      hair: hex(PALETTE.hair),
      hairToleranceRgb: 24,
      exemptToleranceRgb: 24,
    },
    luminanceExemptColours: [],
    luminance: { min: 0.047, max: 0.61, minAreaFraction: 0.01 },
    stroke: { width: 0.016, tolerance: 0.002, luminanceMin: 0.18, luminanceMax: 0.24, luminanceSlack: 0.03 },
    // maskRatio 的上下界不對稱是有理由的：虹膜是固定大小的圓盤在眼眶內移動，
    // 可見面積只會被眼瞼遮掉（變小），沒有合法的理由變大。所以污染只會往上跑。
    gaze: { zeroAxisRatio: 0.2, maskRatioMin: 0.35, maskRatioMax: 1.25 },
    blink: { featherS: 0.004 },
    readability: { targetPx: 128, minBrowContrast: 0.25 },
    cells: {
      directions: ['左上', '上', '右上', '左', '中性(master)', '右', '左下', '下', '右下'],
      reactions: ['click', 'warning', 'critical', 'resolved', '半開嘴', '大開嘴', '全閉眼', '半閉眼', 'pending'],
    },
    reactionOwnership: ['EBMK', 'BMK', 'BMK', 'BMK', 'M', 'M', 'E', 'E', 'BMK'],
    intentionally_empty: [],
    budget: { perSheetBytes: 921600, totalBytes: 1258291 },
    sha256: { directions: '', reactions: '' },
  };
  return { ...m, ...overrides };
}

// --- 幾何 -----------------------------------------------------------------

const HEAD = { cx: 0.5 * S, cy: ((0.08 + 0.6) / 2) * S, rx: 0.2 * S, ry: ((0.6 - 0.08) / 2) * S };
const BODY_TOP = 0.586 * S;
const BODY_BOTTOM = 0.89 * S;
const STROKE_PX = 0.016 * S;

function inHead(x, y) {
  const dx = (x + 0.5 - HEAD.cx) / HEAD.rx;
  const dy = (y + 0.5 - HEAD.cy) / HEAD.ry;
  return dx * dx + dy * dy <= 1;
}

function inBody(x, y) {
  if (y < BODY_TOP || y > BODY_BOTTOM) {
    return false;
  }
  const t = (y - BODY_TOP) / (BODY_BOTTOM - BODY_TOP);
  const half = 106 + t * 40;
  return Math.abs(x + 0.5 - 0.5 * S) <= half;
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x + 0.5 - cx) / rx;
  const dy = (y + 0.5 - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/** 5-7-11 chamfer 距離變換（相對誤差約 2%），用來把描邊環畫在剪影外緣。 */
function distanceOutside(mask) {
  const INF = 1 << 28;
  const d = new Int32Array(S * S).fill(INF);
  for (let i = 0; i < d.length; i++) {
    if (mask[i]) {
      d[i] = 0;
    }
  }
  const fwd = [[-2, -1, 11], [-2, 1, 11], [-1, -2, 11], [-1, -1, 7], [-1, 0, 5], [-1, 1, 7], [-1, 2, 11], [0, -1, 5]];
  const bwd = fwd.map(([dy, dx, c]) => [-dy, -dx, c]);
  const pass = (order, neigh) => {
    for (const y of order) {
      for (let k = 0; k < S; k++) {
        const x = neigh === fwd ? k : S - 1 - k;
        const i = y * S + x;
        let best = d[i];
        for (const [dy, dx, c] of neigh) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= S || nx >= S) {
            continue;
          }
          best = Math.min(best, d[ny * S + nx] + c);
        }
        d[i] = best;
      }
    }
  };
  pass([...Array(S).keys()], fwd);
  pass([...Array(S).keys()].reverse(), bwd);
  return d; // 單位為 1/5 像素
}

function invertMask(m) {
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) {
    out[i] = m[i] ? 0 : 1;
  }
  return out;
}

function hexToRgbLocal(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function setPx(buf, ox, oy, x, y, rgb, a = 255) {
  const o = ((oy + y) * SHEET + (ox + x)) * 4;
  buf[o] = rgb[0];
  buf[o + 1] = rgb[1];
  buf[o + 2] = rgb[2];
  buf[o + 3] = a;
}

/**
 * 畫一格 directions。`gazeDx` / `gazeDy` 是虹膜相對中性格的位移（像素），
 * **只有虹膜會動** —— 這正是 SP-7.2「頭部不動」要驗的性質。
 */
function drawDirectionCell(buf, ox, oy, gazeDx, gazeDy, opts = {}, cellIndex = 0) {
  const core = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inHead(x, y) || inBody(x, y)) {
        core[y * S + x] = 1;
      }
    }
  }
  // `strands`：四根漸細髮束。**真實畫稿必然有這類細長附屬物**，而面積÷周長的
  // 描邊估計器對它們極度敏感（複審實測四根就把 8.192 推到 9.505）。
  // 從顱骨兩側往下垂，末端收細到 2px。
  if (opts.strands) {
    for (const [baseX, dir] of [[0.315, -1], [0.345, -1], [0.655, 1], [0.685, 1]]) {
      const x0 = baseX * S;
      const len = 0.30 * S;
      for (let t = 0; t < len; t++) {
        const w = Math.max(1, Math.round(7 * (1 - t / len)));
        const cx = Math.round(x0 + dir * t * 0.18);
        for (let k = -w; k <= w; k++) {
          const x = cx + k;
          const y = Math.round(0.22 * S + t);
          if (x >= 0 && x < S && y >= 0 && y < S) {
            core[y * S + x] = 1;
          }
        }
      }
    }
  }
  const dist = distanceOutside(core);
  // `perCellStrokePx` 讓 selftest 造「單一格描邊寬度不同」的變異體（SP-6.5 跨格一致）。
  const strokePx = opts.perCellStrokePx?.[cellIndex] ?? opts.strokePx ?? STROKE_PX;
  const strokeLimit = Math.round(strokePx * 5);
  const strokeRgb = opts.strokeColour ? hexToRgbLocal(opts.strokeColour) : PALETTE.stroke;
  // `strokeGapY`：該 y 區間不畫描邊（SP-2.8 下襬豁免、或肩部真的缺一段）。
  const gap = opts.strokeGapY ?? null;
  const inGap = (y) => gap !== null && y >= gap[0] && y < gap[1];
  // `strokeInside`：描邊畫進剪影**內**而不是外。同一個剪影、同一條真實厚度，
  // 兩種畫法都是合法的 —— 而面積÷周長在兩者之間差 2.31 px，比整個容差窗還寬。
  const distIn = opts.strokeInside ? distanceOutside(invertMask(core)) : null;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (!core[i]) {
        if (!opts.strokeInside && dist[i] > 0 && dist[i] <= strokeLimit && !inGap(y)) {
          setPx(buf, ox, oy, x, y, strokeRgb);
        }
        continue;
      }
      if (opts.strokeInside && distIn[i] > 0 && distIn[i] <= strokeLimit && !inGap(y)) {
        setPx(buf, ox, oy, x, y, strokeRgb);
        continue;
      }
      let colour;
      if (inHead(x, y)) {
        colour = y <= 0.25 * S ? PALETTE.hair : PALETTE.skin;
      } else if (opts.inBandGarment) {
        // 落在描邊亮度帶內的**合法**中性灰（L = 0.2016，SP-6.2 的 [0.047, 0.61] 內）。
        colour = [0x7c, 0x7c, 0x7c];
      } else {
        colour = Math.abs(x + 0.5 - 0.5 * S) <= 62 ? PALETTE.top : PALETTE.capelet;
      }
      setPx(buf, ox, oy, x, y, colour);
    }
  }

  // 眉（眉窗 B 內）與嘴（嘴窗 M 內）—— 在九格之間完全相同
  for (let y = 0.273 * S; y < 0.293 * S; y++) {
    for (const [x0, x1] of [[0.352 * S, 0.469 * S], [0.531 * S, 0.648 * S]]) {
      for (let x = x0; x < x1; x++) {
        setPx(buf, ox, oy, Math.round(x), Math.round(y), PALETTE.lineart);
      }
    }
  }
  for (let y = 0.523 * S; y < 0.539 * S; y++) {
    for (let x = 0.441 * S; x < 0.559 * S; x++) {
      setPx(buf, ox, oy, Math.round(x), Math.round(y), PALETTE.lineart);
    }
  }

  // 眼：鞏膜固定，虹膜依格號位移（兩者都完全落在眼窗 E 內）
  const eyeY = 0.38 * S;
  for (const px of [0.41 * S, 0.59 * S]) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (inEllipse(x, y, px, eyeY, 30, 20)) {
          setPx(buf, ox, oy, x, y, PALETTE.sclera);
        }
      }
    }
  }
  const irisR = opts.irisRadius ?? 12;
  for (const px of [0.41 * S, 0.59 * S]) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (inEllipse(x, y, px + gazeDx, eyeY + gazeDy, irisR, irisR)) {
          setPx(buf, ox, oy, x, y, PALETTE.iris);
        }
      }
    }
  }
}

/** master frame 的臉部區域（含被眼／眉／嘴挖掉的洞）—— reactions 的產權上界。 */
function faceRegion() {
  const mask = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inHead(x, y) && y > 0.25 * S) {
        mask[y * S + x] = 1;
      }
    }
  }
  return mask;
}

function drawReactionCell(buf, ox, oy, cell) {
  const face = faceRegion();
  const put = (x, y, rgb, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S || !face[y * S + x]) {
      return;
    }
    setPx(buf, ox, oy, x, y, rgb, a);
  };
  const ellipse = (cx, cy, rx, ry, rgb) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (inEllipse(x, y, cx, cy, rx, ry)) {
          put(x, y, rgb);
        }
      }
    }
  };
  const bar = (x0, x1, y0, y1, rgb) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        put(x, y, rgb);
      }
    }
  };

  const eyeY = 0.38 * S;
  switch (cell) {
    case 0: // click（驚訝）—— 此格允許畫入眼窗 E
      bar(0.352 * S, 0.469 * S, 0.266 * S, 0.281 * S, PALETTE.lineart);
      bar(0.531 * S, 0.648 * S, 0.266 * S, 0.281 * S, PALETTE.lineart);
      ellipse(0.5 * S, 0.531 * S, 16, 16, PALETTE.lineart);
      ellipse(0.41 * S, eyeY, 26, 16, PALETTE.sclera);
      break;
    case 1: // warning：眉略下 + 汗滴
      bar(0.352 * S, 0.469 * S, 0.285 * S, 0.3 * S, PALETTE.lineart);
      bar(0.531 * S, 0.648 * S, 0.285 * S, 0.3 * S, PALETTE.lineart);
      ellipse(SP_2_12_MARKS.sweat.cx * S, SP_2_12_MARKS.sweat.cy * S, SP_2_12_MARKS.sweat.rx, SP_2_12_MARKS.sweat.ry, PALETTE.sclera);
      bar(0.441 * S, 0.559 * S, 0.523 * S, 0.531 * S, PALETTE.lineart);
      break;
    case 2: // critical：眉下壓 + 怒紋
      bar(0.352 * S, 0.469 * S, 0.297 * S, 0.316 * S, PALETTE.lineart);
      bar(0.531 * S, 0.648 * S, 0.297 * S, 0.316 * S, PALETTE.lineart);
      bar(SP_2_12_MARKS.anger.x0 * S, SP_2_12_MARKS.anger.x1 * S, SP_2_12_MARKS.anger.y0 * S, SP_2_12_MARKS.anger.y1 * S, PALETTE.lineart);
      bar(0.43 * S, 0.57 * S, 0.523 * S, 0.535 * S, PALETTE.lineart);
      break;
    case 3: // resolved：微笑 + 腮紅
      bar(0.352 * S, 0.469 * S, 0.262 * S, 0.273 * S, PALETTE.lineart);
      ellipse(0.5 * S, 0.531 * S, 30, 7, PALETTE.lineart);
      ellipse(0.33 * S, 0.47 * S, 18, 11, PALETTE.skin);
      break;
    case 4: // 半開嘴（僅嘴窗 M）
      ellipse(0.5 * S, 0.531 * S, 22, 9, PALETTE.lineart);
      break;
    case 5: // 大開嘴（僅嘴窗 M）
      ellipse(0.5 * S, 0.531 * S, 26, 16, PALETTE.lineart);
      break;
    case 6: // 全閉眼（僅眼窗 E）
      ellipse(0.41 * S, eyeY, 32, 12, PALETTE.skin);
      ellipse(0.59 * S, eyeY, 32, 12, PALETTE.skin);
      break;
    case 7: // 半閉眼（僅眼窗 E）
      ellipse(0.41 * S, eyeY - 6, 32, 7, PALETTE.skin);
      ellipse(0.59 * S, eyeY - 6, 32, 7, PALETTE.skin);
      break;
    case 8: // pending：眉挑 + 直線陰影
      bar(0.352 * S, 0.469 * S, 0.27 * S, 0.279 * S, PALETTE.lineart);
      bar(0.531 * S, 0.648 * S, 0.276 * S, 0.285 * S, PALETTE.lineart);
      bar(0.441 * S, 0.559 * S, 0.525 * S, 0.533 * S, PALETTE.lineart);
      break;
    default:
      break;
  }
}

/** 產生 directions 與 reactions 兩張 sheet，格式與 `decodePng` 的回傳一致。 */
/**
 * 後處理：把一格的硬邊換成 SP-2.14 要求的 alpha 漸層。
 *
 * ⚠️ **漸層必須以真實邊界為中心**，不是往外加半透明像素。
 * 單向往外加等於把剪影放大，alpha=127.5 等值線落在原邊界外約 h/2，
 * 每一條法線游程系統性變長 —— 我第一版就是這樣錯的，抗鋸齒基準因此讀成
 * 9.856（真值 8.192，+1.664），差點把 fixture 的錯算到估計器頭上。
 * 正確的模型是 `alpha = clamp(0.5 − signed / (2h), 0, 1)`，signed 為到邊界的帶號距離。
 *
 * RGB 一律取最近不透明像素（SP-2.15 的色彩擴張，那是**強制**步驟）。
 */
function applyAlphaRamp(buf, ox, oy, h) {
  const solid = new Uint8Array(S * S);
  const rgb = new Uint8Array(S * S * 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = ((oy + y) * SHEET + (ox + x)) * 4;
      const i = y * S + x;
      solid[i] = buf[o + 3] === 255 ? 1 : 0;
      rgb[i * 3] = buf[o];
      rgb[i * 3 + 1] = buf[o + 1];
      rgb[i * 3 + 2] = buf[o + 2];
    }
  }
  // 邊界像素 = 實心且四鄰有空的
  const bd = new Uint8Array(S * S);
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      if (solid[i] && !(solid[i - 1] && solid[i + 1] && solid[i - S] && solid[i + S])) {
        bd[i] = 1;
      }
    }
  }
  const reach = Math.ceil(h) + 2;
  const db = new Int16Array(S * S).fill(9999);
  const src = new Int32Array(S * S).fill(-1);
  for (let i = 0; i < S * S; i++) {
    if (bd[i]) {
      db[i] = 0;
    }
    if (solid[i]) {
      src[i] = i;
    }
  }
  for (let p = 0; p < reach; p++) {
    for (let y = 1; y < S - 1; y++) {
      for (let x = 1; x < S - 1; x++) {
        const i = y * S + x;
        const mn = Math.min(db[i - 1], db[i + 1], db[i - S], db[i + S]);
        if (mn + 1 < db[i]) {
          db[i] = mn + 1;
        }
        if (src[i] < 0) {
          for (const j of [i - 1, i + 1, i - S, i + S]) {
            if (src[j] >= 0) {
              src[i] = src[j];
              break;
            }
          }
        }
      }
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (db[i] > h) {
        continue;
      }
      const signed = solid[i] ? -db[i] : db[i];
      const a = Math.round(255 * Math.min(1, Math.max(0, 0.5 - signed / (2 * h))));
      const sj = src[i];
      if (sj < 0) {
        continue;
      }
      const o = ((oy + y) * SHEET + (ox + x)) * 4;
      buf[o] = rgb[sj * 3];
      buf[o + 1] = rgb[sj * 3 + 1];
      buf[o + 2] = rgb[sj * 3 + 2];
      buf[o + 3] = a;
    }
  }
}

/**
 * 後處理：把相鄰的**填色**畫到描邊之外 N px（手繪 lineart-over-fill 的常態，
 * 日文叫「はみ出し」）。這會讓「最外圈不透明像素」變成填色而不是描邊色 ——
 * 環狀 flood 因此找不到種子，舊實作直接回 NaN 硬失敗。
 */
function applyFillBleed(buf, ox, oy, n) {
  for (let pass = 0; pass < n; pass++) {
    const add = [];
    for (let y = 1; y < S - 1; y++) {
      for (let x = 1; x < S - 1; x++) {
        const o = ((oy + y) * SHEET + (ox + x)) * 4;
        if (buf[o + 3] !== 0) {
          continue;
        }
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const q = ((oy + y + dy) * SHEET + (ox + x + dx)) * 4;
          if (buf[q + 3] === 255) {
            // 往內走 12px 取真正的填色（跳過描邊那一圈）
            const f = ((oy + y + dy * 12) * SHEET + (ox + x + dx * 12)) * 4;
            const useF = f >= 0 && f + 3 < buf.length && buf[f + 3] === 255;
            add.push([o, useF ? [buf[f], buf[f + 1], buf[f + 2]] : [buf[q], buf[q + 1], buf[q + 2]]]);
            break;
          }
        }
      }
    }
    for (const [o, c] of add) {
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
      buf[o + 3] = 255;
    }
  }
}

/**
 * 後處理：對底色合成（matte）。**違反 SP-2.13 的非預乘要求**，
 * 用來驗 SP-7.1/預乘alpha 與「不得因此降級寬度判定」那條守門測試。
 * 必須在 applyAlphaRamp 之後 —— 沒有半透明像素就沒有 matte 可言。
 */
function applyMatte(buf, ox, oy, bgHex) {
  const bg = hexToRgbLocal(bgHex);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = ((oy + y) * SHEET + (ox + x)) * 4;
      const a = buf[o + 3];
      if (a === 0 || a === 255) {
        continue;
      }
      const f = a / 255;
      buf[o] = Math.round(buf[o] * f + bg[0] * (1 - f));
      buf[o + 1] = Math.round(buf[o + 1] * f + bg[1] * (1 - f));
      buf[o + 2] = Math.round(buf[o + 2] * f + bg[2] * (1 - f));
    }
  }
}

export function buildSheets(opts = {}) {
  const directions = new Uint8Array(SHEET * SHEET * 4);
  const reactions = new Uint8Array(SHEET * SHEET * 4);
  const gx = opts.gazeStepX ?? 12;
  const gy = opts.gazeStepY ?? 8;
  for (let c = 0; c < 9; c++) {
    const ox = (c % 3) * S;
    const oy = Math.floor(c / 3) * S;
    // perCellGaze 讓 selftest 造出「方向對但殘差超標」這類只違反單一條款的變異體 ——
    // 靠事後搬移整格做不到，那會連帶破壞「兩格不得相同」。
    const [dx, dy] = opts.perCellGaze?.[c] ?? [((c % 3) - 1) * gx, (Math.floor(c / 3) - 1) * gy];
    drawDirectionCell(directions, ox, oy, dx, dy, opts, c);
    drawReactionCell(reactions, ox, oy, c);
    // 後處理的順序是有意義的：滲出 → 羽化 → matte。
    // 滲出要在羽化之前（否則滲出的那圈自己是硬邊）；
    // matte 要在羽化之後（沒有半透明像素就沒有 matte 可言）。
    if (opts.fillBleedPx) {
      applyFillBleed(directions, ox, oy, opts.fillBleedPx);
    }
    // ⚠️ **預設是 2px 羽化，不是 1-bit 硬邊。**
    // 先前預設沒有羽化，於是整個閘門是對著一張**規格自己會退的圖**校準的
    // （SP-2.14 明文禁止 1-bit alpha）。那不是理論問題 ——
    // 2026-09-22 的複審因此抓到兩條門檻在合規素材上算術達不到：
    // 眨眼的 90% 不透明比例、以及描邊的環狀 flood。
    // 要刻意測 1-bit（例如驗 SP-2.14 檢查本身）就傳 `alphaRampPx: 0`。
    const ramp = opts.alphaRampPx === undefined ? 2 : opts.alphaRampPx;
    if (ramp) {
      applyAlphaRamp(directions, ox, oy, ramp);
      // 覆蓋層的邊緣同樣會被降取樣，SP-2.14 對它們一樣適用 ——
      // 眨眼的修補塊邊緣就是一例（見 SP-7.4 的 blink.featherS）。
      applyAlphaRamp(reactions, ox, oy, ramp);
    }
    if (opts.matte) {
      applyMatte(directions, ox, oy, opts.matte);
      applyMatte(reactions, ox, oy, opts.matte);
    }
  }
  return {
    directions: { width: SHEET, height: SHEET, data: directions },
    reactions: { width: SHEET, height: SHEET, data: reactions },
  };
}
