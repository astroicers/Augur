/**
 * #79：feed 列的合併、篩選與空清單判斷（抽出前只能靠 render 整個面板間接驗）。
 *
 * 顯示字串的 formatter 一律注入（`when(t)` → `@<t>`），所以這裡的斷言不看時鐘、
 * 也不看 locale 臉色；`formatHistoryWhen` 自己那幾支另外注入「現在」來驗。
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildBroadcastPlan } from '../../core/format';
import type { HistoryEntry, HistoryResult } from '../../sources/history';
import { FEED_EMPTY_TEXT, SESSION_MATCH_WINDOW_MS, buildFeedRows, formatHistoryWhen, type FeedLine } from '../feedRows';

/** 測試用的顯示字串：不走 locale，才驗得出「哪一列的時間來自哪一筆」。 */
const when = (t: number) => `@${t}`;

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);

function line(text: string, at: number, key = `s:${text}:${at}`): FeedLine {
  return {
    key,
    when: `session-${at}`,
    at,
    plan: buildBroadcastPlan({
      status: 'firing',
      source: 'test',
      name: text,
      severity: 'warning',
      startsAt: new Date(at).toISOString(),
      fingerprint: `alert:${text}`,
    }),
  };
}

/** 紀錄列。`search` 的內容與 `history.ts` 同一套：句子加上所有 label 值，已轉小寫。 */
function entry(text: string, time: number, labels: string[] = [], key = `h:${text}:${time}`): HistoryEntry {
  return {
    key,
    time,
    text,
    plan: buildBroadcastPlan({
      status: 'firing',
      source: 'grafana-history',
      name: text,
      severity: 'warning',
      startsAt: new Date(time).toISOString(),
      fingerprint: `alert:${text}`,
    }),
    search: [text, ...labels].join(' ').toLowerCase(),
  };
}

function history(entries: HistoryEntry[], truncated: HistoryResult['truncated'] = null): HistoryResult {
  return { entries, truncated };
}

describe('#79 AC-3：沒有紀錄時', () => {
  test('只列本分頁念過的句子，順序照 feed、每一列都標 origin=session', () => {
    const feed = [line('較新', T0 + 1000), line('較舊', T0)];
    const { rows, emptyText } = buildFeedRows(feed, null, '', when);
    expect(emptyText).toBeNull();
    expect(rows.map((r) => [r.origin, r.text, r.when, r.key])).toEqual([
      ['session', feed[0]!.plan.text, `session-${T0 + 1000}`, feed[0]!.key],
      ['session', feed[1]!.plan.text, `session-${T0}`, feed[1]!.key],
    ]);
  });

  test('篩選字串不生效（篩選框只在紀錄模式顯示）', () => {
    const feed = [line('資料庫', T0), line('記憶體', T0)];
    expect(buildFeedRows(feed, null, '資料庫', when).rows).toHaveLength(2);
  });
});

describe('#79 AC-3：有紀錄時的合併', () => {
  test('紀錄裡沒有的本分頁句子（sessionOnly）排在所有紀錄列的最上面', () => {
    const only = line('範圍開始前就在燒', T0);
    const rec = entry('紀錄裡的一則', T0 - 60_000);
    const { rows } = buildFeedRows([only], history([rec]), '', when);
    expect(rows.map((r) => r.origin)).toEqual(['session', 'history']);
    expect(rows[0]!.text).toBe(only.plan.text);
    expect(rows[1]!).toEqual({ key: rec.key, origin: 'history', when: `@${rec.time}`, at: rec.time, text: rec.text });
  });

  test('同文字而且時間在窗內 → 只留紀錄那一列，不重複列出', () => {
    const l = line('同一件事', T0);
    const rec = entry(l.plan.text, T0 - SESSION_MATCH_WINDOW_MS);
    const { rows } = buildFeedRows([l], history([rec]), '', when);
    expect(rows.map((r) => r.origin)).toEqual(['history']);
  });

  test('同文字、紀錄時間晚於念出時刻但仍在窗內 → 一樣算同一件事（比的是絕對差）', () => {
    const l = line('同一件事', T0);
    const rec = entry(l.plan.text, T0 + SESSION_MATCH_WINDOW_MS);
    expect(buildFeedRows([l], history([rec]), '', when).rows.map((r) => r.origin)).toEqual(['history']);
  });

  test('同文字、紀錄時間晚於念出時刻而且在窗外 → 兩列都留（只比單側差的寫法會在這裡把本分頁那一列吞掉）', () => {
    // 例：念出後過一小時，同一則告警再次 firing 留下同文字的紀錄 —— 那是另一件事。
    const l = line('同一句話、晚來的另一次', T0);
    const rec = entry(l.plan.text, T0 + SESSION_MATCH_WINDOW_MS + 1);
    expect(buildFeedRows([l], history([rec]), '', when).rows.map((r) => r.origin)).toEqual(['session', 'history']);
  });

  test('同文字但時間在窗外 → 兩列都留（只比文字的話會被幾小時前的舊紀錄吃掉，複審 L3）', () => {
    const l = line('同一句話、不同次事件', T0);
    const rec = entry(l.plan.text, T0 - SESSION_MATCH_WINDOW_MS - 1);
    const { rows } = buildFeedRows([l], history([rec]), '', when);
    expect(rows.map((r) => r.origin)).toEqual(['session', 'history']);
    expect(rows.map((r) => r.text)).toEqual([l.plan.text, rec.text]);
  });

  test('時間在窗內但文字不同 → 兩列都留', () => {
    const l = line('念過的那一句', T0);
    const rec = entry('紀錄裡的另一句', T0);
    expect(buildFeedRows([l], history([rec]), '', when).rows.map((r) => r.origin)).toEqual(['session', 'history']);
  });

  test('窗內有任何一筆對得上就算在紀錄裡（不是只比最新的那一筆）', () => {
    const l = line('同一件事', T0);
    const far = entry(l.plan.text, T0 - SESSION_MATCH_WINDOW_MS - 1);
    const near = entry(l.plan.text, T0 - 1000);
    expect(buildFeedRows([l], history([far, near]), '', when).rows.map((r) => r.origin)).toEqual([
      'history',
      'history',
    ]);
  });
});

describe('#79 AC-3：篩選', () => {
  const l = line('Session 的句子', T0);
  const rec = entry('偵測到告警：DiskFull', T0, ['prod', 'db-01']);

  test('大小寫不敏感：查詢字與被查的句子各自大小寫都不影響', () => {
    expect(buildFeedRows([l], history([rec]), 'DISKFULL', when).rows.map((r) => r.text)).toEqual([rec.text]);
    expect(buildFeedRows([l], history([rec]), 'session', when).rows.map((r) => r.text)).toEqual([l.plan.text]);
  });

  test('比對 label 值：句子裡沒有、只出現在 label 的字也查得到', () => {
    expect(rec.text).not.toContain('db-01');
    expect(buildFeedRows([l], history([rec]), 'DB-01', when).rows.map((r) => r.key)).toEqual([rec.key]);
  });

  test('前後空白修掉後為空字串 → 視為沒有篩選，全部列出', () => {
    expect(buildFeedRows([l], history([rec]), '   ', when).rows).toHaveLength(2);
  });

  test('本分頁的句子也吃篩選（比對自己的句子）', () => {
    expect(buildFeedRows([l], history([rec]), '的句子', when).rows.map((r) => r.origin)).toEqual(['session']);
  });
});

describe('#79 AC-3：三種空清單提示', () => {
  test('沒有紀錄、本分頁也還沒念過 → 說明 dedup 只念一次', () => {
    const { rows, emptyText } = buildFeedRows([], null, '', when);
    expect(rows).toEqual([]);
    expect(emptyText).toBe(FEED_EMPTY_TEXT.session);
    expect(emptyText).toBe('尚無播報。持續 firing 只會念一次 —— 那是 dedup 在生效。');
  });

  test('紀錄模式、沒有篩選、範圍內沒有任何列 → 說的是時間範圍', () => {
    const { rows, emptyText } = buildFeedRows([], history([]), '', when);
    expect(rows).toEqual([]);
    expect(emptyText).toBe(FEED_EMPTY_TEXT.history);
    expect(emptyText).toBe('這段時間範圍內沒有播報紀錄。');
  });

  test('紀錄模式、有篩選但沒有列對得上 → 說的是篩選，不是「這段時間沒事」', () => {
    const { rows, emptyText } = buildFeedRows([line('有念過', T0)], history([entry('有紀錄', T0)]), 'zzz', when);
    expect(rows).toEqual([]);
    expect(emptyText).toBe(FEED_EMPTY_TEXT.filtered);
    expect(emptyText).toBe('沒有符合的紀錄。');
  });

  test('三種提示彼此不同 —— 共用一句就分不出「沒事」與「篩選打錯」', () => {
    expect(new Set(Object.values(FEED_EMPTY_TEXT)).size).toBe(3);
  });

  test('有列可顯示時 emptyText 是 null（rows 非空與 emptyText 為 null 恆等價）', () => {
    for (const r of [
      buildFeedRows([line('a', T0)], null, '', when),
      buildFeedRows([], history([entry('b', T0)]), '', when),
      buildFeedRows([line('c', T0)], history([]), 'c', when),
    ]) {
      expect(r.rows.length > 0).toBe(r.emptyText === null);
      expect(r.rows.length).toBeGreaterThan(0);
    }
  });
});

describe('#79 AC-1：純函式', () => {
  test('不改動傳進來的 feed 與 history', () => {
    const feed = [line('一', T0), line('二', T0 - SESSION_MATCH_WINDOW_MS * 2)];
    const entries = [entry('一', T0), entry('三', T0)];
    const snapshot = JSON.stringify({ feed, entries });
    buildFeedRows(feed, history(entries), '一', when);
    expect(JSON.stringify({ feed, entries })).toBe(snapshot);
  });

  test('同樣的輸入連呼叫兩次，輸出相同', () => {
    // 「不讀現在」本身由上面窗內／窗外的邊界測試間接釘住；這一支只驗冪等。
    const feed = [line('一', T0)];
    const h = history([entry('一', T0 - SESSION_MATCH_WINDOW_MS - 1)]);
    expect(buildFeedRows(feed, h, '', when)).toEqual(buildFeedRows(feed, h, '', when));
  });

  test('不 import React、不碰 DOM（原始碼層的機械檢查）', () => {
    // 這一條是 AC-1 的字面要求，而「不小心 import 了 react」在 jest（jsdom）裡
    // 不會自己紅 —— 要讀原始碼才看得見。判法與 `BroadcastDirector.test.ts` 的
    // `AC-1：導播不 import react、不碰 DOM` 同一套（同族的規則同一個判法）：
    // 先拿掉註解 —— 檔頭的說明會提到 react / DOM，那是散文不是相依。
    const code = fs
      .readFileSync(path.join(__dirname, '..', 'feedRows.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const sources = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(sources).toEqual(['../core/types', '../sources/history']);
    // 裸 token（不是只看 `window.`／`document.`）：`typeof window !== 'undefined'`
    // 這種寫法也要擋得到。
    for (const token of [/\breact\b/i, /\bwindow\b/, /\bdocument\b/, /\bnavigator\b/, /\blocalStorage\b/]) {
      expect(code).not.toMatch(token);
    }
  });
});

describe('#80：每一列的時間戳（匯出 CSV 的 ISO 欄位要用）', () => {
  test('紀錄列的 at 是 entry.time、本分頁的列是 line.at', () => {
    const l = line('本分頁念的', T0 + 5000);
    const rec = entry('紀錄裡的', T0);
    const { rows } = buildFeedRows([l], history([rec]), '', when);
    expect(rows.map((r) => [r.origin, r.at])).toEqual([
      ['session', T0 + 5000],
      ['history', T0],
    ]);
  });

  test('沒有紀錄時（降級路徑）每一列也帶著 at', () => {
    const l = line('只有本分頁', T0);
    expect(buildFeedRows([l], null, '', when).rows.map((r) => r.at)).toEqual([T0]);
  });

  test('篩選過後留下的列，at 仍是那一筆自己的時間（不是被串位）', () => {
    const recs = [entry('第一則 DiskFull', T0), entry('第二則 MemHigh', T0 + 60_000)];
    const { rows } = buildFeedRows([], history(recs), 'memhigh', when);
    expect(rows.map((r) => [r.text, r.at])).toEqual([[recs[1]!.text, T0 + 60_000]]);
  });

  test('at 是機器要讀的時間戳，與給人看的 when 分開（when 吃 locale、還會省略日期）', () => {
    const rec = entry('一', T0);
    const [row] = buildFeedRows([], history([rec]), '').rows;
    expect(row!.at).toBe(T0);
    expect(row!.when).toBe(formatHistoryWhen(T0));
    expect(typeof row!.at).toBe('number');
  });
});

describe('#79：formatHistoryWhen', () => {
  test('今天的紀錄只顯示時間（不含日期）', () => {
    const t = Date.UTC(2026, 9, 18, 3, 4, 5);
    expect(formatHistoryWhen(t, t + 60_000)).toBe(new Date(t).toLocaleTimeString());
  });

  test('不是今天的紀錄連日期一起顯示', () => {
    const t = Date.UTC(2026, 9, 1, 3, 4, 5);
    const now = Date.UTC(2026, 9, 18, 3, 4, 5);
    expect(formatHistoryWhen(t, now)).toBe(new Date(t).toLocaleString());
  });

  test('buildFeedRows 省略 formatter 時用它當預設', () => {
    const rec = entry('一', Date.now());
    const [row] = buildFeedRows([], history([rec]), '').rows;
    expect(row!.when).toBe(formatHistoryWhen(rec.time));
  });
});

describe('#81：每一列為什麼沒念（suppressed 原樣轉手）', () => {
  /** 一句被抑制的本分頁播報。 */
  const held = (text: string, at: number, suppressed: FeedLine['suppressed']): FeedLine => ({
    ...line(text, at),
    suppressed,
  });

  test('沒有紀錄時：本分頁的列原樣帶著 suppressed，兩種原因各自分得出來', () => {
    const feed = [held('抖的', T0 + 1000, 'flapping'), held('靜音的', T0, 'quiet')];
    const { rows } = buildFeedRows(feed, null, '', when);
    expect(rows.map((r) => r.suppressed)).toEqual(['flapping', 'quiet']);
  });

  test('沒有 suppressed 的列，suppressed 是 undefined（元件據此整個屬性都不渲染）', () => {
    const { rows } = buildFeedRows([line('念過的', T0)], null, '', when);
    expect(rows[0]!.suppressed).toBeUndefined();
  });

  test('紀錄模式：補進來的本分頁那一列照樣帶著標記，紀錄列一律沒有標記', () => {
    // 紀錄來自 Grafana 自己的狀態歷史，那份資料記的是狀態變化，不知道這個分頁念了沒有。
    const feed = [held('只在本分頁的', T0 + 1000, 'quiet')];
    const rec = entry('紀錄裡的', T0);
    const { rows } = buildFeedRows(feed, history([rec]), '', when);
    expect(rows.map((r) => [r.origin, r.suppressed])).toEqual([
      ['session', 'quiet'],
      ['history', undefined],
    ]);
  });

  test('篩選過後留下的列，標記仍是那一列自己的（不是被串位）', () => {
    const feed = [held('抖的', T0 + 2000, 'flapping'), held('靜音的', T0 + 1000, 'quiet')];
    const { rows } = buildFeedRows(feed, history([entry('紀錄裡的', T0)]), '靜音', when);
    expect(rows.map((r) => [r.text, r.suppressed])).toEqual([[feed[1]!.plan.text, 'quiet']]);
  });
});

describe('#99：被抑制的標記在合併時轉到紀錄列（真實部署幾乎都有紀錄）', () => {
  /** 一句被抑制的本分頁播報。 */
  const held = (text: string, at: number, suppressed: FeedLine['suppressed']): FeedLine => ({
    ...line(text, at),
    suppressed,
  });

  test('AC-1：被同一件事的紀錄列取代時，標記跟著走 —— 靜音時段', () => {
    // #81 當時的行為是標記隨本分頁那一列一起消失；而有播報紀錄的 panel（EKS 值班台）是常態，
    // 所以那個取捨等於「標記幾乎不會出現」。被抑制的是「這個分頁沒念這件事」，
    // 紀錄列講的正是同一件事，換哪一列顯示不改變這個事實。
    const l = held('同一件事', T0, 'quiet');
    const rec = entry(l.plan.text, T0 - 60_000);
    const { rows } = buildFeedRows([l], history([rec]), '', when);
    expect(rows.map((r) => [r.origin, r.key, r.suppressed])).toEqual([['history', rec.key, 'quiet']]);
  });

  test('AC-1：被同一件事的紀錄列取代時，標記跟著走 —— 抖動抑制', () => {
    const l = held('同一件事', T0, 'flapping');
    const rec = entry(l.plan.text, T0 + 60_000);
    const { rows } = buildFeedRows([l], history([rec]), '', when);
    expect(rows.map((r) => [r.origin, r.suppressed])).toEqual([['history', 'flapping']]);
  });

  test('AC-1：轉移的是原樣的那個原因，不是「有沒有被抑制」的布林', () => {
    const quiet = held('靜音的', T0, 'quiet');
    const flapping = held('抖的', T0, 'flapping');
    const rows = buildFeedRows(
      [quiet, flapping],
      history([entry(quiet.plan.text, T0), entry(flapping.plan.text, T0)]),
      '',
      when
    ).rows;
    expect(rows.map((r) => [r.text, r.origin, r.suppressed])).toEqual([
      [quiet.plan.text, 'history', 'quiet'],
      [flapping.plan.text, 'history', 'flapping'],
    ]);
  });

  test('AC-1：念出去的那一句被紀錄列取代時，紀錄列不會多出標記', () => {
    // 轉移的是「那一句的答案」而不是「有本分頁列對得上」——念了就是 undefined。
    const l = line('念過的同一件事', T0);
    const { rows } = buildFeedRows([l], history([entry(l.plan.text, T0)]), '', when);
    expect(rows.map((r) => [r.origin, r.suppressed])).toEqual([['history', undefined]]);
  });

  test('AC-2：沒有對應的本分頁列（分頁打開之前就發生的事）→ 不帶標記', () => {
    const rec = entry('分頁打開之前就發生的事', T0);
    const { rows } = buildFeedRows([], history([rec]), '', when);
    expect(rows.map((r) => [r.origin, r.suppressed])).toEqual([['history', undefined]]);
  });

  test('AC-2：同文字但時間在合併窗外 → 兩列都留，紀錄列不帶標記（久遠的紀錄不被誤標）', () => {
    // 這一條堵的是另一條「讓標記出現」的達成路徑：把比對窗放寬。
    // 比對鍵與窗長一律不動，只改「留下的那一列帶誰的 suppressed」。
    const l = held('同一句話、不同次事件', T0, 'quiet');
    const rec = entry(l.plan.text, T0 - SESSION_MATCH_WINDOW_MS - 1);
    const { rows } = buildFeedRows([l], history([rec]), '', when);
    expect(rows.map((r) => [r.origin, r.suppressed])).toEqual([
      ['session', 'quiet'],
      ['history', undefined],
    ]);
  });

  test('AC-2：時間在窗內但文字不同 → 標記不跨事件轉移', () => {
    const l = held('念過的那一句', T0, 'flapping');
    const rec = entry('紀錄裡的另一句', T0);
    const { rows } = buildFeedRows([l], history([rec]), '', when);
    expect(rows.map((r) => [r.origin, r.suppressed])).toEqual([
      ['session', 'flapping'],
      ['history', undefined],
    ]);
  });

  test('多對一：窗內兩句本分頁的話對上同一筆紀錄 → 取時間最接近的那一句的原因', () => {
    // 例：先被抖動抑制，窗內又進入靜音時段。兩個原因不同，留哪一個不能靠巧合。
    const far = held('同一件事', T0 - 5 * 60_000, 'flapping');
    const near = held('同一件事', T0 - 60_000, 'quiet');
    const rec = entry(near.plan.text, T0);
    expect(buildFeedRows([near, far], history([rec]), '', when).rows.map((r) => r.suppressed)).toEqual(['quiet']);
    // feed 的順序不影響結果（「最接近」是時間上的，不是陣列位置）。
    expect(buildFeedRows([far, near], history([rec]), '', when).rows.map((r) => r.suppressed)).toEqual(['quiet']);
  });

  test('多對一：最接近的那一句其實念了 → 不從較遠的那一句撿一個原因來標', () => {
    const spoken = line('同一件事', T0 - 60_000);
    const suppressed = held('同一件事', T0 - 5 * 60_000, 'quiet');
    const rec = entry(spoken.plan.text, T0);
    const { rows } = buildFeedRows([spoken, suppressed], history([rec]), '', when);
    expect(rows.map((r) => [r.origin, r.suppressed])).toEqual([['history', undefined]]);
  });

  test('一對多：窗內有兩筆紀錄對得上同一句 → 標記只出現在最接近的那一筆上', () => {
    // 一次被抑制的播報在畫面上就該是一個標記；兩筆都標會讓人以為被擋了兩次。
    const l = held('同一件事', T0, 'flapping');
    const near = entry(l.plan.text, T0 - 60_000);
    const far = entry(l.plan.text, T0 - 9 * 60_000);
    const { rows } = buildFeedRows([l], history([near, far]), '', when);
    expect(rows.map((r) => [r.key, r.suppressed])).toEqual([
      [near.key, 'flapping'],
      [far.key, undefined],
    ]);
  });

  test('AC-3：篩選讀的那份字串沒變 —— 加了標記之後篩選結果逐字相同', () => {
    // suppressed 不進 search，所以 #79 的篩選與 #80 的匯出（讀的是同一份 feedRows）不受影響。
    const l = held('同一件事 DiskFull', T0, 'quiet');
    const rec = entry(l.plan.text, T0, ['prod', 'db-01']);
    const other = entry('另一句 MemHigh', T0, ['prod']);
    const h = history([rec, other]);
    for (const q of ['', 'diskfull', 'db-01', 'memhigh', 'quiet', 'flapping', 'zzz']) {
      const { rows, emptyText } = buildFeedRows([l], h, q, when);
      // 期望值由「不帶標記的同一份輸入」算出來 —— 等於把本票之前的行為當基準線。
      const baseline = buildFeedRows([{ ...l, suppressed: undefined }], h, q, when);
      expect(rows.map((r) => [r.key, r.origin, r.text, r.at, r.when])).toEqual(
        baseline.rows.map((r) => [r.key, r.origin, r.text, r.at, r.when])
      );
      expect(emptyText).toBe(baseline.emptyText);
    }
    // 而標記本身在篩選後仍留在它自己那一列上（不是被串位）。
    expect(buildFeedRows([l], h, 'db-01', when).rows.map((r) => r.suppressed)).toEqual(['quiet']);
  });

  test('AC-3：沒有任何列帶標記時，輸出與本票之前逐字相同（迴歸面）', () => {
    const feed = [line('只在本分頁的', T0 + 1000), line('同一件事', T0)];
    const h = history([entry('同一件事', T0), entry('紀錄裡的另一則', T0 - 60_000)]);
    expect(buildFeedRows(feed, h, '', when).rows.every((r) => r.suppressed === undefined)).toBe(true);
  });

  test('轉移不改動傳進來的 feed 與 history（純函式，#79 AC-1 的延伸）', () => {
    const feed = [held('同一件事', T0, 'quiet')];
    const entries = [entry('同一件事', T0)];
    const snapshot = JSON.stringify({ feed, entries });
    buildFeedRows(feed, history(entries), '', when);
    expect(JSON.stringify({ feed, entries })).toBe(snapshot);
  });
});
