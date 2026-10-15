/**
 * 斷句規則的 golden 測試（#59 AC-2）。
 *
 * 語料 `../__fixtures__/split-corpus.json` 是 TypeScript 與 Python 兩邊共用的唯一事實源：
 * 這一支比對 `splitForRemoteVoice` 與 `splitClauses`，`tools/tts-server/test_textsplit.py`
 * 的「語料逐句比對」那一支讀同一份檔案比對 `textsplit.clauses`。
 *
 * 用 `readFileSync` 而不是 `import`：語料不該進 webpack bundle（它只給測試用），
 * 也不必為了一個 fixture 打開 `resolveJsonModule`。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitForRemoteVoice } from '../speaker';
import { splitClauses } from '../remoteSpeaker';

interface Suspect {
  severity: string;
  why: string;
  whyNotFixedHere: string;
}

interface Corpus {
  about: string[];
  cases: Array<{
    id: string;
    covers: string[];
    note: string;
    text: string;
    maxChars: number;
    minChars: number;
    splitForRemoteVoice: string[];
    splitClauses: string[];
    pythonClauses: string[];
    suspect?: Suspect;
  }>;
}

const CORPUS_PATH = join(__dirname, '..', '__fixtures__', 'split-corpus.json');
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;

/** AC-1 點名要涵蓋的邊界。語料每一句用 `covers` 標自己屬於哪幾個。 */
const REQUIRED_COVERAGE = [
  '中英混合',
  'IPv4',
  '小數',
  'URL',
  'IPv6',
  '時間',
  'Windows 路徑',
  'Alert firing: X',
  '全形與半形標點',
  '超長沒有標點',
  'emoji',
  '空字串',
];

describe('split-corpus.json：語料本身的形狀（AC-1）', () => {
  it('至少 25 句，id 不重複', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(25);
    const ids = corpus.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每一句都附三份實作的輸出與一段說明', () => {
    for (const c of corpus.cases) {
      expect(typeof c.text).toBe('string');
      expect(Number.isInteger(c.maxChars) && c.maxChars >= 1).toBe(true);
      expect(Number.isInteger(c.minChars) && c.minChars >= 1).toBe(true);
      expect(Array.isArray(c.splitForRemoteVoice)).toBe(true);
      expect(Array.isArray(c.splitClauses)).toBe(true);
      expect(Array.isArray(c.pythonClauses)).toBe(true);
      expect(c.note.length).toBeGreaterThan(0);
    }
  });

  it('AC-1 列的每個邊界都至少有一句涵蓋，且 covers 只用得到清單上的標籤', () => {
    const used = new Set(corpus.cases.flatMap((c) => c.covers));
    for (const tag of REQUIRED_COVERAGE) {
      expect([...used]).toContain(tag);
    }
    // 反向：標籤打錯字會讓上面那一圈白過，所以也擋住清單外的標籤。
    expect([...used].filter((t) => !REQUIRED_COVERAGE.includes(t))).toEqual([]);
  });

  it('人工複核標記的可疑句子都寫明理由與「為什麼本票不改」', () => {
    const suspects = corpus.cases.filter((c) => c.suspect);
    expect(suspects.length).toBeGreaterThan(0);
    for (const c of suspects) {
      const s = c.suspect!;
      expect(['高', '中', '低']).toContain(s.severity);
      expect(s.why.length).toBeGreaterThan(20);
      expect(s.whyNotFixedHere.length).toBeGreaterThan(10);
    }
  });
});

describe('golden：splitForRemoteVoice 的輸出與語料逐句相同（AC-2、AC-4）', () => {
  for (const c of corpus.cases) {
    it(`${c.id}（上限 ${c.maxChars} 字）`, () => {
      expect(splitForRemoteVoice(c.text, c.maxChars)).toEqual(c.splitForRemoteVoice);
    });
  }

  it('每一句的輸出接起來都等於原文、每段不超過上限（硬切單一代理對除外）', () => {
    for (const c of corpus.cases) {
      expect(c.splitForRemoteVoice.join('')).toBe(c.text);
      for (const chunk of c.splitForRemoteVoice) {
        expect(chunk.length).toBeLessThanOrEqual(Math.max(c.maxChars, 1));
      }
    }
  });
});

describe('golden：splitClauses 的輸出與語料逐句相同（AC-2、AC-4）', () => {
  for (const c of corpus.cases) {
    it(`${c.id}（下限 ${c.minChars} 字）`, () => {
      expect(splitClauses(c.text, c.minChars)).toEqual(c.splitClauses);
    });
  }
});

describe('語料釘住的三份差異（AC-5 的機械證據）', () => {
  const byId = new Map(corpus.cases.map((c) => [c.id, c]));
  const get = (id: string) => {
    const c = byId.get(id);
    if (!c) {
      throw new Error(`語料缺少 ${id}`);
    }
    return c;
  };

  it('差異 1：五個全形切點三份都切；半形 , ; ? ! 在 splitClauses 與 Python 都是切點', () => {
    const fw = get('fullwidth-punct-sweep');
    for (const out of [fw.splitForRemoteVoice, fw.splitClauses, fw.pythonClauses]) {
      expect(out).toEqual(['警告；', '磁碟快滿了！', '要清嗎？', '請處理，', '謝謝。']);
    }
    // 半形：空白是 splitForRemoteVoice 專屬的切點、Python 另外 strip，所以三份的段落邊界不同；
    // 半形那句每個標點後面都接空白，而空白本身是 splitForRemoteVoice 的切點，
    // 所以這裡驗不到「, ; ? ! 是 splitForRemoteVoice 的切點」——那由其他 golden 句子釘住。
    const ascii = get('ascii-punct-sweep');
    for (const out of [ascii.splitForRemoteVoice, ascii.splitClauses, ascii.pythonClauses]) {
      expect(out.map((s) => s.trim()).filter((s) => s !== '')).toEqual(
        expect.arrayContaining(['disk full!', 'clean it,'])
      );
    }
    expect(ascii.splitClauses).toEqual(['warn;', ' disk full!', ' clean it,', ' do it now?']);
    expect(ascii.pythonClauses).toEqual(['warn;', 'disk full!', 'clean it,', 'do it now?']);
  });

  it('差異 2：頓號只有 splitForRemoteVoice 當切點', () => {
    const c = get('ideographic-comma-forced');
    expect(c.splitForRemoteVoice).toEqual(['受影響的服務有 web、db、', 'cache，請檢查。']);
    expect(c.splitClauses).toEqual([c.text]);
    expect(c.pythonClauses).toEqual([c.text]);
    // 同一條規則、但上限選得不同時，聚合層會把差別抹平 —— 語料兩種都留著。
    expect(get('ideographic-comma').splitForRemoteVoice).toEqual(['受影響對象甲、乙、丙，', '請檢查。']);
  });

  it('差異 3：全形冒號只有 splitClauses 與 Python 當切點', () => {
    const c = get('fullwidth-colon');
    expect(c.splitForRemoteVoice).toEqual(['偵測到告警：主機 ', 'CPU 使用率過高']);
    expect(c.splitClauses).toEqual(['偵測到告警：', '主機 CPU 使用率過高']);
    expect(c.pythonClauses).toEqual(['偵測到告警：', '主機 CPU 使用率過高']);
  });

  it('差異 4：半形句點只有 splitForRemoteVoice 當切點', () => {
    const c = get('en-period-sentences');
    expect(c.splitForRemoteVoice).toEqual(['Disk is almost full.', ' Please check now!']);
    expect(c.splitClauses).toEqual([c.text]);
    expect(c.pythonClauses).toEqual([c.text]);
  });

  it('差異 5：半形標點後面接數字或 / 時三份都不切（這句拿掉守衛時三份的輸出都會變）', () => {
    // 上限 6、下限 1：正規式真的會跑，`x,` 與 `y,` 若被當成切點會自成一段。
    // 舊的 `digit-and-slash-after-punct` 那句短於上限、且 `.` 本來就不是後兩份的切點，驗不到守衛。
    const c = get('guard-digit-slash-observable');
    expect(c.splitForRemoteVoice).toEqual(['x,1234', '5。', 'y,/234', '5']);
    expect(c.splitClauses).toEqual(['x,12345。', 'y,/2345']);
    expect(c.pythonClauses).toEqual(['x,12345。', 'y,/2345']);
  });

  it('差異 5b：全形數字前，兩份 TS 會切、Python 不切（\\d 的範圍不同）', () => {
    const c = get('fullwidth-digit-after-ascii-comma');
    expect(c.splitForRemoteVoice).toEqual(['數量,', '１２３。']);
    expect(c.splitClauses).toEqual(['數量,', '１２３。']);
    expect(c.pythonClauses).toEqual([c.text]);
  });

  it('差異 6：半形冒號只有 splitClauses 與 Python 當切點 —— IPv6 與 C:\\ 在它們身上被切開', () => {
    const v6 = get('ipv6');
    expect(v6.splitForRemoteVoice).toEqual(['對象 ', 'fe80::1ff:fe23:4567:890a ', '異常']);
    expect(v6.splitClauses).toEqual(['對象 fe80::1ff:', 'fe23:4567:890a 異常']);
    expect(v6.pythonClauses).toEqual(['對象 fe80::1ff:', 'fe23:4567:890a 異常']);

    const win = get('windows-path-visible-split');
    expect(win.splitForRemoteVoice).toEqual([win.text]);
    expect(win.splitClauses).toEqual(['受影響的磁碟是 C:', '\\Data\\logs，請清理。']);
    expect(win.pythonClauses).toEqual(['受影響的磁碟是 C:', '\\Data\\logs，請清理。']);
  });

  it('差異 7：空白只有 splitForRemoteVoice 當切點', () => {
    const c = get('long-no-punct-with-space');
    expect(c.splitForRemoteVoice.length).toBeGreaterThan(1);
    expect(c.splitForRemoteVoice.every((s) => s.length <= c.maxChars)).toBe(true);
    expect(c.splitClauses).toEqual([c.text]); // 沒有標點 → 整串一句，不受字數上限約束
    expect(c.pythonClauses).toEqual([c.text]);
  });

  it('差異 8：注音標註裡的冒號只有 Python 不切', () => {
    const c = get('bopomofo-tag');
    expect(c.splitClauses).toEqual(['受影響對象是主機点[:', 'ㄉㄧㄢ3]三五，請檢查。']);
    expect(c.pythonClauses).toEqual([c.text]);
  });

  it('聚合層：空字串在三份的回傳形狀不同', () => {
    const c = get('empty');
    expect(c.splitForRemoteVoice).toEqual(['']);
    expect(c.splitClauses).toEqual(['']);
    expect(c.pythonClauses).toEqual([]);
  });

  it('聚合層：splitClauses 丟掉只有空白的片段，接起來不等於原文', () => {
    const c = get('trailing-space');
    expect(c.splitForRemoteVoice.join('')).toBe(c.text);
    expect(c.splitClauses.join('')).not.toBe(c.text);
    expect(c.splitClauses.join('')).toBe(c.text.trimEnd());
  });

  it('聚合層：沒有標點的超長字串只有 splitForRemoteVoice 硬切', () => {
    const c = get('long-no-punct-ascii');
    expect(c.splitForRemoteVoice.length).toBeGreaterThan(1);
    expect(c.splitClauses).toEqual([c.text]);
    expect(c.pythonClauses).toEqual([c.text]);
  });

  it('聚合層：硬切不切在代理對中間，但上限為 1 時無法避免', () => {
    const ok = get('emoji-hard-split');
    for (const chunk of ok.splitForRemoteVoice) {
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    // 上限 1：一個 emoji 本身就超過上限，`end - 1 > i` 不成立 → 代理對被拆成兩段。
    expect(get('emoji-limit-1').splitForRemoteVoice).toHaveLength(4);
  });
});

describe('AC-3：兩個 speaker 檔沒有內嵌的切點正規式', () => {
  it.each(['speaker.ts', 'remoteSpeaker.ts'])('%s 裡找不到 lookbehind', (file) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(src).not.toMatch(/\(\?<=/);
    expect(src).toMatch(/from '\.\/splitRules'/);
  });
});
