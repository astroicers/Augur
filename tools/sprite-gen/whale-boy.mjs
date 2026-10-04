#!/usr/bin/env node
/**
 * 暫定角色「藍鯨布偶裝的疲憊男孩」的精靈圖產生器。`node tools/sprite-gen/whale-boy.mjs`
 *
 * 角色由專案主人於 2026-10-02 指定：看起來很疲憊、有黑眼圈、穿著藍鯨布偶裝的男孩；
 * 同日追加畫風要求：動漫風、可愛、萌（Q 版大頭、大眼、慵懶感 —— 參考的是風格與氛圍，
 * 造型是原創的，不照抄任何既有角色）。
 * 2026-10-04 專案主人裁定這個角色**取代**原角色（規格 SP-0.9），本檔是它的參考實作；
 * 圖本身仍是程式畫的版本，正式畫師若重繪，以 SP-0.9 為角色設定。
 *
 * **為什麼用程式畫**：出處乾淨（本檔即出處，隨 repo Apache-2.0），而且幾何可以
 * 直接照規格的錨點寫死 —— 頭不動（九個方向格只有眼窗 E 內的眼睛不同）、
 * 外描邊 0.016·S、覆蓋格只在各自的視窗與臉部膚色範圍內。
 *
 * 流程：每格一張 SVG（viewBox 512）→ headless Chromium 光柵化（透明底）→
 * 外緣做 SP-2.14 的守恆柔邊（alpha 高斯模糊）、透明與半透明像素補色（SP-2.15）→
 * directions 的下襬做 SP-2.8 漸隱 → 組成 3×3 sheet → `tools/lib/png.mjs` 編碼。輸出：
 *   src/img/sprite/directions.png、reactions.png、sprite-manifest.json（檔名照 check-sprite-sheets.mjs 的 SHEET_FILES）
 *
 * 依賴：`@playwright/test`（devDependency，只用來光柵化 SVG）。驗收工具
 * `tools/check-sprite-sheets.mjs` 的零依賴原則（SP-7.0）不受影響 —— 這支是素材來源，不是檢查。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng } from '../lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

const S = 512;
const SHEET = S * 3;

// ---- 錨點（docs/sprite/sprite-manifest.example.json 的 anchors，單位 px）----
const AXIS = 0.5 * S;
const PUPIL_L = 0.41 * S; // 209.92
const PUPIL_R = 0.59 * S; // 302.08
const STROKE_W = 0.016 * S; // 8.192
const HEM_TOP = 0.89 * S; // SP-2.8：不透明止於此
const HEM_END = 0.95 * S; // SP-2.8：alpha 線性漸隱到 0
/** 眼心。eyeLineY 錨點是 0.38·S = 194.56；虹膜盤的質心會因上眼皮遮住頂端而略低於眼心。 */
const EY = 198;

// ---- 色票 ----
// 亮度夾制 [0.047, 0.61] 管面積 ≥ 剪影 1% 的色塊；L ≥ 0.85（眼白、高光）與線稿、虹膜豁免。
const C = {
  stroke: '#6E7681', // SP-6.4 參考色（manifest 宣告為 stroke.colour）
  hood: '#6EA8E8', // 藍鯨布偶裝，L ≈ 0.37。manifest 把它宣告為 colours.hair（頭套占了頭髮的位置）
  hoodShade: '#5891D6', // 與 hood 至少一個通道差 > 24（hairToleranceRgb），不算進頭部遮罩
  hoodGloss: '#A9CDF4', // L ≈ 0.58
  hoodLine: '#3F6FB0', // 頭套與身體的內部分界線
  belly: '#AFCCEC', // 鯨魚腹面／嘴緣，L ≈ 0.58（≤ 0.61）
  pleat: '#86A9D8',
  spout: '#9ED2F2',
  whaleEye: '#22314F',
  // 膚色：SP-6.2 推薦值是 #E2C8B1（L 0.607）。這裡改用偏粉的桃色，仍在夾制內（L ≈ 0.60）。
  skin: '#ECC4B3',
  hair: '#7B4B36', // 從頭套下露出的瀏海，L ≈ 0.09
  hairHi: '#A06A50',
  hairDark: '#5A3626',
  brow: '#5E3828',
  line: '#3B2226', // 線稿（manifest lineart；豁免亮度夾制）
  lowerLash: '#9A6458',
  sclera: '#FFFFFF',
  scleraShade: '#DCE5F2',
  // 虹膜：蜂蜜琥珀。必須與線稿、膚色、頭套色，以及「線稿×膚色」「線稿×鞏膜」的整條
  // 抗鋸齒混色線每通道相距 > 40（否則眼皮線的混色像素會被當成虹膜碎塊）。
  // 深、淺兩色刻意落在 ±40 內：虹膜遮罩仍是一整塊盤，漸層只是給人看的。
  iris: '#D98A2B',
  irisDark: '#B96E1E',
  irisLight: '#EFAE52',
  irisRim: '#7A4515',
  pupil: '#4A2613',
  shine: '#FFFFFF',
  circle: '#C9A3BE', // 黑眼圈
  circleLine: '#A97E9E',
  blush: '#F4A0AC',
  blushLine: '#E07D8E',
  mouth: '#B84A5A',
  tongue: '#F08A98',
  tooth: '#FFFFFF',
  sweat: '#A9DDF7',
  anger: '#E0455A',
  nose: '#D99A8A',
};

// ---------------------------------------------------------------------------
// 共用形狀
// ---------------------------------------------------------------------------
const mirrorX = (x) => 2 * AXIS - x;
const mirror = (d) => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${mirrorX(Number(x))},${y}`);

// 頭套（鯨魚頭）：頂 38、寬 220（0.43·S）。SP-7.5 的頭部 bbox 量的就是它（colours.hair）。
const HOOD = `<ellipse cx="${AXIS}" cy="190" rx="110" ry="152"/>`;
// 臉（頭套開口）：麻糬臉，兩頰在 y≈228 最寬，下巴 307（= chinY）。
const FACE_D = 'M256,106 C318,106 350,160 350,226 C350,278 308,307 256,307 C204,307 162,278 162,226 C162,160 194,106 256,106 Z';
const RIM_W = 12; // 臉外圈的鯨魚嘴緣（belly 色）
// 頭頂的噴水
const SPOUT_D = 'M256,40 C252,33 245,31 238,34 C242,26 250,23 256,28 C262,23 270,26 274,34 C267,31 260,33 256,40 Z';
// 身體：豆子形的連身衣，底部延伸過 SP-2.8 的漸隱帶（漸隱在後處理做）。
// Q 版比例：身體比頭窄。
const BODY_D = 'M200,300 C176,316 168,354 170,400 L172,500 L340,500 L342,400 C344,354 336,316 312,300 Z';
const FLIP_L = 'M184,334 C160,344 140,374 138,410 C152,402 168,396 182,396 Z';
const FLIP_R = mirror(FLIP_L);
// 尾巴：從右後方翹起來，尾鰭露在肩膀旁邊
const TAIL_D = 'M330,420 C360,410 384,384 398,350 C392,338 380,330 372,318 C390,322 404,330 410,338 C418,326 432,320 450,320 C440,330 430,342 424,356 C412,392 382,424 340,442 Z';

// ---------------------------------------------------------------------------
// 眼睛
// ---------------------------------------------------------------------------
const ERX = 27;
const ERY = 24;

/** 上眼皮曲線的端點與控制點。drop = 上眼皮下垂量（往上看時小、往下看時大）。 */
function lidGeom(cx, drop) {
  const outer = cx < AXIS ? -1 : 1;
  const apex = EY - ERY + drop;
  const yIn = EY - 3 + drop * 0.5;
  const yOut = EY - 8 + drop * 0.5; // 外眼角微微上揚
  const xIn = cx - outer * (ERX + 1);
  const xOut = cx + outer * (ERX + 2);
  const yc = 2 * apex - 0.5 * (yIn + yOut);
  return { outer, apex, xIn, yIn, xOut, yOut, yc };
}

/**
 * 睜開的眼睛。gx/gy = 虹膜位移（視線）；drop = 上眼皮下垂量。
 * 虹膜：漸層盤 + 瞳孔 + 兩顆高光（光源在左上，兩眼同側）。
 */
function openEye(cx, gx, gy, drop, id, { sparkle = false } = {}) {
  const g = lidGeom(cx, drop);
  const ix = cx + gx;
  const iy = EY + 2 + gy;
  const lidD = `M${g.xIn},${g.yIn} Q${cx},${g.yc} ${g.xOut},${g.yOut}`;
  // 眼皮線以上的區域。⚠️ 左右角要依 x 排序再走 —— 先前直接寫「外角 → 內角」，
  // 左眼的外角在左邊，多邊形就從右上角一條直線橫切到左角，左眼的眼皮整個畫錯（兩眼不等高）。
  const [xa, ya, xb, yb] = g.xOut > g.xIn ? [g.xIn, g.yIn, g.xOut, g.yOut] : [g.xOut, g.yOut, g.xIn, g.yIn];
  const lidFill = `M${cx - 40},${EY - 40} L${cx + 40},${EY - 40} L${cx + 40},${yb} L${xb},${yb}
    Q${cx},${g.yc} ${xa},${ya} L${cx - 40},${ya} Z`;
  // 高光兩眼**鏡像**（都在外眼角那一側）：同側的話兩眼的可見虹膜形狀不對稱，
  // 質心一高一低（SP-7.5/兩眼不等高）、往上看時 X 質心也會偏（SP-7.3/殘差X）。
  // 大高光壓在瞳孔邊上，不切斷虹膜環 —— 切斷的話往右下看時虹膜會碎成好幾塊（SP-7.3/眼窗雜塊）。
  const o = g.outer;
  const shine = sparkle
    ? `<path d="M${ix + o * 5},${iy - 15} L${ix + o * 7.5},${iy - 9.5} L${ix + o * 13},${iy - 7} L${ix + o * 7.5},${iy - 4.5}
         L${ix + o * 5},${iy + 1} L${ix + o * 2.5},${iy - 4.5} L${ix - o * 3},${iy - 7} L${ix + o * 2.5},${iy - 9.5} Z"/>
       <circle cx="${ix - o * 6}" cy="${iy + 8}" r="2.8"/>`
    : `<circle cx="${ix + o * 4}" cy="${iy - 6}" r="5.5"/>
       <circle cx="${ix - o * 6}" cy="${iy + 8}" r="2.6"/>`;
  return `
  <defs>
    <clipPath id="eo${id}"><ellipse cx="${cx}" cy="${EY}" rx="${ERX}" ry="${ERY}"/></clipPath>
    <linearGradient id="ig${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.irisDark}"/><stop offset="0.45" stop-color="${C.iris}"/>
      <stop offset="1" stop-color="${C.irisLight}"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#eo${id})">
    <ellipse cx="${cx}" cy="${EY}" rx="${ERX}" ry="${ERY}" fill="${C.sclera}"/>
    <path d="${lidD}" fill="none" stroke="${C.scleraShade}" stroke-width="11"/>
    <ellipse cx="${ix}" cy="${iy}" rx="18" ry="21.5" fill="url(#ig${id})" stroke="${C.irisRim}" stroke-width="1.8"/>
    <ellipse cx="${ix}" cy="${iy + 1}" rx="7" ry="9.5" fill="${C.pupil}"/>
    <g fill="${C.shine}">${shine}</g>
    <path d="${lidFill}" fill="${C.skin}"/>
  </g>
  <path d="${lidD}" fill="none" stroke="${C.line}" stroke-width="5.5" stroke-linecap="round"/>
  <path d="M${g.xOut},${g.yOut} Q${g.xOut + g.outer * 3},${g.yOut - 1} ${g.xOut + g.outer * 5},${g.yOut - 5}"
        fill="none" stroke="${C.line}" stroke-width="3.6" stroke-linecap="round"/>
  <path d="M${cx + g.outer * 23},${EY + 12} Q${cx + g.outer * 10},${EY + ERY} ${cx - g.outer * 8},${EY + ERY - 1}"
        fill="none" stroke="${C.lowerLash}" stroke-width="2.2" stroke-linecap="round"/>`;
}

/**
 * 黑眼圈：下眼瞼下方淡紫的新月，加一道細線。
 * 畫在眼部修補塊（下緣 227）**之外**（y ≥ 229）：九個方向格都一樣、閉眼格也不必重畫，
 * 修補塊的羽化帶只淡淡碰到它的上緣。
 */
function darkCircle(cx) {
  const outer = cx < AXIS ? -1 : 1;
  return `
  <path d="M${cx - 22},229 Q${cx},242 ${cx + 22},229 Q${cx},234 ${cx - 22},229 Z" fill="${C.circle}"/>
  <path d="M${cx - outer * 13},236.5 Q${cx + outer * 2},239.5 ${cx + outer * 15},235.5" fill="none"
        stroke="${C.circleLine}" stroke-width="1.8" stroke-linecap="round"/>`;
}

/** 閉眼：「‿」形的弧（睡著般的閉眼），外眼角一撇睫毛。 */
function closedEye(cx) {
  const outer = cx < AXIS ? -1 : 1;
  const xo = cx + outer * 27;
  const xi = cx - outer * 25;
  return `
  <path d="M${xo},${EY} Q${cx},${EY + 15} ${xi},${EY + 1}" fill="none" stroke="${C.line}" stroke-width="5.5" stroke-linecap="round"/>
  <path d="M${xo},${EY} q${outer * 4},-1 ${outer * 6},-5" fill="none" stroke="${C.line}" stroke-width="3.6" stroke-linecap="round"/>`;
}

const brow = (d, w = 5) => `<path d="${d}" fill="none" stroke="${C.brow}" stroke-width="${w}" stroke-linecap="round"/>`;
const browPair = (d, w) => brow(d, w) + brow(mirror(d), w);
const BROWS_BASE = browPair('M190,152 Q208,145 228,149');

function blush({ strong = false } = {}) {
  const rx = strong ? 21 : 17;
  const ry = strong ? 10 : 8;
  const one = (cx) => `
  <ellipse cx="${cx}" cy="252" rx="${rx}" ry="${ry}" fill="${C.blush}" fill-opacity="${strong ? 0.95 : 0.8}"/>
  ${[-8, 0, 8].map((dx) => `<path d="M${cx + dx - 3},256 l5,-8" stroke="${C.blushLine}" stroke-width="2.2" stroke-linecap="round"/>`).join('')}`;
  return one(194) + one(mirrorX(194));
}

// ---------------------------------------------------------------------------
// directions：master 全身，眼睛依視線格參數化
// ---------------------------------------------------------------------------
function directionSvg(cell) {
  const col = cell % 3;
  const row = Math.floor(cell / 3);
  const gx = (col - 1) * 9;
  const gy = (row - 1) * 5;
  // 往上看眼睛睜大、往下看眼皮垂下；平視就有點睏。
  // 往上看那排的眼皮線頂端 ≈ 174.3：閉眼修補塊上緣是 171.5（再往上就吃進眉窗），
  // 高斯羽化要 ~2.5px 才到 α≈255 —— 眼皮線再高就會從閉眼格底下透出來。
  const drop = [3, 7, 11][row];
  const outline = (d, extra = 0) => `<path d="${d}" stroke-width="${2 * STROKE_W + extra}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <!-- 描邊裁在 HEM_TOP 上方 4px：高斯羽化會把描邊往下拖 ~3px，裁在 HEM_TOP 剛好的話尾巴會進漸隱帶 -->
  <defs><clipPath id="aboveHem"><rect x="0" y="0" width="${S}" height="${HEM_TOP - 4}"/></clipPath>
    <clipPath id="hood"><ellipse cx="${AXIS}" cy="190" rx="104" ry="146"/></clipPath></defs>
  <!-- SP-6.4 外描邊：所有剪影形狀先用描邊色畫粗一圈，再蓋上填色。SP-6.5：下襬漸隱帶不描邊。 -->
  <g clip-path="url(#aboveHem)" fill="${C.stroke}" stroke="${C.stroke}" stroke-linejoin="round" stroke-linecap="round">
    ${outline(TAIL_D)}${outline(BODY_D)}${outline(FLIP_L)}${outline(FLIP_R)}
    <ellipse cx="${AXIS}" cy="190" rx="110" ry="152" stroke-width="${2 * STROKE_W}"/>
    ${outline(SPOUT_D)}
    ${outline(FACE_D, RIM_W)}
  </g>
  <!-- 尾巴、身體、鰭 -->
  <path d="${TAIL_D}" fill="${C.hood}" stroke="${C.hoodLine}" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M410,338 C404,360 392,382 372,402" fill="none" stroke="${C.hoodShade}" stroke-width="5" stroke-linecap="round"/>
  <path d="${BODY_D}" fill="${C.hood}"/>
  <ellipse cx="${AXIS}" cy="430" rx="64" ry="84" fill="${C.belly}"/>
  ${[384, 402, 420, 438, 456].map((y) => `<path d="M${AXIS - 50},${y} Q${AXIS},${y + 7} ${AXIS + 50},${y}" fill="none" stroke="${C.pleat}" stroke-width="2.6" stroke-linecap="round"/>`).join('')}
  ${[FLIP_L, FLIP_R].map((d) => `<path d="${d}" fill="${C.hood}" stroke="${C.hoodLine}" stroke-width="2.4" stroke-linejoin="round"/>`).join('')}
  <path d="M146,402 C158,396 168,392 178,391" fill="none" stroke="${C.belly}" stroke-width="5" stroke-linecap="round"/>
  <path d="${mirror('M146,402 C158,396 168,392 178,391')}" fill="none" stroke="${C.belly}" stroke-width="5" stroke-linecap="round"/>
  <!-- 頭套 -->
  <path d="${SPOUT_D}" fill="${C.spout}"/>
  <ellipse cx="${AXIS}" cy="190" rx="110" ry="152" fill="${C.hood}"/>
  <path d="M152,232 C156,290 196,334 256,342 C316,334 356,290 360,232 C352,300 316,330 256,334 C196,330 160,300 152,232 Z" fill="${C.hoodShade}"/>
  <!-- 反光裁進頭套內（內縮 6px）：先前畫到頭套外緣，蓋在描邊上，剪影那一段就沒有描邊 -->
  <g clip-path="url(#hood)">
    <path d="M176,96 Q192,66 230,54" fill="none" stroke="${C.hoodGloss}" stroke-width="8" stroke-linecap="round"/>
    <circle cx="172" cy="118" r="4.5" fill="${C.hoodGloss}"/>
  </g>
  <ellipse cx="186" cy="102" rx="7.5" ry="8.5" fill="${C.whaleEye}"/><circle cx="183.5" cy="99" r="2.6" fill="${C.sclera}"/>
  <ellipse cx="${mirrorX(186)}" cy="102" rx="7.5" ry="8.5" fill="${C.whaleEye}"/><circle cx="${mirrorX(186) - 2.5}" cy="99" r="2.6" fill="${C.sclera}"/>
  <!-- 鯨魚嘴緣（臉外圈）與喉部摺紋 -->
  <path d="${FACE_D}" fill="${C.belly}" stroke="${C.belly}" stroke-width="${RIM_W}" stroke-linejoin="round"/>
  ${[-2, -1, 0, 1, 2].map((k) => `<path d="M${AXIS + k * 13},306 L${AXIS + k * 14.5},314" stroke="${C.pleat}" stroke-width="2.4" stroke-linecap="round"/>`).join('')}
  <!-- 臉 -->
  <path d="${FACE_D}" fill="${C.skin}"/>
  <defs><clipPath id="face"><path d="${FACE_D}"/></clipPath></defs>
  <g clip-path="url(#face)">
    <!-- 瀏海：從頭套下垂出來的幾撮，尖端避開眉窗修補塊（x 181–239、y ≥ 137） -->
    <path d="M150,96 L362,96 L362,182 Q354,150 340,166 Q340,140 328,124 Q322,132 316,137 Q308,126 298,118
             Q292,128 286,134 Q280,122 270,116 Q266,134 256,147 Q246,134 242,116 Q232,122 226,134
             Q220,126 214,118 Q204,126 196,137 Q190,132 184,124 Q172,140 172,166 Q158,150 150,182 Z" fill="${C.hair}"/>
    <path d="M226,106 Q236,112 242,116 M286,106 Q276,112 270,116 M256,104 Q258,122 256,136 M198,108 Q206,116 214,118 M314,108 Q306,116 298,118"
          fill="none" stroke="${C.hairDark}" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M200,112 Q214,106 230,110 M282,110 Q298,106 312,112" fill="none" stroke="${C.hairHi}" stroke-width="3.6" stroke-linecap="round"/>
  </g>
  ${BROWS_BASE}
  ${darkCircle(PUPIL_L)}${darkCircle(PUPIL_R)}
  ${openEye(PUPIL_L, gx, gy, drop, 'L')}${openEye(PUPIL_R, gx, gy, drop, 'R')}
  ${blush()}
  <circle cx="${AXIS}" cy="246" r="1.8" fill="${C.nose}"/>
  <path d="M243,268 Q249.5,276 256,269 Q262.5,276 269,268" fill="none" stroke="${C.line}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

// ---------------------------------------------------------------------------
// reactions：只畫修補塊（膚色底 + 新五官），落在各格的視窗與臉部膚色內
// ---------------------------------------------------------------------------
const BROW_PATCHES = [PUPIL_L, PUPIL_R].map((cx) => `<ellipse cx="${cx}" cy="150" rx="29" ry="13" fill="${C.skin}"/>`).join('');
const MOUTH_PATCH = `<ellipse cx="${AXIS}" cy="272" rx="27" ry="17" fill="${C.skin}"/>`;
/**
 * 眼部修補塊：蓋住底圖睜眼的**全部**像素（SP-4.7）—— 九個方向格的上眼皮線兩端、
 * 外眼角那一撇、下睫毛與黑眼圈都在裡面。上緣 172 留給羽化帶，不碰眉窗 B（< 169）；
 * 下緣 227 在眼窗 E 內（≤ 227.84）。
 */
const eyePatch = (cx) => `<rect x="${cx - 38}" y="171.5" width="76" height="55.5" rx="12" fill="${C.skin}"/>`;
const EYE_PATCHES = eyePatch(PUPIL_L) + eyePatch(PUPIL_R);

function reactionSvg(cell) {
  const parts = [];
  switch (cell) {
    case 0: // click：嚇醒 —— 眉挑高、眼睛圓睜閃亮、嘴成小 o
      parts.push(BROW_PATCHES, browPair('M190,144 Q208,136 228,141'));
      parts.push(EYE_PATCHES);
      for (const [cx, id] of [[PUPIL_L, 'cL'], [PUPIL_R, 'cR']]) {
        parts.push(openEye(cx, 0, 0, 3, id, { sparkle: true }));
      }
      parts.push(MOUTH_PATCH, `<ellipse cx="${AXIS}" cy="273" rx="7.5" ry="9" fill="${C.mouth}" stroke="${C.line}" stroke-width="2.8"/>`);
      break;
    case 1: // warning：八字眉（擔心）+ 臉頰邊的大汗滴 + 波浪嘴
      // 汗滴必須整顆落在臉部皮膚內（SP-6.6）—— 太陽穴是側髮與鯨魚嘴緣，不算皮膚。
      parts.push(BROW_PATCHES, browPair('M190,149 Q210,148 228,140'));
      // 眼窗 E（y < 228）只屬於眼睛格（SP-7.4 產權），所以汗滴從 y 233 開始。
      parts.push(`<path d="M335,233 Q345,249 341,257 Q336,262 330,257 Q326,249 335,233 Z" fill="${C.sweat}" stroke="${C.line}" stroke-width="2.4" stroke-linejoin="round"/>
        <path d="M332,249 Q331,254 334,256" fill="none" stroke="${C.sclera}" stroke-width="2.2" stroke-linecap="round"/>`);
      parts.push(MOUTH_PATCH, `<path d="M240,273 Q244,267 248,273 Q252,279 256,273 Q260,267 264,273 Q268,279 272,273" fill="none" stroke="${C.line}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`);
      break;
    case 2: // critical：倒八字眉 + 眉心的怒筋 + 張嘴吼（小虎牙）
      // 怒筋放眉心（瀏海中央那撮的尖端下方）：額頭兩側被瀏海與側髮蓋住，不是皮膚（SP-6.6）。
      parts.push(BROW_PATCHES, browPair('M188,141 Q210,144 230,153', 5.5));
      parts.push(`<g fill="none" stroke="${C.anger}" stroke-width="3.6" stroke-linecap="round">
        <path d="M248,153 Q253,154 254,158"/><path d="M264,153 Q259,154 258,158"/>
        <path d="M248,167 Q253,166 254,162"/><path d="M264,167 Q259,166 258,162"/></g>`);
      parts.push(MOUTH_PATCH, `<path d="M240,264 L272,264 Q270,284 256,286 Q242,284 240,264 Z" fill="${C.mouth}" stroke="${C.line}" stroke-width="2.8" stroke-linejoin="round"/>
        <path d="M245,264 L249,272 L253,264 Z" fill="${C.tooth}"/>
        <path d="M248,281 Q256,276 264,281 Q260,285 256,285 Q252,285 248,281 Z" fill="${C.tongue}"/>`);
      break;
    case 3: // resolved：鬆一口氣 —— 眉放鬆、開心的 D 嘴、腮紅更紅
      parts.push(BROW_PATCHES, browPair('M190,149 Q208,140 228,146'));
      parts.push(blush({ strong: true }));
      parts.push(MOUTH_PATCH, `<path d="M242,266 L270,266 Q268,284 256,284 Q244,284 242,266 Z" fill="${C.mouth}" stroke="${C.line}" stroke-width="2.8" stroke-linejoin="round"/>
        <path d="M247,278 Q256,272 265,278 Q262,283 256,283 Q250,283 247,278 Z" fill="${C.tongue}"/>`);
      break;
    case 4: // 半開嘴
      parts.push(MOUTH_PATCH, `<path d="M246,267 Q256,264 266,267 Q264,280 256,281 Q248,280 246,267 Z" fill="${C.mouth}" stroke="${C.line}" stroke-width="2.8" stroke-linejoin="round"/>
        <path d="M250,277 Q256,274 262,277 Q259,280 256,280 Q253,280 250,277 Z" fill="${C.tongue}"/>`);
      break;
    case 5: // 大開嘴（打哈欠）
      parts.push(MOUTH_PATCH, `<ellipse cx="${AXIS}" cy="274" rx="14" ry="16" fill="${C.mouth}" stroke="${C.line}" stroke-width="2.8"/>
        <path d="M245,282 Q256,276 267,282 Q263,289 256,289 Q249,289 245,282 Z" fill="${C.tongue}"/>`);
      break;
    case 6: // 全閉眼（眨眼的閉合格）
      parts.push(EYE_PATCHES);
      for (const cx of [PUPIL_L, PUPIL_R]) {
        parts.push(closedEye(cx));
      }
      break;
    case 7: // 半閉眼：上半被厚重的眼皮蓋住，眼皮線落在眼心下方
      for (const cx of [PUPIL_L, PUPIL_R]) {
        const outer = cx < AXIS ? -1 : 1;
        const xo = cx + outer * 29;
        const xi = cx - outer * 28;
        // 修補塊：上緣圓頂，兩端抬到眼心上方 4px 再斜回眼皮線端點 —— 不要水平往外延伸的下緣。
        parts.push(`<path d="M${cx - 38},${EY - 4} L${cx - 38},183.5 Q${cx - 38},171.5 ${cx - 26},171.5 L${cx + 26},171.5
             Q${cx + 38},171.5 ${cx + 38},183.5 L${cx + 38},${EY - 4} L${Math.max(xo, xi)},${EY + 3}
             Q${cx},${EY - 4} ${Math.min(xo, xi)},${EY + 3} Z" fill="${C.skin}"/>
          <path d="M${xo},${EY + 2} Q${cx},${EY - 5} ${xi},${EY + 3}" fill="none" stroke="${C.line}" stroke-width="5.5" stroke-linecap="round"/>
          <path d="M${xo},${EY + 2} q${outer * 3},-1 ${outer * 5},-5" fill="none" stroke="${C.line}" stroke-width="3.6" stroke-linecap="round"/>`);
      }
      break;
    case 8: // pending：一邊眉挑起（疑惑）+ 撇向一邊的小嘴
      parts.push(BROW_PATCHES, brow('M190,152 Q208,146 228,150'), brow(`M${mirrorX(190)},141 Q${mirrorX(208)},134 ${mirrorX(228)},143`));
      parts.push(MOUTH_PATCH, `<path d="M247,273 Q253,269 258,272 Q263,275 268,269" fill="none" stroke="${C.line}" stroke-width="3.2" stroke-linecap="round"/>`);
      break;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${parts.join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// 後處理
// ---------------------------------------------------------------------------
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

function featherAndBleed(rgba) {
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
function hemFade(rgba) {
  for (let y = Math.floor(HEM_TOP); y < S; y++) {
    const k = Math.min(1, Math.max(0, (HEM_END - (y + 0.5)) / (HEM_END - HEM_TOP)));
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4 + 3;
      rgba[o] = Math.round(rgba[o] * k);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// 光柵化與組圖
// ---------------------------------------------------------------------------
async function rasterise(page, svg) {
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: S, height: S } });
  return decodePng(png).data;
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
  dirCells.push(hemFade(featherAndBleed(await rasterise(page, directionSvg(c)))));
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
tmpl._note =
  '角色「藍鯨布偶裝的疲憊男孩」（2026-10-02 專案主人指定，同日改為動漫萌系畫風；2026-10-04 定案取代原角色，定義見 sprite-sheet-spec.md SP-0.9），由 tools/sprite-gen/whale-boy.mjs 產生。正式畫師重繪時整份取代。';
tmpl.colours.iris = C.iris;
tmpl.colours.hair = C.hood;
tmpl.colours._note_hair =
  '本角色沒有外露的髮頂：藍鯨頭套占了頭髮的位置，所以 colours.hair 宣告為頭套色 —— SP-7.5 的頭部 bbox（膚色＋髮色）因此量到頭套。從頭套下露出的瀏海是另一個顏色。';
tmpl.colours.lineart = C.line;
tmpl.colours.skin = C.skin;
tmpl.stroke.colour = C.stroke;
delete tmpl._example_empty;
delete tmpl.irisCentroids;
tmpl.sha256.directions = crypto.createHash('sha256').update(dirPng).digest('hex');
tmpl.sha256.reactions = crypto.createHash('sha256').update(reaPng).digest('hex');
fs.writeFileSync(path.join(outDir, 'sprite-manifest.json'), JSON.stringify(tmpl, null, 2) + '\n');

console.log(
  `directions ${(dirPng.length / 1024).toFixed(0)} KB, reactions ${(reaPng.length / 1024).toFixed(0)} KB → ${path.relative(ROOT, outDir)}`
);
