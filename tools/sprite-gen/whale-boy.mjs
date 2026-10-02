#!/usr/bin/env node
/**
 * 暫定角色「藍鯨布偶裝的疲憊男孩」的精靈圖產生器。`node tools/sprite-gen/whale-boy.mjs`
 *
 * 角色由專案主人於 2026-10-02 指定：看起來很疲憊、有黑眼圈、穿著藍鯨布偶裝的男孩。
 * 這是**暫定素材**：在正式畫師交付之前，讓驗收鏈與 SpriteController 有真圖可跑。
 *
 * **為什麼用程式畫**：出處乾淨（本檔即出處，隨 repo Apache-2.0），而且幾何可以
 * 直接照規格的錨點寫死 —— 頭不動（九個方向格只有眼窗 E 內的虹膜不同）、
 * 外描邊 0.016·S、覆蓋格只在各自的視窗與臉部膚色範圍內。
 *
 * 流程：每格一張 SVG（viewBox 512）→ headless Chromium 光柵化（透明底）→
 * 外緣改成 SP-2.14 要求的 2px 守恆柔邊、半透明像素補色（SP-2.15）→ 組成 3×3 sheet →
 * `tools/lib/png.mjs` 編碼。輸出：
 *   src/img/sprite/directions.png、reactions.png、sprite-manifest.json（檔名照 check-sprite-sheets.mjs 的 SHEET_FILES）
 *   .sprite-check/whale-boy-preview.png（給人看的預覽，不進版控）
 *
 * 依賴：`@playwright/test`（devDependency，只用來光柵化 SVG）。驗收工具
 * `tools/check-sprite-sheets.mjs` 的零依賴原則（SP-7.0）不受影響 —— 這支是素材來源，不是檢查。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

const S = 512;
const SHEET = S * 3;

// ---- 錨點（docs/sprite/sprite-manifest.example.json 的 anchors，單位 px）----
const AXIS = 0.5 * S;
const EYE_Y = 0.38 * S;
const PUPIL_L = 0.41 * S;
const PUPIL_R = 0.59 * S;
const MOUTH_Y = 0.53 * S;
const STROKE_W = 0.016 * S; // 8.192

// ---- 色票 ----
// 亮度夾制 [0.047, 0.61] 只管大面積色塊（≥ 剪影 1%）；鞏膜 L ≥ 0.85 與線稿、虹膜自動豁免。
const C = {
  stroke: '#6E7681', // SP-6.4 參考色（manifest 宣告為 stroke.colour）
  hood: '#3A66A0', // 藍鯨布偶裝，L ≈ 0.13。manifest 把它宣告為 colours.hair（頭套占了頭髮的位置）
  belly: '#9DB8D2', // 鯨魚腹面／嘴緣，L ≈ 0.46
  pleat: '#7E9DBC', // 腹面摺紋
  skin: '#E2C8B1', // SP-6.2 指定膚色
  bangs: '#5C4330', // 從頭套下露出的瀏海，L ≈ 0.06
  bangsDark: '#4D3828',
  line: '#000010', // 線稿（豁免亮度夾制）
  sclera: '#F4F2EE',
  iris: '#28875F', // 綠。必須與「線稿×膚色」「線稿×鞏膜」的整條抗鋸齒混色線、以及頭套色，每通道相距 > 40 —— 先前的 #2E5E4E 太灰，眼皮線的混色像素被當成虹膜碎塊
  circle: '#9C7F98', // 黑眼圈（外）
  circleDark: '#836684', // 黑眼圈（內）
  spout: '#8FC4E0', // 頭頂噴水的紋飾（畫在頭套內，不延伸剪影）
  whaleEye: '#1B2B44',
  blush: '#E39A9A',
  mouth: '#6B2E36',
  tongue: '#C46A6E',
  sweat: '#BFE0F0',
  anger: '#C0392B',
};

// ---------------------------------------------------------------------------
// 共用形狀
// ---------------------------------------------------------------------------
const HOOD = `<ellipse cx="${AXIS}" cy="168" rx="110" ry="134"/>`;
const BODY = `<path d="M152,296 L360,296 L402,448 Q402,456 394,456 L118,456 Q110,456 110,448 Z"/>`;
const FIN_L = `<path d="M150,326 Q82,350 86,424 Q118,398 162,392 Z"/>`;
const FIN_R = `<path d="M362,326 Q430,350 426,424 Q394,398 350,392 Z"/>`;
// 臉：圓頰的童臉。頂 86、頰最寬 x∈[164,348]、底 307（= chinY）。
const FACE_D = 'M256,86 C320,86 348,138 348,206 C348,268 306,307 256,307 C206,307 164,268 164,206 C164,138 192,86 256,86 Z';

/** 眼睛。gx/gy = 虹膜位移；lidY = 上眼皮邊緣（相對眼心），往上看時抬起、往下看時垂下。 */
function eye(cx, gx, gy, lidY, id) {
  const top = EYE_Y - 14;
  const lid = EYE_Y + lidY;
  const outer = cx < AXIS ? -1 : 1; // 外眼角方向
  const ox = cx + outer * 25;
  const ix = cx - outer * 25;
  return `
  <clipPath id="sc${id}"><ellipse cx="${cx}" cy="${EYE_Y}" rx="24" ry="14"/></clipPath>
  <ellipse cx="${cx}" cy="${EYE_Y}" rx="24" ry="14" fill="${C.sclera}"/>
  <g clip-path="url(#sc${id})">
    <circle cx="${cx + gx}" cy="${EYE_Y + gy}" r="12" fill="${C.iris}"/>
    <path d="M${cx - 30},${top - 4} L${cx + 30},${top - 4} L${cx + 30},${lid + 1}
             Q${cx},${lid - 4} ${cx - 30},${lid + 1} Z" fill="${C.skin}"/>
  </g>
  <path d="M${ox},${lid + 4} Q${cx},${lid - 4} ${ix},${lid + 1}" fill="none" stroke="${C.line}"
        stroke-width="3.6" stroke-linecap="round"/>
  <path d="M${ox},${lid + 4} l${outer * 4},3" stroke="${C.line}" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M${cx - 20},${EYE_Y + 13} Q${cx},${EYE_Y + 17} ${cx + 20},${EYE_Y + 13}" fill="none"
        stroke="${C.line}" stroke-width="1.4" stroke-opacity="0.55" stroke-linecap="round"/>`;
}

/** 黑眼圈：眼睛下方的兩層新月。 */
function darkCircle(cx) {
  return `
  <path d="M${cx - 25},${EYE_Y + 10} Q${cx},${EYE_Y + 31} ${cx + 25},${EYE_Y + 10}
           Q${cx},${EYE_Y + 18} ${cx - 25},${EYE_Y + 10} Z" fill="${C.circle}"/>
  <path d="M${cx - 18},${EYE_Y + 13} Q${cx},${EYE_Y + 25} ${cx + 18},${EYE_Y + 13}
           Q${cx},${EYE_Y + 18} ${cx - 18},${EYE_Y + 13} Z" fill="${C.circleDark}"/>`;
}

const brow = (d) => `<path d="${d}" fill="none" stroke="${C.line}" stroke-width="4.5" stroke-linecap="round"/>`;
const BROWS_TIRED =
  brow('M180,154 Q206,145 234,149') + brow(`M${2 * AXIS - 180},154 Q${2 * AXIS - 206},145 ${2 * AXIS - 234},149`);

// ---------------------------------------------------------------------------
// directions：master 全身，眼睛依視線格參數化
// ---------------------------------------------------------------------------
function directionSvg(cell) {
  const col = cell % 3;
  const row = Math.floor(cell / 3);
  const gx = (col - 1) * 10;
  const gy = (row - 1) * 6;
  const lidY = [-11, -6, -3][row];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <g fill="${C.stroke}" stroke="${C.stroke}" stroke-width="${2 * STROKE_W}" stroke-linejoin="round">
    ${HOOD}${BODY}${FIN_L}${FIN_R}
  </g>
  <g fill="${C.hood}">${BODY}${FIN_L}${FIN_R}</g>
  <path d="M90,418 Q118,396 160,390" fill="none" stroke="${C.belly}" stroke-width="5" stroke-linecap="round"/>
  <path d="M422,418 Q394,396 352,390" fill="none" stroke="${C.belly}" stroke-width="5" stroke-linecap="round"/>
  <ellipse cx="${AXIS}" cy="395" rx="62" ry="56" fill="${C.belly}"/>
  ${[372, 388, 404, 420].map((y) => `<path d="M${AXIS - 46},${y} Q${AXIS},${y + 6} ${AXIS + 46},${y}" fill="none" stroke="${C.pleat}" stroke-width="2.5"/>`).join('')}
  <g fill="${C.hood}">${HOOD}</g>
  <path d="M248,60 Q239,49 244,40 M256,58 L256,38 M264,60 Q273,49 268,40" fill="none" stroke="${C.spout}"
        stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="190" cy="72" r="9" fill="${C.whaleEye}"/><circle cx="187" cy="69" r="3" fill="${C.sclera}"/>
  <circle cx="322" cy="72" r="9" fill="${C.whaleEye}"/><circle cx="319" cy="69" r="3" fill="${C.sclera}"/>
  <path d="${FACE_D}" fill="${C.belly}" stroke="${C.belly}" stroke-width="18" stroke-linejoin="round"/>
  ${[-3, -1, 1, 3].map((k) => `<path d="M${AXIS + k * 14},302 L${AXIS + k * 16},314" stroke="${C.pleat}" stroke-width="2.4"/>`).join('')}
  <path d="${FACE_D}" fill="${C.skin}"/>
  <path d="M166,118 Q180,92 210,86 Q256,74 302,86 Q332,92 346,118 L336,112 L326,126 L314,106 L300,124
           L286,102 L270,122 L256,100 L240,124 L226,102 L212,126 L198,106 L186,124 L176,110 Z" fill="${C.bangs}"/>
  <path d="M226,102 L222,90 M286,102 L290,90 M256,100 L256,88" stroke="${C.bangsDark}" stroke-width="2.4"/>
  ${BROWS_TIRED}
  ${darkCircle(PUPIL_L)}${darkCircle(PUPIL_R)}
  ${eye(PUPIL_L, gx, gy, lidY, 'L')}${eye(PUPIL_R, gx, gy, lidY, 'R')}
  <path d="M254,226 Q259,232 252,236" fill="none" stroke="${C.line}" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M244,274 Q256,270 268,275" fill="none" stroke="${C.line}" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}

// ---------------------------------------------------------------------------
// reactions：只畫修補塊（膚色底 + 新五官），落在各格的視窗與臉部膚色內
// ---------------------------------------------------------------------------
const BROW_PATCHES = `<ellipse cx="207" cy="151" rx="34" ry="15" fill="${C.skin}"/><ellipse cx="${2 * AXIS - 207}" cy="151" rx="34" ry="15" fill="${C.skin}"/>`;
const MOUTH_PATCH = `<ellipse cx="${AXIS}" cy="276" rx="30" ry="20" fill="${C.skin}"/>`;
const EYE_PATCHES = `<ellipse cx="${PUPIL_L}" cy="196" rx="28" ry="18" fill="${C.skin}"/><ellipse cx="${PUPIL_R}" cy="196" rx="28" ry="18" fill="${C.skin}"/>`;
const mirror = (d) => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${2 * AXIS - Number(x)},${y}`);
const browPair = (d) => brow(d) + brow(mirror(d));

/** 閉眼：下彎的弧（疲憊的閉眼），附睫毛與黑眼圈。 */
function closedEye(cx) {
  const outer = cx < AXIS ? -1 : 1;
  return `
  <path d="M${cx + outer * 23},${EYE_Y + 3} Q${cx},${EYE_Y + 10} ${cx - outer * 22},${EYE_Y + 2}" fill="none"
        stroke="${C.line}" stroke-width="3.6" stroke-linecap="round"/>
  <path d="M${cx + outer * 23},${EYE_Y + 3} l${outer * 4},2" stroke="${C.line}" stroke-width="2.4" stroke-linecap="round"/>
  ${darkCircle(cx)}`;
}

function reactionSvg(cell) {
  const parts = [];
  switch (cell) {
    case 0: // click：驚醒 —— 眉挑高、眼睛整個睜開、嘴成 o
      parts.push(BROW_PATCHES, browPair('M182,148 Q206,136 232,142'));
      parts.push(EYE_PATCHES);
      for (const cx of [PUPIL_L, PUPIL_R]) {
        parts.push(`<ellipse cx="${cx}" cy="${EYE_Y}" rx="24" ry="16" fill="${C.sclera}"/>
          <circle cx="${cx}" cy="${EYE_Y}" r="12" fill="${C.iris}"/>
          <ellipse cx="${cx}" cy="${EYE_Y}" rx="24" ry="16" fill="none" stroke="${C.line}" stroke-width="2.6"/>`);
        parts.push(darkCircle(cx));
      }
      parts.push(MOUTH_PATCH, `<ellipse cx="${AXIS}" cy="277" rx="7" ry="9" fill="${C.mouth}" stroke="${C.line}" stroke-width="2.4"/>`);
      break;
    case 1: // warning：眉頭上揚（擔心）+ 汗滴 + 抿嘴
      parts.push(BROW_PATCHES, browPair('M182,156 Q206,153 232,143'));
      parts.push(`<path d="M326,236 Q334,250 326,256 Q318,250 326,236 Z" fill="${C.sweat}" stroke="${C.line}" stroke-width="1.6"/>`);
      parts.push(MOUTH_PATCH, `<path d="M242,276 Q249,271 256,276 Q263,281 270,276" fill="none" stroke="${C.line}" stroke-width="3" stroke-linecap="round"/>`);
      break;
    case 2: // critical：眉頭下壓 + 怒紋 + 咬牙
      parts.push(BROW_PATCHES, browPair('M182,146 Q208,148 234,158'));
      parts.push(`<g stroke="${C.anger}" stroke-width="3" stroke-linecap="round" fill="none">
        <path d="M312,131 Q318,134 316,140"/><path d="M326,131 Q320,134 322,140"/>
        <path d="M312,141 Q318,138 316,132"/></g>`);
      parts.push(MOUTH_PATCH, `<rect x="242" y="270" width="28" height="11" rx="3" fill="${C.sclera}" stroke="${C.line}" stroke-width="2.4"/>
        <path d="M249,270 L249,281 M256,270 L256,281 M263,270 L263,281" stroke="${C.line}" stroke-width="1.4"/>`);
      break;
    case 3: // resolved：鬆一口氣 —— 眉放鬆、淡淡的笑、腮紅
      parts.push(BROW_PATCHES, browPair('M182,151 Q206,143 232,147'));
      parts.push(`<ellipse cx="196" cy="246" rx="13" ry="6" fill="${C.blush}"/><ellipse cx="${2 * AXIS - 196}" cy="246" rx="13" ry="6" fill="${C.blush}"/>`);
      parts.push(MOUTH_PATCH, `<path d="M243,272 Q256,284 269,272" fill="none" stroke="${C.line}" stroke-width="3" stroke-linecap="round"/>`);
      break;
    case 4: // 半開嘴
      parts.push(MOUTH_PATCH, `<path d="M245,272 Q256,268 267,272 Q263,283 256,284 Q249,283 245,272 Z" fill="${C.mouth}" stroke="${C.line}" stroke-width="2.4" stroke-linejoin="round"/>`);
      break;
    case 5: // 大開嘴（打哈欠）
      parts.push(MOUTH_PATCH, `<ellipse cx="${AXIS}" cy="277" rx="13" ry="15" fill="${C.mouth}" stroke="${C.line}" stroke-width="2.4"/>
        <path d="M245,285 Q256,280 267,285 Q262,292 256,292 Q250,292 245,285 Z" fill="${C.tongue}"/>`);
      break;
    case 6: // 全閉眼
      parts.push(EYE_PATCHES, closedEye(PUPIL_L), closedEye(PUPIL_R));
      break;
    case 7: // 半閉眼：上半被眼皮蓋住，眼皮線落在眼心下方 2px
      for (const cx of [PUPIL_L, PUPIL_R]) {
        const outer = cx < AXIS ? -1 : 1;
        parts.push(`<path d="M${cx - 28},${EYE_Y + 2} A28,18 0 0 1 ${cx + 28},${EYE_Y + 2}
             Q${cx},${EYE_Y - 3} ${cx - 28},${EYE_Y + 2} Z" fill="${C.skin}"/>
          <path d="M${cx + outer * 25},${EYE_Y + 4} Q${cx},${EYE_Y - 3} ${cx - outer * 25},${EYE_Y + 2}" fill="none"
             stroke="${C.line}" stroke-width="3.6" stroke-linecap="round"/>`);
      }
      break;
    case 8: // pending：一邊眉挑起（疑惑）+ 嘴撇一邊
      parts.push(BROW_PATCHES, brow('M180,154 Q206,145 234,149'), brow(`M${2 * AXIS - 182},144 Q${2 * AXIS - 206},134 ${2 * AXIS - 232},142`));
      parts.push(MOUTH_PATCH, `<path d="M246,276 L268,272" fill="none" stroke="${C.line}" stroke-width="3" stroke-linecap="round"/>`);
      break;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${parts.join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// 後處理：外緣 2px 守恆柔邊 + 補色（與 tools/lib/syntheticSheet.mjs 的 applyAlphaRamp 同一套）
// ---------------------------------------------------------------------------
function featherAndBleed(rgba, h = 2) {
  const N = S * S;
  const solid = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    solid[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  }
  const bd = new Uint8Array(N);
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      if (solid[i] && !(solid[i - 1] && solid[i + 1] && solid[i - S] && solid[i + S])) {
        bd[i] = 1;
      }
    }
  }
  const reach = Math.ceil(h) + 6; // 多擴幾格做補色
  const db = new Int16Array(N).fill(9999);
  const src = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
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
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const sj = src[i];
    if (solid[i] && db[i] > h) {
      out[o] = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
      out[o + 3] = 255;
      continue;
    }
    if (sj < 0) {
      continue; // 遠處的透明像素維持 0
    }
    // SP-2.15：半透明與透明像素的 RGB = 最近不透明像素的 RGB
    out[o] = rgba[sj * 4];
    out[o + 1] = rgba[sj * 4 + 1];
    out[o + 2] = rgba[sj * 4 + 2];
    if (db[i] > h) {
      out[o + 3] = 0;
      continue;
    }
    const signed = solid[i] ? -db[i] : db[i];
    const d = 0.5 - signed;
    let acc = 0;
    for (let t = 0; t < 8; t++) {
      const u = d - 0.5 + (t + 0.5) / 8;
      acc += Math.min(1, Math.max(0, 0.5 + u / h));
    }
    out[o + 3] = Math.round((255 * acc) / 8);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 光柵化與組圖
// ---------------------------------------------------------------------------
async function rasterise(page, svg) {
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`
  );
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: S, height: S } });
  const { decodePng } = await import('../lib/png.mjs');
  const img = decodePng(png);
  return img.rgba ?? img.data ?? img.pixels;
}

function compose(cells) {
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

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: S, height: S }, deviceScaleFactor: 1 })).newPage();
const dirCells = [];
const reaCells = [];
for (let c = 0; c < 9; c++) {
  dirCells.push(featherAndBleed(await rasterise(page, directionSvg(c))));
  reaCells.push(featherAndBleed(await rasterise(page, reactionSvg(c))));
}
await browser.close();

const outDir = path.join(ROOT, 'src/img/sprite');
fs.mkdirSync(outDir, { recursive: true });
const dirPng = encodePng(SHEET, SHEET, compose(dirCells), 4);
const reaPng = encodePng(SHEET, SHEET, compose(reaCells), 4);
fs.writeFileSync(path.join(outDir, 'directions.png'), dirPng);
fs.writeFileSync(path.join(outDir, 'reactions.png'), reaPng);

// manifest：以樣板為底，填入本角色的色值與 sha256
const tmpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/sprite/sprite-manifest.example.json'), 'utf8'));
tmpl._note = '暫定角色「藍鯨布偶裝的疲憊男孩」（2026-10-02 專案主人指定），由 tools/sprite-gen/whale-boy.mjs 產生。正式畫師交付時整份重做。';
tmpl.colours.iris = C.iris;
tmpl.colours.hair = C.hood;
tmpl.colours._note_hair = '本角色沒有外露的髮頂：藍鯨頭套占了頭髮的位置，所以 colours.hair 宣告為頭套色 —— SP-7.5 的頭部 bbox（膚色＋髮色）因此量到頭套。從頭套下露出的瀏海是另一個顏色。';
tmpl.colours.lineart = C.line;
tmpl.colours.skin = C.skin;
tmpl.stroke.colour = C.stroke;
delete tmpl._example_empty;
delete tmpl.irisCentroids;
tmpl.sha256.directions = crypto.createHash('sha256').update(dirPng).digest('hex');
tmpl.sha256.reactions = crypto.createHash('sha256').update(reaPng).digest('hex');
fs.writeFileSync(path.join(outDir, 'sprite-manifest.json'), JSON.stringify(tmpl, null, 2) + '\n');

console.log(`directions ${(dirPng.length / 1024).toFixed(0)} KB, reactions ${(reaPng.length / 1024).toFixed(0)} KB → ${path.relative(ROOT, outDir)}`);
