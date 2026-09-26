#!/usr/bin/env node
/**
 * sprite sheet 機械驗收（SP-7）。`node tools/check-sprite-sheets.mjs`。
 *
 * **退出碼（SP-7.11）**：0 = 通過；1 = 素材違規；2 = 工具或格式錯誤。
 * 兩者分開是有意義的 —— 「交付了一張 colour type 2 的圖」是流程錯了不是畫錯了，
 * 報給畫師的訊息完全不同。
 *
 * **開關（SP-7.14）**：以 `src/img/sprite/sprite-manifest.json` 在不在決定。
 * 不在 → 印 `SPRITE-CHECK: NOT-DELIVERED` 並回 0。用版控的 manifest 當開關
 * 而不是「PNG 在不在」，是為了讓關閘成為一筆看得見的 diff。
 *
 * **不提供旁路（SP-7.12）**：沒有 `--force`、沒有 `--skip`。要放寬只能改 manifest 裡
 * 凍結的錨點值或容差參數，而那會被 sha256 連帶影響、視同規格變更須經 review。
 *
 * **不呼叫任何 git 指令（SP-7.13）**：會刷新 `.git/index` 的 mtime，破壞
 * `tools/asp-test.sh` 所依賴的「最後一個動作必須是寫 .asp-test-result.json」時序判定
 * （ASP hook 的判定是 `[ ! "$IDX" -nt "$TR" ]`）。素材路徑一律用常數，不用 `git ls-files`。
 *
 * **sheet 檔名是常數不是 manifest 欄位**：SP-7.15 明文「manifest 不得記錄 sheet 的路徑，
 * 只記 sha256」—— 因為 webpack 會把它們改成 hash 檔名，manifest 記路徑必然過期。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng, PngFormatError } from './lib/png.mjs';
import { encodeGif } from './lib/gif.mjs';
import {
  CELL_COUNT,
  skinMask,
  cellView,
  checkAnchors,
  checkDownsampleReadability,
  checkFileSize,
  checkFormatAndHygiene,
  checkGazeBinding,
  checkHeadImmobility,
  checkLuminanceAndStroke,
  checkOverlayOwnership,
  optional as effective,
  windowRect,
} from './lib/spriteChecks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPRITE_DIR = path.join(ROOT, 'src', 'img', 'sprite');
const MANIFEST_PATH = path.join(SPRITE_DIR, 'sprite-manifest.json');
const SHEET_FILES = { directions: 'directions.png', reactions: 'reactions.png' };
const OUT_DIR = path.join(ROOT, '.sprite-check');
const SENTINEL = 'SPRITE-CHECK: NOT-DELIVERED';

/** Grafana 主題參考色（SP-6.3，實查 @grafana/data 的 palette.mjs）。 */
const THEMES = [
  { name: 'dark', bg: [0x18, 0x1b, 0x1f] },
  { name: 'light', bg: [0xff, 0xff, 0xff] },
];
const CONTACT_SIZES = [128, 160, 224];
const MAGENTA = [0xff, 0x00, 0xff, 0xff];

class ToolError extends Error {}

/**
 * manifest 的完整驗證表。**每一個會被 deref 的值都必須在這裡有一列。**
 *
 * ⚠️ **這張表是 SP-7.12「不提供旁路」唯一的機械承接，而它先前不存在。**
 * 原本的 `readManifest` 只驗頂層鍵在不在，不看內容。後果不是「錯誤訊息比較差」，
 * 是**刪掉或拼錯一個欄位等於把那條檢查關掉，而且仍然印 PASS**：
 *
 *   - `margins.opaqueFree` 拼成 `opaque_free` → `band = NaN` → 四個邊界比較全 false
 *     → SP-7.1 的透明帶檢查永不觸發。實測：同一組位元組相同的 PNG，
 *     正確 manifest 是 `FAIL（9 項素材違規）` exit 1，拼錯之後是 `PASS` exit 0。
 *   - 刪掉 `luminance.min` / `luminance.max` / `stroke.width` → `NaN > tol` 與
 *     `L < undefined` 都是 false → 10 個真實違規變成 PASS。實測確認。
 *
 * **刪欄位比放寬門檻更強大**：放寬是一筆看得見的 diff，刪掉是整條關閉。
 * 而 `manifest.sha256` 只涵蓋兩張 PNG、**不涵蓋 manifest 自身**，所以這種編輯是
 * sha256-clean 的 —— 工具檔頭原本宣稱「改門檻會被 sha256 連帶影響」，那句話是錯的。
 *
 * 驗證失敗一律 `ToolError` → exit 2（SP-7.11 的「工具或格式錯誤」），
 * 而且**一次回報全部**，不是撞一個修一個 —— 填這個檔的人通常是畫師不是工程師。
 */
const HEX = /^#?[0-9a-fA-F]{6}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;

function validateManifest(m) {
  const errs = [];
  const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), m);
  const num = (path, { min = -Infinity, max = Infinity, integer = false, optional = false } = {}) => {
    const v = get(path);
    if (v === undefined && optional) {
      return;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errs.push(`${path} 必須是有限數字，實際是 ${JSON.stringify(v)}`);
      return;
    }
    if (integer && !Number.isInteger(v)) {
      errs.push(`${path} 必須是整數，實際是 ${v}`);
    }
    if (v < min || v > max) {
      errs.push(`${path} 必須落在 [${min}, ${max}]，實際是 ${v}`);
    }
  };
  const hex = (path, { optional = false } = {}) => {
    const v = get(path);
    if (v === undefined && optional) {
      return;
    }
    if (typeof v !== 'string' || !HEX.test(v)) {
      errs.push(`${path} 必須是 #RRGGBB 色值，實際是 ${JSON.stringify(v)}${String(v).includes('TBD') ? '（還沒填？樣板在 docs/sprite/sprite-manifest.example.json）' : ''}`);
    }
  };

  // --- sheet 幾何 ---
  for (const k of ['width', 'height', 'cellPx', 'cols', 'rows']) {
    num(`sheet.${k}`, { min: 1, integer: true });
  }
  const g = m.sheet || {};
  if (g.cols !== 3 || g.rows !== 3) {
    // CELL_COUNT 是寫死的 9，而 cellView 只用 cols 算格位；非 3×3 會讓格 4–8 讀到影像外。
    errs.push(`sheet.cols/rows 必須是 3/3（CELL_COUNT 寫死 9），實際是 ${g.cols}/${g.rows}`);
  }
  if (Number.isFinite(g.cols * g.cellPx) && (g.cols * g.cellPx !== g.width || g.rows * g.cellPx !== g.height)) {
    errs.push(`sheet 幾何自相矛盾：${g.cols}×${g.cellPx} ≠ ${g.width} 或 ${g.rows}×${g.cellPx} ≠ ${g.height}`);
  }

  // --- 錨點（§2，全部是 0–1 的比例） ---
  for (const k of ['faceAxisX', 'crownY', 'chinY', 'eyeLineY', 'pupilLeftX', 'pupilRightX', 'mouthCentreY', 'shoulderY', 'headWidth']) {
    num(`anchors.${k}`, { min: 0, max: 1 });
  }
  num('anchors.hairTopMinY', { min: 0, max: 1, optional: true });
  num('anchors.maxSilhouetteWidth', { min: 0, max: 1, optional: true });
  num('anchorToleranceS', { min: 0, max: 1 });
  // 這兩組是 SP-7.5 的區間端點。倒置 → 接受區間為空 → 每一張交付都失敗，
  // 而訊息寫成對畫稿的要求（`必須落在 [0.4, 0.3]·S`），一個沒有任何圖能滿足的要求。
  //
  // ⚠️ 比的是**生效值**不是「兩鍵都在時才比」：兩個 hairTopMinY / maxSilhouetteWidth 都是
  // 選填，只比並存的情況會漏掉「省略選填的那個、把必填的那個壓過預設值」。
  // 預設值來自 spriteChecks.mjs 的 MANIFEST_DEFAULTS —— 驗證器與檢查讀同一份，
  // 否則驗證器用 A 比區間、檢查用 B 算，而那種不一致不會有任何訊息。
  const A = m.anchors || {};
  // 別名 `effective`：本函式內的 num()/hex() 各有一個同名參數 `optional`，
  // 雖然作用域不同，相鄰同名遲早會在某次編輯裡被搞混。
  const eff = (k) => effective(m, 'anchors', k);
  if (Number.isFinite(A.crownY) && eff('hairTopMinY') >= A.crownY) {
    errs.push(`anchors.hairTopMinY 必須小於 anchors.crownY（生效值 ${eff('hairTopMinY')} / ${A.crownY}；髮頂在顱骨頂之上）`);
  }
  if (Number.isFinite(A.headWidth) && A.headWidth >= eff('maxSilhouetteWidth')) {
    errs.push(`anchors.headWidth 必須小於 anchors.maxSilhouetteWidth（生效值 ${A.headWidth} / ${eff('maxSilhouetteWidth')}）`);
  }

  // --- 三個視窗（SP-2.11） ---
  for (const w of ['E', 'B', 'M']) {
    for (const k of ['x0', 'x1', 'y0', 'y1']) {
      num(`windows.${w}.${k}`, { min: 0, max: 1 });
    }
    const r = (m.windows || {})[w] || {};
    if (Number.isFinite(r.x0) && Number.isFinite(r.x1) && r.x0 >= r.x1) {
      errs.push(`windows.${w}.x0 必須小於 x1`);
    }
    if (Number.isFinite(r.y0) && Number.isFinite(r.y1) && r.y0 >= r.y1) {
      errs.push(`windows.${w}.y0 必須小於 y1`);
    }
  }

  // --- 三層留白（SP-2.1） ---
  num('margins.opaqueFree', { min: 0, max: 0.5 });
  num('margins.featherOuter', { min: 0, max: 0.5 });
  const box = (m.margins || {}).silhouetteBox;
  if (!Array.isArray(box) || box.length !== 2 || !box.every((v) => typeof v === 'number' && Number.isFinite(v)) || box[0] >= box[1]) {
    errs.push(`margins.silhouetteBox 必須是 [lo, hi] 兩個有限數字且 lo < hi，實際是 ${JSON.stringify(box)}`);
  }

  // --- 色票（SP-6.0 / SP-6.1） ---
  for (const k of ['lineart', 'iris', 'skin', 'hair']) {
    hex(`colours.${k}`);
  }
  for (const k of ['irisToleranceRgb', 'skinToleranceRgb', 'hairToleranceRgb', 'exemptToleranceRgb']) {
    num(`colours.${k}`, { min: 0, max: 255 });
  }
  const exempt = m.luminanceExemptColours;
  if (exempt !== undefined && (!Array.isArray(exempt) || !exempt.every((v) => typeof v === 'string' && HEX.test(v)))) {
    errs.push('luminanceExemptColours 必須是色值陣列');
  }

  // --- 門檻（SP-6.2 / SP-6.4 / SP-7.6） ---
  num('luminance.min', { min: 0, max: 1 });
  num('luminance.max', { min: 0, max: 1 });
  num('luminance.minAreaFraction', { min: 0, max: 1 });
  const L = m.luminance || {};
  if (Number.isFinite(L.min) && Number.isFinite(L.max) && L.min >= L.max) {
    errs.push('luminance.min 必須小於 luminance.max');
  }
  num('stroke.width', { min: 0, max: 1 });
  num('stroke.tolerance', { min: 0, max: 1 });
  num('stroke.luminanceMin', { min: 0, max: 1 });
  num('stroke.luminanceMax', { min: 0, max: 1 });
  num('stroke.luminanceSlack', { min: 0, max: 1, optional: true });
  // 與五行之上的 luminance.min/max 同形。少了它，把這兩個值對調會讓亮度帶收縮成空集合，
  // 九格全報「量不到描邊（剪影邊緣沒有落在亮度帶內的像素）」—— 輸出裡沒有一個字指向 manifest，
  // 畫師被告知九次他的描邊不見了。
  //
  // ⚠️ 而且倒置幅度小於 2×slack 時會被 slack 的外擴「救回來」（實測 0.20/0.19 → exit 0 PASS）：
  // 一個語意上無意義的 manifest 拿到綠燈，描邊檢查跑在一條被偷偷重建的帶上。
  // 所以這裡比的是原始值而不是套用 slack 之後的帶。
  const S = m.stroke || {};
  if (Number.isFinite(S.luminanceMin) && Number.isFinite(S.luminanceMax) && S.luminanceMin >= S.luminanceMax) {
    errs.push(`stroke.luminanceMin 必須小於 stroke.luminanceMax（實際 ${S.luminanceMin} / ${S.luminanceMax}）`);
  }
  num('gaze.zeroAxisRatio', { min: 0, max: 10, optional: true });
  num('gaze.maskRatioMin', { min: 0, max: 1, optional: true });
  num('gaze.maskRatioMax', { min: 1, max: 10, optional: true });
  // blink.opaqueFraction 已移除：那條「輪廓內 90% 須為 alpha=255」的門檻在抗鋸齒素材上
  // 算術達不到（實測 89.1 / 84.3 / 78.9 / 70.3%），而 SP-2.14 又強制要求羽化 ——
  // 規格自己要求的東西正好讓它失敗。改量「合成後還讀不讀得出虹膜」，見 spriteChecks.mjs。
  num('blink.featherS', { min: 0, max: 0.1, optional: true });
  num('readability.targetPx', { min: 1, integer: true, optional: true });
  num('readability.minBrowContrast', { min: 0, max: 1, optional: true });
  num('budget.perSheetBytes', { min: 1, integer: true });
  num('budget.totalBytes', { min: 1, integer: true });

  // --- 格號語意與產權 ---
  for (const k of ['directions', 'reactions']) {
    const arr = (m.cells || {})[k];
    if (!Array.isArray(arr) || arr.length !== CELL_COUNT) {
      errs.push(`cells.${k} 必須是 ${CELL_COUNT} 個元素的陣列`);
    }
  }
  if (!Array.isArray(m.reactionOwnership) || m.reactionOwnership.length !== CELL_COUNT) {
    errs.push(`reactionOwnership 必須是 ${CELL_COUNT} 個元素的陣列`);
  } else {
    m.reactionOwnership.forEach((code, i) => {
      if (typeof code !== 'string' || code.length === 0 || !/^[EBMK]+$/.test(code)) {
        errs.push(`reactionOwnership[${i}] 必須是由 E/B/M/K 組成的字串，實際是 ${JSON.stringify(code)}`);
      }
    });
  }

  // --- sha256（SP-7.15）---
  for (const name of Object.keys(SHEET_FILES)) {
    const v = (m.sha256 || {})[name];
    if (typeof v !== 'string' || !SHA256.test(v)) {
      errs.push(`sha256.${name} 必須是 64 位十六進位字串，實際是 ${JSON.stringify(v)}${String(v).includes('TBD') ? '（用 sha256sum 算出來填進去）' : ''}`);
    }
  }

  // --- intentionally_empty：規格與工具訊息都用底線寫法，程式卻只讀駝峰 ---
  //
  // ⚠️ 要讀**原始值**再判形狀。先前這裡讀的是 `intentionallyEmpty(m)` 的回傳，
  // 而那支函式把任何非陣列強制成 `[]` —— 於是 `{"reactions":[8]}`、`"reactions:8"`、`8`
  // 三種畸形寫法全部靜默丟棄，結果與「根本沒宣告」逐位元組相同，
  // 而畫師收到的訊息是「去宣告 intentionally_empty」，指向一個他已經填了的鍵。
  // ⚠️ 兩個鍵**各自**驗形狀，不要先用 `??` 挑一個 —— `[] ?? x` 得到 `[]`，
  // 而 `[]` 是合法陣列，於是「駝峰是空陣列、底線是畸形物件」會整個驗不到。
  // （這行原本就是寫成 `??` 的，被新增的 D-1 斷言當場抓到。）
  for (const k of ['intentionallyEmpty', 'intentionally_empty']) {
    if (m[k] !== undefined && !Array.isArray(m[k])) {
      errs.push(`${k} 必須是 [{ sheet, cell }] 陣列，實際是 ${JSON.stringify(m[k])}`);
    }
  }
  const empties = intentionallyEmpty(m);
  if (empties !== null && !empties.every((e) => e && typeof e.sheet === 'string' && Number.isInteger(e.cell))) {
    errs.push('intentionally_empty 的每一項必須是 { sheet, cell }');
  }
  // 兩種拼法並存且內容不同 —— 只取其一會靜默丟掉另一半的宣告（見下方 intentionallyEmpty）。
  if (m.intentionallyEmpty !== undefined && m.intentionally_empty !== undefined) {
    const a = JSON.stringify(m.intentionallyEmpty);
    const b = JSON.stringify(m.intentionally_empty);
    if (a !== b) {
      errs.push(
        `intentionallyEmpty 與 intentionally_empty 兩種拼法同時存在且內容不同（${a} vs ${b}）——` +
          '請只留底線寫法 intentionally_empty（規格與本工具訊息用的都是它）'
      );
    }
  }

  return errs;
}

/**
 * 讀 `intentionally_empty`。
 *
 * ⚠️ **兩種拼法都收，而且取聯集。** SP-7.15、SP-7.1、SP-4 與工具自己印的錯誤訊息
 * （「未宣告 intentionally_empty」）用的都是**底線**寫法，而程式只讀駝峰的
 * `intentionallyEmpty`。後果是：畫師照規格的字填了 `intentionally_empty`，
 * 一個**合規**的空格仍然被判 FAIL，而錯誤訊息叫他去宣告一個他已經宣告了的東西。
 * 這是最惡劣的一種 —— 訊息本身把人推向錯誤的方向。
 *
 * ⚠️ 但用 `??` 取「其中一個」還不夠，因為 **`[] ?? x` 得到 `[]`**：
 * SP-7.15 叫畫師複製的樣板出貨就帶著 `"intentionallyEmpty": []`，
 * 畫師照規格再加一個底線鍵，駝峰的空陣列就**無條件勝出**、底線那邊被整個丟掉，
 * 輸出與「完全沒宣告」逐位元組相同。這正是上面那段註解說它修掉的情況，
 * 而且是最可能發生的那條路徑（2026-09-22 複審實測）。
 * 取聯集則兩種寫法都算數；並存而內容不同時另有一條 validator error 提醒收斂成一種。
 */
function intentionallyEmpty(m) {
  if (m.intentionallyEmpty === undefined && m.intentionally_empty === undefined) {
    return null;
  }
  const a = Array.isArray(m.intentionallyEmpty) ? m.intentionallyEmpty : [];
  const b = Array.isArray(m.intentionally_empty) ? m.intentionally_empty : [];
  return [...a, ...b];
}

/**
 * 在驗證**之前**把字串欄位正規化，讓驗證器與所有消費端看到同一個值。
 *
 * ⚠️ 方向很重要：不是放寬 regex，是在讀入時收斂。兩者的差別在 sha256 上很具體 ——
 * 畫師把 `sha256sum directions.png` 的輸出整行貼進來（`<hash>  directions.png`）時：
 *   - 放寬 regex 讓它通過 → `verifyDigests` 只做 `.toLowerCase()` 不 trim →
 *     比對失敗 → exit 1 的「sha256 不符，換圖必須同時更新 manifest」，
 *     **誣賴畫師換了圖**，而且跳過全部像素檢查。比原本的 exit 2 更糟。
 *   - 讀入時取第一個空白前的 token → 那一貼就是對的，而真正的不符仍然抓得到。
 * 色值同理：`hexToRgb` 本來就 `.trim()`，驗證器卻不 trim，於是驗證器比消費端還嚴格，
 * 把一個下游能正確處理的值擋在門口。
 */
function normaliseManifestStrings(m) {
  if (m.sha256 && typeof m.sha256 === 'object') {
    for (const k of Object.keys(m.sha256)) {
      if (typeof m.sha256[k] === 'string') {
        m.sha256[k] = m.sha256[k].trim().split(/\s+/)[0].toLowerCase();
      }
    }
  }
  if (m.colours && typeof m.colours === 'object') {
    for (const k of Object.keys(m.colours)) {
      if (typeof m.colours[k] === 'string') {
        m.colours[k] = m.colours[k].trim();
      }
    }
  }
  if (Array.isArray(m.luminanceExemptColours)) {
    m.luminanceExemptColours = m.luminanceExemptColours.map((v) => (typeof v === 'string' ? v.trim() : v));
  }
}

function readManifest(manifestPath) {
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new ToolError(`manifest 讀不到：${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    throw new ToolError(`manifest 不是合法 JSON：${err.message}`);
  }
  // ⚠️ 這裡一度先跑一輪 `REQUIRED_MANIFEST_KEYS` 的缺鍵檢查並直接 throw。
  // 那正好製造了 validateManifest 存在的理由所要消滅的東西：缺 `budget` 區塊而另有
  // 6 個問題時，輸出只有一行「manifest 缺少必要欄位：budget」，補上之後下一輪才看到其餘 6 個
  // —— 兩趟往返，而填這個檔的人通常是畫師不是工程師。
  // 實測拿掉之後同一份輸入一次回報 11 項，空物件 `{}` 回報 53 項且不崩，
  // 證明 validateManifest 獨力涵蓋全部 11 個必要鍵。
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    // 非物件會讓 validateManifest 內的屬性存取丟出未捕捉的 TypeError，
    // 被上層標成 CRASH 而不是 SP-7.11 的 exit 2。
    throw new ToolError(`manifest 必須是一個 JSON 物件，實際是 ${Array.isArray(manifest) ? 'array' : typeof manifest}`);
  }
  normaliseManifestStrings(manifest);
  const errs = validateManifest(manifest);
  if (errs.length) {
    throw new ToolError(`manifest 有 ${errs.length} 處不合法：\n` + errs.map((e) => `    - ${e}`).join('\n'));
  }
  // 兩種拼法正規化成一種，讓下游只需要認一個名字。
  manifest.intentionallyEmpty = intentionallyEmpty(manifest) ?? [];
  return manifest;
}

/**
 * SP-7.15：**先比對 sha256 再做像素檢查**。
 * 沒有這一步，換一張圖而不動 manifest 會全部照樣綠 ——
 * 那等於把 SP-7.12「不提供旁路」變成一句空話。
 */
function verifyDigests(manifest, spriteDir) {
  const findings = [];
  const buffers = {};
  const sizes = {};
  for (const [name, file] of Object.entries(SHEET_FILES)) {
    const p = path.join(spriteDir, file);
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch (err) {
      throw new ToolError(`manifest 存在但 ${file} 讀不到：${err.message}`);
    }
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = manifest.sha256[name].toLowerCase();
    if (actual !== expected) {
      findings.push({
        id: 'SP-7.15/sha256',
        severity: 'error',
        sheet: name,
        message: `${file} 的 sha256 為 ${actual}，manifest 記的是 ${expected} —— 換圖必須同時更新 manifest`,
      });
    }
    buffers[name] = buf;
    sizes[name] = buf.length;
  }
  return { findings, buffers, sizes };
}

// --- 產出物 ---------------------------------------------------------------

function cellBuffer(sheet, cell, manifest) {
  const { cellPx } = manifest.sheet;
  const v = cellView(sheet, cell, manifest.sheet);
  const out = new Uint8Array(cellPx * cellPx * 4);
  for (let y = 0; y < cellPx; y++) {
    const src = v.offset(0, y);
    out.set(sheet.data.subarray(src, src + cellPx * 4), y * cellPx * 4);
  }
  return out;
}

/** source-over 合成，兩邊都是同尺寸的 RGBA。 */
function composite(under, over) {
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

function downsampleSquare(buf, size, target) {
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

function flatten(buf, size, bg) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = buf[i + 3] / 255;
    out[i] = Math.round(buf[i] * a + bg[0] * (1 - a));
    out[i + 1] = Math.round(buf[i + 1] * a + bg[1] * (1 - a));
    out[i + 2] = Math.round(buf[i + 2] * a + bg[2] * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

class Canvas {
  constructor(width, height, bg) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = bg[0];
      this.data[i + 1] = bg[1];
      this.data[i + 2] = bg[2];
      this.data[i + 3] = 255;
    }
  }
  blit(buf, size, dx, dy) {
    for (let y = 0; y < size; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) {
        continue;
      }
      for (let x = 0; x < size; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.width) {
          continue;
        }
        const s = (y * size + x) * 4;
        const t = (ty * this.width + tx) * 4;
        this.data[t] = buf[s];
        this.data[t + 1] = buf[s + 1];
        this.data[t + 2] = buf[s + 2];
        this.data[t + 3] = 255;
      }
    }
  }
}

/**
 * SP-7.9 檢查 I — 合成聯絡表。
 *
 * 檢查 A–H 全是像素級／幾何級的不變量，**沒有一條會因為「臉太小看不懂」
 * 或「嘴巴像發條玩具」而紅**。這四張圖是唯一能擋下那類失敗的閘門 ——
 * 它不自動判定，它只負責讓人一眼看到。
 */
function writeContactSheets(sheets, manifest, outDir) {
  const { cellPx } = manifest.sheet;
  const pad = 12;
  const written = [];

  const emit = (fileName, items) => {
    // 版面：每個主題一個橫帶，帶內每個尺寸一列，列內每個項目並排
    const rowH = CONTACT_SIZES.reduce((s, n) => s + n + pad, pad);
    const width = pad + items.length * (Math.max(...CONTACT_SIZES) + pad);
    const canvas = new Canvas(width, THEMES.length * rowH, THEMES[0].bg);
    THEMES.forEach((theme, ti) => {
      const bandTop = ti * rowH;
      for (let y = bandTop; y < bandTop + rowH && y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const o = (y * canvas.width + x) * 4;
          canvas.data[o] = theme.bg[0];
          canvas.data[o + 1] = theme.bg[1];
          canvas.data[o + 2] = theme.bg[2];
        }
      }
      let top = bandTop + pad;
      for (const size of CONTACT_SIZES) {
        items.forEach((buf, i) => {
          const small = flatten(downsampleSquare(buf, cellPx, size), size, theme.bg);
          canvas.blit(small, size, pad + i * (Math.max(...CONTACT_SIZES) + pad), top);
        });
        top += size + pad;
      }
    });
    const p = path.join(outDir, fileName);
    fs.writeFileSync(p, encodePng(canvas.width, canvas.height, canvas.data));
    written.push(path.relative(ROOT, p));
  };

  const master = cellBuffer(sheets.directions, 4, manifest);
  const mouthClosed = master;

  // 1. 九個視線格 × master 情緒
  emit(
    'contact-1-gaze.png',
    Array.from({ length: CELL_COUNT }, (_, c) => cellBuffer(sheets.directions, c, manifest))
  );
  // 2. 三個情緒 × 閉口（warning=1 / critical=2 / resolved=3）
  emit(
    'contact-2-emotions.png',
    [1, 2, 3].map((r) => composite(mouthClosed, cellBuffer(sheets.reactions, r, manifest)))
  );
  // 4. pending（格 8）與 click（格 0）各一張
  emit(
    'contact-4-reactions.png',
    [8, 0].map((r) => composite(master, cellBuffer(sheets.reactions, r, manifest)))
  );

  // 3. 張口/閉口交替的 GIF。嘴型幀是 reactions 4（半開）與 5（大開）。
  //    GIF 承載不了 alpha 的抗鋸齒邊緣，所以先合成到 dark panel 底色上（見 gif.mjs 檔頭）。
  const frames = [mouthClosed, composite(master, cellBuffer(sheets.reactions, 4, manifest)), composite(master, cellBuffer(sheets.reactions, 5, manifest))]
    .map((buf) => flatten(downsampleSquare(buf, cellPx, 160), 160, THEMES[0].bg));
  const gifPath = path.join(outDir, 'contact-3-mouth.gif');
  fs.writeFileSync(gifPath, encodeGif({ width: 160, height: 160, frames: [frames[0], frames[1], frames[0], frames[2]], delayCs: 18 }));
  written.push(path.relative(ROOT, gifPath));

  return written;
}

/**
 * SP-7.10 的診斷**圖**（表在 `report()` 裡）。
 * 規格明寫「只印『不過』而不印『差多少』不符本規格」—— 圖是那句話的另一半：
 * 差異像素以洋紅標示（沿用 check_layers.py 的粉紅慣例），人才知道差在哪裡。
 */
function writeDiffImages(sheets, manifest, findings, outDir) {
  const { cellPx } = manifest.sheet;
  const base = cellBuffer(sheets.directions, 4, manifest);
  const E = windowRect(manifest.windows.E, cellPx);
  const written = [];

  // ⚠️ **每一種帶格號的失敗都要有圖，不只 SP-7.2。**
  // 原本 `headFails` 只從 `SP-7.2/頭部不動` 建，而 SP-7.4/視窗產權、SP-6.6/皮膚遮罩、
  // SP-7.4/眨眼吃眉、SP-7.1/透明帶 全部沒有圖。畫師拿到的是一個座標與一格 512×512
  // 要自己找 —— 而 SP-7.10 逐字寫「只印『不過』而不印『差多少』不符本規格」。
  const bySheetCell = new Map();
  for (const f of findings) {
    if (f.severity !== 'error' || f.cell === undefined || !f.sheet) {
      continue;
    }
    const key = `${f.sheet}:${f.cell}`;
    if (!bySheetCell.has(key)) {
      bySheetCell.set(key, []);
    }
    bySheetCell.get(key).push(f.id);
  }

  for (const [key, ids] of bySheetCell) {
    const [sheetName, cellStr] = key.split(':');
    const cell = Number(cellStr);
    const sheet = sheets[sheetName];
    if (!sheet) {
      continue;
    }
    const buf = cellBuffer(sheet, cell, manifest);
    const out = flatten(buf, cellPx, THEMES[0].bg);
    let marked = 0;

    if (sheetName === 'directions') {
      // 與 master frame 逐像素比，眼窗外的差異標洋紅（SP-7.2 的失敗模式）
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          if (cell !== 4 && x >= E.x0 && x < E.x1 && y >= E.y0 && y < E.y1) {
            continue;
          }
          const o = (y * cellPx + x) * 4;
          const differs =
            Math.abs(base[o] - buf[o]) > 2 ||
            Math.abs(base[o + 1] - buf[o + 1]) > 2 ||
            Math.abs(base[o + 2] - buf[o + 2]) > 2 ||
            Math.abs(base[o + 3] - buf[o + 3]) > 2;
          if (differs) {
            out.set(MAGENTA, o);
            marked++;
          }
        }
      }
    } else {
      // reactions：把**越界**的非零 alpha 標洋紅（SP-7.4 / SP-6.6 的失敗模式）
      const allow = ownershipMaskFor(manifest, cell);
      const skin = skinMask(sheets.directions, manifest);
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          const o = (y * cellPx + x) * 4;
          if (buf[o + 3] === 0) {
            continue;
          }
          const i = y * cellPx + x;
          if (!allow[i] || !skin[i]) {
            out.set(MAGENTA, o);
            marked++;
          }
        }
      }
    }

    const p = path.join(outDir, `diff-${sheetName}-${cell}.png`);
    fs.writeFileSync(p, encodePng(cellPx, cellPx, out));
    written.push(`${path.relative(ROOT, p)}（${ids.join(' ')}：${marked} 個洋紅像素）`);
  }
  return written;
}

/** 取某一格的產權允許遮罩。`spriteChecks` 的 `ownershipMask` 未 export，這裡用同一組規則重建。 */
function ownershipMaskFor(manifest, cell) {
  const { cellPx } = manifest.sheet;
  const code = manifest.reactionOwnership[cell] ?? '';
  const mask = new Uint8Array(cellPx * cellPx);
  const rects = { E: windowRect(manifest.windows.E, cellPx), B: windowRect(manifest.windows.B, cellPx), M: windowRect(manifest.windows.M, cellPx) };
  const inR = (x, y, r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
  if (code.includes('K')) {
    const lo = Math.floor(manifest.margins.silhouetteBox[0] * cellPx);
    const hi = Math.ceil(manifest.margins.silhouetteBox[1] * cellPx);
    for (let y = lo; y < hi; y++) {
      for (let x = lo; x < hi; x++) {
        if (!inR(x, y, rects.E) && !inR(x, y, rects.B) && !inR(x, y, rects.M)) {
          mask[y * cellPx + x] = 1;
        }
      }
    }
  }
  for (const k of ['E', 'B', 'M']) {
    if (!code.includes(k)) {
      continue;
    }
    const r = rects[k];
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        if (x >= 0 && y >= 0 && x < cellPx && y < cellPx) {
          mask[y * cellPx + x] = 1;
        }
      }
    }
  }
  return mask;
}

// --- 報表 -----------------------------------------------------------------

function report(findings, centroids, manifest, log = console.log) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');

  const rows = [];
  for (let c = 0; c < CELL_COUNT; c++) {
    const mine = findings.filter((f) => f.cell === c);
    const cov = mine.find((f) => f.id === 'SP-7.1/覆蓋率');
    const ctr = centroids?.[c];
    rows.push({
      格: c,
      語意: `${manifest.cells.directions[c]} / ${manifest.cells.reactions[c]}`,
      覆蓋率: cov ? `${(cov.measured * 100).toFixed(1)}%` : '-',
      虹膜質心: ctr && ctr.n > 0 ? `${ctr.cx.toFixed(1)},${ctr.cy.toFixed(1)}` : '-',
      // ⚠️ 遮罩像素數必須印出來。SP-7.15 要人工把質心抄進 manifest 當日後的回歸基準，
      // 而只看質心分辨不出「虹膜移動」與「眼窗裡混進同色像素」—— 一次受污染的交付
      // 會重新定義「正確」。n 是分辨它們的唯一線索。
      遮罩px: ctr && ctr.n > 0 ? String(ctr.n) : '-',
      失敗: mine.filter((f) => f.severity === 'error').map((f) => f.id).join(' ') || '-',
    });
  }
  log('\n--- 逐格診斷（SP-7.10）---');
  log(renderTable(rows));

  const detail = (f) => {
    const where = [f.sheet, f.cell !== undefined ? `格${f.cell}` : null].filter(Boolean).join(' ');
    const over =
      f.measured !== undefined && f.limit !== undefined
        ? `  [實測 ${fmt(f.measured)} / 上限 ${fmt(f.limit)}；超出 ${fmt(Math.abs(f.measured - f.limit))}]`
        : '';
    return `  ${f.id.padEnd(20)} ${where.padEnd(18)} ${f.message}${over}`;
  };
  if (errors.length) {
    log(`\n--- 素材違規 ${errors.length} 項 ---`);
    errors.forEach((f) => log(detail(f)));
  }
  if (warns.length) {
    log(`\n--- 警告 ${warns.length} 項（首版僅記錄）---`);
    warns.forEach((f) => log(detail(f)));
  }
  return errors.length;
}

/** 自繪表格：`console.table` 不吃注入的 log，且中日文欄寬會亂。 */
function renderTable(rows) {
  const cols = Object.keys(rows[0]);
  const wide = (v) => [...String(v)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  const w = cols.map((c) => Math.max(wide(c), ...rows.map((r) => wide(r[c]))));
  const padTo = (v, n) => String(v) + ' '.repeat(Math.max(0, n - wide(v)));
  const line = (cells) => '  ' + cells.map((v, i) => padTo(v, w[i])).join('  ');
  return [line(cols), '  ' + w.map((n) => '-'.repeat(n)).join('  '), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

/**
 * 數字格式化。
 *
 * ⚠️ **接近門檻時不能全部塌成同一個數字。** 原本一律 `toFixed(4)`，於是一個
 * 相對亮度 0.0469656（比下限 0.047 低 0.0000344）的真實違規會印成
 * `[實測 0.0470 / 上限 0.0470；超出 0.0000]` —— 讀起來像工具壞了或誤報，
 * 而它是對的。畫師看到這一行不會知道要改什麼。
 * 小到 toFixed(4) 會變成全零時改用科學記號。
 */
function fmt(n) {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  if (Math.abs(n) >= 1000 || Number.isInteger(n)) {
    return String(n);
  }
  const fixed = n.toFixed(4);
  return Number.parseFloat(fixed) === 0 && n !== 0 ? n.toExponential(2) : fixed;
}

// --- 主流程 ---------------------------------------------------------------

/**
 * 跑一次完整檢查，回傳 SP-7.11 的退出碼。
 *
 * **參數化 spriteDir / outDir 不是旁路**（SP-7.12）：它換的是「檢查哪一組檔案」，
 * 換不掉任何一條檢查、也放寬不了任何一個門檻。CLI 一律以 repo 內的固定路徑呼叫，
 * 沒有對應的命令列旗標；參數的唯一用途是讓 selftest 能餵合成 fixture 進來，
 * 而那正是這些檢查會不會變成裝飾品的分水嶺。
 */
export function runCheck({ spriteDir = SPRITE_DIR, outDir = OUT_DIR, log = console.log } = {}) {
  const manifestPath = path.join(spriteDir, 'sprite-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // SP-7.14：跳過本身要看得見。asp-test.sh 擷取這一行串進 .asp-test-result.json。
    log(SENTINEL);
    return 0;
  }

  const manifest = readManifest(manifestPath);
  const { findings: digestFindings, buffers, sizes } = verifyDigests(manifest, spriteDir);
  if (digestFindings.length) {
    // SP-7.15：sha256 不符就不往下做像素檢查 —— 底下每一條測的都會是「不是宣告的那張圖」。
    digestFindings.forEach((f) => log(`  ${f.id}  ${f.sheet}  ${f.message}`));
    log('\nsha256 不符，像素檢查未執行。');
    return 1;
  }

  const sheets = {};
  for (const [name, buf] of Object.entries(buffers)) {
    try {
      sheets[name] = decodePng(buf);
    } catch (err) {
      if (err instanceof PngFormatError) {
        throw new ToolError(`${SHEET_FILES[name]}：${err.message}`);
      }
      throw err;
    }
  }

  const findings = [];
  findings.push(...checkFormatAndHygiene(sheets, manifest));
  findings.push(...checkHeadImmobility(sheets.directions, manifest));
  const gaze = checkGazeBinding(sheets.directions, manifest);
  findings.push(...gaze.findings);
  findings.push(...checkOverlayOwnership(sheets, manifest));
  findings.push(...checkAnchors(sheets.directions, manifest, gaze.centroids));
  findings.push(...checkLuminanceAndStroke(sheets.directions, manifest));
  findings.push(...checkDownsampleReadability(sheets, manifest));
  findings.push(...checkFileSize(sizes, manifest));

  fs.mkdirSync(outDir, { recursive: true });
  const artefacts = [...writeContactSheets(sheets, manifest, outDir)];
  artefacts.push(...writeDiffImages(sheets, manifest, findings, outDir));

  const errorCount = report(findings, gaze.centroids, manifest, log);
  log(`\n產出物（SP-7.9 / SP-7.10）：\n${artefacts.map((p) => `  ${p}`).join('\n')}`);
  log(errorCount === 0 ? '\nSPRITE-CHECK: PASS' : `\nSPRITE-CHECK: FAIL（${errorCount} 項素材違規）`);
  return errorCount === 0 ? 0 : 1;
}

function main() {
  return runCheck();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main());
  } catch (err) {
    // ⚠️ **每一條路徑都必須印一個 `SPRITE-CHECK:` 開頭的字串。**
    // 原本非 ToolError 的例外直接印裸 stack，沒有前綴 —— 而 `tools/asp-test.sh` 是
    // **純靠這些字串分類**的（case 有四個 arm）。結果是每一個這類 crash 都落進
    // 「其他」那一臂，被記成「sprites: 素材違規」，也就是把一個 exit 2 的工具錯誤
    // 寫成 exit 1 的素材問題 —— 操作者會去找畫師，而問題在工具。
    if (err instanceof ToolError) {
      console.error(`SPRITE-CHECK: TOOL-ERROR  ${err.message}`);
    } else {
      console.error('SPRITE-CHECK: CRASH  工具自己壞了，不是素材的問題。堆疊如下：');
      console.error(err);
    }
    process.exit(2);
  }
}

export { main, SENTINEL, MANIFEST_PATH, SHEET_FILES, SPRITE_DIR, OUT_DIR, ToolError };
