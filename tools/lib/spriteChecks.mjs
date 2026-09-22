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

/**
 * 把 SP-2.11 的比例視窗換算成格內像素矩形（半開區間 `[x0, x1)`）。
 *
 * ⚠️ **四個邊界都用 `round`，不是 floor/ceil。**
 * 原本 x0/y0 用 floor、x1/y1 用 ceil，把每個視窗向外撐大不到一個像素。後果有兩個：
 *
 * 1. **讓 SP-2.11 宣告「互斥」的視窗重疊。** B 的下緣與 E 的上緣共用 `0.330·S`：
 *    S=512 時是 168.96，floor 給 168、ceil 給 169，於是**第 168 列同時屬於 B 與 E**。
 *    `round` 兩邊都給 169，剛好接合 —— 不重疊也不留縫。
 * 2. **讓 SP-7.2 少檢查一列。** 那條檢查「差異像素必須全部落在 E 之內」是用
 *    `continue` 跳過 E 內的像素實作的，E 被撐大一列就等於多放行一列。
 */
export function windowRect(win, cellPx) {
  return {
    x0: Math.round(win.x0 * cellPx),
    x1: Math.round(win.x1 * cellPx),
    y0: Math.round(win.y0 * cellPx),
    y1: Math.round(win.y1 * cellPx),
  };
}

/**
 * 讀 `intentionally_empty` 宣告。**兩種拼法都收。**
 *
 * SP-7.15、SP-7.1、SP-4 與本檔自己印的錯誤訊息（「未宣告 intentionally_empty」）
 * 用的都是**底線**寫法，而程式只讀駝峰。後果是畫師照規格的字填了 `intentionally_empty`，
 * 一個合規的空格仍被判 FAIL，而訊息叫他去宣告一個他已經宣告了的東西。
 */
function declaredEmpty(manifest) {
  const v = manifest.intentionallyEmpty ?? manifest.intentionally_empty;
  return Array.isArray(v) ? v : [];
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
    const emptyCells = new Set(declaredEmpty(manifest).filter((e) => e.sheet === name).map((e) => e.cell));

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

  /**
   * ⚠️ **虹膜遮罩只看顏色，對大小、位置、形狀毫無約束** —— 所以它可以被偽造。
   *
   * 實測：把某一格換成「瞳孔往反方向偏」的內容，再於眼窗 E 內畫一片容差內的
   * 假睫毛色（630 px），質心 Δx 由 +12 翻成 −29.58，而 **A–H 全綠**。
   * E 正是 SP-7.2 唯一豁免逐像素比對的區域，也正是 SP-3.5 要求逐格變化的區域 ——
   * 兩個豁免疊在一起，這裡就是整套檢查最薄的一塊。
   *
   * 加重情節：SP-7.15 要求人工把診斷表的質心抄進 `irisCentroids.directions` 當日後的
   * 回歸基準。一次受污染的交付不只會過，還會**重新定義「正確」**。
   *
   * 兩道約束：
   * (a) 各格的遮罩大小相對 master frame 必須落在一個比率區間內。門檻放寬是刻意的 ——
   *     SP-3.5 允許向下看的格子被眼瞼遮住部分虹膜，那是**合法**的大小變化。
   *     **下界鬆、上界緊**是有理由的：虹膜是固定大小的圓盤在眼眶內移動，
   *     可見面積只會被眼瞼**遮掉**（變小），沒有任何合法的理由讓它比 master frame **變大**。
   *     所以污染（把非虹膜的同色像素框進來）只會往上跑，而合法變化只會往下跑。
   *     ⚠️ 兩個值仍是**未經真素材校準的**，第一批到貨後必須重新量（見 SP-7.3）。
   * (b) manifest 宣告的其他色值都不得落在虹膜色的容差內 —— 色盤相撞應該是
   *     「規則排除的」而不是「碰巧沒發生」。
   */
  const maskLo = manifest.gaze?.maskRatioMin ?? 0.35;
  const maskHi = manifest.gaze?.maskRatioMax ?? 1.25;
  const irisTol = manifest.colours.irisToleranceRgb;
  const irisRgb = hexToRgb(manifest.colours.iris);
  for (const key of ['lineart', 'skin', 'hair']) {
    const other = manifest.colours[key];
    if (other && colourNear(...hexToRgb(other), irisRgb, irisTol)) {
      out.push({
        id: 'SP-7.3/色盤相撞',
        severity: 'error',
        sheet: 'directions',
        message: `colours.${key} = ${other} 落在虹膜色 ${manifest.colours.iris} 的容差 ±${irisTol} 內 —— 虹膜遮罩會把它一起框進來，視線質心不可信`,
      });
    }
  }
  const baseN = centroids[4].n;
  if (baseN > 0) {
    for (let c = 0; c < CELL_COUNT; c++) {
      if (c === 4 || centroids[c].n === 0) {
        continue;
      }
      const ratio = centroids[c].n / baseN;
      if (ratio < maskLo || ratio > maskHi) {
        out.push({
          id: 'SP-7.3/虹膜遮罩大小',
          severity: 'error',
          sheet: 'directions',
          cell: c,
          message: `虹膜遮罩 ${centroids[c].n} px 是 master frame（${baseN} px）的 ${ratio.toFixed(2)} 倍，落在 [${maskLo}, ${maskHi}] 之外 —— 眼窗內混進了非虹膜的同色像素，或虹膜被畫成不同大小`,
          measured: ratio,
          limit: ratio < maskLo ? maskLo : maskHi,
        });
      }
    }
  }

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
  // ⚠️ **必須限縮到「臉」，不是「整格裡所有膚色的像素」。**
  // 胸上構圖的脖子、鎖骨、耳朵、手都是膚色，原本全部被當成合法的覆蓋區域。
  // 配上 K 被當成整個安全框那個缺陷（已修），一滴畫在裸露鎖骨上的汗滴
  // —— 下巴以下 43 px —— 會同時通過 SP-7.4 與 SP-6.6，而那正是 SP-6.6 要擋的漂移。
  //
  // 兩道限縮：(a) 下界取**凍結的**下巴錨點（SP-2.3 的 chinY），不是猜的；
  // (b) 只保留**與眼窗中心連通**的那一塊 —— 耳朵或手若與臉不連通就不算。
  const chinPx = Math.round((manifest.anchors?.chinY ?? 1) * cellPx);
  const mask = new Uint8Array(cellPx * cellPx);
  for (let y = 0; y < Math.min(cellPx, chinPx); y++) {
    for (let x = 0; x < cellPx; x++) {
      const [r, g, b, a] = v.px(x, y);
      if (a >= 128 && colourNear(r, g, b, skin, tol)) {
        mask[y * cellPx + x] = 1;
      }
    }
  }
  const filled = fillHoles(mask, cellPx);
  return faceComponent(filled, cellPx, manifest);
}

/**
 * 只保留與眼窗中心連通的那一個連通塊。
 *
 * 眼窗中心是**臉**的定義性位置 —— 若連它都不在遮罩裡（例如整張臉被瀏海蓋住），
 * 就退回原遮罩而不是回傳空的：空遮罩會讓 SP-6.6 把**每一個**覆蓋像素都判成越界，
 * 那是把一個量測失敗變成一場素材災難。
 */
function faceComponent(mask, cellPx, manifest) {
  const E = windowRect(manifest.windows.E, cellPx);
  const seedX = Math.round((E.x0 + E.x1) / 2);
  const seedY = Math.round((E.y0 + E.y1) / 2);
  if (!mask[seedY * cellPx + seedX]) {
    return mask;
  }
  const keep = new Uint8Array(cellPx * cellPx);
  const stack = [seedY * cellPx + seedX];
  keep[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % cellPx;
    const y = (i - x) / cellPx;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= cellPx || ny >= cellPx) {
        continue;
      }
      const j = ny * cellPx + nx;
      if (mask[j] && !keep[j]) {
        keep[j] = 1;
        stack.push(j);
      }
    }
  }
  return keep;
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
 * 把 `"EBMK"` 之類的產權宣告展開成一張**允許遮罩**。
 *
 * ⚠️ **原本這裡回傳矩形清單，而 K 被當成「整個安全框」—— 那是錯的。**
 * SP-2.12 逐字寫 K ＝「安全框內、**E ∪ B ∪ M 以外**的全部區域」。
 * 把 K 展成整個安全框的後果是：`'BMK'` 這四個格（warning / critical / resolved / pending）
 * 的產權**悄悄包含了眼窗 E**，而它們是疊在當下那一格 directions 上的 ——
 * 任何畫進 E 的東西都會毀掉 SP-7.3 存在的理由。
 * 實測：在 warning 格的眼窗正中央（瞳孔上）畫一塊 13×13 的不透明線稿，**A–H 全綠**。
 *
 * 用遮罩而不是矩形，是因為「框減去三個視窗」不是矩形，用矩形表達不出來。
 */
function ownershipMask(code, manifest) {
  const { cellPx } = manifest.sheet;
  const mask = new Uint8Array(cellPx * cellPx);
  const E = windowRect(manifest.windows.E, cellPx);
  const B = windowRect(manifest.windows.B, cellPx);
  const M = windowRect(manifest.windows.M, cellPx);

  if (code.includes('K')) {
    // K = 安全框 − (E ∪ B ∪ M)
    const lo = Math.floor(manifest.margins.silhouetteBox[0] * cellPx);
    const hi = Math.ceil(manifest.margins.silhouetteBox[1] * cellPx);
    for (let y = lo; y < hi; y++) {
      for (let x = lo; x < hi; x++) {
        if (!inRect(x, y, E) && !inRect(x, y, B) && !inRect(x, y, M)) {
          mask[y * cellPx + x] = 1;
        }
      }
    }
  }
  const add = (r) => {
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        if (x >= 0 && y >= 0 && x < cellPx && y < cellPx) {
          mask[y * cellPx + x] = 1;
        }
      }
    }
  };
  if (code.includes('E')) {
    add(E);
  }
  if (code.includes('B')) {
    add(B);
  }
  if (code.includes('M')) {
    add(M);
  }
  return mask;
}

export function checkOverlayOwnership(sheets, manifest) {
  /** @type {Finding[]} */
  const out = [];
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const skin = skinMask(sheets.directions, manifest);
  const B = windowRect(manifest.windows.B, cellPx);
  const emptyCells = new Set(declaredEmpty(manifest).filter((e) => e.sheet === 'reactions').map((e) => e.cell));

  for (let c = 0; c < CELL_COUNT; c++) {
    if (emptyCells.has(c)) {
      continue;
    }
    const code = manifest.reactionOwnership[c];
    const allow = ownershipMask(code, manifest);
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
        if (!allow[y * cellPx + x]) {
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
      // ⚠️ **分母必須是修補塊的「輪廓面積」，不是「非零 alpha 的像素數」。**
      // 原本算的是 `fullyOpaque / nonZero` —— 被挖成 alpha=0 的洞根本不在分母裡，
      // 所以洞**永遠壓不低這個比例**。實測：把閉眼格挖成棋盤狀（1201 個像素 alpha 歸零，
      // 也就是一半的眼瞼是透的、底下的瞳孔直接讀出來），這條檢查回報 0 個 finding。
      // 而那正是 SP-4.7 點名的「不足」失敗模式。
      //
      // 反過來，一塊有 20% 像素是 alpha=254 的修補塊（肉眼完全看不出差別）原本會被判失敗。
      // 兩個方向都錯。
      //
      // 修法：先把非零 alpha 的區域補洞（`fillHoles`）得到修補塊的**輪廓**，
      // 再要求輪廓內每一個像素 alpha === 255。
      const footprint = new Uint8Array(cellPx * cellPx);
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          footprint[y * cellPx + x] = v.px(x, y)[3] !== 0 ? 1 : 0;
        }
      }
      const filled = fillHoles(footprint, cellPx);
      let area = 0;
      let opaqueInFootprint = 0;
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          if (!filled[y * cellPx + x]) {
            continue;
          }
          area++;
          if (v.px(x, y)[3] === 255) {
            opaqueInFootprint++;
          }
        }
      }
      const ratio = area === 0 ? 0 : opaqueInFootprint / area;
      const need = manifest.blink?.opaqueFraction ?? 0.9;
      if (ratio < need) {
        const holes = area - nonZero;
        out.push({
          id: 'SP-7.4/眨眼不透明',
          severity: 'error',
          sheet: 'reactions',
          cell: c,
          message: `修補塊輪廓 ${area} px 中只有 ${(ratio * 100).toFixed(1)}% 是 alpha=255（低於 ${(need * 100).toFixed(0)}%）${holes > 0 ? `，其中 ${holes} px 是 alpha=0 的洞` : ''} —— 透的眼瞼會讓底下的瞳孔讀出來`,
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

    // SP-7.4 第三點：composite 在產權視窗之外必須與 master frame 逐位元相同。
    //
    // ⚠️ **原本這段是死碼。** 它寫的是 `const composited = under;` 然後逐欄比較
    // `composited` 與 `under` —— 同一個陣列自己比自己，`drift` 恆為 0，
    // 這條 finding 永遠發不出來。
    //
    // 真正要擋的是**帶顏色酬載的透明像素**：alpha = 0 但 RGB 非零。
    // 直通道（straight alpha）的正確匯出會把它們清成 0；預乘或某些圖層扁平化不會。
    // 那種像素在標準 source-over 下看不見，但一旦有人改用預乘合成、或把 sheet
    // 餵進會忽略 alpha 的工具，它們就會浮出來 —— 而那時已經沒有人記得這裡查過什麼。
    let payload = 0;
    let firstPayload = null;
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        if (allow[y * cellPx + x]) {
          continue;
        }
        const over = v.px(x, y);
        if (over[3] === 0 && (over[0] !== 0 || over[1] !== 0 || over[2] !== 0)) {
          payload++;
          if (!firstPayload) {
            firstPayload = [x, y, over[0], over[1], over[2]];
          }
        }
      }
    }
    if (payload > 0) {
      out.push({
        id: 'SP-7.4/透明像素帶色',
        severity: 'error',
        sheet: 'reactions',
        cell: c,
        message: `產權視窗外有 ${payload} 個 alpha=0 卻帶非零 RGB 的像素（首例 ${firstPayload[0]},${firstPayload[1]} = rgb(${firstPayload[2]},${firstPayload[3]},${firstPayload[4]})）—— 直通道匯出應把它們清成 0`,
        measured: payload,
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

  /** 點值比對：實測必須落在 `expected ± tol`。 */
  const point = (id, label, measured, expected) => {
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

  /**
   * 區間比對：實測必須落在 `[lo, hi]`（單位都是 ·S）。
   *
   * ⚠️ **為什麼頭頂與頭寬是區間而不是點值** —— 這是規格自己的一處矛盾，2026-09-22 解掉的：
   *
   * SP-7.5 的量測法逐字寫「頭寬與頭頂/下巴由**皮膚+髮遮罩**的 bbox」，
   * 而它要比對的 SP-2.3 `crownY = 0.080` 定義的是「**顱骨**最高處，**不含髮量與呆毛**」。
   * 兩者量的是**不同的東西**：bbox 的頂端是頭髮的頂端，顱骨頂在它下面。
   *
   * 後果不是「稍微不準」，是**合規的畫稿會硬失敗**：SP-2.3 明文允許髮／呆毛最高到
   * `0.048·S`，而那會讓 bbox 頂端比宣告的 crownY 高出 `0.032·S`＝ 容差的 8 倍。
   * SP-2.11 自己的註記還寫著這個角色「有 long side locks」。
   *
   * 顱骨頂端在 2D 算繪裡**本來就量不到**（它被頭髮蓋著），所以沒有「量得更準」這條路。
   * 改成區間：bbox 頂端必須落在 `[髮頂上限, 顱骨頂]` 之間 —— 兩個數字**規格都已經凍結**
   * （SP-2.3 的 0.048 與 0.080），不需要發明新的值。頭寬同理，用 SP-2.9 的
   * 「頭寬 0.400」與「剪影最寬處 ≤ 0.840」當上下界。
   *
   * 代價要說清楚：**區間比點值鬆得多**，它擋得住「整顆頭畫錯位置」，擋不住
   * 「頭頂差了 0.01·S」。要恢復點值精度，規格必須凍結一個**量得到**的錨點
   * （例如「髮絲最高點 Y」），那是規格修訂不是程式修正。
   */
  const range = (id, label, measured, lo, hi, why) => {
    if (!Number.isFinite(measured)) {
      out.push({ id, severity: 'error', sheet: 'directions', cell: 4, message: `${label} 量不到` });
      return;
    }
    const m = measured / cellPx;
    if (m < lo - manifest.anchorToleranceS || m > hi + manifest.anchorToleranceS) {
      out.push({
        id,
        severity: 'error',
        sheet: 'directions',
        cell: 4,
        message: `${label} 實測 ${m.toFixed(4)}·S，必須落在 [${lo}, ${hi}]·S（${why}）`,
        measured: m,
        limit: m < lo ? lo : hi,
      });
    }
  };

  point('SP-7.5/臉中軸', '臉中軸 X', silhouetteAxis(directions, manifest), a.faceAxisX);

  const box = headBox(directions, manifest);
  if (!box) {
    out.push({ id: 'SP-7.5/頭部遮罩', severity: 'error', sheet: 'directions', cell: 4, message: '皮膚＋髮色遮罩為空，量不到頭部 bbox' });
  } else {
    // ⚠️ bbox 的 x0/x1/y0/y1 是**含端點的像素索引**，所以範圍是 `x1 - x0 + 1` 而不是 `x1 - x0`。
    // 原本少算一格：對 ±0.004·S（S=512 時 ±2.048 px）的容差來說，整個接受窗被平移一整個像素，
    // 於是真寬 203 px（Δ=−1.8，在容差內）被量成 202 而硬失敗，
    // 真寬 207 px（Δ=+2.2，超出容差）被量成 206 而放行。兩個方向都錯。
    const hairTopMin = a.hairTopMinY ?? 0.048;
    const maxSilWidth = a.maxSilhouetteWidth ?? 0.84;
    range(
      'SP-7.5/頭頂',
      '皮膚＋髮 bbox 頂端 Y',
      box.y0,
      hairTopMin,
      a.crownY,
      `SP-2.3：髮/呆毛最高 ${hairTopMin}·S、顱骨頂 ${a.crownY}·S，而 bbox 量到的是前者`
    );
    range(
      'SP-7.5/頭寬',
      '皮膚＋髮 bbox 寬',
      box.x1 - box.x0 + 1,
      a.headWidth,
      maxSilWidth,
      `SP-2.9：顱骨最寬 ${a.headWidth}·S、剪影最寬 ${maxSilWidth}·S，而 bbox 含側髮`
    );
    // 下巴：SP-7.5 指名要驗，而 headBox 早就算出 y1 卻被丟掉。
    // 它比頭頂乾淨 —— 下巴以下通常不是膚色也不是髮色，bbox 底端就是下巴。
    // ⚠️ 但胸上構圖的脖子與鎖骨也是膚色，所以這裡只能是**警告**：
    // 要把下巴與脖子機械地分開，需要規格凍結一個量得到的分界，目前沒有。
    const chin = (box.y1 + 1) / cellPx;
    if (Math.abs(chin - a.chinY) > manifest.anchorToleranceS) {
      out.push({
        id: 'SP-7.5/下巴',
        severity: 'warn',
        sheet: 'directions',
        cell: 4,
        message: `皮膚＋髮 bbox 底端 ${chin.toFixed(4)}·S，宣告下巴 ${a.chinY}·S。胸上構圖的脖子與鎖骨同為膚色，bbox 底端未必等於下巴 —— 本條僅記錄，不判失敗`,
        measured: chin,
        limit: a.chinY,
      });
    }
  }

  if (centroids && centroids[4] && centroids[4].n > 0) {
    point('SP-7.5/眼線', '眼線 Y', centroids[4].cy, a.eyeLineY);
  }

  // 瞳距與左右瞳心 X（SP-2.5）。左右眼各自的虹膜質心，用眼窗中線切開。
  const eyes = eyeCentroids(directions, 4, manifest);
  if (eyes) {
    point('SP-7.5/左瞳心', '左瞳心 X', eyes.left, a.pupilLeftX);
    point('SP-7.5/右瞳心', '右瞳心 X', eyes.right, a.pupilRightX);
  }

  return out;
}

/**
 * master frame 的左右虹膜質心 X（像素）。以臉中軸把眼窗 E 切成兩半分別取質心。
 *
 * SP-2.5 凍結了瞳距 0.180 與左右瞳心 X 0.410 / 0.590，而先前**一個都沒有機械承接** ——
 * `irisCentroid` 把兩眼混成一個質心，剛好把「兩眼一起偏移」與「瞳距變了」抹平成同一個數字。
 */
export function eyeCentroids(directions, cell, manifest) {
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const E = windowRect(manifest.windows.E, cellPx);
  const iris = hexToRgb(manifest.colours.iris);
  const tol = manifest.colours.irisToleranceRgb;
  const mid = manifest.anchors.faceAxisX * cellPx;
  const v = cellView(directions, cell, geom);
  let lx = 0;
  let ln = 0;
  let rx = 0;
  let rn = 0;
  for (let y = E.y0; y < E.y1; y++) {
    for (let x = E.x0; x < E.x1; x++) {
      const [r, g, b, alpha] = v.px(x, y);
      if (alpha < 128 || !colourNear(r, g, b, iris, tol)) {
        continue;
      }
      if (x < mid) {
        lx += x;
        ln++;
      } else {
        rx += x;
        rn++;
      }
    }
  }
  return ln > 0 && rn > 0 ? { left: lx / ln, right: rx / rn, leftN: ln, rightN: rn } : null;
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

    // ⚠️ **描邊帶取「從外緣連通的那一圈」，不是「3w 以內所有亮度在帶內的像素」。**
    //
    // 原本的寫法把 `depth <= 3w`（S=512 時 25 px）以內、亮度落在
    // [0.18−slack, 0.24+slack] = [0.15, 0.27] 的**任何**像素都算進描邊面積，
    // 而描邊本身只佔最外面約 8 px —— 剩下的 17 px 是角色內部。
    // 內部的帶內色不是罕見情形：實測描邊 #6E7681 與髮色 #9FB4CC 之間的抗鋸齒過渡
    // 在 t=0.25 處是 L=0.2333，正在帶內。任何貼著邊緣的陰影或漸層都會把量到的
    // 寬度拉高，而容差只有 ±1.02 px —— 合規的畫稿會被硬失敗。
    //
    // 改成從 depth 0 的帶內像素往內 flood，只穿過帶內鄰居：得到的就是真正貼著
    // 外緣的那一圈，內部另一塊帶內色即使距離很近也不會被併進來。
    const inBand = (x, y) => {
      const [r, g, b] = v.px(x, y);
      const L = relativeLuminance(r, g, b);
      return L >= lo && L <= hi;
    };
    const ring = new Uint8Array(cellPx * cellPx);
    const stack = [];
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        const i = y * cellPx + x;
        if (depth[i] === 0 && inBand(x, y)) {
          ring[i] = 1;
          stack.push(i);
        }
      }
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % cellPx;
      const y = (i - x) / cellPx;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= cellPx || ny >= cellPx) {
          continue;
        }
        const j = ny * cellPx + nx;
        if (depth[j] >= 0 && !ring[j] && inBand(nx, ny)) {
          ring[j] = 1;
          stack.push(j);
        }
      }
    }
    let band = 0;
    for (let i = 0; i < ring.length; i++) {
      band += ring[i];
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

/**
 * SP-7.6：把 **`composite(directions[4], reactions[2])`** 降採樣到 128px，量眉線對比。
 *
 * ⚠️ **三處修正（2026-09-22）**：
 *
 * 1. **原本從來沒讀過 reactions。** 函式簽章收 `sheets`，body 裡只出現 `sheets.directions` ——
 *    `sheets.reactions` 一次都沒有。也就是說 reactions[2]（critical，整個情緒讀值
 *    最依賴眉形的那一格，也正是 SP-7.6 指名的那一格）可以是空白或垃圾，
 *    量到的對比**逐位元相同**。
 * 2. **`severity: contrast >= need ? 'warn' : 'warn'`** —— 三元判斷算了結果然後丟掉。
 *    它看起來像是已經分辨兩種情形了，於是未來只改門檻值的那次 commit 會讓檢查
 *    永遠停在 warn 而沒有人發現。改成明寫 `'warn'` 並把「什麼時候翻成 error」寫在註解裡。
 * 3. **空眉窗回報 −1。** `lo` 初值 1、`hi` 初值 0，一個像素都沒取到時 `hi − lo = −1`，
 *    讀起來像「對比很差」而不是「量測失敗」。眉窗全透明是真實的交付失誤，
 *    它該是 error 而不是一個看不懂的負數。
 */
export function checkDownsampleReadability(sheets, manifest) {
  const { cellPx } = manifest.sheet;
  const target = manifest.readability?.targetPx ?? 128;
  const need = manifest.readability?.minBrowContrast ?? 0.25;

  // SP-7.6 指名的是合成後的畫面，不是底圖。critical 的眉壓在 reactions[2]。
  const base = cellBufferOf(sheets.directions, 4, manifest);
  const over = cellBufferOf(sheets.reactions, 2, manifest);
  const composed = compositeOver(base, over);
  const small = downsampleBuffer(composed, cellPx, target);

  const B = windowRect(manifest.windows.B, cellPx);

  // 空窗判定要在**全解析度**上做。在降採樣後判會把窗外的不透明像素混進來
  // （每個輸出像素平均 4×4 個來源像素，窗邊一定吃到外面），於是「眉毛整個漏畫」
  // 這種真實的交付失誤驗不出來。
  let fullResSamples = 0;
  for (let y = B.y0; y < B.y1; y++) {
    for (let x = B.x0; x < B.x1; x++) {
      if (composed[(y * cellPx + x) * 4 + 3] >= 128) {
        fullResSamples++;
      }
    }
  }
  if (fullResSamples === 0) {
    return [
      {
        id: 'SP-7.6/眉窗為空',
        severity: 'error',
        sheet: 'directions',
        cell: 4,
        message: '合成後眉窗內一個不透明像素都沒有 —— 這是量測失敗不是對比差。檢查眉毛是否漏畫或畫在窗外',
        measured: 0,
        limit: 1,
      },
    ];
  }

  const s = target / cellPx;
  let lo = Infinity;
  let hi = -Infinity;
  const rowMeans = [];
  const yLo = Math.floor(B.y0 * s);
  const yHi = Math.ceil(B.y1 * s);
  for (let y = yLo; y < yHi; y++) {
    let sum = 0;
    let n = 0;
    for (let x = Math.floor(B.x0 * s); x < Math.ceil(B.x1 * s); x++) {
      const o = (y * target + x) * 4;
      if (small[o + 3] < 128) {
        continue;
      }
      const L = relativeLuminance(small[o], small[o + 1], small[o + 2]);
      lo = Math.min(lo, L);
      hi = Math.max(hi, L);
      sum += L;
      n++;
    }
    rowMeans.push(n ? sum / n : null);
  }
  const contrast = Number.isFinite(hi) && Number.isFinite(lo) ? hi - lo : 0;

  /**
   * 第二個度量：**眉列與其鄰列的落差**。
   *
   * SP-7.6 規定的是眉窗內線性亮度的 `max − min`，而實測顯示**它對眉毛本身不敏感**：
   * 把 `reactions[2]`（critical 的壓眉）整格清空，這個數字**一位數都沒變**（0.606），
   * 因為窗內同時有線稿（L≈0）與膚色（L≈0.61），兩個極值由它們決定，眉毛在不在都一樣。
   *
   * 這裡另外算「最暗的那一列」與「其上下各兩列」的平均落差 —— 眉毛糊成灰霧時它會掉，
   * 而 `max − min` 不會。**不改 SP-7.6 的驗收條件**（那是規格修訂），
   * 只是把這個數字一併報出來，讓第一批素材到貨時的校準有東西可用。
   */
  const valid = rowMeans.map((v, i) => [v, i]).filter(([v]) => v !== null);
  let browDrop = 0;
  if (valid.length >= 3) {
    const [, darkest] = valid.reduce((a, b) => (b[0] < a[0] ? b : a));
    const near = valid.filter(([, i]) => Math.abs(i - darkest) >= 1 && Math.abs(i - darkest) <= 2);
    if (near.length) {
      const around = near.reduce((a, [v]) => a + v, 0) / near.length;
      browDrop = Math.max(0, around - rowMeans[darkest]);
    }
  }

  return [
    {
      id: 'SP-7.6/眉線對比',
      // 首版刻意固定為 warn（SP-7.6 明文）。要翻成 error 的條件是「第一批素材交付後
      // 以實測校準 readability.minBrowContrast」—— 改的是門檻值**與這一行**，兩者要一起改。
      severity: 'warn',
      sheet: 'directions',
      cell: 4,
      message: `composite(directions[4], reactions[2]) 降採樣到 ${target}px：眉窗 max−min = ${contrast.toFixed(3)}（SP-7.6 的暫定門檻 ${need}）；眉列相對鄰列落差 = ${browDrop.toFixed(3)}（第二度量，見程式註解 —— max−min 對眉毛本身不敏感）`,
      measured: contrast,
      limit: need,
    },
  ];
}

/** 取單一格的 RGBA 緩衝區。 */
export function cellBufferOf(sheet, cell, manifest) {
  const { cellPx } = manifest.sheet;
  const v = cellView(sheet, cell, manifest.sheet);
  const out = new Uint8Array(cellPx * cellPx * 4);
  for (let y = 0; y < cellPx; y++) {
    const src = v.offset(0, y);
    out.set(sheet.data.subarray(src, src + cellPx * 4), y * cellPx * 4);
  }
  return out;
}

/** source-over 合成，兩邊同尺寸 RGBA。 */
export function compositeOver(under, over) {
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

/** box filter 降採樣，輸入是方形 RGBA 緩衝區。 */
export function downsampleBuffer(buf, size, target) {
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
