/**
 * feed 要顯示哪幾列（#79）。
 *
 * 從 `MascotPanel.tsx` 的 `renderFeedLines` 抽出來的三件事：
 *  1. 合併 —— 本分頁念過、但紀錄裡沒有的句子（sessionOnly）補在紀錄前面；
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
import type { BroadcastPlan } from '../core/types';
import type { HistoryResult } from '../sources/history';

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
}

/** 畫面上的一列。`origin` 讓探測與測試分得出「紀錄列」與「本分頁念過的列」（複審 H1）。 */
export interface FeedRow {
  key: string;
  origin: 'session' | 'history';
  when: string;
  text: string;
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
      rows: feed.map((l) => ({ key: l.key, origin: 'session', when: l.when, text: l.plan.text })),
      emptyText: feed.length ? null : FEED_EMPTY_TEXT.session,
    };
  }
  const q = filter.trim().toLowerCase();
  // 本分頁念過、但紀錄裡沒有的句子：典型是範圍開始前就在燒的告警 —— 載入時照樣念，
  // 但那次狀態變化不在範圍內。不補上就會「念了、清單上卻找不到」。它們是剛念的，排在最上面。
  // 「已經在紀錄裡」要同文字**而且時間對得上**：紀錄時間在念出時刻前後的窗內。
  // 只比文字的話，數值沒變的 firing 或沒有數值的 resolved，會被幾小時前同文字的舊紀錄吃掉（複審 L3）。
  const sessionOnly = feed.filter(
    (l) => !history.entries.some((e) => e.text === l.plan.text && Math.abs(e.time - l.at) <= SESSION_MATCH_WINDOW_MS)
  );
  const rows: Array<FeedRow & { search: string }> = [
    ...sessionOnly.map((l) => ({
      key: l.key,
      origin: 'session' as const,
      when: l.when,
      text: l.plan.text,
      search: l.plan.text.toLowerCase(),
    })),
    // `e.search` 是句子加上所有 label 值、已轉小寫（`history.ts`）——篩選因此同時比對兩者。
    ...history.entries.map((e) => ({
      key: e.key,
      origin: 'history' as const,
      when: formatWhen(e.time),
      text: e.text,
      search: e.search,
    })),
  ];
  const shown = q ? rows.filter((r) => r.search.includes(q)) : rows;
  return {
    rows: shown.map((r) => ({ key: r.key, origin: r.origin, when: r.when, text: r.text })),
    emptyText: shown.length ? null : q ? FEED_EMPTY_TEXT.filtered : FEED_EMPTY_TEXT.history,
  };
}
