/**
 * feed 要顯示哪幾列（#79）。
 *
 * 從 `MascotPanel.tsx` 的 `renderFeedLines` 抽出來的三件事：
 *  1. 合併 —— 本分頁念過、但紀錄裡沒有的句子（sessionOnly）補在紀錄前面；講同一件事的
 *     兩邊都有時只留紀錄那一列，並把「為什麼沒念」帶過去（#99）；
 *  2. 篩選 —— 篩選框的字串，大小寫不敏感，同時比對句子與 label 值；
 *  3. 空清單 —— 三種情境各自的提示文字。
 *
 * **不 import React、不碰 DOM**：元件只負責把 `rows` 映射成 JSX。抽出來的理由是
 * 這三件事先前只能靠 render 整個面板間接驗，而後續的紀錄匯出、清單標記都要讀
 * 「現在畫面上的那幾列」。**對外行為與抽出前相同**，由 `MascotPanel.test.tsx`
 * 既有的斷言（一行未改）釘住。
 *
 * **時鐘**：合併規則只比對兩個**既有的時間戳**（紀錄的 `time` 與念出時刻 `at`），
 * 不讀「現在」——所以 `buildFeedRows` 的決策面（合併、篩選、空清單）是輸入的純函式。
 * 唯一讀時鐘的是把紀錄時間戳轉成顯示字串的 `formatHistoryWhen`（要分辨「今天」），
 * 它的「現在」是參數，而且整個 formatter 可從第四個參數注入 —— 測試因此不必看時鐘臉色。
 */
import type { BroadcastPlan, SuppressReason } from '../core/types';
import type { HistoryEntry, HistoryResult } from '../sources/history';

/**
 * 本分頁念過的一句，和紀錄裡同文字的一筆，時間差多少以內算「同一件事」。
 * 紀錄時間是 Grafana 評估出狀態變化的時刻；panel 要到下一次 refresh 才念，所以念出時刻會晚一些
 * （refresh 間隔＋評估間隔）。窗開寬一點無妨：同一條規則在十分鐘內又出現同一句，本來就是同一類事件。
 * 上限：refresh 間隔超過 10 分鐘時，同一事件可能同時出現一列紀錄列與一列本分頁列 —— 只是重複，資訊不錯。
 */
export const SESSION_MATCH_WINDOW_MS = 10 * 60 * 1000;

/** 本分頁念過的一句（feed 的 state 元素）。 */
export interface FeedLine {
  key: string;
  when: string;
  /** 念出的時刻（epoch ms）。紀錄模式要拿它和紀錄的時間比，判斷「這一句是不是已經在紀錄裡」。 */
  at: number;
  plan: BroadcastPlan;
  /**
   * 這一句**沒有**被念出來的原因（`BroadcastItem.suppressed` 原樣轉手，#81）；
   * `undefined` ＝ 念了。`'flapping'`／`'quiet'` 兩種各自在清單上標一個標記，
   * 文字由 `feedNotices.ts` 的 `suppressedMark` 決定。
   *
   * 名字叫「沒念」而不是「沒播報」是刻意的：被抑制的那一則**照樣進清單、照樣換表情**，
   * 只是沒有聲音（見 `BroadcastDirector.ts` 的交付閘門）。
   */
  suppressed?: SuppressReason;
}

/** 畫面上的一列。`origin` 讓探測與測試分得出「紀錄列」與「本分頁念過的列」（複審 H1）。 */
export interface FeedRow {
  key: string;
  origin: 'session' | 'history';
  /** 給人看的時間字串（`formatWhen` 的輸出，吃 locale）。 */
  when: string;
  /**
   * 這一列的時間戳（epoch ms）：紀錄列是狀態變化時刻 `entry.time`，本分頁的列是念出時刻 `line.at`。
   * 與 `when` 並存而不是取代它：`when` 是**給人看的**、吃 locale 又會省略日期，
   * 機器要讀的時間（匯出 CSV 的 ISO 8601 欄，#80）從它回推不出來。
   */
  at: number;
  text: string;
  /**
   * 這一列**沒有**被念出來的原因（#81）；`undefined` ＝ 念了，那一列的畫面與 #81 之前逐字相同。
   *
   * 紀錄列（`origin: 'history'`）本身不帶這個資訊 —— Grafana 的狀態歷史（ADR-006）記的是
   * 「狀態變化」而不是「這個分頁念了沒有」。但合併時紀錄列會**取代**講同一件事的本分頁列
   * （`sameEvent`），而被取代掉的那一列知道答案，所以原因跟著轉移過來（#99）：被抑制的是
   * 「這個分頁沒念這件事」，換哪一列顯示不改變這個事實。沒有本分頁列對得上的紀錄列
   * （例如分頁打開之前就發生的事）一律 `undefined` —— 紀錄裡沒有的就不猜。
   */
  suppressed?: SuppressReason;
}

export interface FeedRowsResult {
  rows: FeedRow[];
  /** 清單是空的時候要顯示的提示；有列可顯示時是 `null`（`rows.length === 0` 與它非 null 恆等價）。 */
  emptyText: string | null;
}

/**
 * 三種空清單提示。三種情境是分開的：沒有紀錄模式、有紀錄但範圍內沒有、有紀錄但篩選後沒有 ——
 * 共用一句的話，使用者分不出「這段時間沒事」和「你的篩選字打錯了」。
 */
export const FEED_EMPTY_TEXT = {
  /** 沒有紀錄（降級或還沒載到）且本分頁也還沒念過。 */
  session: '尚無播報。持續 firing 只會念一次 —— 那是 dedup 在生效。',
  /** 紀錄模式、沒有篩選，而這段時間範圍內沒有任何列。 */
  history: '這段時間範圍內沒有播報紀錄。',
  /** 紀錄模式、有篩選字串，但沒有列對得上。 */
  filtered: '沒有符合的紀錄。',
} as const;

/**
 * 一筆紀錄的時間要怎麼顯示：今天的只顯示時間；更早的連日期一起顯示，翻舊紀錄時才分得出是哪一天。
 * `now` 是參數而不是直接讀 `Date.now()`，這樣「今天」這個判斷在測試裡是可控的。
 */
export function formatHistoryWhen(time: number, now: number = Date.now()): string {
  const d = new Date(time);
  return d.toDateString() === new Date(now).toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

/**
 * 紀錄裡的一筆和本分頁念過的一句，是不是「同一件事」：同文字**而且**時間對得上
 * （紀錄時間落在念出時刻前後 `SESSION_MATCH_WINDOW_MS` 的窗內）。
 *
 * 合併（留哪一列）與抑制原因的轉移（#99）讀的是**同一個**判定，而且比對鍵與窗長都不動：
 * 另開一套比對鍵、或把窗放寬，也能讓標記「出現」而單元測試照樣綠 —— 代價是久遠的紀錄
 * 被誤標成本分頁抑制的。本票只改「留下的那一列帶誰的 `suppressed`」。
 */
function sameEvent(entry: Pick<HistoryEntry, 'text' | 'time'>, line: FeedLine): boolean {
  return entry.text === line.plan.text && Math.abs(entry.time - line.at) <= SESSION_MATCH_WINDOW_MS;
}

/**
 * 合併的結果：哪幾列本分頁的句子沒有紀錄可對（要補在紀錄前面），以及**每一筆紀錄**
 * 要帶誰的「沒念」原因。兩者出自同一次比對 —— 分成兩個迴圈算就可能一邊說「這一列被
 * 紀錄取代了」、另一邊說「沒有本分頁列對得上」。
 */
interface SessionMerge {
  /** 紀錄裡沒有的本分頁句子，順序照 `feed`。 */
  sessionOnly: FeedLine[];
  /** 與 `entries` 同長、同索引：那一筆紀錄列要顯示的 `suppressed`（#99）。 */
  suppressed: Array<SuppressReason | undefined>;
}

/**
 * 把本分頁的句子和紀錄對起來。
 *
 * 一句本分頁的話若對得上紀錄，它就**不自己佔一列**，而是由**時間最接近**的那一筆紀錄代替顯示 ——
 * 所以「這個分頁沒念它」這個資訊也跟著轉到那一筆上（#99 AC-1）。一筆紀錄被多句對上時
 * （例如窗內先被抖動抑制、後來又進了靜音時段），取距離最近的那一句；同距離取 `feed` 裡
 * 較前面的，而呼叫端維持「新的在前」，於是同距離取較新的。
 *
 * 兩個刻意的選擇：
 *  - **一句只轉移到一筆紀錄**（它最近的那一筆）。否則窗內有兩筆紀錄時，一次被抑制的播報
 *    會在畫面上標出兩個標記。
 *  - 最近的那一句其實念了（`suppressed` 是 `undefined`）時就**不帶標記**，而不是從較遠的
 *    那一句撿一個原因來標 —— 那會謊稱沒念。
 *
 * 沒有任何本分頁句子對得上的紀錄列一律 `undefined`（AC-2：抑制是本分頁當下的決定，
 * 紀錄裡沒有，不猜）。
 */
function mergeSession(feed: readonly FeedLine[], entries: readonly HistoryEntry[]): SessionMerge {
  const sessionOnly: FeedLine[] = [];
  const suppressed: Array<SuppressReason | undefined> = entries.map(() => undefined);
  /** 每一筆紀錄目前是被多近的一句本分頁話對上的（還沒有就是 `Infinity`）。 */
  const claimed: number[] = entries.map(() => Infinity);
  for (const l of feed) {
    let nearest = -1;
    let nearestGap = Infinity;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (!sameEvent(e, l)) {
        continue;
      }
      const gap = Math.abs(e.time - l.at);
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = i;
      }
    }
    if (nearest < 0) {
      sessionOnly.push(l);
      continue;
    }
    if (nearestGap < claimed[nearest]!) {
      claimed[nearest] = nearestGap;
      suppressed[nearest] = l.suppressed;
    }
  }
  return { sessionOnly, suppressed };
}

/**
 * 算出 feed 要顯示的列與空清單提示。
 *
 * @param feed    本分頁念過的句子，**新的在前**（呼叫端維持的順序，這裡不重排）。
 * @param history 紀錄模式的結果；`null`＝沒有紀錄（降級回本分頁的句子，ADR-006 決策 7），
 *                此時 `filter` 不生效 —— 篩選框本來就只在紀錄模式下顯示。
 * @param filter  篩選框的字串；前後空白修掉後為空字串即視為沒有篩選。
 * @param formatWhen 紀錄時間戳 → 顯示字串。預設讀「現在」以分辨今天，測試可注入。
 */
export function buildFeedRows(
  feed: readonly FeedLine[],
  history: HistoryResult | null,
  filter: string,
  formatWhen: (time: number) => string = formatHistoryWhen
): FeedRowsResult {
  if (!history) {
    return {
      rows: feed.map((l) => ({
        key: l.key,
        origin: 'session' as const,
        when: l.when,
        at: l.at,
        text: l.plan.text,
        suppressed: l.suppressed,
      })),
      emptyText: feed.length ? null : FEED_EMPTY_TEXT.session,
    };
  }
  const q = filter.trim().toLowerCase();
  // 本分頁念過、但紀錄裡沒有的句子：典型是範圍開始前就在燒的告警 —— 載入時照樣念，
  // 但那次狀態變化不在範圍內。不補上就會「念了、清單上卻找不到」。它們是剛念的，排在最上面。
  // 「已經在紀錄裡」要同文字**而且時間對得上**：紀錄時間在念出時刻前後的窗內。
  // 只比文字的話，數值沒變的 firing 或沒有數值的 resolved，會被幾小時前同文字的舊紀錄吃掉（複審 L3）。
  const { sessionOnly, suppressed } = mergeSession(feed, history.entries);
  const rows: Array<FeedRow & { search: string }> = [
    ...sessionOnly.map((l) => ({
      key: l.key,
      origin: 'session' as const,
      when: l.when,
      at: l.at,
      text: l.plan.text,
      suppressed: l.suppressed,
      search: l.plan.text.toLowerCase(),
    })),
    // `e.search` 是句子加上所有 label 值、已轉小寫（`history.ts`）——篩選因此同時比對兩者。
    // `suppressed` 是被這一列取代掉的本分頁列轉過來的（#99）；它不進 `search`，
    // 所以 AC-3 成立：篩選讀的還是同一份字串，結果與本票之前逐字相同。
    ...history.entries.map((e, i) => ({
      key: e.key,
      origin: 'history' as const,
      when: formatWhen(e.time),
      at: e.time,
      text: e.text,
      suppressed: suppressed[i],
      search: e.search,
    })),
  ];
  const shown = q ? rows.filter((r) => r.search.includes(q)) : rows;
  return {
    rows: shown.map((r) => ({
      key: r.key,
      origin: r.origin,
      when: r.when,
      at: r.at,
      text: r.text,
      suppressed: r.suppressed,
    })),
    emptyText: shown.length ? null : q ? FEED_EMPTY_TEXT.filtered : FEED_EMPTY_TEXT.history,
  };
}
