#!/usr/bin/env node
/**
 * 描邊寬度估計器的**正規電池**。`node tools/stroke-battery.mjs`。
 *
 * ⚠️ **這支存在的理由：先前沒有共用的測試台，所以沒有人能比較兩個估計器。**
 * 2026-09-22 跑過一輪五設計 × 五評審的重寫比較，每個 agent 各自造 fixture，
 * 得到的數字互不可比 —— 最後連「新的有沒有比舊的好」都驗不出來，整批退回。
 * 卡點從來不是演算法，是測試台。
 *
 * 電池的每一列都對應一個**真實畫稿必然有**的性質（抗鋸齒、內/外描邊、
 * 填色溢出、細髮束、matte 匯出、同亮度的合法填色），或一個**真的畫錯**的描邊。
 * `want` 欄寫的是「這一列應該通過還是應該紅」—— 兩個方向都要對才算數：
 * 只看「壞的會紅」分辨不出「每一列都恆紅」這種壞掉的檢查。
 *
 * 改估計器時先跑這支，判對數不得下降。
 *
 * **退出碼**：0 = 判錯的列與 `KNOWN_FAIL` 逐列相符；1 = 不相符（兩個方向都算）；2 = 工具錯誤。
 * 這支先前**只印不判** —— 沒有 `process.exit`、不在 `asp-test.sh`、不在 `ci.yml`、
 * 不在 selftest，全 repo 只有四處散文提到它。實測把 `measureStrokeWidths` 換成
 * 回傳定值的樁，計分板由 19/20 崩到 5/20，而它**仍然回 0**。
 * 上面那句「判對數不得下降」於是沒有任何機械承接。
 */
import { buildManifest, buildSheets } from './lib/syntheticSheet.mjs';
import { measureStrokeWidths } from './lib/spriteChecks.mjs';
const m = buildManifest();
const TRUE = m.stroke.width * m.sheet.cellPx;
const TOL = m.stroke.tolerance * m.sheet.cellPx;

/** 正規電池。`want` = 這個案例**應該**通過還是應該紅。 */
export const BATTERY = [
  // ⚠️ A 列必須顯式寫 `alphaRampPx: 0`。先前它是 `{}`，而 `aa7ef08` 把
  // syntheticSheet 的預設羽化由 0 改成 2 —— 於是 A 與 B 變成**同一張 fixture**
  // （兩列都讀 7.553），電池裡再也沒有 1-bit 那一列，而估計器 docblock 第 1 點
  // 講的正是 1-bit 邊緣。標籤說它是 1-bit，實際上不是，沒有東西會發現。
  ['A 基準（外描邊、1-bit）',        { alphaRampPx: 0 },                                         'pass'],
  ['B 抗鋸齒 2px（SP-2.14 下限）',   { alphaRampPx: 2 },                                         'pass'],
  ['C 抗鋸齒 4px',                  { alphaRampPx: 4 },                                         'pass'],
  ['D 內描邊',                      { strokeInside: true },                                     'pass'],
  ['E 內描邊 + 抗鋸齒',              { strokeInside: true, alphaRampPx: 2 },                     'pass'],
  ['F 四根漸細髮束',                 { strands: true },                                          'pass'],
  ['G 髮束 + 抗鋸齒',                { strands: true, alphaRampPx: 2 },                          'pass'],
  ['H 填色溢出 1px',                { fillBleedPx: 1, alphaRampPx: 2 },                         'pass'],
  ['I 填色溢出 3px',                { fillBleedPx: 3, alphaRampPx: 2 },                         'pass'],
  ['J 同亮度衣物 #7c7c7c',          { inBandGarment: true, alphaRampPx: 2 },                    'pass'],
  ['K 四種一次上',                  { strokeInside: true, strands: true, fillBleedPx: 1, inBandGarment: true, alphaRampPx: 2 }, 'pass'],
  ['L 黑 matte 匯出',               { alphaRampPx: 3, matte: '#000000' },                       'pass'],
  ['M 白 matte 匯出',               { alphaRampPx: 3, matte: '#ffffff' },                       'pass'],
  ['N 真的太細 4px',                { strokePx: 4 },                                            'fail'],
  ['O 真的太細 6.5px',              { strokePx: 6.5 },                                          'fail'],
  ['P 真的太粗 10.5px',             { strokePx: 10.5 },                                         'fail'],
  ['Q 真的太粗 12px',               { strokePx: 12 },                                           'fail'],
  ['R 窗內邊緣 7.4px',              { strokePx: 7.4 },                                          'pass'],
  ['S 窗內邊緣 9.0px',              { strokePx: 9.0 },                                          'pass'],
  ['T 單格不同寬（SP-6.5）',         { perCellStrokePx: { 5: 10.0 } },                           'fail'],
];

/**
 * 目前**已知**會判錯的列（取列首字母）。空集合 = 全對。
 *
 * **R 曾在這裡（2026-09-28～29）**：讀 6.716（−1.476）誤紅。當時歸因於估計器的
 * 內緣半像素偏差 —— 但真正的大頭是 **fixture 自己**：applyAlphaRamp 的斜坡相位
 * 以邊界像素中心為零點（幾何邊界在它外緣 +0.5px），每條羽化邊覆蓋積分淨損 0.5px，
 * 也就是「7.4px 的列」實際只畫出 ~6.9px。修正相位（守恆斜坡）後 R 讀 7.170、
 * 全電池 20/20，估計器一行都沒改。剩餘 −0.2 上下的偏差與獨立複審用解析地面真值
 * 量到的 −0.29 一致，來源是內緣（描邊↔填色）的硬分類 —— 合成 fixture 內緣無混色
 * 所以量不到它，真素材才會。
 *
 * **為什麼釘「哪幾列」而不是釘「判對幾列」**：只釘數量分辨不出
 * 「R 修好了但 S 壞了」—— 總數不變，而護欄該紅。兩個方向都要對。
 */
export const KNOWN_FAIL = new Set([]);

export function run(measure) {
  const rows = [];
  for (const [name, opts, want] of BATTERY) {
    const w = measure(buildSheets(opts).directions, m);
    const v = Array.isArray(w) ? (typeof w[0] === 'object' ? w[0].width : w[0]) : NaN;
    const all = Array.isArray(w) ? w.map((x) => (typeof x === 'object' ? x.width : x)) : [];
    const spread = all.length ? Math.max(...all) - Math.min(...all) : NaN;
    const verdict = Number.isFinite(v) && Math.abs(v - TRUE) <= TOL && spread <= TOL ? 'pass' : 'fail';
    rows.push({ name, want, got: verdict, width: v, err: v - TRUE, spread, correct: verdict === want });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = run(measureStrokeWidths);
  console.log(`真值 ${TRUE.toFixed(3)} px，容差 ±${TOL.toFixed(3)}\n`);
  console.log('案例                           寬度     誤差    跨格    應該  實得  對?');
  for (const r of rows) {
    console.log(
      r.name.padEnd(28) + ' ' +
      (Number.isFinite(r.width) ? r.width.toFixed(3) : 'NaN').padStart(7) + ' ' +
      (Number.isFinite(r.err) ? (r.err >= 0 ? '+' : '') + r.err.toFixed(3) : '   —').padStart(7) + ' ' +
      (Number.isFinite(r.spread) ? r.spread.toFixed(3) : '  —').padStart(6) + '  ' +
      r.want.padEnd(5) + ' ' + r.got.padEnd(5) + ' ' + (r.correct ? '✓' : '✗')
    );
  }
  const ok = rows.filter((r) => r.correct).length;
  console.log(`\n判對 ${ok} / ${rows.length}`);

  const wrong = rows.filter((r) => !r.correct).map((r) => r.name.split(' ')[0]).sort();
  const pinned = [...KNOWN_FAIL].sort();
  const unexpected = wrong.filter((k) => !KNOWN_FAIL.has(k));
  const fixed = pinned.filter((k) => !wrong.includes(k));

  if (unexpected.length === 0 && fixed.length === 0) {
    console.log(`STROKE-BATTERY: PASS  判錯的列與 KNOWN_FAIL 相符（${pinned.join(', ') || '空集合'}）`);
  } else {
    if (unexpected.length) {
      console.error(`STROKE-BATTERY: FAIL  新增判錯的列：${unexpected.join(', ')} —— 估計器退步了`);
    }
    if (fixed.length) {
      console.error(
        `STROKE-BATTERY: FAIL  ${fixed.join(', ')} 不再判錯 —— 這是好事，` +
          '但要把它從 tools/stroke-battery.mjs 的 KNOWN_FAIL 移除，否則下次退步時看不出來'
      );
    }
    process.exitCode = 1;
  }
}
