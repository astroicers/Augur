/**
 * 精靈圖素材的共用後處理：守恆柔邊＋補色（SP-2.14 / SP-2.15）、下襬漸隱（SP-2.8）、組 3×3 sheet。
 * `assemble.mjs`（素材組裝）使用；先前也供程式畫的 `whale-boy.mjs`（已刪除）共用，兩條產製路線的邊緣處理一致。
 */
export const S = 512;
export const SHEET = S * 3;
export const HEM_TOP = 0.89 * S; // SP-2.8：不透明止於此
export const HEM_END = 0.95 * S; // SP-2.8：alpha 線性漸隱到 0

/**
 * 外緣守恆柔邊（SP-2.14）+ 透明／半透明像素補色（SP-2.15）。
 *
 * 柔邊：對 alpha 做 σ = 1px 的高斯模糊。模糊保總量（「守恆」），而且**各方向同寬** ——
 * 先前用 4-鄰接距離（L1）做線性斜坡，斜坡在法線角 φ 的歐氏寬度是 h·max(|cos φ|, |sin φ|)，
 * 45° 的邊只剩 h/√2：h = 2 時曲線剪影約三到四成周長不到 2px（PR #8 複審實測，最窄 1.49px），
 * 而且階梯狀的 alpha 讓曲線外緣看起來毛毛的。高斯階梯的等效斜坡寬約 3.2σ（一階矩法）。
 *
 * 補色：**用歐氏最近的「畫出來的像素」（光柵化 alpha ≥ 128）**，不用就地掃描傳播。
 * 先前固定 8 輪、由左上往右下就地傳播：往右、往下一輪可以走完一整列，往左、往上一輪只推 1px，
 * 於是左上方曼哈頓距離超過 8 的透明像素補不到（956 個停在黑色），補到的也常不是最近的那個。
 * 畫出來的像素保留自己的顏色：細線模糊後沒有 alpha = 255 的核心，不能拿鄰居的色。
 */
const BLUR_SIGMA = 1;
const BLUR_KERNEL = (() => {
  const r = Math.ceil(BLUR_SIGMA * 4);
  const k = [];
  for (let i = -r; i <= r; i++) {
    k.push(Math.exp(-(i * i) / (2 * BLUR_SIGMA * BLUR_SIGMA)));
  }
  const sum = k.reduce((a, b) => a + b, 0);
  return k.map((v) => v / sum);
})();

function blurAlpha(rgba) {
  const r = (BLUR_KERNEL.length - 1) / 2;
  const a = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    a[i] = rgba[i * 4 + 3] / 255;
  }
  const tmp = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(S - 1, Math.max(0, x + k));
        acc += a[y * S + xx] * BLUR_KERNEL[k + r];
      }
      tmp[y * S + x] = acc;
    }
  }
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(S - 1, Math.max(0, y + k));
        acc += tmp[yy * S + x] * BLUR_KERNEL[k + r];
      }
      out[y * S + x] = acc;
    }
  }
  return out;
}

export function featherAndBleed(rgba) {
  const N = S * S;
  const solid = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    solid[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  }
  const alpha = blurAlpha(rgba);
  const out = new Uint8Array(rgba.length);
  const R = 10; // 補色半徑：柔邊外緣再往外 8px 以上
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const o = i * 4;
      const a8 = Math.round(255 * Math.min(1, Math.max(0, alpha[i])));
      // 模糊核尾巴的 1/255 雜訊歸零：看不見，卻會讓「必須嚴格為 0」的區域
      // （外緣 opaqueFree 帶、閉眼格與眉窗的交界）出現非零 alpha。
      out[o + 3] = a8 < 2 ? 0 : a8;
      if (solid[i]) {
        out[o] = rgba[o];
        out[o + 1] = rgba[o + 1];
        out[o + 2] = rgba[o + 2];
        continue;
      }
      let best = -1;
      let bd = R * R + 1;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= S) {
          continue;
        }
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          const d2 = dx * dx + dy * dy;
          if (xx < 0 || xx >= S || d2 >= bd) {
            continue;
          }
          if (solid[yy * S + xx]) {
            bd = d2;
            best = yy * S + xx;
          }
        }
      }
      if (best < 0) {
        out[o + 3] = 0; // 遠處的透明像素維持 (0,0,0,0)
        continue;
      }
      out[o] = rgba[best * 4];
      out[o + 1] = rgba[best * 4 + 1];
      out[o + 2] = rgba[best * 4 + 2];
    }
  }
  return out;
}

/**
 * SP-2.8 下襬：不透明止於 0.890·S，0.890 → 0.950 alpha 線性降到 0。只對 directions 做
 * （reactions 的修補塊都在臉上）。RGB 不動，所以 SP-2.15 的補色照舊成立。
 */
export function hemFade(rgba) {
  for (let y = Math.floor(HEM_TOP); y < S; y++) {
    const k = Math.min(1, Math.max(0, (HEM_END - (y + 0.5)) / (HEM_END - HEM_TOP)));
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4 + 3;
      rgba[o] = Math.round(rgba[o] * k);
    }
  }
  return rgba;
}

export function compose(cells) {
  const sheet = new Uint8Array(SHEET * SHEET * 4);
  cells.forEach((rgba, c) => {
    const ox = (c % 3) * S;
    const oy = Math.floor(c / 3) * S;
    for (let y = 0; y < S; y++) {
      sheet.set(rgba.subarray(y * S * 4, (y + 1) * S * 4), ((oy + y) * SHEET + ox) * 4);
    }
  });
  return sheet;
}
