/**
 * 把「目前畫面上那幾列」轉成一份 CSV（#80）。
 *
 * 值班交接或事後檢討時要把吉祥物念過的話帶走（貼進工單、附在報告裡）。零後端（ADR-004）
 * 所以整件事在瀏覽器裡做完：**本檔只產字串**，Blob 與 `a[download]` 那一步在
 * `MascotPanel.tsx`（#80 AC-3 要求兩者分開）。
 *
 * **不 import React、不碰 DOM、不讀時鐘**：唯一的輸入是 `buildFeedRows` 的輸出
 * （#79 的 `FeedRow[]`，也就是畫面上那幾列 —— 篩選已經套過了），加上檔名要用的
 * dashboard uid、panel id 與時間。匯出與畫面讀**同一份** `rows`，所以「匯出的就是
 * 畫面上那幾列」不需要兩邊各算一次來維持一致。
 *
 * **跳脫（RFC 4180）與防公式注入是兩件不同的事，兩件都做**：
 *  1. RFC 4180：含逗號、雙引號、換行，或前後有空白的欄位加雙引號包起來，內部的雙引號加倍。
 *     前後空白在 RFC 裡是欄位的一部分（§2.4），加引號是為了在「看得出來」這件事上不靠解析器的善意。
 *  2. 公式注入：試算表會把 `=`、`+`、`-`、`@` 開頭的儲存格當公式算（還可能跳出外部連結、
 *     DDE 執行提示）。告警句子裡的 `-` 開頭很常見（`- A=0.93`），所以這不是理論風險。
 *     處置是**在前面加一個單引號**（`CSV_FORMULA_PREFIX`），OWASP 的建議做法。
 *     代價誠實寫在文件裡（`src/README.md`）：那個單引號**會出現在儲存格裡**。
 */
import type { FeedRow } from './feedRows';

/** 欄位標題。順序就是欄位順序；`時間` 是 UTC 的 ISO 8601（見 `isoUtc`）。 */
export const FEED_CSV_COLUMNS = ['時間（ISO 8601，UTC）', '來源', '句子'] as const;

/** `FeedRow.origin` 在 CSV 裡的字。與畫面上的 `data-origin` 同一個分界，只是給人讀。 */
export const FEED_CSV_ORIGIN: Record<FeedRow['origin'], string> = {
  history: '紀錄',
  session: '本分頁',
};

/** RFC 4180 §2.1：記錄以 CRLF 分隔。最後一列也收尾（§2.2 的尾端 CRLF 是選填的）。 */
export const CSV_NEWLINE = '\r\n';

/**
 * UTF-8 BOM。Excel 在 Windows 上讀沒有 BOM 的 CSV 會用系統的舊編碼，中文句子整欄變亂碼 ——
 * 匯出的東西是要貼進工單的，亂碼等於沒匯出。BOM 放在純函式這一側（而不是下載那一步）：
 * 「檔案的內容長什麼樣」整條規則有一個住處，測試也釘得到。
 */
export const CSV_BOM = '\ufeff';

/** 防公式注入的前綴。釘死用單引號（不是定位字元、不是前置空白）—— 見檔頭第 2 點。 */
export const CSV_FORMULA_PREFIX = "'";

/**
 * 要加前綴的開頭。`^\s*[=+\-@]`：**前置空白不算安全** —— 部分試算表匯入時會把它修掉，
 * 修掉之後 `=` 就又在開頭了。`^[\t\r]`：定位字元與 CR 自己也在 OWASP 的清單上。
 */
const CSV_FORMULA_RISK = /^[\t\r]|^\s*[=+\-@]/;

/** 要加引號的欄位：含分隔字元、雙引號、換行，或前後有空白。 */
const CSV_NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** 檔名允許的字元以外一律換成 `-`（Windows 的 `:*?"<>|/\` 與空白都在「以外」）。 */
const FILENAME_UNSAFE = /[^A-Za-z0-9_-]+/g;

/** `new Date(t).toISOString()` 的有效範圍（ECMA-262 的 time clip）；超過會丟 RangeError。 */
const MAX_TIME_MS = 8.64e15;

/** dashboard uid 進檔名前先截這麼長。uid 是使用者可控的字串，不讓它把檔名撐爆。 */
const UID_MAX_CHARS = 48;

/**
 * 一個欄位 → CSV 的一格。防注入的前綴先加，再決定要不要加引號 ——
 * 要不要加引號看的是**原值**（前綴是我們加的 `'`，它自己不需要引號）。
 */
export function csvCell(value: string): string {
  const body = CSV_FORMULA_RISK.test(value) ? CSV_FORMULA_PREFIX + value : value;
  return CSV_NEEDS_QUOTES.test(value) ? `"${body.replace(/"/g, '""')}"` : body;
}

/**
 * 時間戳 → UTC 的 ISO 8601（`2026-10-18T07:45:00.000Z`）。
 *
 * **釘死 UTC（`Z`）而不是本地時區偏移**：值班交接跨時區時，「09:00」是誰的九點會被讀錯；
 * 帶 `Z` 的那一欄在任何地方讀都是同一個時刻。要看本地時間的人在畫面上看（那一欄是
 * `FeedRow.when`，吃 locale）。
 *
 * 時間戳壞掉（`NaN`、`Infinity`、超出 time clip 範圍）時回空字串而不是丟錯：
 * 一筆紀錄的時間讀壞不該讓整份匯出失敗，而空欄位看得出來是壞的。
 */
function isoUtc(at: number): string {
  return Number.isFinite(at) && Math.abs(at) <= MAX_TIME_MS ? new Date(at).toISOString() : '';
}

/**
 * 畫面上那幾列 → 一整份 CSV（含 BOM 與標題列）。
 *
 * 空清單時回「只有標題列」的字串。**畫面上不會按到這個結果**：清單是空的時候匯出鈕是
 * disabled（#80 AC-4，`MascotPanel.tsx` 另有一道早退）。純函式這一側仍回一份合法的 CSV，
 * 因為「零列」不是錯誤，而回空字串會讓呼叫端多一條分支。
 */
export function feedRowsToCsv(rows: readonly FeedRow[]): string {
  const records: Array<readonly string[]> = [
    FEED_CSV_COLUMNS,
    ...rows.map((r) => [isoUtc(r.at), FEED_CSV_ORIGIN[r.origin], r.text]),
  ];
  return CSV_BOM + records.map((cells) => cells.map(csvCell).join(',')).join(CSV_NEWLINE) + CSV_NEWLINE;
}

/** 檔名的一段：允許的字元以外換成 `-`，頭尾的 `-` 去掉（去掉後可能是空字串，由呼叫端濾掉）。 */
function fileSafe(s: string): string {
  return s.replace(FILENAME_UNSAFE, '-').replace(/^-+|-+$/g, '');
}

/** 時間戳 → 檔名用的 UTC 戳記 `20261018T074500Z`（`:` 在 Windows 的檔名裡不合法）。 */
function filenameStamp(at: number): string {
  const iso = isoUtc(at);
  return iso === '' ? '' : iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * 匯出檔的檔名：`augur-broadcast-<dashboard uid>-panel<id>-<UTC 戳記>.csv`。
 *
 * **dashboard uid 取不到時整段省略**（檔名變 `augur-broadcast-panel7-…`，不是
 * `…-undefined-…`）：這個值在本專案是**會缺的** —— `alertState` 在 12.3.0–12.3.11 只有數字
 * `dashboardId`，而 `data.request.dashboardUID` 在還沒存檔的 dashboard 上也沒有
 * （`MascotPanel.tsx` 的兩處取法都是 `alertState?.dashboardUID ?? data.request?.dashboardUID`）。
 * 時間戳同理：壞掉就省略那一段，不讓 `NaN` 進檔名。
 */
export function feedCsvFilename(opts: { dashboardUid?: string; panelId: number; at: number }): string {
  const segments = [
    'augur-broadcast',
    fileSafe((opts.dashboardUid ?? '').slice(0, UID_MAX_CHARS)),
    `panel${fileSafe(String(opts.panelId))}`,
    filenameStamp(opts.at),
  ];
  return `${segments.filter((s) => s !== '').join('-')}.csv`;
}

/** 下載時用的 MIME。`charset=utf-8` 與 `CSV_BOM` 是同一件事的兩層保險。 */
export const FEED_CSV_MIME = 'text/csv;charset=utf-8';
