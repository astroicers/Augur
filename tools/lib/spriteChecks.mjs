/**
 * SP-7.1 ~ SP-7.8 的檢查邏輯，全部是對「已解碼的 RGBA」的純運算。
 *
 * **為什麼與 CLI 分開**：這些函式是 selftest 唯一能直接餵合成 fixture 的入口。
 * 混在 CLI 裡就只能靠退出碼驗證，而退出碼分辨不出「擋下來的是哪一條」——
 * 那會讓「刻意做壞一格、確認紅的是 SP-7.3 而不是 SP-7.1」這種測試寫不出來。
 *
 * 所有檢查回傳 `Finding[]`，不丟例外、不印東西、不碰檔案系統。
 * severity 只有兩種：`error` 對應 SP-7.11 的 exit 1，`warn` 只進報表。
 * 首版刻意留成 warn 的兩條（SP-7.1 覆蓋率、SP-7.6 可讀性）在規格裡有明文，
 * 理由是門檻要等第一批實際交付才校得準 —— 猜一個數字放進硬失敗，
 * 第一次交付就會紅在一個沒有根據的值上，然後被人關掉。
 */

/** @typedef {{ id: string, severity: 'error'|'warn', sheet?: string, cell?: number, message: string, measured?: number, limit?: number }} Finding */

export const CELL_COUNT = 9;

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) {
    throw new Error(`色值格式不正確：${hex}`);
  }
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** sRGB 相對亮度（WCAG 定義）。SP-6.2 / SP-6.4 的門檻都是用這個算的。 */
export function relativeLuminance(r, g, b) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 以 sheet + 格號建一個格內取樣器。格號一律 row-major 0–8。 */
export function cellView(sheet, index, geom) {
  const { cellPx, cols } = geom;
  const ox = (index % cols) * cellPx;
  const oy = Math.floor(index / cols) * cellPx;
  const { width, data } = sheet;
  return {
    size: cellPx,
    ox,
    oy,
    /** 回傳 [r,g,b,a]；超出格外回傳全 0。 */
    px(x, y) {
      if (x < 0 || y < 0 || x >= cellPx || y >= cellPx) {
        return [0, 0, 0, 0];
      }
      const o = ((oy + y) * width + (ox + x)) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    },
    offset(x, y) {
      return ((oy + y) * width + (ox + x)) * 4;
    },
  };
}

/** 把 SP-2.11 的比例視窗換算成格內像素矩形（含上界，取 floor/ceil 放寬一格）。 */
export function windowRect(win, cellPx) {
  return {
    x0: Math.floor(win.x0 * cellPx),
    x1: Math.ceil(win.x1 * cellPx),
    y0: Math.floor(win.y0 * cellPx),
    y1: Math.ceil(win.y1 * cellPx),
  };
}

function inRect(x, y, r) {
  return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
}

function colourNear(r, g, b, target, tol) {
  return Math.abs(r - target[0]) <= tol && Math.abs(g - target[1]) <= tol && Math.abs(b - target[2]) <= tol;
}

// ---------------------------------------------------------------------------
// SP-7.1 檢查 A — 格式與衛生
// ---------------------------------------------------------------------------

export function checkFormatAndHygiene(sheets, manifest) {
  /** @type {Finding[]} */
  const out = [];
  const geom = manifest.sheet;
  const { width: W, height: H, cellPx } = geom;

  for (const [name, sheet] of Object.entries(sheets)) {
    if (sheet.width !== W || sheet.height !== H) {
      out.push({
        id: 'SP-7.1/尺寸',
        severity: 'error',
        sheet: name,
        message: `尺寸為 ${sheet.width}×${sheet.height}，manifest 宣告 ${W}×${H}`,
      });
      continue;
    }

    const band = Math.round(manifest.margins.opaqueFree * cellPx);
    const emptyCells = new Set((manifest.intentionallyEmpty || []).filter((e) => e.sheet === name).map((e) => e.cell));

    for (let c = 0; c < CELL_COUNT; c++) {
      const v = cellView(sheet, c, geom);

      // 外緣帶 alpha 嚴格為 0（SP-2.1 第一層，防跨格滲色的保險）
      let bleed = 0;
      let worstAlpha = 0;
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          const edge = x < band || y < band || x >= cellPx - band || y >= cellPx - band;
          if (!edge) {
            continue;
          }
          const a = v.px(x, y)[3];
          if (a !== 0) {
            bleed++;
            worstAlpha = Math.max(worstAlpha, a);
          }
        }
      }
      if (bleed > 0) {
        out.push({
          id: 'SP-7.1/透明帶',
          severity: 'error',
          sheet: name,
          cell: c,
          message: `外緣 ${manifest.margins.opaqueFree}·S 帶內有 ${bleed} 個非透明像素（最大 alpha ${worstAlpha}），須嚴格為 0`,
          measured: bleed,
          limit: 0,
        });
      }

      // 黑邊 matte：半透明且 RGB 純黑 —— 匯出成預乘 alpha 的指紋
      let matte = 0;
      let opaque = 0;
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          const [r, g, b, a] = v.px(x, y);
          if (a > 0) {
            opaque += a === 255 ? 1 : 0;
          }
          if (a > 0 && a < 255 && r === 0 && g === 0 && b === 0) {
            matte++;
          }
        }
      }
      const matteRatio = matte / (cellPx * cellPx);
      if (matteRatio > 0.001) {
        out.push({
          id: 'SP-7.1/黑邊matte',
          severity: 'error',
          sheet: name,
          cell: c,
          message: `半透明純黑像素佔 ${(matteRatio * 100).toFixed(3)}%，超過 0.1% —— 匯出成了預乘 alpha`,
          measured: matteRatio,
          limit: 0.001,
        });
      }

      // 覆蓋率：首版警告（SP-7.1 明文，門檻待第一批交付回填）
      if (!emptyCells.has(c)) {
        out.push({
          id: 'SP-7.1/覆蓋率',
          severity: 'warn',
          sheet: name,
          cell: c,
          message: `不透明覆蓋率 ${((opaque / (cellPx * cellPx)) * 100).toFixed(1)}%（首版僅記錄，門檻待回填）`,
          measured: opaque / (cellPx * cellPx),
        });
      }
    }

    // 同一張 sheet 內任兩格不得逐位元組相同
    const digests = new Map();
    for (let c = 0; c < CELL_COUNT; c++) {
      if (emptyCells.has(c)) {
        continue;
      }
      const v = cellView(sheet, c, geom);
      const buf = new Uint8Array(cellPx * cellPx * 4);
      for (let y = 0; y < cellPx; y++) {
        const src = v.offset(0, y);
        buf.set(sheet.data.subarray(src, src + cellPx * 4), y * cellPx * 4);
      }
      const key = fnv1a(buf);
      if (digests.has(key)) {
        out.push({
          id: 'SP-7.1/重複格',
          severity: 'error',
          sheet: name,
          cell: c,
          message: `與格 ${digests.get(key)} 逐位元組相同；未宣告 intentionally_empty 的格不得重複`,
        });
      } else {
        digests.set(key, c);
      }
    }
  }
  return out;
}

/** 非密碼學用途，只用來找「逐位元組相同」的格。碰撞的後果是漏報一格重複，不是誤報。 */
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// SP-7.2 檢查 B — 頭部不動
// ---------------------------------------------------------------------------

export function checkHeadImmobility(directions, manifest) {
  /** @type {Finding[]} */
  const out = [];
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const E = windowRect(manifest.windows.E, cellPx);
  const base = cellView(directions, 4, geom);

  for (let c = 0; c < CELL_COUNT; c++) {
    if (c === 4) {
      continue;
    }
    const v = cellView(directions, c, geom);
    let outside = 0;
    let firstX = -1;
    let firstY = -1;
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        if (inRect(x, y, E)) {
          continue;
        }
        const a = base.px(x, y);
        const b = v.px(x, y);
        if (Math.abs(a[0] - b[0]) > 2 || Math.abs(a[1] - b[1]) > 2 || Math.abs(a[2] - b[2]) > 2 || Math.abs(a[3] - b[3]) > 2) {
          if (outside === 0) {
            firstX = x;
            firstY = y;
          }
          outside++;
        }
      }
    }
    if (outside > 0) {
      out.push({
        id: 'SP-7.2/頭部不動',
        severity: 'error',
        sheet: 'directions',
        cell: c,
        message: `與 master frame 有 ${outside} 個差異像素落在眼窗 E 之外（首例 ${firstX},${firstY}）—— directions 九格除眼窗外必須逐像素相同`,
        measured: outside,
        limit: 0,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SP-7.3 檢查 C — 視線方向綁定 gaze.ts
// ---------------------------------------------------------------------------

/** 在眼窗 E 內以虹膜色取遮罩，回傳質心與像素數。 */
export function irisCentroid(directions, cell, manifest) {
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const E = windowRect(manifest.windows.E, cellPx);
  const iris = hexToRgb(manifest.colours.iris);
  const tol = manifest.colours.irisToleranceRgb;
  const v = cellView(directions, cell, geom);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = E.y0; y < E.y1; y++) {
    for (let x = E.x0; x < E.x1; x++) {
      const [r, g, b, a] = v.px(x, y);
      if (a < 128) {
        continue;
      }
      if (colourNear(r, g, b, iris, tol)) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n === 0 ? { n: 0, cx: NaN, cy: NaN } : { n, cx: sx / n, cy: sy / n };
}

export function checkGazeBinding(directions, manifest) {
  /** @type {Finding[]} */
  const out = [];
  const centroids = [];
  for (let c = 0; c < CELL_COUNT; c++) {
    const m = irisCentroid(directions, c, manifest);
    centroids.push(m);
    if (m.n === 0) {
      out.push({
        id: 'SP-7.3/虹膜遮罩',
        severity: 'error',
        sheet: 'directions',
        cell: c,
        message: `眼窗 E 內找不到虹膜色 ${manifest.colours.iris}（容差 ±${manifest.colours.irisToleranceRgb}）的像素`,
        measured: 0,
      });
    }
  }
  if (Number.isNaN(centroids[4].cx)) {
    return { findings: out, centroids };
  }

  const zeroAxisRatio = manifest.gaze?.zeroAxisRatio ?? 0.2;

  for (let c = 0; c < CELL_COUNT; c++) {
    if (c === 4 || centroids[c].n === 0) {
      continue;
    }
    const dx = centroids[c].cx - centroids[4].cx;
    const dy = centroids[c].cy - centroids[4].cy;
    const wantX = (c % 3) - 1;
    const wantY = Math.floor(c / 3) - 1;

    // 第 3 點：sign 必須吻合 gaze.ts 的 row-major 語意
    if (wantX !== 0 && Math.sign(dx) !== wantX) {
      out.push({
        id: 'SP-7.3/方向X',
        severity: 'error',
        sheet: 'directions',
        cell: c,
        message: `虹膜質心 Δx = ${dx.toFixed(2)}，方向應為 ${wantX > 0 ? '右' : '左'}（gaze.ts 的 SECTOR_TO_CELL 要求 sign = ${wantX}）`,
        measured: dx,
      });
    }
    if (wantY !== 0 && Math.sign(dy) !== wantY) {
      out.push({
        id: 'SP-7.3/方向Y',
        severity: 'error',
        sheet: 'directions',
        cell: c,
        message: `虹膜質心 Δy = ${dy.toFixed(2)}，方向應為 ${wantY > 0 ? '下' : '上'}（gaze.ts 的 SECTOR_TO_CELL 要求 sign = ${wantY}）`,
        measured: dy,
      });
    }

    // 第 4 點：應為零的軸，以同一格自己的非零軸為基準（2026-09-20 改寫版）
    // 對角格兩軸皆非零，本點不適用 —— 由上面的 sign 檢查承接。
    if (wantX === 0 && wantY !== 0) {
      const limit = Math.abs(dy) * zeroAxisRatio;
      if (Math.abs(dx) > limit) {
        out.push({
          id: 'SP-7.3/殘差X',
          severity: 'error',
          sheet: 'directions',
          cell: c,
          message: `應為零的 X 軸殘差 |Δx| = ${Math.abs(dx).toFixed(2)}，超過非零軸 |Δy| = ${Math.abs(dy).toFixed(2)} 的 ${zeroAxisRatio} 倍（上限 ${limit.toFixed(2)}）`,
          measured: Math.abs(dx),
          limit,
        });
      }
    }
    if (wantY === 0 && wantX !== 0) {
      const limit = Math.abs(dx) * zeroAxisRatio;
      if (Math.abs(dy) > limit) {
        out.push({
          id: 'SP-7.3/殘差Y',
          severity: 'error',
          sheet: 'directions',
          cell: c,
          message: `應為零的 Y 軸殘差 |Δy| = ${Math.abs(dy).toFixed(2)}，超過非零軸 |Δx| = ${Math.abs(dx).toFixed(2)} 的 ${zeroAxisRatio} 倍（上限 ${limit.toFixed(2)}）`,
          measured: Math.abs(dy),
          limit,
        });
      }
    }
  }
  return { findings: out, centroids };
}

// ---------------------------------------------------------------------------
// SP-7.4 檢查 D — 覆蓋層產權
// ---------------------------------------------------------------------------

/** master frame 的臉部皮膚遮罩（SP-6.6 的產權上界）。以膚色 ± 容差取。 */
export function skinMask(directions, manifest) {
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const v = cellView(directions, 4, geom);
  const skin = hexToRgb(manifest.colours.skin);
  const tol = manifest.colours.skinToleranceRgb;
  const mask = new Uint8Array(cellPx * cellPx);
  for (let y = 0; y < cellPx; y++) {
    for (let x = 0; x < cellPx; x++) {
      const [r, g, b, a] = v.px(x, y);
      if (a >= 128 && colourNear(r, g, b, skin, tol)) {
        mask[y * cellPx + x] = 1;
      }
    }
  }
  return fillHoles(mask, cellPx);
}

/**
 * 把遮罩裡「四面被遮罩包住」的洞補起來。
 *
 * **為什麼非補不可**：SP-6.6 說的是「臉部皮膚**遮罩**」，指的是臉的**區域**，
 * 不是「顏色剛好等於膚色的像素集合」。眼睛在 master frame 上是鞏膜與虹膜、
 * 眉與嘴是線稿色 —— 照字面用顏色比對，格 6/7 的眨眼修補塊（必須蓋住眼睛）
 * 與格 4/5 的嘴型幀（必須蓋住嘴）會**全部**被判成越界，而那正是它們的職責所在。
 *
 * 補法是從格邊界對補集做 flood fill，填不到的即為洞。這同時保住了規格真正要擋的東西：
 * 側髮、斗篷、描邊、剪影外都與格邊界連通，不會被補進來。
 */
function fillHoles(mask, cellPx) {
  const outside = new Uint8Array(cellPx * cellPx);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= cellPx || y >= cellPx) {
      return;
    }
    const i = y * cellPx + x;
    if (outside[i] || mask[i]) {
      return;
    }
    outside[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < cellPx; x++) {
    push(x, 0);
    push(x, cellPx - 1);
  }
  for (let y = 0; y < cellPx; y++) {
    push(0, y);
    push(cellPx - 1, y);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % cellPx;
    const y = (i - x) / cellPx;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  const filled = new Uint8Array(cellPx * cellPx);
  for (let i = 0; i < filled.length; i++) {
    filled[i] = mask[i] || !outside[i] ? 1 : 0;
  }
  return filled;
}

/**
 * 把 `"EBMK"` 之類的產權宣告展開成矩形清單。
 * K = 安全框內、E ∪ B ∪ M 以外的全部區域（SP-2.12），所以含 K 時
 * 產權上界即整個安全框 —— 這也是為什麼 SP-6.6 的皮膚遮罩約束必須同時生效：
 * 光靠視窗表，含 K 的格等於沒有邊界。
 */
function ownershipRects(code, manifest) {
  const { cellPx } = manifest.sheet;
  const rects = [];
  if (code.includes('E')) {
    rects.push(windowRect(manifest.windows.E, cellPx));
  }
  if (code.includes('B')) {
    rects.push(windowRect(manifest.windows.B, cellPx));
  }
  if (code.includes('M')) {
    rects.push(windowRect(manifest.windows.M, cellPx));
  }
  if (code.includes('K')) {
    const lo = Math.floor(manifest.margins.silhouetteBox[0] * cellPx);
    const hi = Math.ceil(manifest.margins.silhouetteBox[1] * cellPx);
    rects.push({ x0: lo, x1: hi, y0: lo, y1: hi });
  }
  return rects;
}

export function checkOverlayOwnership(sheets, manifest) {
  /** @type {Finding[]} */
  const out = [];
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const skin = skinMask(sheets.directions, manifest);
  const B = windowRect(manifest.windows.B, cellPx);
  const emptyCells = new Set(
    (manifest.intentionallyEmpty || []).filter((e) => e.sheet === 'reactions').map((e) => e.cell)
  );

  for (let c = 0; c < CELL_COUNT; c++) {
    if (emptyCells.has(c)) {
      continue;
    }
    const code = manifest.reactionOwnership[c];
    const rects = ownershipRects(code, manifest);
    const v = cellView(sheets.reactions, c, geom);

    let outsideWindows = 0;
    let outsideSkin = 0;
    let nonZero = 0;
    let fullyOpaque = 0;
    let firstOut = null;
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        const a = v.px(x, y)[3];
        if (a === 0) {
          continue;
        }
        nonZero++;
        if (a === 255) {
          fullyOpaque++;
        }
        if (!rects.some((r) => inRect(x, y, r))) {
          outsideWindows++;
          if (!firstOut) {
            firstOut = [x, y];
          }
        }
        if (!skin[y * cellPx + x]) {
          outsideSkin++;
        }
      }
    }

    if (nonZero === 0) {
      out.push({
        id: 'SP-7.4/空格',
        severity: 'error',
        sheet: 'reactions',
        cell: c,
        message: '整格 alpha 全 0，但未宣告 intentionally_empty',
      });
      continue;
    }
    if (outsideWindows > 0) {
      out.push({
        id: 'SP-7.4/視窗產權',
        severity: 'error',
        sheet: 'reactions',
        cell: c,
        message: `${outsideWindows} 個非零 alpha 像素落在宣告的產權 ${code} 之外（首例 ${firstOut[0]},${firstOut[1]}）`,
        measured: outsideWindows,
        limit: 0,
      });
    }
    // SP-6.6：比視窗表更嚴的第二條，兩條同時生效
    if (outsideSkin > 0) {
      out.push({
        id: 'SP-6.6/皮膚遮罩',
        severity: 'error',
        sheet: 'reactions',
        cell: c,
        message: `${outsideSkin} 個非零 alpha 像素不在 master frame 的臉部皮膚遮罩內 —— 覆蓋層不得寫到剪影外、側髮、斗篷或描邊上`,
        measured: outsideSkin,
        limit: 0,
      });
    }

    // 格 6 / 7 為眨眼：必須是不透明的修補塊（SP-4.7 的「不足」失敗模式）
    if (c === 6 || c === 7) {
      const ratio = fullyOpaque / nonZero;
      const need = manifest.blink?.opaqueFraction ?? 0.9;
      if (ratio < need) {
        out.push({
          id: 'SP-7.4/眨眼不透明',
          severity: 'error',
          sheet: 'reactions',
          cell: c,
          message: `非零 alpha 像素中僅 ${(ratio * 100).toFixed(1)}% 為 alpha=255，低於 ${(need * 100).toFixed(0)}% —— 半透明的閉眼會讓底下的瞳孔透出來`,
          measured: ratio,
          limit: need,
        });
      }
      let intoBrow = 0;
      for (let y = B.y0; y < B.y1; y++) {
        for (let x = B.x0; x < B.x1; x++) {
          if (v.px(x, y)[3] !== 0) {
            intoBrow++;
          }
        }
      }
      if (intoBrow > 0) {
        out.push({
          id: 'SP-7.4/眨眼吃眉',
          severity: 'error',
          sheet: 'reactions',
          cell: c,
          message: `與眉窗 B 的交集有 ${intoBrow} 個非零 alpha 像素 —— 眨眼不得吃掉眉毛`,
          measured: intoBrow,
          limit: 0,
        });
      }
    }

    // composite 在視窗之外必須與 master frame 逐位元相同。
    // 這條其實由「非零 alpha 全在視窗內」蘊含，但分開驗是有意義的：
    // 它擋的是 alpha=0 卻帶了非零 RGB 的像素在某些合成實作下滲出來。
    const base = cellView(sheets.directions, 4, geom);
    let drift = 0;
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        if (rects.some((r) => inRect(x, y, r))) {
          continue;
        }
        const over = v.px(x, y);
        if (over[3] !== 0) {
          continue;
        }
        const under = base.px(x, y);
        const composited = under;
        if (composited[0] !== under[0] || composited[1] !== under[1] || composited[2] !== under[2] || composited[3] !== under[3]) {
          drift++;
        }
      }
    }
    if (drift > 0) {
      out.push({
        id: 'SP-7.4/合成漂移',
        severity: 'error',
        sheet: 'reactions',
        cell: c,
        message: `composite(directions[4], reactions[${c}]) 在產權視窗外有 ${drift} 個像素與 master frame 不同`,
        measured: drift,
        limit: 0,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SP-7.5 檢查 E — 錨點（只驗 master frame 一張，見 SP-7.5 的理由）
// ---------------------------------------------------------------------------

/** 皮膚 + 髮色遮罩的 bbox 即頭部範圍；SP-7.5 指定的量測法。 */
export function headBox(directions, manifest) {
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const v = cellView(directions, 4, geom);
  const skin = hexToRgb(manifest.colours.skin);
  const hair = hexToRgb(manifest.colours.hair);
  const st = manifest.colours.skinToleranceRgb;
  const ht = manifest.colours.hairToleranceRgb;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let n = 0;
  for (let y = 0; y < cellPx; y++) {
    for (let x = 0; x < cellPx; x++) {
      const [r, g, b, a] = v.px(x, y);
      if (a < 128) {
        continue;
      }
      if (colourNear(r, g, b, skin, st) || colourNear(r, g, b, hair, ht)) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        n++;
      }
    }
  }
  return n === 0 ? null : { x0, x1, y0, y1, n };
}

/** 剪影（alpha ≥ 128）的對稱軸：以每列質心的中位數估。 */
export function silhouetteAxis(directions, manifest) {
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const v = cellView(directions, 4, geom);
  const rows = [];
  for (let y = 0; y < cellPx; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < cellPx; x++) {
      if (v.px(x, y)[3] >= 128) {
        if (lo < 0) {
          lo = x;
        }
        hi = x;
      }
    }
    if (lo >= 0) {
      rows.push((lo + hi) / 2);
    }
  }
  if (!rows.length) {
    return NaN;
  }
  rows.sort((a, b) => a - b);
  return rows[Math.floor(rows.length / 2)];
}

export function checkAnchors(directions, manifest, centroids) {
  /** @type {Finding[]} */
  const out = [];
  const { cellPx } = manifest.sheet;
  const tol = (manifest.anchorToleranceS ?? 0.004) * cellPx;
  const a = manifest.anchors;

  const push = (id, label, measured, expected) => {
    if (!Number.isFinite(measured)) {
      out.push({ id, severity: 'error', sheet: 'directions', cell: 4, message: `${label} 量不到` });
      return;
    }
    const delta = Math.abs(measured - expected * cellPx);
    if (delta > tol) {
      out.push({
        id,
        severity: 'error',
        sheet: 'directions',
        cell: 4,
        message: `${label} 實測 ${(measured / cellPx).toFixed(4)}·S，宣告 ${expected}·S，超出容差 ${(delta / cellPx).toFixed(4)}·S（上限 ${(tol / cellPx).toFixed(4)}·S）`,
        measured: measured / cellPx,
        limit: expected,
      });
    }
  };

  push('SP-7.5/臉中軸', '臉中軸 X', silhouetteAxis(directions, manifest), a.faceAxisX);

  const box = headBox(directions, manifest);
  if (!box) {
    out.push({ id: 'SP-7.5/頭部遮罩', severity: 'error', sheet: 'directions', cell: 4, message: '皮膚＋髮色遮罩為空，量不到頭部 bbox' });
  } else {
    push('SP-7.5/頭頂', '頭頂 Y', box.y0, a.crownY);
    push('SP-7.5/頭寬', '頭寬', box.x1 - box.x0, a.headWidth);
  }

  if (centroids && centroids[4] && centroids[4].n > 0) {
    push('SP-7.5/眼線', '眼線 Y', centroids[4].cy, a.eyeLineY);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SP-7.7 檢查 G — 亮度夾制與描邊
// ---------------------------------------------------------------------------

export function checkLuminanceAndStroke(directions, manifest) {
  /** @type {Finding[]} */
  const out = [];
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const v = cellView(directions, 4, geom);
  const lum = manifest.luminance;
  const exempt = [manifest.colours.lineart, manifest.colours.iris, ...(manifest.luminanceExemptColours || [])].map(hexToRgb);
  const exemptTol = manifest.colours.exemptToleranceRgb ?? 24;

  // 量化到 16 階後統計色塊面積（與 SP-6.0 萃取色票時同一個量化法）
  const hist = new Map();
  let silhouette = 0;
  for (let y = 0; y < cellPx; y++) {
    for (let x = 0; x < cellPx; x++) {
      const [r, g, b, alpha] = v.px(x, y);
      if (alpha < 200) {
        continue;
      }
      silhouette++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      // 代表色取該 bin 的**實際平均**，不是把 bin 索引乘回 17。
      // 乘 17 會把 0xE2 抬成 0xEE —— 膚色 #E2C8B1（L 0.607，SP-6.2 明文指定的合規值）
      // 會被算成 L 0.650 而誤報超上限。量化只用來合併相近色，不該改變顏色本身。
      const bin = hist.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      hist.set(key, bin);
    }
  }
  if (silhouette === 0) {
    return [{ id: 'SP-7.7/剪影', severity: 'error', sheet: 'directions', cell: 4, message: 'master frame 沒有 alpha ≥ 200 的像素' }];
  }

  for (const bin of hist.values()) {
    const frac = bin.n / silhouette;
    if (frac < lum.minAreaFraction) {
      continue;
    }
    const r = Math.round(bin.r / bin.n);
    const g = Math.round(bin.g / bin.n);
    const b = Math.round(bin.b / bin.n);
    // ⚠️ 豁免是**以色距**判定的，不是以語意。線稿色 #000010 配 ±24 的容差，
    // 等於把所有暗於約 (24,24,40)（L ≈ 0.012）的色塊一併豁免掉。
    // 夾制下限是 0.047，所以 [0.012, 0.047] 這一段仍然擋得到；
    // 但比線稿還暗的大面積色塊會通過。要收緊就調小 exemptToleranceRgb，
    // 代價是線稿的抗鋸齒過渡色會開始誤報。這個取捨是刻意的，不是疏漏。
    if (exempt.some((e) => colourNear(r, g, b, e, exemptTol))) {
      continue;
    }
    // 鞏膜（眼白）與高光豁免：SP-6.2 明文
    const L = relativeLuminance(r, g, b);
    if (L >= 0.85) {
      continue;
    }
    if (L < lum.min || L > lum.max) {
      out.push({
        id: 'SP-7.7/亮度夾制',
        severity: 'error',
        sheet: 'directions',
        cell: 4,
        message: `色塊 #${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')} 佔剪影 ${(frac * 100).toFixed(2)}%，相對亮度 ${L.toFixed(3)} 落在 [${lum.min}, ${lum.max}] 之外`,
        measured: L,
        limit: L < lum.min ? lum.min : lum.max,
      });
    }
  }

  // SP-6.4 描邊：由剪影邊緣往內數，連續落在描邊亮度帶內的像素數
  const stroke = manifest.stroke;
  const widths = measureStrokeWidths(directions, manifest);
  const target = stroke.width * cellPx;
  const tol = stroke.tolerance * cellPx;
  for (let c = 0; c < CELL_COUNT; c++) {
    const w = widths[c];
    if (!Number.isFinite(w)) {
      out.push({ id: 'SP-7.7/描邊', severity: 'error', sheet: 'directions', cell: c, message: '量不到描邊（剪影邊緣沒有落在亮度帶內的像素）' });
      continue;
    }
    if (Math.abs(w - target) > tol) {
      out.push({
        id: 'SP-7.7/描邊寬度',
        severity: 'error',
        sheet: 'directions',
        cell: c,
        message: `描邊中位寬度 ${(w / cellPx).toFixed(4)}·S，宣告 ${stroke.width}·S ±${stroke.tolerance}·S`,
        measured: w / cellPx,
        limit: stroke.width,
      });
    }
  }
  return out;
}

/**
 * 量每格的描邊寬度。
 *
 * **不用「水平掃描線的連續 run」**：那量到的是 `w / cos θ`，θ 是邊界與垂直線的夾角。
 * 角色剪影處處是曲線，中位數會系統性高估 —— 而 SP-6.4 的容差只有 ±0.002·S（S=512 時 ±1.02 px），
 * 合規素材會被誤判成紅的。誤紅比漏紅更糟：它會讓人把整條檢查關掉。
 *
 * 改用**面積 ÷ 周長**。對繞著剪影一圈、寬度 w 的環帶，面積 ≈ 周長 × w。
 * 凸曲率帶來的偏差是 `w² / 2R`：S=512、w≈8.2、真實頭部 R≈100–200 px 時為 0.17–0.34 px，
 * 只吃掉容差的三分之一以內，而且方向已知（永遠偏大）。
 *
 * 描邊帶的認定額外限制在「距剪影外緣 3w 以內」，否則角色身上任何落在
 * 亮度帶 [0.18, 0.24] 內的色塊都會被算進描邊面積。
 */
export function measureStrokeWidths(directions, manifest) {
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const stroke = manifest.stroke;
  const slack = stroke.luminanceSlack ?? 0.03;
  const lo = stroke.luminanceMin - slack;
  const hi = stroke.luminanceMax + slack;
  const maxDepth = Math.ceil(stroke.width * cellPx * 3);
  const widths = [];

  for (let c = 0; c < CELL_COUNT; c++) {
    const v = cellView(directions, c, geom);
    const core = new Uint8Array(cellPx * cellPx);
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        core[y * cellPx + x] = v.px(x, y)[3] >= 128 ? 1 : 0;
      }
    }
    // 外緣：core 內、四鄰有一個不是 core 的像素
    const depth = new Int32Array(cellPx * cellPx).fill(-1);
    let queue = [];
    let perimeter = 0;
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        const i = y * cellPx + x;
        if (!core[i]) {
          continue;
        }
        const edge =
          x === 0 || y === 0 || x === cellPx - 1 || y === cellPx - 1 ||
          !core[i - 1] || !core[i + 1] || !core[i - cellPx] || !core[i + cellPx];
        if (edge) {
          depth[i] = 0;
          perimeter++;
          queue.push(i);
        }
      }
    }
    if (perimeter === 0) {
      widths.push(NaN);
      continue;
    }
    // 由外緣往內 BFS 到 3w，界定「可能是描邊」的區域
    for (let d = 0; d < maxDepth && queue.length; d++) {
      const next = [];
      for (const i of queue) {
        const x = i % cellPx;
        const y = (i - x) / cellPx;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= cellPx || ny >= cellPx) {
            continue;
          }
          const j = ny * cellPx + nx;
          if (core[j] && depth[j] < 0) {
            depth[j] = d + 1;
            next.push(j);
          }
        }
      }
      queue = next;
    }

    let band = 0;
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        const i = y * cellPx + x;
        if (depth[i] < 0) {
          continue;
        }
        const [r, g, b] = v.px(x, y);
        const L = relativeLuminance(r, g, b);
        if (L >= lo && L <= hi) {
          band++;
        }
      }
    }
    widths.push(band === 0 ? NaN : band / perimeter);
  }
  return widths;
}

// ---------------------------------------------------------------------------
// SP-7.6 檢查 F — 降採樣可讀性（首版警告）
// ---------------------------------------------------------------------------

/** box filter 降採樣；只在本檢查與聯絡表用，不追求品質。 */
export function downsampleCell(sheet, cell, manifest, target) {
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const v = cellView(sheet, cell, geom);
  const out = new Uint8Array(target * target * 4);
  const scale = cellPx / target;
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const sx0 = Math.floor(x * scale);
      const sy0 = Math.floor(y * scale);
      const sx1 = Math.min(cellPx, Math.floor((x + 1) * scale));
      const sy1 = Math.min(cellPx, Math.floor((y + 1) * scale));
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const p = v.px(sx, sy);
          r += p[0] * p[3];
          g += p[1] * p[3];
          b += p[2] * p[3];
          a += p[3];
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

export function checkDownsampleReadability(sheets, manifest) {
  const { cellPx } = manifest.sheet;
  const target = manifest.readability?.targetPx ?? 128;
  const need = manifest.readability?.minBrowContrast ?? 0.25;
  const small = downsampleCell(sheets.directions, 4, manifest, target);
  const B = windowRect(manifest.windows.B, cellPx);
  const s = target / cellPx;
  let lo = 1;
  let hi = 0;
  for (let y = Math.floor(B.y0 * s); y < Math.ceil(B.y1 * s); y++) {
    for (let x = Math.floor(B.x0 * s); x < Math.ceil(B.x1 * s); x++) {
      const o = (y * target + x) * 4;
      if (small[o + 3] < 128) {
        continue;
      }
      const L = relativeLuminance(small[o], small[o + 1], small[o + 2]);
      lo = Math.min(lo, L);
      hi = Math.max(hi, L);
    }
  }
  const contrast = hi - lo;
  return [
    {
      id: 'SP-7.6/眉線對比',
      severity: contrast >= need ? 'warn' : 'warn',
      sheet: 'directions',
      cell: 4,
      message: `降採樣到 ${target}px 後眉窗線性亮度 max−min = ${contrast.toFixed(3)}（暫定門檻 ${need}；首版僅記錄，待第一批交付校準後改硬失敗）`,
      measured: contrast,
      limit: need,
    },
  ];
}

// ---------------------------------------------------------------------------
// SP-7.8 檢查 H — 體積
// ---------------------------------------------------------------------------

export function checkFileSize(sizes, manifest) {
  /** @type {Finding[]} */
  const out = [];
  const budget = manifest.budget;
  let total = 0;
  for (const [name, bytes] of Object.entries(sizes)) {
    total += bytes;
    if (bytes > budget.perSheetBytes) {
      out.push({
        id: 'SP-7.8/單張體積',
        severity: 'error',
        sheet: name,
        message: `${bytes} bytes，超過單張上限 ${budget.perSheetBytes}。SP-7.8 的退路是改用 S = 384（1152×1152）重新匯出`,
        measured: bytes,
        limit: budget.perSheetBytes,
      });
    }
  }
  if (total > budget.totalBytes) {
    out.push({
      id: 'SP-7.8/合計體積',
      severity: 'error',
      message: `兩張合計 ${total} bytes，超過上限 ${budget.totalBytes}`,
      measured: total,
      limit: budget.totalBytes,
    });
  }
  return out;
}
