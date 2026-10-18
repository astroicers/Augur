/**
 * #80：匯出 CSV 的純函式（格式、跳脫、防公式注入、檔名）。
 *
 * 這裡不 render 任何東西、也不碰 DOM —— 下載那一步（Blob + `a[download]`）在
 * `MascotPanel.tsx`，由 `MascotPanel.test.tsx` 的 #80 那一族測試驗。
 *
 * 跳脫那幾支除了比對字串，還**把產出的 CSV 解析回來**（`parseCsv`，一支照 RFC 4180
 * 寫的小解析器）：比對字串釘住「寫出來長什麼樣」，解析回來釘住「別人讀得回去」——
 * 少了後者，把逗號換成分號之類的改法可以通過全部的字串斷言。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CSV_BOM,
  CSV_FORMULA_PREFIX,
  CSV_NEWLINE,
  FEED_CSV_COLUMNS,
  FEED_CSV_MIME,
  FEED_CSV_ORIGIN,
  csvCell,
  feedCsvFilename,
  feedRowsToCsv,
} from '../feedCsv';
import type { FeedRow } from '../feedRows';

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);

function row(over: Partial<FeedRow> = {}): FeedRow {
  return { key: 'k', origin: 'history', when: `@${T0}`, at: T0, text: '偵測到告警：DiskFull', ...over };
}

/** 去掉 BOM 之後的列（尾端 CRLF 不算一列）。 */
function lines(csv: string): string[] {
  expect(csv.startsWith(CSV_BOM)).toBe(true);
  const body = csv.slice(CSV_BOM.length);
  expect(body.endsWith(CSV_NEWLINE)).toBe(true);
  return body.slice(0, -CSV_NEWLINE.length).split(CSV_NEWLINE);
}

/**
 * 照 RFC 4180 把一份 CSV 解析回二維陣列（只為測試用：逐字元走，認得引號內的逗號、
 * CRLF 與加倍的雙引號）。**刻意不用 split** —— 用 split 的解析器會把「跳脫錯誤」
 * 和「跳脫正確」讀成同一個結果，那就驗不到東西了。
 */
function parseCsv(input: string): string[][] {
  const text = input.startsWith(CSV_BOM) ? input.slice(CSV_BOM.length) : input;
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      cells.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (text.startsWith(CSV_NEWLINE, i)) {
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = '';
      i += CSV_NEWLINE.length;
      continue;
    }
    cell += c;
    i += 1;
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    records.push(cells);
  }
  return records;
}

describe('#80 AC-1：欄位與內容', () => {
  test('第一列是標題：時間（ISO 8601，UTC）、來源、句子', () => {
    expect(FEED_CSV_COLUMNS).toEqual(['時間（ISO 8601，UTC）', '來源', '句子']);
    expect(lines(feedRowsToCsv([]))).toEqual(['時間（ISO 8601，UTC）,來源,句子']);
  });

  test('每一列是「時間、來源、句子」，順序照傳進來的 rows（也就是畫面上的順序）', () => {
    const csv = feedRowsToCsv([
      row({ key: 'a', origin: 'session', at: T0 + 1000, text: '本分頁念的' }),
      row({ key: 'b', origin: 'history', at: T0, text: '紀錄裡的' }),
    ]);
    expect(parseCsv(csv)).toEqual([
      ['時間（ISO 8601，UTC）', '來源', '句子'],
      ['2026-10-18T09:00:01.000Z', '本分頁', '本分頁念的'],
      ['2026-10-18T09:00:00.000Z', '紀錄', '紀錄裡的'],
    ]);
  });

  test('來源欄用的是「紀錄」與「本分頁」（兩種各自不同，分得出哪一列是哪一種）', () => {
    expect(FEED_CSV_ORIGIN).toEqual({ history: '紀錄', session: '本分頁' });
    expect(FEED_CSV_ORIGIN.history).not.toBe(FEED_CSV_ORIGIN.session);
  });

  test('時間欄是 UTC（結尾是 Z），不是本地時區偏移 —— 跨時區交接才不會讀錯', () => {
    const [, first] = parseCsv(feedRowsToCsv([row({ at: T0 })]));
    expect(first![0]).toBe('2026-10-18T09:00:00.000Z');
    expect(first![0]).toBe(new Date(T0).toISOString());
    expect(first![0]).toMatch(/Z$/);
    // 本地時區偏移的寫法（`+08:00`）會在這裡紅。
    expect(first![0]).not.toMatch(/[+-]\d\d:\d\d$/);
  });

  test('時間戳壞掉（NaN／Infinity／超出可表示範圍）→ 那一欄空著，不丟錯、其餘欄位照出', () => {
    for (const at of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
      const records = parseCsv(feedRowsToCsv([row({ at, text: '時間讀壞的一列' })]));
      expect(records[1]).toEqual(['', '紀錄', '時間讀壞的一列']);
    }
  });

  test('記錄之間是 CRLF，最後一列也收尾（RFC 4180 §2.1）', () => {
    const csv = feedRowsToCsv([row({ text: '一' }), row({ text: '二' })]);
    expect(csv.slice(CSV_BOM.length).split(CSV_NEWLINE)).toHaveLength(4); // 標題＋兩列＋尾端空字串
    expect(csv.endsWith(CSV_NEWLINE)).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n'); // 沒有落單的 LF
  });

  test('開頭是 UTF-8 BOM —— Excel 少了它會把中文整欄讀成亂碼', () => {
    expect(feedRowsToCsv([row()]).charCodeAt(0)).toBe(0xfeff);
    expect(CSV_BOM).toBe('\ufeff');
  });

  test('下載用的 MIME 是 text/csv 且標明 utf-8', () => {
    expect(FEED_CSV_MIME).toBe('text/csv;charset=utf-8');
  });

  test('零列時回「只有標題列」的 CSV（畫面上按不到 —— 清單空的時候按鈕是 disabled）', () => {
    expect(parseCsv(feedRowsToCsv([]))).toEqual([[...FEED_CSV_COLUMNS]]);
  });
});

describe('#80 AC-2：RFC 4180 的跳脫', () => {
  test('逗號 → 整欄加引號（不加的話一句話會被讀成兩欄）', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('磁碟快滿, 剩 3%')).toBe('"磁碟快滿, 剩 3%"');
    expect(parseCsv(feedRowsToCsv([row({ text: 'a,b' })]))[1]![2]).toBe('a,b');
    // 全形逗號不是分隔字元，不必加引號 —— 告警句子裡幾乎都是這一個（`buildBroadcastPlan` 用全形）。
    expect(csvCell('磁碟快滿，剩 3%')).toBe('磁碟快滿，剩 3%');
  });

  test('雙引號 → 加引號並把內部的雙引號加倍', () => {
    expect(csvCell('他說 "完了"')).toBe('"他說 ""完了"""');
    expect(parseCsv(feedRowsToCsv([row({ text: '他說 "完了"' })]))[1]![2]).toBe('他說 "完了"');
  });

  test('換行（LF 與 CRLF）→ 加引號，而且原樣留在那一格裡', () => {
    for (const text of ['第一行\n第二行', '第一行\r\n第二行']) {
      expect(csvCell(text)).toBe(`"${text}"`);
      expect(parseCsv(feedRowsToCsv([row({ text })]))[1]![2]).toBe(text);
    }
  });

  test('前後空白 → 加引號，空白一個都不掉', () => {
    expect(csvCell('  前面有空白')).toBe('"  前面有空白"');
    expect(csvCell('後面有空白  ')).toBe('"後面有空白  "');
    expect(csvCell('\t前面是定位字元')).toBe(`"${CSV_FORMULA_PREFIX}\t前面是定位字元"`);
    expect(parseCsv(feedRowsToCsv([row({ text: ' 兩邊都有 ' })]))[1]![2]).toBe(' 兩邊都有 ');
  });

  test('沒有特殊字元的欄位不加引號、不加前綴（匯出的檔案不該到處是引號）', () => {
    expect(csvCell('偵測到告警：DiskFull')).toBe('偵測到告警：DiskFull');
    expect(csvCell('')).toBe('');
    expect(feedRowsToCsv([row({ text: '乾淨的一句' })])).toContain(`,紀錄,乾淨的一句${CSV_NEWLINE}`);
  });

  test('四種字元一起來（逗號＋引號＋換行＋前後空白）也解析得回去', () => {
    const text = ' 他說 "a,b"\r\n然後呢 ';
    expect(parseCsv(feedRowsToCsv([row({ text })]))[1]![2]).toBe(text);
  });
});

describe('#80 AC-2：防公式注入', () => {
  test('=、+、-、@ 開頭的句子前面加一個單引號', () => {
    expect(CSV_FORMULA_PREFIX).toBe("'");
    for (const lead of ['=', '+', '-', '@']) {
      expect(csvCell(`${lead}cmd`)).toBe(`'${lead}cmd`);
    }
    // 實際會遇到的那種：Grafana 的紀錄字串以 `- A=0.93` 收尾，換行後就在開頭。
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('=HYPERLINK("http://evil","按我")')).toBe('"\'=HYPERLINK(""http://evil"",""按我"")"');
  });

  test('前面有空白的 =：照樣加前綴（試算表匯入時會把前置空白修掉）', () => {
    expect(csvCell('  =1+1')).toBe('"\'  =1+1"');
    // 解析回來時前綴仍在那一格裡 —— 這就是「貼回工單會看到一個單引號」的代價。
    expect(parseCsv(feedRowsToCsv([row({ text: '  =1+1' })]))[1]![2]).toBe("'  =1+1");
  });

  test('定位字元或 CR 開頭也加前綴（OWASP 的清單裡有這兩個）', () => {
    expect(csvCell('\t=1+1')).toBe('"\'\t=1+1"');
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
  });

  test('只是句子裡有 = 或 - 不加前綴（只有開頭才會被當公式）', () => {
    expect(csvCell('數值 A=0.93')).toBe('數值 A=0.93');
    expect(csvCell('db-01 磁碟滿了')).toBe('db-01 磁碟滿了');
  });

  test('三個欄位都過同一套處理 —— 來源與時間欄也不例外', () => {
    // 來源與時間是我們自己產的字（不可能以 = 開頭），但處理是逐欄一致的：
    // 這一支釘的是「沒有任何一欄繞過 csvCell」。
    const csv = feedRowsToCsv([row({ text: '=1+1' })]);
    for (const cell of parseCsv(csv)[1]!) {
      expect(cell.startsWith('=') || cell.startsWith('+') || cell.startsWith('@')).toBe(false);
    }
    expect(parseCsv(csv)[1]![2]).toBe("'=1+1");
  });
});

describe('#80 AC-3：檔名', () => {
  test('含 dashboard uid、panel id 與 UTC 時間，而且只用檔名安全的字元', () => {
    const name = feedCsvFilename({ dashboardUid: 'dash-1', panelId: 7, at: T0 });
    expect(name).toBe('augur-broadcast-dash-1-panel7-20261018T090000Z.csv');
    expect(name).toMatch(/^[A-Za-z0-9_-]+\.csv$/);
  });

  test('uid 取不到時省略那一段，不會長出 undefined', () => {
    for (const uid of [undefined, '', '   ']) {
      const name = feedCsvFilename({ dashboardUid: uid, panelId: 7, at: T0 });
      expect(name).toBe('augur-broadcast-panel7-20261018T090000Z.csv');
      expect(name).not.toContain('undefined');
      expect(name).toMatch(/^[A-Za-z0-9_-]+\.csv$/);
    }
  });

  test('uid 裡的危險字元（路徑、Windows 不允許的字、空白、中文）全部換掉', () => {
    for (const uid of ['../../etc/passwd', 'a:b*c?d"e<f>g|h', '有中文的 uid', 'a/b\\c', '....', '\\\\host\\share']) {
      const name = feedCsvFilename({ dashboardUid: uid, panelId: 7, at: T0 });
      expect(name).toMatch(/^[A-Za-z0-9_-]+\.csv$/);
      expect(name).not.toContain('..');
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
    }
    expect(feedCsvFilename({ dashboardUid: '../../etc/passwd', panelId: 7, at: T0 })).toBe(
      'augur-broadcast-etc-passwd-panel7-20261018T090000Z.csv'
    );
  });

  test('uid 很長時截斷，檔名不被撐爆', () => {
    const name = feedCsvFilename({ dashboardUid: 'u'.repeat(300), panelId: 7, at: T0 });
    expect(name.length).toBeLessThan(120);
    expect(name).toMatch(/^augur-broadcast-u{48}-panel7-\d{8}T\d{6}Z\.csv$/);
  });

  test('時間戳不含 : 或 .（Windows 的檔名不允許 :），而且是 UTC', () => {
    const name = feedCsvFilename({ dashboardUid: 'd', panelId: 1, at: Date.UTC(2026, 0, 2, 3, 4, 5, 678) });
    expect(name).toBe('augur-broadcast-d-panel1-20260102T030405Z.csv');
    expect(name).not.toContain(':');
    expect(name.endsWith('.csv')).toBe(true);
    expect(name.slice(0, -4)).not.toContain('.');
  });

  test('時間戳壞掉時省略那一段（不讓 NaN 進檔名）', () => {
    expect(feedCsvFilename({ dashboardUid: 'd', panelId: 7, at: NaN })).toBe('augur-broadcast-d-panel7.csv');
  });

  test('panel id 一定出現在檔名裡（同一個 dashboard 上多個吉祥物 panel 分得出來）', () => {
    expect(feedCsvFilename({ dashboardUid: 'd', panelId: 42, at: T0 })).toContain('panel42');
    expect(feedCsvFilename({ dashboardUid: 'd', panelId: 7, at: T0 })).not.toContain('panel42');
  });
});

describe('#80 AC-3：純函式', () => {
  test('不改動傳進來的 rows', () => {
    const rows = [row({ text: 'a,b' }), row({ origin: 'session', text: '=1+1' })];
    const snapshot = JSON.stringify(rows);
    feedRowsToCsv(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  test('同樣的輸入連呼叫兩次，輸出相同', () => {
    const rows = [row({ text: 'a' })];
    expect(feedRowsToCsv(rows)).toBe(feedRowsToCsv(rows));
    const opts = { dashboardUid: 'd', panelId: 7, at: T0 };
    expect(feedCsvFilename(opts)).toBe(feedCsvFilename(opts));
  });

  test('不讀「現在」—— 把 Date.now 換成會丟錯的函式，兩支照樣跑完', () => {
    // 時間一律從參數進來（列的 `at`、檔名的 `at`），所以匯出的內容在測試裡是可控的。
    const realNow = Date.now;
    Date.now = () => {
      throw new Error('不該讀現在');
    };
    try {
      expect(feedRowsToCsv([row()])).toContain('2026-10-18T09:00:00.000Z');
      expect(feedCsvFilename({ dashboardUid: 'd', panelId: 7, at: T0 })).toContain('20261018T090000Z');
    } finally {
      Date.now = realNow;
    }
  });

  test('不 import React、不碰 DOM（原始碼層的機械檢查）', () => {
    // 判法與 `feedRows.test.ts`／`BroadcastDirector.test.ts` 同一套：先去註解（檔頭的散文
    // 會提到 React、DOM、Blob），再比 import 清單與裸 token。這種事在 jsdom 裡不會自己紅。
    const code = fs
      .readFileSync(path.join(__dirname, '..', 'feedCsv.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect([...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)).toEqual(['./feedRows']);
    for (const token of [
      /\breact\b/i,
      /\bwindow\b/,
      /\bdocument\b/,
      /\bnavigator\b/,
      /\blocalStorage\b/,
      /\bBlob\b/,
      /\bURL\b/,
      /\bfetch\b/,
    ]) {
      expect(code).not.toMatch(token);
    }
  });
});
