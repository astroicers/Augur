/**
 * #81：清單列上的標記與編輯模式那一行提示的**文字**。
 *
 * 這裡只驗純函式。「標記真的出現在那一列上」「提示只在編輯模式出現」由
 * `MascotPanel.test.tsx` 那幾支接線測試驗 —— 兩種原因 × 兩種語言共八個字串，
 * 用 render 去驗等於每個字串都要跑一次完整的導播管線。
 */
import * as fs from 'fs';
import * as path from 'path';
import { CoreApp } from '@grafana/data';
import type { AlertLang, SuppressReason } from '../../core/types';
import {
  describeSkippedAliases,
  parseSeverityAliases,
  type SkippedAlias,
  type SkippedAliasLang,
} from '../../core/severityAliases';
import { PANEL_EDITOR_APP, isPanelEditor, skippedAliasNotice, suppressedMark } from '../feedNotices';

const LANGS: AlertLang[] = ['zh', 'en'];
const REASONS: SuppressReason[] = ['flapping', 'quiet'];

/** 寫錯的別名設定：一項缺 `=`、一項目標不是已知嚴重度。 */
const BAD_SPEC = '亂寫, sev2=nonsense';

// --- AC-1／AC-3：清單列上的標記 ------------------------------------------------

describe('#81 AC-1／AC-3：suppressedMark', () => {
  test('中文：兩種原因各有一個講得出「沒念」的標記，兩者不同字', () => {
    expect(suppressedMark('flapping', 'zh').label).toBe('抖動中，未念');
    expect(suppressedMark('quiet', 'zh').label).toBe('靜音時段，未念');
  });

  test('英文：跟著 alertLang 換成英文，兩者不同字', () => {
    expect(suppressedMark('flapping', 'en').label).toBe('flapping, not spoken');
    expect(suppressedMark('quiet', 'en').label).toBe('quiet hours, not spoken');
  });

  test('四種組合的 label 互不相同 —— 標記分辨得出原因，也分辨得出語言', () => {
    const labels = LANGS.flatMap((lang) => REASONS.map((reason) => suppressedMark(reason, lang).label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('每一種組合都有一段比 label 長的 title（滑過去才看到的完整原因）', () => {
    for (const lang of LANGS) {
      for (const reason of REASONS) {
        const mark = suppressedMark(reason, lang);
        expect(mark.label.trim()).not.toBe('');
        expect(mark.title.length).toBeGreaterThan(mark.label.length);
      }
    }
  });

  test('title 講得出是哪一道閘門（抖動提到窗、靜音提到時段）', () => {
    expect(suppressedMark('flapping', 'zh').title).toContain('窗');
    expect(suppressedMark('quiet', 'zh').title).toContain('時段');
    expect(suppressedMark('flapping', 'en').title).toContain('window');
    expect(suppressedMark('quiet', 'en').title).toContain('quiet-hours');
  });

  /**
   * #94：解除抑制時**不一定**會聽到一句 —— `createFlappingTracker` 的 `release()`／`drain()`
   * 只回傳「當下狀態與上次念出去的不同」的那幾則（`state.announced !== state.status`），
   * 一樣的就不出聲。原本的末句（「會把當下狀態念出來」／"the current state is spoken"）
   * 把它說成無條件會念，使用者於是等一句永遠不會來的話。
   *
   * 斷言釘的是**語意**而不是逐字的句子：條件子句在、無條件句式不在。逐字比對會讓日後
   * 任何潤飾都變紅，而本票要擋的缺陷是「有沒有講條件」，不是「用哪一種措辭講」。
   */
  test('#94：抖動的 title 寫明「與上次念出去的不同才補念」，沒有無條件會念的句式', () => {
    const zh = suppressedMark('flapping', 'zh').title;
    expect(zh).toContain('不同才補念');
    expect(zh).not.toContain('會把當下狀態念出來');

    const en = suppressedMark('flapping', 'en').title;
    expect(en).toContain('only if it differs');
    expect(en).not.toContain('is spoken');
  });
});

// --- AC-2：編輯模式的判定 ------------------------------------------------------

describe('#81 AC-2：isPanelEditor', () => {
  test('PANEL_EDITOR_APP 與 @grafana/data 的 CoreApp.PanelEditor 同值（本檔刻意不 import 它）', () => {
    expect(PANEL_EDITOR_APP).toBe(CoreApp.PanelEditor);
  });

  test('只有 panel-editor 算編輯模式', () => {
    expect(isPanelEditor(CoreApp.PanelEditor)).toBe(true);
    expect(isPanelEditor('panel-editor')).toBe(true);
  });

  test('其餘的 app 一律不算 —— 含 panel-viewer（看單一 panel 不是在編輯）', () => {
    for (const app of [CoreApp.Dashboard, CoreApp.PanelViewer, CoreApp.Explore, CoreApp.Unknown, 'PANEL-EDITOR', '']) {
      expect(isPanelEditor(app)).toBe(false);
    }
  });

  test('`data.request` 缺席（真實部署裡會發生）時回 false —— 退化成觀看模式，牆面螢幕不受干擾', () => {
    for (const app of [undefined, null, 0, false, {}, []]) {
      expect(isPanelEditor(app)).toBe(false);
    }
  });
});

// --- AC-2／AC-3：別名提示的文字 -----------------------------------------------

describe('#81 AC-2／AC-3：skippedAliasNotice', () => {
  test('沒有被略過的項目回 null（呼叫端一個 !== null 就決定要不要渲染）', () => {
    for (const lang of LANGS) {
      expect(skippedAliasNotice([], lang)).toBeNull();
      expect(skippedAliasNotice(parseSeverityAliases('P1=critical, sev2=warning').skipped, lang)).toBeNull();
    }
  });

  test('有被略過的項目時，輸出與 describeSkippedAliases 逐字相同（AC-2 指名用它的輸出）', () => {
    const { skipped } = parseSeverityAliases(BAD_SPEC);
    for (const lang of LANGS) {
      expect(skippedAliasNotice(skipped, lang)).toBe(describeSkippedAliases(skipped, lang));
    }
  });

  test('中文：列出項目數、每一項的原文與原因', () => {
    const notice = skippedAliasNotice(parseSeverityAliases(BAD_SPEC).skipped, 'zh')!;
    expect(notice).toContain('2 項');
    expect(notice).toContain('亂寫');
    expect(notice).toContain('sev2=nonsense');
    expect(notice).toContain('缺 `=`');
    expect(notice).toContain('目標不是已知嚴重度');
  });

  test('英文：同樣列出項目數、每一項的原文與原因，而且一個中文字都沒有', () => {
    const notice = skippedAliasNotice(parseSeverityAliases(BAD_SPEC).skipped, 'en')!;
    expect(notice).toContain('2 entries skipped');
    expect(notice).toContain('亂寫'); // 原文是使用者打的字，不翻譯
    expect(notice).toContain('sev2=nonsense');
    expect(notice).toContain('no `=`');
    expect(notice).toContain('target is not a known severity');
    // 原因與句子本身全是英文：唯一的非 ASCII 只准出現在使用者的原文與排版引號裡。
    expect(notice.replace(/亂寫/g, '').replace(/[“”—]/g, '')).toMatch(/^[\x20-\x7e]+$/);
  });

  test('英文的單數：只有一項時寫 entry 而不是 entries', () => {
    const notice = skippedAliasNotice(parseSeverityAliases('亂寫').skipped, 'en')!;
    expect(notice).toContain('1 entry skipped');
    expect(notice).not.toContain('entries');
  });

  test('四種略過原因在兩種語言下都講得出原因，而且同語言下四句互不相同', () => {
    const { skipped } = parseSeverityAliases('亂寫, =critical, sev2=nonsense, P1=critical, P1=warning');
    expect(skipped.map((s) => s.reason)).toEqual([
      'no-separator',
      'empty-alias',
      'unknown-target',
      'duplicate-alias',
    ]);
    for (const lang of LANGS) {
      const lines = skipped.map((s) => skippedAliasNotice([s], lang)!);
      expect(new Set(lines).size).toBe(lines.length);
      for (const line of lines) {
        expect(line).not.toBe('');
      }
    }
  });

  test('describeSkippedAliases 的 lang 預設仍是中文 —— #81 之前的呼叫端輸出逐字不變', () => {
    const { skipped } = parseSeverityAliases(BAD_SPEC);
    expect(describeSkippedAliases(skipped)).toBe(describeSkippedAliases(skipped, 'zh'));
    expect(describeSkippedAliases(skipped)).not.toBe(describeSkippedAliases(skipped, 'en'));
  });

  test('SkippedAliasLang 與 AlertLang 是同一個聯集（severityAliases.ts 刻意不 import 後者）', () => {
    // 雙向可指派才等於「完全相同」：單向只驗得到成員。任一邊多一種語言，這兩行之一就不編譯。
    const aliasLangs: SkippedAliasLang[] = ['zh', 'en'];
    const aliasToAlert: AlertLang[] = aliasLangs;
    const alertToAlias: SkippedAliasLang[] = LANGS;
    expect(aliasToAlert).toEqual(alertToAlias);
  });
});

// --- 純函式（AC-3 的字面要求） -------------------------------------------------

describe('#81 AC-3：純函式', () => {
  test('不 import React、不碰 DOM（原始碼層的機械檢查）', () => {
    // 判法與 `feedRows.test.ts`／`feedCsv.test.ts`／`BroadcastDirector.test.ts` 同一套
    // （同族的規則同一個判法）：先拿掉註解 —— 檔頭的說明會提到 react / DOM，那是散文不是相依。
    const code = fs
      .readFileSync(path.join(__dirname, '..', 'feedNotices.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const sources = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    // 刻意沒有 `@grafana/data`：編輯模式那個字串以 `PANEL_EDITOR_APP` 的字面值表示，
    // 與上游的 `CoreApp.PanelEditor` 由上面那一支測試比對。
    expect(sources).toEqual(['../core/types', '../core/severityAliases']);
    // 裸 token 的掃描**要先把字串字面值掏空**：本檔的字串是給人看的文字，而英文那幾句
    // 真的含 "window"（抖動抑制的那個窗）—— 掃原始碼會把顯示文字誤判成相依。
    const logic = code.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
    for (const token of [/\breact\b/i, /\bwindow\b/, /\bdocument\b/, /\bnavigator\b/, /\bDate\b/]) {
      expect(logic).not.toMatch(token);
    }
  });

  test('同輸入同輸出，而且不會被呼叫端改到（標記物件是凍不凍都一樣的共用常數，比的是值）', () => {
    const a = suppressedMark('flapping', 'zh');
    const b = suppressedMark('flapping', 'zh');
    expect(a).toEqual(b);
    const skipped: SkippedAlias[] = [{ entry: '亂寫', reason: 'no-separator' }];
    expect(skippedAliasNotice(skipped, 'zh')).toBe(skippedAliasNotice([...skipped], 'zh'));
    // 傳進去的陣列一字未動（`readonly` 只是型別，這一條驗的是執行期）。
    expect(skipped).toEqual([{ entry: '亂寫', reason: 'no-separator' }]);
  });
});
