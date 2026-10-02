/**
 * SP-8 實作契約的機械承接（規格：docs/sprite/sprite-sheet-spec.md §SP-8）。
 *
 * **為什麼放 jest 而不是另開一道閘門**：這些規則的違反全是「typecheck 綠、
 * bundle 或執行期才爆」的類型 —— CI 的 build 步驟能抓到其中一部分，但錯誤
 * 訊息（`Module parse failed`、`TS2300 Duplicate identifier`）不會告訴你
 * 是哪條規格、為什麼。放 jest 讓它自動進 MIN_TESTS 與 CI，不加閘門道數。
 *
 * 2026-09-29 的文件審計：spec 的 127 條 SP-* 規則有 85 條沒有任何機械承接，
 * 其中 SP-8（實作契約）整族 17 條全靠散文。這裡接住的是「素材接入時
 * （SpriteController / spriteAssets）最會踩、且踩下去最安靜」的四條，
 * 外加 SP-1.5（唯一被量測支撐的 CSS 禁令）。
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..');
const ROOT = path.resolve(SRC, '..');

/** 遞迴列出 src/ 下的 .ts/.tsx（排除測試 —— 契約管生產碼）。 */
function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__') {
          walk(p);
        }
      } else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
}

test('SP-8.5：不得存在 src/images.d.ts —— 腳手架的 bundler-rules.d.ts 已宣告，重複會 TS2300', () => {
  expect(fs.existsSync(path.join(SRC, 'images.d.ts'))).toBe(false);
});

test('SP-8.3：不得 import .webp —— 型別宣告有它而 webpack 資產規則沒有，typecheck 綠、bundle 才爆', () => {
  const hits: string[] = [];
  for (const f of srcFiles()) {
    const txt = fs.readFileSync(f, 'utf8');
    // 與 check-js-suffix 同一族的判定：import/require 的來源字串以 .webp 結尾。
    if (/(from|import|require)\s*\(?\s*['"][^'"]*\.webp['"]/.test(txt)) {
      hits.push(path.relative(ROOT, f));
    }
  }
  expect(hits).toEqual([]);
});

test('SP-8.2：cellToBackgroundPosition 的定義只有 gaze.ts 那一份 —— 其他檔案只准 import/re-export', () => {
  const defs: string[] = [];
  for (const f of srcFiles()) {
    const txt = fs.readFileSync(f, 'utf8');
    // 「定義」= function 宣告或指派；import { … } / export { … } 不算。
    if (/(?:function|const|let)\s+cellToBackgroundPosition\s*[(=]/.test(txt)) {
      defs.push(path.relative(ROOT, f));
    }
  }
  expect(defs).toEqual(['src/avatar/gaze.ts']);
});

test('SP-8.6：根 jest.config.js 必須合併 .config 的設定，不得整份覆蓋', () => {
  // 誠實記：整份覆蓋時 jest 自己會先跑不動（transform 全丟 → 0 total），
  // 那個情況抓它的是 asp-test.sh 的 MIN_TESTS 下限，不是這條斷言。
  // 這條防的是「部分覆蓋」—— 保留 transform 但丟掉 moduleNameMapper 之類，
  // jest 還能跑而行為悄悄變了的那種。
  const txt = fs.readFileSync(path.join(ROOT, 'jest.config.js'), 'utf8');
  expect(txt).toMatch(/require\(['"]\.\/\.config\/jest\.config['"]\)/);
});

test('SP-1.5：src/ 中出現的每個 background-size 都必須是 300% 300%', () => {
  // 唯一被量測支撐的 CSS 禁令：`auto 300%` 實測在 150×100 的元素上污染
  // 5000/15000 像素；`300% 300%` 在任何長寬比下都不滲色。
  // SpriteController 還不存在時本條自然通過（零出現），它進來時自動生效。
  const bad: string[] = [];
  for (const f of srcFiles()) {
    const txt = fs.readFileSync(f, 'utf8');
    const re = /background-?[sS]ize['"]?\s*[:=]\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      if (m[1]!.trim() !== '300% 300%') {
        bad.push(`${path.relative(ROOT, f)}: ${m[1]}`);
      }
    }
  }
  expect(bad).toEqual([]);
});
