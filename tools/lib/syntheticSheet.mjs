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
    gaze: { zeroAxisRatio: 0.2 },
    blink: { opaqueFraction: 0.9 },
    readability: { targetPx: 128, minBrowContrast: 0.25 },
    cells: {
      directions: ['左上', '上', '右上', '左', '中性(master)', '右', '左下', '下', '右下'],
      reactions: ['click', 'warning', 'critical', 'resolved', '半開嘴', '大開嘴', '全閉眼', '半閉眼', 'pending'],
    },
    reactionOwnership: ['EBMK', 'BMK', 'BMK', 'BMK', 'M', 'M', 'E', 'E', 'BMK'],
    intentionallyEmpty: [],
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
function drawDirectionCell(buf, ox, oy, gazeDx, gazeDy, opts = {}) {
  const core = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inHead(x, y) || inBody(x, y)) {
        core[y * S + x] = 1;
      }
    }
  }
  const dist = distanceOutside(core);
  const strokeLimit = Math.round((opts.strokePx ?? STROKE_PX) * 5);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (!core[i]) {
        if (dist[i] > 0 && dist[i] <= strokeLimit) {
          setPx(buf, ox, oy, x, y, PALETTE.stroke);
        }
        continue;
      }
      let colour;
      if (inHead(x, y)) {
        colour = y <= 0.25 * S ? PALETTE.hair : PALETTE.skin;
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
      ellipse(0.645 * S, 0.293 * S, 9, 13, PALETTE.sclera);
      bar(0.441 * S, 0.559 * S, 0.523 * S, 0.531 * S, PALETTE.lineart);
      break;
    case 2: // critical：眉下壓 + 怒紋
      bar(0.352 * S, 0.469 * S, 0.297 * S, 0.316 * S, PALETTE.lineart);
      bar(0.531 * S, 0.648 * S, 0.297 * S, 0.316 * S, PALETTE.lineart);
      bar(0.629 * S, 0.668 * S, 0.258 * S, 0.266 * S, PALETTE.lineart);
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
    drawDirectionCell(directions, ox, oy, dx, dy, opts);
    drawReactionCell(reactions, ox, oy, c);
  }
  return {
    directions: { width: SHEET, height: SHEET, data: directions },
    reactions: { width: SHEET, height: SHEET, data: reactions },
  };
}
