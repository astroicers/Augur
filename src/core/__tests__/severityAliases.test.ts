/**
 * 嚴重度別名(#35)。
 *
 * 這支檔案把三件事釘住:
 *  1. **留空 = 行為完全相同**(AC-1)。不是「看起來一樣」而是恆等:
 *     `resolveSeverity` 在空表下回傳同一個值,`rankOf`/`meetsMin`/`severityToEmotion`
 *     於是連輸入都沒變。
 *  2. 命中別名時那三個函式**都**以標準嚴重度判斷(AC-2),沒命中的照舊 unknown/calm。
 *  3. 格式錯誤只讓該項失效、不拋、可回報(AC-3)。
 */
import * as fs from 'fs';
import * as path from 'path';
import { meetsMin, normalize, rankOf } from '../severity';
import { severityToEmotion } from '../emotion';
import { buildBroadcastPlan } from '../format';
import { describeSkippedAliases, parseSeverityAliases, resolveSeverity, type SkippedAlias } from '../severityAliases';
import type { ParsedAlert } from '../types';

const SPEC = 'P1=critical, sev2=warning, disaster=critical';

// --- AC-1:留空 ---------------------------------------------------------------

test('AC-1:留空/只有空白/非字串 → 空表、零略過', () => {
  for (const spec of ['', '   ', '\n', ',', ' , ; ', undefined, null, 42, {}, [], true]) {
    const { aliases, skipped } = parseSeverityAliases(spec);
    expect(aliases.size).toBe(0);
    expect(skipped).toEqual([]);
  }
});

test('AC-1:空別名表下 resolveSeverity 是恆等函式（原值原樣回傳，含非字串）', () => {
  const empty = parseSeverityAliases('').aliases;
  const obj = {};
  for (const v of ['critical', 'P1', '  Warning  ', '', 'garbage', undefined, null, 42, NaN, obj]) {
    // 不只是「相等」——要同一個值/同一個參考,才談得上「行為完全相同」。
    expect(resolveSeverity(v, empty)).toBe(v);
    expect(resolveSeverity(v)).toBe(v); // 省略參數(既有呼叫點的形狀)
  }
  expect(resolveSeverity(obj, empty)).toBe(obj);
});

test('AC-1:留空時三個函式的判斷與沒有別名時逐一相同', () => {
  const empty = parseSeverityAliases('').aliases;
  for (const v of ['critical', 'error', 'warning', 'info', 'unknown', 'P1', 'garbage', undefined, null, 42]) {
    expect(rankOf(resolveSeverity(v, empty))).toBe(rankOf(v));
    expect(meetsMin(resolveSeverity(v, empty), 'warning')).toBe(meetsMin(v, 'warning'));
    expect(severityToEmotion(resolveSeverity(v, empty), 'firing')).toBe(severityToEmotion(v, 'firing'));
  }
});

// --- AC-2:命中別名 -----------------------------------------------------------

test('AC-2:票文那一行設定解析出三筆', () => {
  const { aliases, skipped } = parseSeverityAliases(SPEC);
  expect(skipped).toEqual([]);
  expect([...aliases.entries()]).toEqual([
    ['p1', 'critical'],
    ['sev2', 'warning'],
    ['disaster', 'critical'],
  ]);
});

test('AC-2:rankOf / meetsMin / severityToEmotion 都以對應的標準嚴重度判斷', () => {
  const { aliases } = parseSeverityAliases(SPEC);
  // 先前:P1 查不到 → 排名 0、被 warning 門檻擋掉、表情 calm。
  expect(rankOf('P1')).toBe(0);
  expect(meetsMin('P1', 'warning')).toBe(false);
  expect(severityToEmotion('P1', 'firing')).toBe('calm');
  // 現在:等同 critical。
  expect(rankOf(resolveSeverity('P1', aliases))).toBe(rankOf('critical'));
  expect(meetsMin(resolveSeverity('P1', aliases), 'warning')).toBe(true);
  expect(meetsMin(resolveSeverity('P1', aliases), 'critical')).toBe(true);
  expect(severityToEmotion(resolveSeverity('P1', aliases), 'firing')).toBe('critical');
  // sev2 → warning:達 warning 門檻但不達 critical,表情是 warning。
  expect(rankOf(resolveSeverity('sev2', aliases))).toBe(rankOf('warning'));
  expect(meetsMin(resolveSeverity('sev2', aliases), 'critical')).toBe(false);
  expect(severityToEmotion(resolveSeverity('sev2', aliases), 'firing')).toBe('warning');
  // resolved 照舊完全不看 severity(#30 AC-2)。
  expect(severityToEmotion(resolveSeverity('P1', aliases), 'resolved')).toBe('resolved');
});

test('AC-2:大小寫與前後空白不敏感（設定端與告警端都是）', () => {
  const { aliases, skipped } = parseSeverityAliases('  p1  =  CRITICAL  \n SEV2 = warning ');
  expect(skipped).toEqual([]);
  for (const v of ['P1', 'p1', ' p1 ', 'P1\n', '  p1  ']) {
    expect(resolveSeverity(v, aliases)).toBe('critical');
  }
  expect(resolveSeverity(' Sev2 ', aliases)).toBe('warning');
  // 正規化走的是 severity.ts 的那一份(單一事實源):normalize 過的值結果相同。
  for (const v of [' P1 ', 'SEV2']) {
    expect(resolveSeverity(v, aliases)).toBe(resolveSeverity(normalize(v), aliases));
  }
});

test('AC-2:沒命中別名的值照舊走 unknown / 不過濾路徑', () => {
  const { aliases } = parseSeverityAliases(SPEC);
  for (const v of ['high', 'sev1', 'garbage', '', undefined, null, 42, {}]) {
    expect(resolveSeverity(v, aliases)).toBe(v);
    expect(rankOf(resolveSeverity(v, aliases))).toBe(0);
    expect(severityToEmotion(resolveSeverity(v, aliases), 'firing')).toBe('calm');
  }
  // 已知嚴重度沒被設成別名時也不受影響。
  expect(resolveSeverity('warning', aliases)).toBe('warning');
  expect(rankOf(resolveSeverity('ERROR', aliases))).toBe(3);
});

test('AC-2:別名可指向 unknown，也可以是已知嚴重度本身（刻意的重新對映）', () => {
  const { aliases, skipped } = parseSeverityAliases('noise=unknown, critical=info');
  expect(skipped).toEqual([]);
  expect(rankOf(resolveSeverity('noise', aliases))).toBe(0);
  expect(meetsMin(resolveSeverity('noise', aliases), 'info')).toBe(false);
  expect(rankOf(resolveSeverity('critical', aliases))).toBe(rankOf('info'));
  expect(severityToEmotion(resolveSeverity('Critical', aliases), 'firing')).toBe('calm');
});

test('AC-2:Map 查表，原型鍵不會穿透（severity.ts 同一族的回歸護欄）', () => {
  const { aliases } = parseSeverityAliases('constructor=critical');
  // 只有明文設過的那個鍵會命中。
  expect(resolveSeverity('constructor', aliases)).toBe('critical');
  expect(rankOf(resolveSeverity('constructor', aliases))).toBe(4);
  for (const k of ['__proto__', 'tostring', 'hasownproperty', 'valueof']) {
    expect(resolveSeverity(k, aliases)).toBe(k);
    expect(rankOf(resolveSeverity(k, aliases))).toBe(0);
  }
});

test('AC-2:導播層的 emotion 吃別名，而播報句與 severity 欄保留原始 label', () => {
  const { aliases } = parseSeverityAliases(SPEC);
  const alert: ParsedAlert = {
    status: 'firing',
    source: 'grafana-panel',
    name: 'Pager',
    severity: 'P1',
    startsAt: '2026-10-14T00:00:00.000Z',
    fingerprint: 'alert:Pager',
  };
  const plain = buildBroadcastPlan(alert, 'zh');
  expect(plain.emotion).toBe('calm'); // 不帶別名表 → 與先前完全相同
  const aliased = buildBroadcastPlan(alert, 'zh', aliases);
  expect(aliased.emotion).toBe('critical');
  // 念出來的還是告警上寫的 P1 —— 念成 critical 會對不上 Grafana 裡看到的那一則。
  expect(aliased.text).toContain('嚴重度 P1');
  expect(aliased.severity).toBe('P1');
  expect(aliased.text).toBe(plain.text);
  // severityToEmotion 的簽章沒有多出設定參數(2026-09-18 的裁定)。
  expect(severityToEmotion.length).toBe(2);
});

// --- AC-3:格式錯誤 -----------------------------------------------------------

test('AC-3:缺 `=`、目標不是已知嚴重度、重複鍵 → 不拋、略過該項、其餘照常生效', () => {
  const { aliases, skipped } = parseSeverityAliases(
    'P1=critical, 亂寫, sev2=nonsense, p1=warning, =critical, disaster=warning, a=b=c'
  );
  // 合法的兩筆都在,而且 p1 維持第一筆的 critical(先寫先算)。
  expect([...aliases.entries()]).toEqual([
    ['p1', 'critical'],
    ['disaster', 'warning'],
  ]);
  expect(skipped).toEqual<SkippedAlias[]>([
    { entry: '亂寫', reason: 'no-separator' },
    { entry: 'sev2=nonsense', reason: 'unknown-target' },
    { entry: 'p1=warning', reason: 'duplicate-alias' },
    { entry: '=critical', reason: 'empty-alias' },
    { entry: 'a=b=c', reason: 'unknown-target' },
  ]);
});

test('AC-3:任何輸入都不拋（設定來自 dashboard JSON，不該讓播報中斷）', () => {
  const nasty = [
    '=',
    '==',
    'a=',
    '=a',
    ',,,',
    '__proto__=critical',
    'constructor=constructor',
    'p1=critical;p1=critical;p1=critical',
    'x'.repeat(5000),
    ' =critical',
    'P1=critical\nP1=error',
  ];
  for (const spec of nasty) {
    expect(() => parseSeverityAliases(spec)).not.toThrow();
    const { aliases, skipped } = parseSeverityAliases(spec);
    expect(() => describeSkippedAliases(skipped)).not.toThrow();
    // 不論設定多髒,resolveSeverity 都不拋、且沒命中就原值回傳。
    expect(() => resolveSeverity(undefined, aliases)).not.toThrow();
    expect(resolveSeverity('definitely-not-set', aliases)).toBe('definitely-not-set');
  }
});

test('AC-3:describeSkippedAliases 回報被略過的項目；沒有就回空字串', () => {
  expect(describeSkippedAliases([])).toBe('');
  expect(describeSkippedAliases(parseSeverityAliases(SPEC).skipped)).toBe('');
  const { skipped } = parseSeverityAliases('亂寫, sev2=nonsense');
  const msg = describeSkippedAliases(skipped);
  expect(msg).toContain('2 項');
  expect(msg).toContain('亂寫');
  expect(msg).toContain('sev2=nonsense');
  expect(msg).toContain('缺 `=`');
  expect(msg).toContain('目標不是已知嚴重度');
});

test('AC-3:純函式 —— 不 import React、不碰 DOM，同輸入同輸出且各次結果互不共用', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'severityAliases.ts'), 'utf8');
  expect(src).not.toMatch(/from\s+['"]react['"]/);
  expect(src).not.toMatch(/\b(document|window)\b/);
  // 唯一的 import 來源是 severity.ts(正規化與已知嚴重度的單一事實源)。
  expect(src.match(/^import .*$/gm)).toEqual(["import { isKnownSeverity, normalize } from './severity'"]);

  const a = parseSeverityAliases(SPEC);
  const b = parseSeverityAliases(SPEC);
  expect([...a.aliases.entries()]).toEqual([...b.aliases.entries()]);
  expect(a.aliases).not.toBe(b.aliases); // 兩次呼叫不共用同一個 Map
  expect(a.skipped).not.toBe(b.skipped);
});
