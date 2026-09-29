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

/**
 * 「選填欄位」的預設值 —— **唯一來源**。
 *
 * 這些鍵是後來才加進 manifest 的，舊 manifest 沒有它們仍要能跑，所以各有一個預設。
 * 但預設值一旦同時出現在「驗證器」與「消費端」兩處，就會各自漂移：驗證器拿 A 去比
 * 區間、檢查拿 B 去算，於是驗證通過的 manifest 在檢查裡用的是另一個數字 ——
 * 而這種不一致不會有任何錯誤訊息。
 *
 * 更具體的坑（2026-09-22 複審實測）：`anchors.hairTopMinY` 與 `anchors.crownY` 若只在
 * 「兩鍵都存在時」比大小，就漏掉「省略 hairTopMinY、把 crownY 壓到 0.048 以下」——
 * 那同樣會讓 SP-7.5 的接受區間變空，而訊息寫成對畫稿的要求（`必須落在 [0.048, 0.04]·S`），
 * 沒有一個字指向 manifest。要比的是**生效值**，所以兩邊必須讀同一份預設。
 */
export const MANIFEST_DEFAULTS = Object.freeze({
  anchors: { hairTopMinY: 0.048, maxSilhouetteWidth: 0.84 },
  gaze: { maskRatioMin: 0.35, maskRatioMax: 1.25 },
  // SP-2.14：剪影邊緣必須有 ≥ 0.004·S 的 alpha 漸層（禁 1-bit 硬邊）。
  // 眨眼檢查要把這條**規格強制**的羽化帶從修補塊輪廓裡侵蝕掉，
  // 剩下的才是「本來就該完全不透明」的核心。
  // ⚠️ 不要拿 `margins.featherOuter`（0.04·S = 20px）來侵蝕 —— 那是剪影的留白帶，
  // 差一個數量級，24px 高的眼瞼會被整個侵蝕成空集合而檢查靜默失效。
  blink: { featherS: 0.004 },
  stroke: { luminanceSlack: 0.03 },
});

/** 讀 manifest 的選填值，缺席時退回 MANIFEST_DEFAULTS。驗證器與檢查都走這裡。 */
export function optional(manifest, group, key) {
  const v = manifest?.[group]?.[key];
  return Number.isFinite(v) ? v : MANIFEST_DEFAULTS[group][key];
}

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
  // ⚠️ 聯集而非 `??`。`[] ?? x` 得到 `[]`，而出貨樣板帶著 `"intentionallyEmpty": []`，
  // 所以畫師照規格補上底線鍵時，駝峰的空陣列會無條件勝出、宣告被靜默丟棄。
  // CLI 會先正規化，但 selftest 直接呼叫本函式 —— 兩邊必須是同一套語意，
  // 否則 CLI 綠而函式庫紅（或反過來），而那種分歧不會有任何訊息。
  const a = Array.isArray(manifest.intentionallyEmpty) ? manifest.intentionallyEmpty : [];
  const b = Array.isArray(manifest.intentionally_empty) ? manifest.intentionally_empty : [];
  return [...a, ...b];
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
  const stroke = manifest.stroke;
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

      /**
       * SP-2.14：剪影邊緣必須有 ≥ 0.004·S 的 alpha 漸層，**禁止 1-bit alpha 硬邊**
       * （硬邊在降取樣時會鋸齒）。
       *
       * ⚠️ **這條規格先前在 `tools/` 裡完全沒有機械承接**，而那不只是「少一條檢查」——
       * 它是好幾個缺陷的共同根源：合成基準 `syntheticSheet.mjs` 畫的就是 1-bit 硬邊
       * （實測整格只有 2 個 alpha 值、**零個**半透明像素），於是**整個閘門是對著一張
       * 規格自己會退的圖校準的**。2026-09-22 的複審因此抓到兩條門檻在合規（抗鋸齒）
       * 素材上算術達不到：眨眼的 90% 不透明比例、以及描邊的環狀 flood。
       *
       * 量測法：`半透明像素數 ÷ 剪影周長`，也就是**平均過渡寬度**（px）。
       * 實測校準（合成基準，周長 1330）：
       *
       *   羽化 h    半透明px   比值
       *     0          0      0.00   ← 1-bit，SP-2.14 明文禁止
       *     1       1330      1.00   ← 1px 過渡，不足
       *     2       3990      3.00   ← 合規
       *     4       9296      6.99
       *
       * 關係是 `比值 = 2h − 1`，分離度很乾淨。分兩級：
       *  - **零個半透明像素 → 硬失敗。** 這是無歧義的 1-bit，不需要任何門檻。
       *  - **過渡寬度 < 2.0 → warn。** 那個門檻**未經真素材校準**，
       *    而猜一個數字放進硬失敗，第一次交付就會紅在一個沒有根據的值上（SP-7.6 的前例）。
       */
      let semiCount = 0;
      let rampMoment = 0;
      let perimeter = 0;
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          const a = v.px(x, y)[3];
          if (a > 0 && a < 255) {
            semiCount++;
            // 一階矩：2·min(α, 1−α)。對寬 h 的線性斜坡，沿法線的積分恰為 h/2，
            // 與斜坡的相位、取樣落點無關 —— 「數半透明像素」則不然：
            // 守恆斜坡（相位修正後）h=1 與 h=2 的半透明像素**一樣多**（各 2 顆/邊），
            // 計數法對 h<2 完全失去鑑別力，還把合規下限 h=2 誤 warn 成 1.5。
            rampMoment += (2 * Math.min(a, 255 - a)) / 255;
          }
          if (a >= 128) {
            const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            if (nb.some(([p, q]) => p < 0 || q < 0 || p >= cellPx || q >= cellPx || v.px(p, q)[3] < 128)) {
              perimeter++;
            }
          }
        }
      }
      if (perimeter > 0) {
        // ⚠️ **量到的是比值，門檻要換算回同一個單位再比。**
        // 第一版寫成 `ratio < 2`，把規格的像素數 2 直接當門檻用 ——
        // 但上表推導的是 `比值 = 2h − 1`，比值 2 對應的是 h = **1.5px**：
        // 實際的執法下限比規格低 25%，一張 1.5px 羽化的圖從整套檢查拿到**零輸出**。
        // 變數名叫 rampPx 也是共犯（聽起來是像素，裝的是比值）。
        // 現在先把比值換回過渡寬度 h，再對規格自己的 0.004·S 比。
        // implied h = 2 × (矩總和 / 周長)。校準（兩種斜坡實測）：
        // 舊相位 h=1/2/4 → 1.00/2.00/4.00；守恆斜坡 h=1/2/4 → 1.00/2.01/4.02。
        const impliedH = (2 * rampMoment) / perimeter;
        // 0.004·S 在 S=512 是 2.048 —— 但羽化只能畫整數像素，2px 就是最接近的
        // 可畫值，整個 repo（含電池 B 列「SP-2.14 下限」）也都以 2px 為下限。
        // 直接拿 2.048 比會把合規下限自己 warn 掉，故向下取整到可繪製像素。
        const minH = Math.floor(0.004 * cellPx);
        // 小塊（reactions 的 overlay）的角落讓比值略低於大周長極限的 2h−1：
        // 實測 h=2 時五個小塊的 impliedH 是 1.983–1.992（偏差 ≤ 0.017px）。
        // 給 0.05px 的量測容差 —— 足以蓋掉角落效應，吞不掉 h=1（impliedH ≈ 1.0）。
        const measureTol = 0.05;
        if (semiCount === 0) {
          out.push({
            id: 'SP-2.14/1-bit硬邊',
            severity: 'error',
            sheet: name,
            cell: c,
            message: `剪影邊緣完全沒有半透明像素（${perimeter} px 的周長上一個都沒有）—— 1-bit alpha 硬邊，SP-2.14 明文禁止，降取樣時會鋸齒`,
            measured: 0,
            limit: 1,
          });
        } else if (impliedH < minH - measureTol) {
          out.push({
            id: 'SP-2.14/漸層過窄',
            severity: 'warn',
            sheet: name,
            cell: c,
            message: `剪影邊緣的平均過渡寬度約 ${impliedH.toFixed(2)} px（一階矩法），SP-2.14 要求 ≥ 0.004·S = ${minH.toFixed(2)}px。此門檻**未經真素材校準**，首版僅記錄`,
            measured: impliedH,
            limit: minH,
          });
        }
      }

      // 黑邊 matte：半透明且 RGB 純黑 —— 對**黑底**合成過的指紋。
      //
      // ⚠️ **這一條抓不到預乘 alpha，而先前的註解宣稱它抓得到。**
      // 實測（抗鋸齒邊緣 + 預乘）：11,970 個半透明像素，RGB 純黑的是 **0 個**，
      // 本條一筆都沒發。原因是算術的：`round(c * a / 255) === 0` 要求 `c * a < 127.5`，
      // 而膚色、髮色這些淺色在任何可見的 alpha 下都不滿足。
      // 所以**預乘的抗鋸齒交付先前完全偵測不到**，而 SP-7.4 移除一條檢查時
      // 寫的理由正是「預乘由本條以正確極性接住」—— 那句話是錯的。
      //
      // ⚠️ **判準是「RGB 隨 alpha 縮放」，不是「RGB ≤ alpha」。**
      // 我第一版用 `max(R,G,B) ≤ alpha`（預乘的代數性質），在合成基準上分得很乾淨
      // （直通 0.0% vs 預乘 100.0%）—— 但它**不通用**：任何比 alpha 暗的顏色都滿足它。
      // 實測：把 fixture 的預設改成 SP-2.14 合規的抗鋸齒之後，線稿色（近乎全黑）的
      // 覆蓋格讀到 **100%** 而它是直通的，四格誤殺。
      //
      // 正確的判準來自 SP-2.15：它強制「半透明／透明像素的 RGB 必須等於最近不透明
      // 像素的 RGB」。**那條規定同時就是直通 alpha 的可驗證後果** ——
      // 合規素材的殘差是 0，而對底色合成過的素材有系統性殘差。實測中位數：
      //
      //   直通（兩張表）        0
      //   黑 matte directions   64
      //   白 matte directions   72
      //   黑 matte reactions     8   ← 近黑素材配黑底本來就難分，這一格抓不到
      //
      // 門檻取 `colourToleranceRgb`（12）：直通的 0 與 directions 的 64/72 之間有很寬的餘裕。
      let matte = 0;
      let opaque = 0;
      let semi = 0;
      const residuals = [];
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          const [r, g, b, a] = v.px(x, y);
          if (a > 0) {
            opaque += a === 255 ? 1 : 0;
          }
          if (a > 0 && a < 255) {
            semi++;
            if (r === 0 && g === 0 && b === 0) {
              matte++;
            }
            // 最近的不透明鄰居（5×5 內）的 RGB —— SP-2.15 保證直通時兩者相等。
            let nb = null;
            for (let dy = -2; dy <= 2 && !nb; dy++) {
              for (let dx = -2; dx <= 2; dx++) {
                const px = x + dx;
                const py = y + dy;
                if (px < 0 || py < 0 || px >= cellPx || py >= cellPx) {
                  continue;
                }
                const q = v.px(px, py);
                if (q[3] >= 250) {
                  nb = q;
                  break;
                }
              }
            }
            if (nb) {
              residuals.push(Math.max(Math.abs(r - nb[0]), Math.abs(g - nb[1]), Math.abs(b - nb[2])));
            }
          }
        }
      }
      // 樣本太少時不判（1-bit alpha 的圖沒有半透明像素 —— 那是 SP-2.14 的事，不是本條的）。
      residuals.sort((p, q) => p - q);
      const residMed = residuals.length ? residuals[residuals.length >> 1] : 0;
      // ⚠️ **不要借用 `stroke.colourToleranceRgb`。** 那個值是「描邊色的容差」，
      // 驗證器允許 0–255，而它與「matte 殘差多大才算異常」沒有任何關係 ——
      // 有人為了描邊而把它調鬆，matte 偵測就跟著失效：實測調到 40 時
      // 白 matte 由 18 格掉到 11 格，調到 80 時黑白兩種都只剩 2 格。
      // 一個檢查的靈敏度不該被另一個檢查的參數左右。
      // 用自己的門檻：直通 alpha 的殘差在 SP-2.15 之下應為 **0**，
      // 而 matte 實測 64（黑）／72（白），所以 12 有很寬的餘裕。
      const MATTE_RESIDUAL_MAX = 12;
      if (residuals.length >= 200 && residMed > MATTE_RESIDUAL_MAX) {
        out.push({
          id: 'SP-7.1/預乘alpha',
          severity: 'error',
          sheet: name,
          cell: c,
          message: `半透明像素的 RGB 與最近不透明像素的 RGB 差距中位數 ${residMed}（${residuals.length} 個樣本）—— SP-2.15 強制兩者相等，有系統性差距代表匯出時對底色合成過（matte）。SP-2.13 要求非預乘（straight）alpha`,
          measured: residMed,
          limit: MATTE_RESIDUAL_MAX,
        });
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


/**
 * 眼窗 E 內虹膜遮罩的連通元件（4-連通），依面積由大到小排序。
 * 每塊回 `{ area, aspect }`，`aspect` 是 bbox 的長邊 ÷ 短邊。
 *
 * ⚠️ **這是 SP-7.3 防偽造的主力，遮罩大小比率做不到這件事。**
 * 虹膜是兩塊近圓的盤（實測乾淨素材：2 塊、各 454 px、長寬比 1.0）；
 * 而「在眼窗邊緣塗一條同色像素把質心拉回來」的污染是第三塊長條
 * （實測 183 px、長寬比 9.4）。兩者在**面積比率**上分不開，在**形狀**上分得很開。
 */
function irisComponents(directions, cell, manifest) {
  const geom = manifest.sheet;
  const { cellPx } = geom;
  const E = windowRect(manifest.windows.E, cellPx);
  const iris = hexToRgb(manifest.colours.iris);
  const tol = manifest.colours.irisToleranceRgb;
  const v = cellView(directions, cell, geom);
  const W = E.x1 - E.x0;
  const H = E.y1 - E.y0;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = v.px(E.x0 + x, E.y0 + y);
      if (a >= 128 && colourNear(r, g, b, iris, tol)) {
        mask[y * W + x] = 1;
      }
    }
  }
  const seen = new Uint8Array(W * H);
  const comps = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) {
      continue;
    }
    const stack = [i];
    seen[i] = 1;
    let area = 0;
    let x0 = W;
    let x1 = -1;
    let y0 = H;
    let y1 = -1;
    while (stack.length) {
      const j = stack.pop();
      area++;
      const jx = j % W;
      const jy = (j / W) | 0;
      if (jx < x0) { x0 = jx; }
      if (jx > x1) { x1 = jx; }
      if (jy < y0) { y0 = jy; }
      if (jy > y1) { y1 = jy; }
      const nb = [];
      if (jx > 0) { nb.push(j - 1); }
      if (jx < W - 1) { nb.push(j + 1); }
      if (jy > 0) { nb.push(j - W); }
      if (jy < H - 1) { nb.push(j + W); }
      for (const k of nb) {
        if (mask[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    comps.push({ area, aspect: Math.max(bw, bh) / Math.min(bw, bh) });
  }
  comps.sort((a, b) => b.area - a.area);
  return comps;
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
   * (a) 各格的遮罩大小相對 master frame 的比率 —— **warn，不是硬失敗**。
   *     ⚠️ 這裡原本寫「下界鬆、上界緊是有理由的：虹膜可見面積只會被眼瞼遮掉（變小），
   *     沒有任何合法的理由讓它比 master frame 變大」。**那個前提是錯的** ——
   *     它只在 master frame 的虹膜完全沒被遮住時成立，而那不是動畫的畫法。
   *     master 的虹膜本來就被上眼瞼壓著，往下看時它從眼瞼下滑出來、可見面積**合法變大**
   *     （複審實測整個下排 1.35 對舊上限 1.25，全部硬失敗）。
   *     而且這個量同時被防偽造用著，兩件事耦合、一個數字做不到（詳見下方 (c)），
   *     所以降為 warn。兩個門檻本來就註明未經真素材校準。
   * (b) manifest 宣告的其他色值都不得落在虹膜色的容差內 —— 色盤相撞應該是
   *     「規則排除的」而不是「碰巧沒發生」。
   * (c) **形狀**才是防偽造的主力：兩隻眼睛之外不得有顯著的虹膜色區塊，
   *     且每隻眼睛的 bbox 長寬比 ≤ 3。見下方 SP-7.3/眼窗雜塊 與 SP-7.3/虹膜不成形。
   */
  const maskLo = optional(manifest, 'gaze', 'maskRatioMin');
  const maskHi = optional(manifest, 'gaze', 'maskRatioMax');
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
          severity: 'warn',
          sheet: 'directions',
          cell: c,
          message: `虹膜遮罩 ${centroids[c].n} px 是 master frame（${baseN} px）的 ${ratio.toFixed(2)} 倍，落在 [${maskLo}, ${maskHi}] 之外（這兩個門檻**未經真素材校準**，首版僅記錄）`,
          measured: ratio,
          limit: ratio < maskLo ? maskLo : maskHi,
        });
      }

      /**
       * **形狀才是防偽造的主力，面積比率不是。**
       *
       * 2026-09-22 複審 + 本機重現：把格 3 換成「看右」的內容，再於眼窗最左端塗
       * 8 欄（183 px）容差內的虹膜色，質心 Δx 由 +12.00 被拉到 −7.99、遮罩比率 1.202
       * —— **A–H 全部綠燈**，一格畫反方向的交付就這樣通過了。
       * 而 SP-7.15 接著要人把診斷表的質心抄進 `irisCentroids` 當回歸基準，
       * 於是受污染的交付**重新定義了「正確」**。
       *
       * ⚠️ 規格原本宣稱「要翻 sign 需要 ≥36% 膨脹，而檢查在 ≥25% 觸發，中間有餘裕」。
       * **那個數字是錯的**：本機量到 20.2% 就夠（複審在他們的 fixture 上是 10.8%），
       * 而 1.202 < maskRatioMax 1.25，攻擊窗正好開在兩者之間。
       *
       * 更關鍵的是這兩件事**耦合**，面積比率一個數字做不到兩件事：
       *   要擋住攻擊 → 上限必須 < 1.20
       *   往下看時虹膜從眼瞼下滑出來、面積合法變大 → 實測 1.35
       * 調低就誤紅整個下排，調高就放大攻擊窗。所以比率降為 warn，改用形狀。
       *
       * 虹膜是兩塊近圓的盤（乾淨素材實測：2 塊、各 454 px、長寬比 1.0），
       * 而污染是眼窗邊緣的一條長條（183 px、長寬比 9.4）。
       * 兩者在面積上分不開，在形狀上分得很開 —— 而且形狀對「合法的面積變化」免疫。
       */
      const comps = irisComponents(directions, c, manifest);
      const eyes = comps.slice(0, 2);
      const strays = comps.slice(2);
      const strayPx = strays.reduce((a, k) => a + k.area, 0);
      const smallestEye = eyes.length === 2 ? eyes[1].area : 0;
      if (strayPx > 0 && smallestEye > 0 && strayPx / smallestEye > 0.1) {
        out.push({
          id: 'SP-7.3/眼窗雜塊',
          severity: 'error',
          sheet: 'directions',
          cell: c,
          message: `眼窗 E 內除了兩隻眼睛之外還有 ${strays.length} 塊虹膜色區域共 ${strayPx} px（較小的那隻眼睛 ${smallestEye} px）—— 眼窗內混進了非虹膜的同色像素`,
          measured: strayPx / smallestEye,
          limit: 0.1,
        });
      }
      for (const eye of eyes) {
        if (eye.aspect > 3) {
          out.push({
            id: 'SP-7.3/虹膜不成形',
            severity: 'error',
            sheet: 'directions',
            cell: c,
            message: `眼窗 E 內有一塊 ${eye.area} px 的虹膜色區域長寬比 ${eye.aspect.toFixed(1)}（上限 3）—— 虹膜應該是近圓的盤，長條代表混進了非虹膜的同色像素`,
            measured: eye.aspect,
            limit: 3,
          });
        }
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
export function skinMask(directions, manifest, flag) {
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
  // ⚠️ **按 SP-2.14 強制的羽化寬度膨脹回去。**
  // 上面用 `alpha >= 128` 收集膚色像素，而 SP-2.14 強制剪影邊緣要有 ≥ 0.004·S 的
  // alpha 漸層 —— 2px 羽化的最外圈是 alpha 64，會被那個門檻排除，
  // 於是遮罩比真實的皮膚**內縮**，而 SP-6.6 的上限是 **0 個**越界像素：
  // 畫在臉上、但貼近臉部邊緣的覆蓋層會被硬失敗，而它完全合規。
  // 複審實測真實畫稿上內縮 2–3.3 px。
  //
  // SP-2.15 保證羽化帶帶著最近不透明像素的真實顏色，所以那一圈**本來就是臉**。
  // 膨脹的量取 SP-2.14 的下限，不是猜的值。
  const feather = Math.max(1, Math.round(optional(manifest, 'blink', 'featherS') * cellPx));
  const filled = fillHoles(dilate(mask, cellPx, feather), cellPx);
  return faceComponent(filled, cellPx, manifest, flag);
}

/**
 * 只保留與眼窗中心連通的那一個連通塊。
 *
 * 眼窗中心是**臉**的定義性位置 —— 若連它都不在遮罩裡（例如整張臉被瀏海蓋住），
 * 就退回原遮罩而不是回傳空的：空遮罩會讓 SP-6.6 把**每一個**覆蓋像素都判成越界，
 * 那是把一個量測失敗變成一場素材災難。
 *
 * ⚠️ 但那個退路**不能是靜默的**。退回原遮罩等於把 SP-6.6 從「臉部皮膚」放寬成
 * 「整格所有膚色像素」—— 脖子、鎖齊、耳朵、手全部變成合法的覆蓋區，
 * 而那正是 2026-09-22 才剛修掉的缺陷。`degraded` 讓呼叫端把它報成 warn。
 */
function faceComponent(mask, cellPx, manifest, flag) {
  const E = windowRect(manifest.windows.E, cellPx);
  const seedX = Math.round((E.x0 + E.x1) / 2);
  const seedY = Math.round((E.y0 + E.y1) / 2);
  if (!mask[seedY * cellPx + seedX]) {
    if (flag) {
      flag.degraded = true;
    }
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
/**
 * 二值遮罩的形態學侵蝕，`n` 次 4-連通。
 *
 * 用途是把「羽化帶」從一塊修補塊的輪廓裡去掉，留下**本來就該完全不透明**的核心。
 * SP-2.14 強制邊緣要有 ≥ 0.004·S 的 alpha 漸層，所以輪廓最外那一圈像素依規格
 * 就不可能是 alpha=255 —— 把它們算進「不透明比例」等於要求畫師違反 SP-2.14。
 */
function erode(mask, cellPx, n) {
  let cur = mask;
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(cellPx * cellPx);
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        if (!cur[y * cellPx + x]) {
          continue;
        }
        // 邊界視為外部：貼著格邊的修補塊不該因為「看不到外面」就被當成內部。
        if (x === 0 || y === 0 || x === cellPx - 1 || y === cellPx - 1) {
          continue;
        }
        if (
          cur[(y - 1) * cellPx + x] &&
          cur[(y + 1) * cellPx + x] &&
          cur[y * cellPx + (x - 1)] &&
          cur[y * cellPx + (x + 1)]
        ) {
          next[y * cellPx + x] = 1;
        }
      }
    }
    cur = next;
  }
  return cur;
}

/** 二值遮罩的形態學膨脹，`n` 次 4-連通。與 erode 成對，用來做開運算。 */
function dilate(mask, cellPx, n) {
  let cur = mask;
  for (let i = 0; i < n; i++) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        if (cur[y * cellPx + x]) {
          continue;
        }
        if (
          (y > 0 && cur[(y - 1) * cellPx + x]) ||
          (y < cellPx - 1 && cur[(y + 1) * cellPx + x]) ||
          (x > 0 && cur[y * cellPx + (x - 1)]) ||
          (x < cellPx - 1 && cur[y * cellPx + (x + 1)])
        ) {
          next[y * cellPx + x] = 1;
        }
      }
    }
    cur = next;
  }
  return cur;
}

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
  const skinFlag = {};
  const skin = skinMask(sheets.directions, manifest, skinFlag);
  if (skinFlag.degraded) {
    // 退回「整格所有膚色像素」——脖子、鎖骨、耳朵、手都變成合法覆蓋區，
    // 也就是 2026-09-22 才剛修掉的那個缺陷。不能讓它靜默發生。
    out.push({
      id: 'SP-6.6/臉部遮罩降級',
      severity: 'warn',
      sheet: 'directions',
      cell: 4,
      message: '眼窗中心不是膚色（整張臉被遮住？），臉部皮膚遮罩退回「整格所有膚色像素」—— SP-6.6 本輪以放寬的定義執行，脖子與鎖骨不會被擋下',
    });
  }
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
    let semiCount = 0;
    let perim = 0;
    const softOutAllow = [];
    const softOutSkin = [];
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
        if (a < 255) {
          semiCount++;
        }
        if (a >= 128) {
          const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
          if (nb.some(([px2, py2]) => px2 < 0 || py2 < 0 || px2 >= cellPx || py2 >= cellPx || v.px(px2, py2)[3] < 128)) {
            perim++;
          }
        }
        const i = y * cellPx + x;
        // ⚠️ **兩級判定，不再是「任何非零 alpha 出界即違規」。**
        // SP-2.14 對 overlay 一樣強制 ≥ 0.004·S 的羽化（syntheticSheet 也刻意
        // 這樣畫），而羽化帶必然溢出遮罩邊界 —— 4px 羽化（電池 C 列，合規）
        // 先前在這兩條 limit:0 上硬紅（溢 13/22 px）。規格要求羽化、規格不設
        // 羽化上限、檢查要求 0 個出界像素：三者不可同時成立，先前輸的是素材。
        // 完全不透明的出界仍是硬違規（那是畫上去的內容，不是羽化）；
        // 半透明的出界先收著，迴圈後對「按該格量到的羽化寬度膨脹過的遮罩」再判。
        if (!allow[i]) {
          if (a >= 250) {
            outsideWindows++;
            if (!firstOut) {
              firstOut = [x, y];
            }
          } else {
            softOutAllow.push(i);
          }
        }
        if (!skin[i]) {
          if (a >= 250) {
            outsideSkin++;
          } else {
            softOutSkin.push(i);
          }
        }
      }
    }
    if (softOutAllow.length || softOutSkin.length) {
      // 該格自己的羽化寬度（SP-2.14 的比值法：implied h = (semi/perim + 1) / 2），
      // 夾在 [下限, 3×下限]。**夾上限是自我廢除防護** —— 「整片半透明」正是這類
      // 檢查要抓的缺陷之一，它會抬高量到的羽化；眨眼檢查踩過同一個坑
      // （侵蝕深度取自缺陷會影響的量，缺陷越重檢查越鬆）。
      const minH = Math.max(1, Math.floor(0.004 * cellPx));
      const impliedH = perim > 0 ? (semiCount / perim + 1) / 2 : minH;
      const featherPx = Math.min(3 * minH, Math.max(minH, Math.ceil(impliedH)));
      if (softOutAllow.length) {
        const allowFeather = dilate(allow, cellPx, featherPx);
        for (const i of softOutAllow) {
          if (!allowFeather[i]) {
            outsideWindows++;
            if (!firstOut) {
              firstOut = [i % cellPx, Math.floor(i / cellPx)];
            }
          }
        }
      }
      if (softOutSkin.length) {
        const skinFeather = dilate(skin, cellPx, featherPx);
        for (const i of softOutSkin) {
          if (!skinFeather[i]) {
            outsideSkin++;
          }
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

      // ⚠️ **不要數 alpha === 255 的比例。** 那條門檻（0.9）在抗鋸齒素材上算術達不到：
      // 用本 repo 自己的眼瞼幾何（格 6 兩個 rx32/ry12 橢圓、格 7 rx32/ry7）做 4×
      // supersample 而**不加**任何額外羽化，實測 89.12% 與 84.27%，都低於 0.9；
      // 抗鋸齒做得越好越糟（16× SS 是 86.93% / 80.95%）。再加上 SP-2.14 強制的
      // ≥ 0.004·S alpha 漸層之後任何尺寸都不過，而格 7（SP-4.8 的半閉眼）本來就細，
      // 在眼窗 E 容得下的全部尺寸掃描中一律落在 79–90% ——
      // **不存在同時滿足 SP-4.8 與那條門檻的交付**，而工具照 SP-7.12 沒有旁路。
      //
      // 基線之所以曾經全綠，是因為 syntheticSheet 的 `ellipse()` 用布林判定寫 a=255，
      // 也就是 SP-2.14 明文禁止的 1-bit 硬邊 —— 閘門是對著一張規格自己會退的圖校準的。
      //
      // 改成量**這條檢查的訊息本來就在講的那件事**：透的眼瞼會讓底下的瞳孔讀出來。
      // 作法是把羽化帶侵蝕掉得到「本來就該完全不透明」的核心，在核心裡合成
      // reactions[c] over directions[4]，然後找還讀得出來的虹膜色像素。
      // 這同時對格 6（全閉，虹膜應完全消失）與格 7（半閉，可見的虹膜在眼瞼**之外**、
      // 不在核心裡）都成立，而且量的與規格描述的是同一個量。
      // ⚠️ **侵蝕深度要量出來，不能用宣告的下限。**
      // `blink.featherS`（0.004·S = 2px）是 SP-2.14 的**下限**，而 4px 羽化同樣合規 ——
      // 固定侵蝕 2px 對 4px 羽化永遠不夠，核心裡會留下羽化像素、把平均 alpha 拉低。
      // 實測（門檻 98%）：固定 2px 時，2px 羽化讀 96.9%/94.5%、4px 羽化讀 81.4%/71.3%，
      // **全部誤紅，而它們都是合規素材**。（這條門檻我上一次「修好」時是對著
      // 1-bit 素材校準的 —— 那時核心全是 255，所以看不出來。）
      //
      // 改成量這一塊自己的過渡寬度（半透明像素數 ÷ 周長，與 SP-2.14 檢查同一個統計量），
      // 再按它侵蝕。下限仍取宣告值，避免 1-bit 修補塊算出 0。
      let patchSemi = 0;
      let patchPerim = 0;
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          const a = v.px(x, y)[3];
          if (a > 0 && a < 255) {
            patchSemi++;
          }
          if (a >= 128) {
            const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            if (nb.some(([p, q]) => p < 0 || q < 0 || p >= cellPx || q >= cellPx || v.px(p, q)[3] < 128)) {
              patchPerim++;
            }
          }
        }
      }
      const declared = Math.max(1, Math.round(optional(manifest, 'blink', 'featherS') * cellPx));
      const measured = patchPerim > 0 ? Math.ceil(patchSemi / patchPerim) : 0;
      const want = Math.max(declared, measured) + 1;

      /**
       * ⚠️ **這個侵蝕深度會讓檢查自我廢除，而且缺陷越嚴重越容易發生。**
       *
       * `measured = patchSemi / patchPerim` 取自**半透明像素的數量**，
       * 而「整片半透明的眼瞼」正是本檢查要抓的缺陷之一 —— 它讓每一個像素都變成
       * 半透明，於是 `measured` 暴增、侵蝕深度暴增、核心被侵蝕成空。
       * 先前沒有 `coreArea === 0` 的守衛，所以空核心 = 兩條檢查都不發 finding。
       *
       * 實測：把格 6 與格 7 的眼瞼整片改成 alpha 130，**只有格 6 報告**——
       * 格 7 比較薄（SP-4.8 的半閉眼），核心是 0 px，零 finding。
       * 而 selftest 的兩個眨眼變異體都只動格 6，所以沒有任何東西釘住這件事。
       * 合規的 6px 羽化也會把格 7 的核心清空。
       *
       * 兩層修正：
       *  1. **逐步退讓**：從 `want` 往下試到 1，取第一個「核心非空」的深度。
       *     那保證量得到東西，而且用的是仍然可行的最深侵蝕。
       *  2. **連深度 1 都空 → 出聲，不要靜默**。那種修補塊細到量不出核心，
       *     可能是合法的細線閉眼、也可能是畫壞了，但兩者都不該是「靜默通過」。
       */
      let feather = 0;
      let core = null;
      for (let d = want; d >= 1; d--) {
        const cand = erode(filled, cellPx, d);
        let any = 0;
        for (let i = 0; i < cand.length && !any; i++) {
          any = cand[i];
        }
        if (any) {
          feather = d;
          core = cand;
          break;
        }
      }
      if (!core) {
        out.push({
          id: 'SP-7.4/眨眼核心量不到',
          severity: 'warn',
          sheet: 'reactions',
          cell: c,
          message: `修補塊侵蝕 1px 之後核心即為空（輪廓 ${nonZero} px）—— 太細，量不到「本來就該完全不透明」的核心。細線閉眼是合法的畫法，但本輪無法驗證它的不透明度`,
          measured: 0,
          limit: 1,
        });
        continue;
      }
      const master = cellView(sheets.directions, 4, geom); // master frame（與本檔 :277 / :503 同一個常數）
      const iris = hexToRgb(manifest.colours.iris);
      const irisTol = manifest.colours.irisToleranceRgb;
      let coreArea = 0;
      let showThrough = 0;
      let firstShow = null;
      let translucent = 0;
      let coreAlphaSum = 0;
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          if (!core[y * cellPx + x]) {
            continue;
          }
          coreArea++;
          const o = v.px(x, y);
          coreAlphaSum += o[3];
          if (o[3] !== 255) {
            translucent++;
          }
          // source-over：核心內的眼瞼若完全不透明，結果就是眼瞼自己的顏色。
          const a = o[3] / 255;
          const u = master.px(x, y);
          const r = Math.round(o[0] * a + u[0] * (1 - a));
          const g = Math.round(o[1] * a + u[1] * (1 - a));
          const b = Math.round(o[2] * a + u[2] * (1 - a));
          if (colourNear(r, g, b, iris, irisTol)) {
            showThrough++;
            if (!firstShow) {
              firstShow = [x, y];
            }
          }
        }
      }
      // 均勻半透明的眼瞼合成後是「偏眼瞼色的混色」，讀不出虹膜色，所以上面那條抓不到它 ——
      // 但 alpha=200 的眼瞼等於眼睛透出來 21%，正是 SP-4.7 的「不足」。
      // 核心的**平均 alpha** 抓得到，而且門檻有很寬的餘裕：alpha=200 的整片是 0.784，
      // 正常畫稿侵蝕掉羽化帶之後接近 1.00，門檻 0.98 落在中間。
      // （對比先前那個「輪廓內 90% 像素恰為 255」—— 它的餘裕是負的，合規畫稿落在 79–90%。）
      const meanAlpha = coreArea === 0 ? 0 : coreAlphaSum / (coreArea * 255);
      if (coreArea > 0 && meanAlpha < 0.98) {
        out.push({
          id: 'SP-7.4/眨眼半透明',
          severity: 'error',
          sheet: 'reactions',
          cell: c,
          message: `眼瞼核心 ${coreArea} px 的平均 alpha 只有 ${(meanAlpha * 255).toFixed(0)}/255（${(meanAlpha * 100).toFixed(1)}%，需 ≥ 98%）—— 整片半透明的眼瞼會讓底下的眼睛透出來`,
          measured: meanAlpha,
          limit: 0.98,
        });
      }
      if (showThrough > 0) {
        out.push({
          id: 'SP-7.4/眨眼不透明',
          severity: 'error',
          sheet: 'reactions',
          cell: c,
          message:
            `眼瞼核心（輪廓內縮 ${feather}px 羽化帶後 ${coreArea} px）合成到 master 之後，` +
            `仍有 ${showThrough} px 讀得出虹膜色（首例 ${firstShow[0]},${firstShow[1]}）` +
            `${translucent > 0 ? `；核心內另有 ${translucent} px 不是 alpha=255` : ''} —— 透的眼瞼會讓底下的瞳孔讀出來`,
          measured: showThrough,
          limit: 0,
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

    // SP-7.4 第三點（composite 在產權視窗外須與 master frame 逐位元相同）**不需要**
    // 獨立檢查：它已由上面的 SP-7.4/視窗產權（limit 0）隱含 —— alpha = 0 的像素在
    // source-over 下是 no-op，視窗外沒有不透明像素就等於沒有漂移。
    //
    // ⚠️ 這裡一度有一條 `SP-7.4/透明像素帶色`，擋「alpha = 0 但 RGB 非零」的像素，
    // 理由寫的是「直通道匯出會把它們清成 0，預乘不會」。**那句話是反的，而且那條
    // 檢查與規格正面衝突**，2026-09-22 複審實測：
    //
    //  1. 極性反了。預乘是 RGB × alpha，alpha = 0 時強制 RGB = 0 —— 預乘正是會清掉
    //     這些像素的那一方；alpha = 0 而帶色是**直通道的指紋**，也就是 SP-2.13 要求的。
    //     真正預乘的交付在那條檢查下反而靜默通過。
    //  2. 它擋掉 SP-2.15 強制要求的東西。SP-2.15 逐字寫「凡距任何不透明像素 ≤ 8px 的
    //     alpha = 0 像素，其 RGB **必須**填為最近的不透明像素之 RGB」（否則縮放時沿
    //     剪影邊緣會出現暗環或白環）。拿本檔的合成 sheet 照 SP-2.15 做一次色彩擴張，
    //     九格裡三格由綠變紅。常見流程也會中：PIL `fill + putalpha(0)` → 4096/4096，
    //     柔邊筆刷 / 圖層遮罩（Photoshop、Krita 的標準做法）→ 840/840。
    //  3. 它是冗餘的。預乘匯出的真正指紋是「半透明且 RGB 純黑」，而那個**極性正確**的
    //     檢查在本檔 SP-7.1/黑邊matte 已經跑了六百多行。
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
  // ⚠️ **只取下巴以上。** 胸上構圖的脖子、鎖骨、裸露的肩膀都是膚色，
  // 而整格的膚＋髮 bbox 寬度量到的是**肩寬**不是頭寬 —— 實測在裸肩的構圖上
  // 量到 0.5742·S（真實頭寬 0.3984），而且**把頭加寬 30px 之後那個數字完全不變**：
  // 肩膀撐滿了 bbox，頭再怎麼變都影響不到它。
  //
  // 分界用 `chinY` 而不是 `shoulderY`：下巴以上是頭（顱骨＋頭髮），以下是脖子與身體。
  // `shoulderY`（0.85）遠低於肩膀實際開始的位置（緊接在下巴 0.60 之下），擋不到東西。
  // `skinMask` 用的也是 `chinY`，兩處保持同一個分界。
  const chinLimit = manifest.anchors.chinY * cellPx;
  for (let y = 0; y < chinLimit; y++) {
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
      // 像素 i 覆蓋 [i, i+1)，中心在 i+0.5；跨度 lo..hi 覆蓋 [lo, hi+1)，
      // 中心是 (lo + hi + 1) / 2。用 (lo + hi) / 2 會有固定 −0.5 px 偏差 ——
      // 對 ±0.004·S（S=512 時 ±2.048 px）的容差來說是 24% 的預算，白白送掉。
      rows.push((lo + hi + 1) / 2);
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
  // ⚠️ **只從這裡讀容差，不要在下面再讀一次 `manifest.anchorToleranceS`。**
  // :1438 與 :1481 一度直接讀原值，而這一行有 `?? 0.004` 的預設 ——
  // 兩種讀法在「欄位缺席」時的行為不同：這裡拿到 0.004，那兩處拿到 `undefined`，
  // 而 `m < lo - undefined` 是 `m < NaN` = **false**，於是
  // `SP-7.5/頭頂` 與 `SP-7.5/頭寬` 在該紅的輸入上**靜默不發**（實測確認）。
  // CLI 有 validateManifest 擋著，但 selftest 直接呼叫本函式，繞過它。
  // 這正是本 repo 記錄過的第一類缺陷：「刪欄位比放寬門檻更強大」。
  const tolS = manifest.anchorToleranceS ?? 0.004;
  const tol = tolS * cellPx;
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
    if (m < lo - tolS || m > hi + tolS) {
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
    const hairTopMin = optional(manifest, 'anchors', 'hairTopMinY');
    const maxSilWidth = optional(manifest, 'anchors', 'maxSilhouetteWidth');
    range(
      'SP-7.5/頭頂',
      '皮膚＋髮 bbox 頂端 Y',
      box.y0,
      hairTopMin,
      a.crownY,
      `SP-2.3：髮/呆毛最高 ${hairTopMin}·S、顱骨頂 ${a.crownY}·S，而 bbox 量到的是前者`
    );
    // ⚠️ **上界 0.840 是 SP-2.9 的「剪影最寬處」（含斗篷與肩膀），當頭寬上界太鬆。**
    // headBox 自 2026-09-22 起以 chinY 為界、只量頭部，所以上界應該跟著收 ——
    // 但「側髮可以比顱骨寬多少」規格沒有凍結，所以那個數字**只能是猜的**。
    // 實測記錄：把頭加寬 30px（0.0586·S，遠超過 ±0.004·S 的容差）之後量到
    // 0.4570·S，落在舊的 [0.400, 0.840] 內而完全不紅。
    // 折衷：**下界維持硬失敗**（頭比顱骨還窄是不可能的，這一側量得準）；
    // 上界降為 warn 並以 `headWidth × 1.25` 為門檻，訊息寫明它未經校準。
    // 要恢復雙側精度，規格必須凍結一個**量得到**的橫向錨點（例如「側髮最外緣 X」）——
    // 那是規格修訂不是程式修正，已記進 ROADMAP。
    const headW = box ? (box.x1 - box.x0 + 1) / cellPx : NaN;
    if (Number.isFinite(headW) && headW < a.headWidth - tolS) {
      out.push({
        id: 'SP-7.5/頭寬',
        severity: 'error',
        sheet: 'directions',
        cell: 4,
        message: `頭部 bbox 寬 ${headW.toFixed(4)}·S 比宣告的頭寬 ${a.headWidth}·S 還窄 —— 顱骨不可能比宣告的窄（量測已以 chinY 為界，不含肩膀）`,
        measured: headW,
        limit: a.headWidth,
      });
    } else if (Number.isFinite(headW) && headW > a.headWidth * 1.1) {
      out.push({
        id: 'SP-7.5/頭寬偏寬',
        severity: 'warn',
        sheet: 'directions',
        cell: 4,
        message: `頭部 bbox 寬 ${headW.toFixed(4)}·S 是宣告頭寬 ${a.headWidth}·S 的 ${(headW / a.headWidth).toFixed(2)} 倍。側髮會讓它合法變寬，但 1.1 這個門檻**未經真素材校準**，首版僅記錄（門檻取 1.25 時，加寬 30px 的頭連 warn 都不會發）`,
        measured: headW / a.headWidth,
        limit: 1.1,
      });
    }
    /**
     * ⚠️ **下巴沒有機械檢查，而且那是刻意的 —— 它在算繪圖上量不到。**
     *
     * 這裡一度用「皮膚＋髮 bbox 的底端」當下巴。兩個版本都不成立：
     *
     *  1. bbox **不裁切**時（最初的版本）：胸上構圖的脖子、鎖骨與及胸長髮都在裡面，
     *     底端是髮尾或胸口而不是下巴。實測每一張合規畫稿都以 **83 倍容差**發出警告，
     *     而訊息還寫著「宣告下巴 0.6·S」—— 一個 100% 觸發率、83 倍數字的警告
     *     與壞掉的檢查無法區分，它會是第一個被消音的東西。
     *  2. bbox **裁切在 chinY** 時（2026-09-22 為了修頭寬而加的）：底端在**數學上**
     *     不可能超過 chinY。實測下巴畫到 0.62 / 0.70 / 0.80·S 全部量成 0.6016、零 finding
     *     ——「下巴畫太低」變成結構上偵測不到，只剩畫太高會響。
     *
     * 兩者是同一個循環：**我們用 chinY 裁切來隔離頭部，再想從裁切後的結果量出 chinY。**
     * 而不裁切就量不到頭 —— 臉部皮膚無縫接進脖子，沒有任何像素級的分界。
     * 要恢復這條檢查，規格必須凍結一個**量得到**的下緣錨點（例如「下顎線稿最低點 Y」），
     * 那是規格修訂不是程式修正。在那之前下巴的驗收屬於 SP-V.1 的人眼複核。
     *
     * 留一個結構上不可能往關鍵方向觸發的檢查，比沒有更糟：它會讓人以為驗過了。
     */
  }

  /**
   * ⚠️ **眼線與瞳心：可見虹膜的質心不是瞳心，而差多少取決於畫風。**
   *
   * 這是與上面頭頂／頭寬同一類的問題（檢查與規格量的不是同一個東西），
   * 2026-09-22 複審實測：
   *
   * - SP-2.4 把眼線定義為「左右**瞳心**連線」Y = 0.380。而動畫畫法裡上眼瞼一定蓋住
   *   虹膜頂端，於是可見虹膜的質心**系統性地低於**瞳心。把瞳心畫在正好 0.380、
   *   上眼瞼切掉約 30% 虹膜高（對動畫來說還算保守）的畫稿，實測質心 Y = 0.4001·S，
   *   偏離 0.0201·S＝**容差的 5.0 倍**，八個變體無一例外。
   * - 側髮蓋住一隻眼（§7 的角色有 long side locks，SP-2.11 的註記也寫著眼窗 E 刻意
   *   往頭部輪廓外延伸 0.020·S 就是為了那裡）時，剩下的虹膜碎片質心會被當成瞳心：
   *   瞳心畫在正好 0.410 的畫稿實測 0.4407·S，偏離 **7.6 倍容差**。
   *   要滿足檢查，畫師得把一個已經正確的瞳孔往旁邊挪 15px。
   *
   * 遮擋深度是畫風選擇不是合規屬性，所以**沒有固定偏移可以校正**，
   * 也就沒有「量得更準」這條路。改成量三件量得到的事：
   *  (a) 兩眼是否等高 —— 這是真的缺陷（一眼畫高了），而且左右受到的遮擋相同，
   *      差值對遮擋深度免疫。這條維持硬失敗。
   *  (b) 絕對的眼線 Y 與瞳心 X —— 降為 warn，訊息寫明量的是可見虹膜質心而非瞳心。
   *  (c) 左右可見虹膜面積明顯不對稱 → 代表一眼被遮，此時 (b) 的數字不可信，
   *      改報「量不準」而不是報「位置錯了」。
   *
   * 真正的瞳孔位置驗收在 SP-V.1 的人眼盲測 —— 那才是這件事的權威，本條是輔助。
   */
  const eyes = eyeCentroids(directions, 4, manifest);
  const soft = (id, label, measured, want, why) => {
    if (!Number.isFinite(measured)) {
      return;
    }
    const m = measured / cellPx;
    if (Math.abs(m - want) > tolS) {
      out.push({
        id,
        severity: 'warn',
        sheet: 'directions',
        cell: 4,
        message: `${label} 實測 ${m.toFixed(4)}·S，宣告 ${want}·S（${why}）—— 本條僅記錄，不判失敗`,
        measured: m,
        limit: want,
      });
    }
  };

  if (!Number.isFinite(eyes.left) || !Number.isFinite(eyes.right)) {
    // 先前這裡回 null 然後整段被靜默略過 —— 一隻眼完全量不到虹膜是真的異常，要說出來。
    out.push({
      id: 'SP-7.5/瞳心量不到',
      severity: 'error',
      sheet: 'directions',
      cell: 4,
      message: `眼窗 E 內左眼 ${eyes.leftN} px、右眼 ${eyes.rightN} px 命中虹膜色，有一側為 0 —— 量不到瞳心`,
      measured: Math.min(eyes.leftN, eyes.rightN),
      limit: 1,
    });
  } else {
    // (a) 兩眼等高：硬失敗。左右受到的眼瞼遮擋相同，所以差值對遮擋深度免疫。
    const dy = Math.abs(eyes.leftY - eyes.rightY) / cellPx;
    if (dy > tolS) {
      out.push({
        id: 'SP-7.5/兩眼不等高',
        severity: 'error',
        sheet: 'directions',
        cell: 4,
        message: `左右虹膜質心 Y 相差 ${dy.toFixed(4)}·S（左 ${(eyes.leftY / cellPx).toFixed(4)}、右 ${(eyes.rightY / cellPx).toFixed(4)}），超出容差 ${tolS.toFixed(4)}·S`,
        measured: dy,
        limit: tolS,
      });
    }

    // (c) 左右可見面積明顯不對稱 → 一眼被遮，(b) 的數字不可信。
    const lo = Math.min(eyes.leftN, eyes.rightN);
    const hi = Math.max(eyes.leftN, eyes.rightN);
    // ⚠️ 門檻 0.9 不是 0.6。`checkAnchors` **只跑 master frame**（中性正視），
    // 兩隻眼睛在那一格本來就該對稱 —— 任何超過 10% 的面積差就代表有東西遮著，
    // 而遮住之後質心會移動、瞳距與對稱性都不可信。
    //
    // 0.6 留下一條誤紅帶：實測用側髮從外側蓋住左眼，可見比 0.80 與 0.65
    // 都**硬失敗 SP-7.5/瞳距**（瞳孔幾何完全正確），而 0.55 以下反而被這個 warn
    // 正確接手。也就是 15–40% 的遮擋剛好漏在縫裡 —— 而那是側髮最常見的幅度。
    const occluded = lo / hi < 0.9;
    if (occluded) {
      out.push({
        id: 'SP-7.5/單眼被遮',
        severity: 'warn',
        sheet: 'directions',
        cell: 4,
        message: `左右可見虹膜面積 ${eyes.leftN} / ${eyes.rightN} px（比 ${(lo / hi).toFixed(2)}），一側被遮住 —— 瞳心與眼線的絕對值本輪量不準，已略過`,
        measured: lo / hi,
        limit: 0.6,
      });
    } else {
      // (b) **瞳距與中點對稱：硬失敗。**
      //
      // 這兩個量對眼瞼遮擋免疫 —— 上眼瞼同時切兩隻眼、而且完全不動 x，
      // 所以「兩個質心的水平距離」與「它們的中點」不受遮擋深度影響，
      // 卻照樣抓得到瞳孔移位：左瞳右移 8px 會讓瞳距縮 0.0156·S＝容差的 3.9 倍。
      // 絕對的單眼 X 做不到這件事（它同時吃遮擋與移位，分不開），所以絕對值留給 warn。
      const span = (eyes.right - eyes.left) / cellPx;
      const wantSpan = a.pupilRightX - a.pupilLeftX;
      if (Math.abs(span - wantSpan) > tolS) {
        out.push({
          id: 'SP-7.5/瞳距',
          severity: 'error',
          sheet: 'directions',
          cell: 4,
          message: `瞳距實測 ${span.toFixed(4)}·S，宣告 ${wantSpan.toFixed(4)}·S（SP-2.5 的 ${a.pupilRightX} − ${a.pupilLeftX}），超出容差 ${tolS.toFixed(4)}·S`,
          measured: span,
          limit: wantSpan,
        });
      }
      const mid2 = (eyes.left + eyes.right) / 2 / cellPx;
      if (Math.abs(mid2 - a.faceAxisX) > tolS) {
        out.push({
          id: 'SP-7.5/瞳心不對稱',
          severity: 'error',
          sheet: 'directions',
          cell: 4,
          message: `左右瞳心中點 ${mid2.toFixed(4)}·S 偏離臉中軸 ${a.faceAxisX}·S，超出容差 ${tolS.toFixed(4)}·S —— 兩眼一起偏移或單眼移位`,
          measured: mid2,
          limit: a.faceAxisX,
        });
      }

      // 絕對值：warn。遮擋深度是畫風選擇，這幾個數字量的是可見虹膜質心不是瞳心。
      soft('SP-7.5/眼線', '眼線 Y（可見虹膜質心）', (eyes.leftY + eyes.rightY) / 2, a.eyeLineY, '上眼瞼會把質心壓到瞳心之下，偏移量取決於畫風');
      soft('SP-7.5/左瞳心', '左瞳心 X（可見虹膜質心）', eyes.left, a.pupilLeftX, '遮擋會移動質心');
      soft('SP-7.5/右瞳心', '右瞳心 X（可見虹膜質心）', eyes.right, a.pupilRightX, '遮擋會移動質心');
    }
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
  let ly = 0;
  let ln = 0;
  let rx = 0;
  let ry = 0;
  let rn = 0;
  for (let y = E.y0; y < E.y1; y++) {
    for (let x = E.x0; x < E.x1; x++) {
      const [r, g, b, alpha] = v.px(x, y);
      if (alpha < 128 || !colourNear(r, g, b, iris, tol)) {
        continue;
      }
      // 像素中心是 (x + 0.5, y + 0.5)；用索引平均會讓每個質心固定偏 −0.5 px。
      // 瞳距與兩眼高差是**差值**，偏差會抵銷；但絕對值（眼線 Y、單眼 X）不會。
      if (x < mid) {
        lx += x + 0.5;
        ly += y + 0.5;
        ln++;
      } else {
        rx += x + 0.5;
        ry += y + 0.5;
        rn++;
      }
    }
  }
  return ln > 0 && rn > 0
    ? { left: lx / ln, right: rx / rn, leftY: ly / ln, rightY: ry / rn, leftN: ln, rightN: rn }
    : { left: NaN, right: NaN, leftY: NaN, rightY: NaN, leftN: ln, rightN: rn };
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
      // ⚠️ 訊息不可以只講亮度帶。樣本是「亮度帶 ∩ 接近描邊參考色」的交集，
      // 先前的訊息只提亮度帶 —— 當像素明明在帶內、是被顏色閘殺掉時
      // （宣告了 stroke.colour 而畫的墨色偏了），畫師會拿著一句
      // 對著檔案看顯然不成立的話排查九次。護欄講假話是它被關掉的最短路徑。
      const colourHint = stroke.colour
        ? `且接近宣告色 ${stroke.colour}（±${stroke.colourToleranceRgb ?? 12}/通道）`
        : '且接近自素材取樣的描邊色';
      out.push({
        id: 'SP-7.7/描邊',
        severity: 'error',
        sheet: 'directions',
        cell: c,
        message: `量不到描邊 —— 剪影邊緣沒有「落在亮度帶內${colourHint}」的連續像素。兩個篩哪個殺的都有可能，先檢查墨色亮度，再檢查它與宣告色的距離`,
      });
      continue;
    }
    if (Math.abs(w - target) > tol) {
      out.push({
        id: 'SP-7.7/描邊寬度',
        severity: 'error',
        sheet: 'directions',
        cell: c,
        message: `描邊寬度 ${(w / cellPx).toFixed(4)}·S，宣告 ${stroke.width}·S ±${stroke.tolerance}·S`,
        measured: w / cellPx,
        limit: stroke.width,
      });
    }
  }

  // SP-6.5「描邊在 18 格中的寬度必須一致」的跨格統計。
  // 每格獨立的 |w − target| ≤ tol 只隱含 spread ≤ 2·tol —— 兩格可以一格貼上限、
  // 一格貼下限（差 0.032·S）而全綠，那正是「一致」要禁止的樣子。
  // reactions 不在這裡量：SP-6.6 禁止 overlay 覆寫描邊（⊆ 臉部皮膚遮罩），
  // 所以 overlay 上不存在也不准存在可量的描邊，「18 格」的另外 9 格由
  // SP-7.4/視窗產權 與 SP-6.6 承接。
  // 門檻取 tol（與電池 run() 的 spread 判定同值）；**未經真素材校準，首版僅 warn**。
  const finite = widths.filter(Number.isFinite);
  if (finite.length >= 2) {
    const spread = Math.max(...finite) - Math.min(...finite);
    if (spread > tol) {
      out.push({
        id: 'SP-7.7/描邊不一致',
        severity: 'warn',
        sheet: 'directions',
        cell: widths.indexOf(Math.max(...finite)),
        message: `九格描邊寬度極差 ${(spread / cellPx).toFixed(4)}·S（${spread.toFixed(2)}px），SP-6.5 要求一致；門檻 ${stroke.tolerance}·S 未經真素材校準，首版僅記錄`,
        measured: spread / cellPx,
        limit: stroke.tolerance,
      });
    }
  }
  return out;
}

/**
 * sRGB → 線性的 256 項查表。**存在的理由是成本**：
 * 描邊量測要對 9 × 512 × 512 = 2.36 M 個像素判亮度，直接呼 `relativeLuminance`
 * 等於 7 M 次 `Math.pow`。查表把同一個公式（與 `relativeLuminance` 逐字相同）
 * 預先算完，整個檢查由秒級掉到百毫秒級。
 */
const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  SRGB_TO_LINEAR[i] = s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function fastLuminance(r, g, b) {
  return 0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b];
}

/** 可分離 box blur（跑 N 次逼近高斯）。只用來算局部法線方向，不求品質。 */
function boxBlurMask(src, W, H, radius, passes) {
  const a = Float32Array.from(src);
  const b = new Float32Array(W * H);
  const clampX = (x) => (x < 0 ? 0 : x >= W ? W - 1 : x);
  const clampY = (y) => (y < 0 ? 0 : y >= H ? H - 1 : y);
  const n = 2 * radius + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let acc = 0;
      for (let x = -radius; x <= radius; x++) {
        acc += a[row + clampX(x)];
      }
      for (let x = 0; x < W; x++) {
        b[row + x] = acc / n;
        acc -= a[row + clampX(x - radius)];
        acc += a[row + clampX(x + radius + 1)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) {
        acc += b[clampY(y) * W + x];
      }
      for (let y = 0; y < H; y++) {
        a[y * W + x] = acc / n;
        acc -= b[clampY(y - radius) * W + x];
        acc += b[clampY(y + radius + 1) * W + x];
      }
    }
  }
  return a;
}

/**
 * 眾數定位 + 峰內平均。
 *
 * **為什麼不是中位數或平均**：髮束的橋接區、附屬物根部的凹角會生出一條長尾
 * （實測最長可到真值的兩倍），平均會被它整條拉走；中位數雖然抗長尾，但當
 * 「合法游程」本身分裂成兩簇（相位在 floor(D) 與 D 之間擺動）時，中位數會選一邊。
 * 眾數負責**定位**主簇（長尾再長也不影響 argmax），再在主簇內取平均**補回次像素** ——
 * 單取眾數的 bin 中心會把解析度砍回 `binPx`。
 */
function modeThenLocalMean(samples, hiLimit, tune) {
  if (samples.length === 0) {
    return NaN;
  }
  const bins = Math.ceil(hiLimit / tune.binPx) + 1;
  const hist = new Float64Array(bins);
  for (const s of samples) {
    const k = Math.round(s / tune.binPx);
    if (k >= 0 && k < bins) {
      hist[k]++;
    }
  }
  const half = Math.max(1, Math.round(tune.smoothPx / tune.binPx));
  let best = 0;
  let bestVal = -1;
  for (let i = 0; i < bins; i++) {
    let acc = 0;
    for (let d = -half; d <= half; d++) {
      const j = i + d;
      if (j >= 0 && j < bins) {
        acc += hist[j] * (1 - Math.abs(d) / (half + 1));
      }
    }
    if (acc > bestVal) {
      bestVal = acc;
      best = i;
    }
  }
  let centre = best * tune.binPx;
  for (let it = 0; it < tune.shiftIters; it++) {
    let sum = 0;
    let count = 0;
    for (const v of samples) {
      if (Math.abs(v - centre) <= tune.shiftPx) {
        sum += v;
        count++;
      }
    }
    if (count === 0) {
      break;
    }
    const next = sum / count;
    if (Math.abs(next - centre) < 1e-4) {
      centre = next;
      break;
    }
    centre = next;
  }
  return centre;
}

/** 本估計器的全部可調項。改動請跑 `node tools/stroke-battery.mjs`。 */
export const STROKE_MEASURE_TUNING = {
  blurRadius: 2,
  blurPasses: 2,
  minGrad: 0.012,
  // 只用「斜」法線。見 measureStrokeWidths 的第 3 點。
  minObliquity: 0.35,
  // 斜法線不足時的退路門檻（低於此數就放棄斜度篩，接受量化）。
  minObliqueSamples: 80,
  stepPx: 0.1,
  outReachPx: 10,
  minFillRunPx: 2,
  binPx: 0.1,
  smoothPx: 0.8,
  shiftPx: 0.9,
  shiftIters: 4,
  matteMinSamples: 40,
  matteAgreeFraction: 0.6,
  matteToleranceRgb: 24,
};

/**
 * 量每格的描邊寬度：**逐邊界像素、沿局部法線的覆蓋率弦長積分，取直方圖眾數**。
 *
 * 取代的是「描邊環面積 ÷ 剪影周長」。那個做法在共用電池（`tools/stroke-battery.mjs`）
 * 上判對 15/20，五個錯的全是「合規卻誤紅」：四根漸細髮束（9.708）、黑白 matte 匯出
 * （NaN，「量不到描邊」）、窗內邊緣 9.0px（9.426）。本實作在同一支電池上 20/20。
 * 面積÷周長的三個根本問題：
 *
 * - **周長正規化會被附屬物稀釋。** 髮束、呆毛、緞帶這些細長物件的描邊環面積
 *   相對它貢獻的周長偏高（環在末端還要繞一圈帽），四根就把 8.192 推到 9.708。
 *   本實作**不做任何周長正規化** —— 每條法線各自量一個獨立的寬度，附屬物只是
 *   多幾條樣本，不再汙染同一個商。
 * - **它是全域商，沒有分布可看。** 一個環狀 flood 灌錯地方（合法的同亮度衣物、
 *   填色溢出把種子擋掉）就整格壞掉，而且壞成 NaN 或一個沒有來歷的數字。
 *   逐法線量出的是**一個分布**，錯的那些是長尾，眾數定位不理它們。
 * - **NaN 是「找不到種子」而不是「沒有描邊」。** matte 匯出把抗鋸齒環變成
 *   描邊與背景的混色，環狀 flood 的種子（最外圈）因此落在亮度帶外，九格全 NaN。
 *
 * 五個關鍵設計：
 *
 * 1. **游程的起點必須是完全不透明的像素。** SP-2.14 強制的 alpha 漸層讓最外圈是
 *    混色；SP-2.13 被違反時（matte 匯出）那圈更是描邊與背景色的線性混合。
 *    所以「這裡是描邊嗎」只在 `alpha ≥ 250` 的像素上用宣告色判定，
 *    半透明的環另外處理（見第 4 點）。
 * 2. **法線取自模糊過的 alpha ≥ 128 遮罩的梯度**，不是四鄰差分：原始遮罩的邊界是
 *    階梯，逐像素梯度只會給八個方向，量到的是 `w / cos θ`。
 * 3. **只採斜法線（|min(gx,gy)| / |g| ≥ 0.35，約 20°–70°）。** 這條是精度的關鍵：
 *    軸向邊界上，描邊帶的像素中心距離全是整數，真實寬度 D 只能被夾在
 *    `[floor(D), floor(D)+1)` —— 那一格資訊**根本不在圖裡**，量到的一定是 floor(D)。
 *    斜法線與晶格不可通約，相位連續變動，弦長平均後才回到 D。
 *    ⚠️ 這一點原記「實測殘差 −0.07 ~ −0.03」—— 那是對著 1-bit fixture 量的
 *    （2026-09-29 複審查出實際是 −0.68 上下，差 20 倍；根因一半在 fixture 的
 *    斜坡相位錯，一半在內緣硬分類，兩者都已修）。當前數字見檔尾校準段。
 *    斜樣本少於 `minObliqueSamples` 時退回不篩（量化好過 NaN）。
 * 4. **兩端都是次像素，靠覆蓋率積分而不是找交界。** 沿法線以 `stepPx` 積
 *    `覆蓋率 du`：不透明描邊算 1，屬於描邊的半透明環算 `alpha / 255`，
 *    內緣（描邊↔填色）的不透明混色像素算解混出的描邊成分 t。
 *    ⚠️ 內緣那一項是 2026-09-29 補的 —— 在那之前這一點的敘述是假的：
 *    只有外緣是次像素，內緣是 colourNear 硬門檻，每條游程系統性少半個像素，
 *    而且少多少隨填色顏色變（解析地面真值：偏差 −0.31 ~ −0.34、隨填色擺 0.08px）。
 *    抗鋸齒環因此**按它實際遮住多少貢獻寬度**，不是整格算或整格不算 ——
 *    2px 與 4px 漸層量到的值相差 0.013px（電池 B 與 C）。
 * 5. **matte 偵測而不是投降。** 半透明像素若其直通道色是描邊色，
 *    則 `observed = ref·f + bg·(1−f)`；反解 `bg` 並看全格是否一致。
 *    一致就用它反合成（L/M 兩列因此從 NaN 變成 7.554）；不一致代表半透明處
 *    根本不是描邊（填色溢出就是這樣 —— 那圈是填色），此時直接用宣告色判定。
 *    這兩件事共用同一個測試，不需要旗標，也不需要問「這張圖有沒有被 matte」。
 *
 * 拒絕器（每條法線各自成立或不成立，不影響其他法線）：
 * - 梯度太弱（`minGrad`）→ 法線方向不可信。
 * - 往內 `0.8·target` 內找不到不透明描邊像素 → 這條法線下沒有描邊。
 * - 游程內側不是連續 `minFillRunPx` 的不透明非描邊像素 → **細附屬物與橋接的拒絕器**。
 *   髮束之間的縫、髮束與顱骨的凹角會被兩側描邊灌滿，從那裡往內走是「描邊→描邊→透明」，
 *   游程可長達真值兩倍。要求內側踩到真正的填色，就把這些接合處剔掉。
 * - 游程落在 `[0.3, 2.2] × target` 之外 → 極端值不進直方圖（眾數本來就不理它們，
 *   但不讓它們進 bin 可以省掉直方圖的長尾）。
 *
 * **沒有任何為了湊電池而加的常數**：兩端的半像素約定是 0（`edgeConvention` 不存在），
 * 量到的就是覆蓋率積分本身。
 *
 * **校準現況（2026-09-29，fixture 斜坡相位修正 + 內緣解混之後）**：
 * - 電池 20/20（`node tools/stroke-battery.mjs`，有退出碼、在閘門與 CI 裡）。
 * - 解析地面真值（8× supersample disc，含內緣真實混色）：
 *   D ∈ [6, 10] 偏差 **+0.03 ~ +0.08**，填色相依擺動 0.017px。
 * - ⚠️ 合成 fixture（內緣硬過渡，解混無素材可解）殘餘偏差約 **−0.2**，
 *   電池 R 列（7.4px）量 7.170、餘裕只剩 **0.002px** —— 貼線過。
 *   這 −0.2 的來源尚未定位（與內緣無關），第一批真素材到貨時要重量。
 *
 * 成本：9 格 512×512 實測 96–103 ms（同機器上 fixture 自己建一張 sheet 要 ~2 s）。
 */
/**
 * 從 master 格（cell 4）自取描邊參考色：剪影邊界向內 1.2·target 的環帶內，
 * 完全不透明且亮度落在描邊帶（含 slack）的像素，4-bit 量化桶取眾數桶的實際平均。
 * 環帶把「同亮度但在角色內部」的色塊（衣物主體）排除在取樣之外；
 * 貼著描邊的窄衣物帶仍可能混入，但描邊繞整圈周長，眾數穩定屬於描邊
 * （電池 J/K 列實測）。樣本太少（< 200）回 null，由呼叫端退回參考色。
 */
function sampleStrokeColour(directions, manifest, lumLo, lumHi) {
  const geom = manifest.sheet;
  const P = geom.cellPx;
  const v = cellView(directions, 4, geom);
  const N = P * P;
  const mask = new Uint8Array(N);
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) {
      mask[y * P + x] = v.px(x, y)[3] >= 128 ? 1 : 0;
    }
  }
  const depth = Math.ceil(manifest.stroke.width * P * 1.2);
  const core = erode(mask, P, depth);
  const hist = new Map();
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) {
      const i = y * P + x;
      if (!mask[i] || core[i]) {
        continue;
      }
      const [r, g, b, a] = v.px(x, y);
      if (a < 250) {
        continue;
      }
      const L = fastLuminance(r, g, b);
      if (L < lumLo || L > lumHi) {
        continue;
      }
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = hist.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      hist.set(key, bin);
    }
  }
  let best = null;
  for (const bin of hist.values()) {
    if (!best || bin.n > best.n) {
      best = bin;
    }
  }
  if (!best || best.n < 200) {
    return null;
  }
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

export function measureStrokeWidths(directions, manifest) {
  const tune = STROKE_MEASURE_TUNING;
  const geom = manifest.sheet;
  const P = geom.cellPx;
  const stroke = manifest.stroke;
  const slack = optional(manifest, 'stroke', 'luminanceSlack');
  const lumLo = stroke.luminanceMin - slack;
  const lumHi = stroke.luminanceMax + slack;
  const target = stroke.width * P;
  // 亮度帶是第一道篩、參考色是第二道 —— 兩道都要，缺一不可：
  // 只看亮度，合法的同亮度衣物（#7c7c7c，L = 0.2016）會被當成描邊；
  // 只看顏色，SP-6.4 規範的是亮度帶而 #6E7681 只是參考色。
  //
  // ⚠️ **未宣告 stroke.colour 時，參考色從素材自己取樣，不用硬編的 #6E7681。**
  // 2026-09-28 複審實測：SP-6.4 是亮度帶規範（0.18–0.24），#7c7c7c（L=0.2016）
  // 完全合規，但它離參考色 ΔRGB = 14/6/5 > 預設容差 12 —— 於是一張合規的圖
  // 九格全 NaN 硬紅，訊息還說「亮度帶內沒有像素」（像素明明在帶內，是被
  // 顏色閘殺的）。更糟的是 #6E7681 自己 L = 0.1786，**低於**帶的下限 0.18，
  // 只靠 luminanceSlack 才活著 —— 唯一被乾淨接受的色系反而不滿足規範本身。
  // 自取樣讓「畫師實際畫的描邊色」成為第二道篩的基準；宣告值仍然優先。
  const sampled = stroke.colour ? null : sampleStrokeColour(directions, manifest, lumLo, lumHi);
  const ref = stroke.colour ? hexToRgb(stroke.colour) : (sampled ?? hexToRgb('#6E7681'));
  const colourTol = stroke.colourToleranceRgb ?? 12;
  const maxRun = Math.ceil(target * 2.6);
  const firstHitLimit = Math.max(6, 0.8 * target);
  const widths = [];

  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const view = cellView(directions, cell, geom);
    const N = P * P;
    const R = new Uint8Array(N);
    const G = new Uint8Array(N);
    const B = new Uint8Array(N);
    const A = new Uint8Array(N);
    const src = directions.data;
    for (let y = 0; y < P; y++) {
      let o = ((view.oy + y) * directions.width + view.ox) * 4;
      let i = y * P;
      for (let x = 0; x < P; x++, i++, o += 4) {
        R[i] = src[o];
        G[i] = src[o + 1];
        B[i] = src[o + 2];
        A[i] = src[o + 3];
      }
    }
    // cls：0 = 透明、1 = 半透明、2 = 不透明非描邊、3 = 不透明描邊
    const cls = new Uint8Array(N);
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const a = A[i];
      mask[i] = a >= 128 ? 1 : 0;
      if (a < 8) {
        cls[i] = 0;
      } else if (a < 250) {
        cls[i] = 1;
      } else {
        const L = fastLuminance(R[i], G[i], B[i]);
        cls[i] = L >= lumLo && L <= lumHi && colourNear(R[i], G[i], B[i], ref, colourTol) ? 3 : 2;
      }
    }

    // --- matte 偵測（見上方第 5 點）------------------------------------
    const bgR = [];
    const bgG = [];
    const bgB = [];
    for (let y = 3; y < P - 3; y++) {
      for (let x = 3; x < P - 3; x++) {
        const i = y * P + x;
        if (cls[i] !== 1) {
          continue;
        }
        const a = A[i];
        // 只用中段 alpha：f 太小反解會把捨入誤差放大 1/f 倍，f 太大 (1−f) 近零。
        if (a < 40 || a > 220) {
          continue;
        }
        let nearStroke = false;
        for (let dy = -5; dy <= 5 && !nearStroke; dy++) {
          for (let dx = -5; dx <= 5; dx++) {
            const j = i + dy * P + dx;
            if (j >= 0 && j < N && cls[j] === 3) {
              nearStroke = true;
              break;
            }
          }
        }
        if (!nearStroke) {
          continue;
        }
        const f = a / 255;
        bgR.push((R[i] - ref[0] * f) / (1 - f));
        bgG.push((G[i] - ref[1] * f) / (1 - f));
        bgB.push((B[i] - ref[2] * f) / (1 - f));
      }
    }
    let matteBg = null;
    if (bgR.length >= tune.matteMinSamples) {
      const median = (arr) => {
        const s = arr.slice().sort((p, q) => p - q);
        return s[s.length >> 1];
      };
      const med = [median(bgR), median(bgG), median(bgB)];
      let agree = 0;
      for (let k = 0; k < bgR.length; k++) {
        if (Math.abs(bgR[k] - med[0]) <= tune.matteToleranceRgb &&
            Math.abs(bgG[k] - med[1]) <= tune.matteToleranceRgb &&
            Math.abs(bgB[k] - med[2]) <= tune.matteToleranceRgb) {
          agree++;
        }
      }
      // 直通道的圖也會通過這個測試 —— 此時反解出來的 bg 就是 ref 本身，
      // 反合成是恆等變換。所以不需要「有沒有 matte」這個旗標。
      if (agree / bgR.length >= tune.matteAgreeFraction) {
        matteBg = med;
      }
    }
    const rimIsStroke = (i) => {
      if (cls[i] !== 1) {
        return false;
      }
      const f = A[i] / 255;
      if (!matteBg) {
        return colourNear(R[i], G[i], B[i], ref, colourTol);
      }
      if (f < 0.04) {
        return false;
      }
      const sr = (R[i] - matteBg[0] * (1 - f)) / f;
      const sg = (G[i] - matteBg[1] * (1 - f)) / f;
      const sb = (B[i] - matteBg[2] * (1 - f)) / f;
      // 反合成把 8-bit 的捨入誤差放大 1/f 倍，容差跟著放大，否則 f 小的那圈全被丟掉。
      const tol = colourTol + 3 / f;
      return Math.abs(sr - ref[0]) <= tol && Math.abs(sg - ref[1]) <= tol && Math.abs(sb - ref[2]) <= tol;
    };

    // 覆蓋率場：不透明描邊 1、屬於描邊的抗鋸齒環 alpha/255、其餘 0。
    const coverage = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      coverage[i] = cls[i] === 3 ? 1 : (cls[i] === 1 && rimIsStroke(i) ? A[i] / 255 : 0);
    }
    // **內緣次像素**：描邊↔填色邊界的不透明混色像素，對鄰接填色解混出描邊成分 t。
    //
    // 沒有這一段時只有外緣（描邊↔透明）是次像素，內緣是 colourNear 的硬門檻 ——
    // 一顆 80% 描邊 / 20% 膚色的邊界像素貢獻 0，每條游程系統性少掉內側半個像素，
    // 而少掉多少取決於**填色的顏色**（門檻切在哪）。解析地面真值（8× supersample
    // disc、內緣含真實混色）實測：修正前偏差 −0.31 ~ −0.34（與獨立複審的 −0.29 一致）
    // 且隨填色擺動 0.08px；解混後 +0.03 ~ +0.08、擺動 0.017px。
    // 合成 fixture 的內緣是硬過渡（無混色像素），所以這一段在電池上零影響 ——
    // 它保護的是真素材。
    {
      const isInnerEdge = new Uint8Array(N);
      for (let y = 1; y < P - 1; y++) {
        for (let x = 1; x < P - 1; x++) {
          const i = y * P + x;
          if (cls[i] !== 2) {
            continue;
          }
          if (cls[i - 1] === 3 || cls[i + 1] === 3 || cls[i - P] === 3 || cls[i + P] === 3) {
            isInnerEdge[i] = 1;
          }
        }
      }
      for (let y = 1; y < P - 1; y++) {
        for (let x = 1; x < P - 1; x++) {
          const i = y * P + x;
          if (!isInnerEdge[i]) {
            continue;
          }
          // 鄰接填色 = 8 鄰域中「非邊界」的不透明非描邊像素平均
          let fr = 0;
          let fg = 0;
          let fb = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const j = i + dy * P + dx;
              if (j === i || cls[j] !== 2 || isInnerEdge[j]) {
                continue;
              }
              fr += R[j];
              fg += G[j];
              fb += B[j];
              n++;
            }
          }
          if (!n) {
            continue;
          }
          fr /= n;
          fg /= n;
          fb /= n;
          const dr = ref[0] - fr;
          const dg = ref[1] - fg;
          const db2 = ref[2] - fb;
          const den = dr * dr + dg * dg + db2 * db2;
          if (den < 400) {
            // 填色與描邊太接近時解不出：den 是解混的分母，8-bit 捨入誤差被放大
            // ref−fill 距離的倒數倍。門檻取 400（≈ 每通道 12）；#E2C8B1 膚色的
            // den ≈ 22,000，不受影響。
            // ⚠️ 誠實記：**近色填色（如 #7c7c7c 整片當填色）的殘餘偏差 +0.42px
            // 不是這個分支能救的** —— 它的內緣混色像素離 ref 只差 7/3/2.5，
            // 在 colourNear 的 tol 12 內，直接被 cls 判成描邊，根本走不到解混。
            // 顏色分不開時內緣位置本來就不可分辨；現實情境（J 列：衣物「帶」
            // 貼邊而非整片填色）不受影響，電池 20/20。
            continue;
          }
          const t = ((R[i] - fr) * dr + (G[i] - fg) * dg + (B[i] - fb) * db2) / den;
          if (t > 0.02) {
            coverage[i] = Math.min(1, t);
          }
        }
      }
    }

    const smooth = boxBlurMask(mask, P, P, tune.blurRadius, tune.blurPasses);
    const step = tune.stepPx;
    const kOut = Math.ceil(tune.outReachPx / step);
    const kIn = Math.ceil((maxRun + 4) / step);
    const wRay = new Float64Array(kOut + kIn + 1);
    const cRay = new Uint8Array(kOut + kIn + 1);

    const gather = (obliquityGate) => {
      const samples = [];
      for (let y = 2; y < P - 2; y++) {
        for (let x = 2; x < P - 2; x++) {
          const i = y * P + x;
          if (!mask[i]) {
            continue;
          }
          if (mask[i - 1] && mask[i + 1] && mask[i - P] && mask[i + P]) {
            continue;
          }
          const gx = (smooth[i + 1] - smooth[i - 1]) * 0.5;
          const gy = (smooth[i + P] - smooth[i - P]) * 0.5;
          const mag = Math.sqrt(gx * gx + gy * gy);
          if (mag < tune.minGrad) {
            continue;
          }
          if (Math.min(Math.abs(gx), Math.abs(gy)) / mag < obliquityGate) {
            continue;
          }
          const nx = gx / mag; // 梯度指向剪影內部
          const ny = gy / mag;
          for (let k = -kOut; k <= kIn; k++) {
            const u = k * step;
            const px = Math.round(x + nx * u);
            const py = Math.round(y + ny * u);
            const slot = k + kOut;
            if (px < 0 || py < 0 || px >= P || py >= P) {
              cRay[slot] = 0;
              wRay[slot] = 0;
              continue;
            }
            const j = py * P + px;
            cRay[slot] = cls[j];
            wRay[slot] = coverage[j];
          }
          // 起點：u ≥ 0 的第一個**完全不透明**描邊像素。
          let k0 = -1;
          for (let k = 0; k <= kIn; k++) {
            if (cRay[k + kOut] === 3) {
              k0 = k + kOut;
              break;
            }
            if (k * step > firstHitLimit) {
              break;
            }
          }
          if (k0 < 0) {
            continue;
          }
          let kLo = k0;
          while (kLo - 1 >= 0 && wRay[kLo - 1] > 0) {
            kLo--;
          }
          let kHi = k0;
          while (kHi + 1 < wRay.length && wRay[kHi + 1] > 0) {
            kHi++;
          }
          let chord = 0;
          for (let k = kLo; k <= kHi; k++) {
            chord += wRay[k];
          }
          chord *= step;
          // 內側必須踩到真正的填色（細附屬物／橋接拒絕器）
          let fill = 0;
          for (let k = kHi + 1; k < cRay.length && fill < tune.minFillRunPx; k++) {
            if (cRay[k] !== 2) {
              break;
            }
            fill += step;
          }
          if (fill < tune.minFillRunPx) {
            continue;
          }
          if (chord < 0.3 * target || chord > 2.2 * target) {
            continue;
          }
          samples.push(chord);
        }
      }
      return samples;
    };

    let samples = gather(tune.minObliquity);
    if (samples.length < tune.minObliqueSamples) {
      // 幾乎全是軸向邊界（例如刻意的方塊素材）。量化好過 NaN。
      samples = gather(0);
    }
    widths.push(modeThenLocalMean(samples, 3 * target, tune));
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
