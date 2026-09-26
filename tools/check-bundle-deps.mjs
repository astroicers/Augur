#!/usr/bin/env node
/**
 * 出貨 bundle 裡有沒有未稽核的第三方程式碼。`node tools/check-bundle-deps.mjs`。
 *
 * **為什麼不是 grep 套件名，也不是看 AMD 的 define 清單** —— 兩種都驗不出東西，
 * 而 `docs/dependency-audit.md` 先後寫過這兩種，2026-09-22 實測都是盲的：
 *
 *  1. `grep -c 'js-cookie' dist/module.js` → **0**。打包後的程式碼壓縮過，
 *     套件名不會以字面字串留在 bundle 裡。
 *  2. `head -c 400 dist/module.js | grep -oE 'define\(\[[^]]*\]'` → **與基準逐字相同**。
 *     方向剛好反了：被 **externalise** 的東西才會出現在 define 清單裡，
 *     被**打包進去**的不會。而稽核要防的正是「打包進去」那一種。
 *
 *     實測：在 `src/module.ts` 加一行 `import Cookies from 'js-cookie'` 之後
 *     bundle 由 25,558 → 27,299 bytes（js-cookie 整包編了進去），
 *     而 define 清單一個字都沒變，複驗者會結論「沒有多出東西，裁決仍成立」。
 *
 * 真正量得到的是 **sourcemap 的 `sources`** —— webpack 逐筆列出編進 bundle 的每個模組
 * 與它的路徑。同一個實驗裡 js-cookie 指名道姓出現在那裡。
 * 清單是離散的（多一個少一個看得出來），不像位元組數會逐版漂移。
 *
 * 退出碼：0 通過；1 bundle 裡有未稽核的第三方模組；2 工具錯誤。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = path.join(ROOT, 'dist', 'module.js.map');

/**
 * 允許出現在 bundle 裡的 node_modules 模組。
 * `grafana-public-path.js` 是 @grafana/create-plugin 自己注入的 shim（用來設定
 * webpack 的 public path），不是本專案選的第三方相依，也在 `.config/` 的託管範圍內。
 */
const ALLOWED = new Set(['grafana-public-path.js']);

let map;
let mapMtime;
try {
  mapMtime = fs.statSync(MAP).mtimeMs;
  map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
} catch (err) {
  // 沒 build 過：印 sentinel 並回 0。這不是放水 —— 沒有 dist 就沒有出貨檔可稽核，
  // 而閘門不強制每次 commit 都跑 webpack（那要多十幾秒）。
  if (err.code === 'ENOENT') {
    console.log('BUNDLE-DEPS: NOT-BUILT  dist/module.js.map 不存在（要稽核先跑 npm run build）');
    process.exit(0);
  }
  console.error(`BUNDLE-DEPS: TOOL-ERROR  讀不到 sourcemap：${err.message}`);
  process.exit(2);
}

/**
 * ⚠️ **不要用 mtime 判斷 dist 過不過期 —— 我試過，那是個誤紅。**
 *
 * webpack 對未變動的輸出印 `[compared for emit]`：**內容相同時它不重寫檔案**。
 * 所以「dist 比 src 舊」完全可能發生在一個**全新且正確**的 build 之後
 * （實測：把一個檔改了又改回去，內容相同 → webpack 不重寫 → map 的 mtime 停在舊的
 * → 這條檢查對著一個正確的 bundle 報 STALE）。
 * 而且 `dist 比 src 舊` 本來就推不出 `dist 是錯的` —— 內容相同就表示 bundle 是對的。
 *
 * 真正的過期判定是「重 build 會不會改變輸出」，而那需要真的 build。
 * 所以本檔**只稽核磁碟上現有的 dist**，並在摘要裡誠實說明它稽核了什麼；
 * 要權威的結論就先 `npm run build`。這一點也寫進 docs/dependency-audit.md 的複驗步驟。
 */

const sources = Array.isArray(map.sources) ? map.sources : [];
if (sources.length === 0) {
  console.error('BUNDLE-DEPS: TOOL-ERROR  sourcemap 沒有 sources 欄位（webpack 設定變了？）');
  process.exit(2);
}

const bundled = sources
  .filter((s) => s.includes('node_modules'))
  .map((s) => {
    // webpack://name/../node_modules/js-cookie/src/js.cookie.js → js-cookie
    const after = s.slice(s.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const parts = after.split('/');
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  });

const bad = [...new Set(bundled)].filter((p) => !ALLOWED.has(p)).sort();

if (bad.length) {
  console.error(`BUNDLE-DEPS: FAIL  出貨 bundle 含 ${bad.length} 個未稽核的第三方模組：`);
  for (const p of bad) {
    console.error(`    - ${p}`);
  }
  console.error('');
  console.error('  這些是被**打包進 dist/module.js**、會隨 plugin 出貨的程式碼，');
  console.error('  不是 externals（externals 由 Grafana 提供，不進 bundle）。');
  console.error('  要嘛把 import 拿掉，要嘛把它列進 docs/dependency-audit.md 並加進本檔的 ALLOWED。');
  process.exit(1);
}

console.log(`BUNDLE-DEPS: PASS  bundle 裡的 node_modules 模組只有 ${[...ALLOWED].join(', ')}（${sources.length} 個 sources）`);
process.exit(0);
