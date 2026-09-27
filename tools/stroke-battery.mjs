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
 */
import { buildManifest, buildSheets } from './lib/syntheticSheet.mjs';
import { measureStrokeWidths } from './lib/spriteChecks.mjs';
const m = buildManifest();
const TRUE = m.stroke.width * m.sheet.cellPx;
const TOL = m.stroke.tolerance * m.sheet.cellPx;

/** 正規電池。`want` = 這個案例**應該**通過還是應該紅。 */
export const BATTERY = [
  ['A 基準（外描邊、1-bit）',        {},                                                        'pass'],
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
}
