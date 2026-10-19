/**
 * 清單列上的標記與面板上的提示文字（#81）。
 *
 * 兩件事已經在資料層算好了，畫面上卻看不到 —— 本檔是它們的消費端，而且只決定**文字**：
 *
 *  1. 導播回傳的每一則 item 帶有 `suppressed`（`'flapping'`／`'quiet'`，#63／#64），
 *     使用者因此看不出「這句為什麼沒念」→ `suppressedMark()`；
 *  2. 別名設定寫錯的項目由 `describeSkippedAliases`（#51）回報，但沒有任何 UI 使用它，
 *     寫錯的設定於是靜默失效 → `skippedAliasNotice()`。
 *
 * **不 import React、不碰 DOM、不讀時鐘**（與 `feedRows.ts`／`feedCsv.ts` 同一條）：元件只負責
 * 把這裡的字串放進 JSX。抽出來的理由是「畫面上寫什麼」要能在不 render 整個面板的情況下驗 ——
 * 兩種標記、兩種語言共八個字串，用 render 去驗等於每一個字串都要跑一次完整的導播管線。
 *
 * **別名提示的句子不在這裡組**：那是 `core/severityAliases.ts` 的 `describeSkippedAliases`
 * （票文 AC-2 指名用它的輸出），本檔只決定「要不要顯示」並把語言轉手過去。中英兩套文字
 * 於是只有一個住處 —— 兩邊各組一句的話，日後多一種略過原因必然只補到其中一邊。
 */
import type { AlertLang, SuppressReason } from '../core/types';
import { describeSkippedAliases, type SkippedAlias } from '../core/severityAliases';

/** 一列上的標記：`label` 進畫面，`title` 是滑過去才看到的那一段原因。 */
export interface SuppressedMark {
  /** 短標記，清單列上每一列都放得下。 */
  label: string;
  /** 完整原因（`title` 屬性）。清單是給人掃的，長句子不能進 label。 */
  title: string;
}

/**
 * 兩種抑制原因 × 兩種語言的文字。**標記的值與 `SuppressReason` 同字**
 * （`data-suppressed="flapping"`／`="quiet"`），所以測試分辨兩種標記不必靠中文字面值 ——
 * 語言一改，靠文字分辨的測試就會碎。
 */
const SUPPRESSED_TEXT: Record<AlertLang, Record<SuppressReason, SuppressedMark>> = {
  zh: {
    flapping: {
      label: '抖動中，未念',
      title:
        '這則在設定的窗內 firing↔resolved 翻太多次，被抖動抑制擋下（#64）。維持同一個狀態滿一個窗之後解除抑制：當下狀態與上次念出去的不同才補念一句，一樣就不出聲。',
    },
    quiet: {
      label: '靜音時段，未念',
      title: '現在落在值班靜音時段內，而這一則破不了靜音（#63）。時段結束後不會補念。',
    },
  },
  en: {
    flapping: {
      label: 'flapping, not spoken',
      title:
        'This alert flipped between firing and resolved too many times inside the window, so flapping suppression held it back. Suppression lifts once it holds one state for a full window: the current state is read out then only if it differs from the state announced last; if they match, nothing is said.',
    },
    quiet: {
      label: 'quiet hours, not spoken',
      title:
        'The quiet-hours window is on right now and this alert does not break the silence. It is not read out later when the window ends.',
    },
  },
};

/**
 * 一則被抑制的 item 在清單上要顯示的標記。
 *
 * 只給**有** `suppressed` 的列用：沒有 `suppressed` 的列不呼叫這一支，也不該為它生出一個
 * 空標記 —— 「沒有 suppressed 的列畫面與先前逐字相同」是本票的驗收條件（AC-1）。
 */
export function suppressedMark(reason: SuppressReason, lang: AlertLang): SuppressedMark {
  return SUPPRESSED_TEXT[lang][reason];
}

/**
 * `data.request.app` 等於這個值時，panel 正在**編輯**面板裡被渲染（`CoreApp.PanelEditor`）。
 *
 * 字面值而不是 import `@grafana/data` 的 `CoreApp`：本檔的不變量是「零 React、零 Grafana
 * 相依的純文字決定」。代價是這個字串可能與上游漂開，所以 `feedNotices.test.ts` 有一支
 * 直接拿 `CoreApp.PanelEditor` 比對它 —— 漂了就紅在那裡，而不是在使用者的面板上靜默失效。
 */
export const PANEL_EDITOR_APP = 'panel-editor';

/**
 * `data.request?.app` 是不是編輯器那個值。
 *
 * ⚠️ **這一支只是聯集裡的一個訊號，不要單獨當「在不在編輯模式」用** —— 它在
 * Grafana 12.4.12 實測不成立（#100），判定請走下面的 `isPanelEditing`。
 *
 * ⚠️ **`data.request` 在真實部署裡會缺**
 * （`MascotPanel.tsx` 的 dashboard uid 那兩處註解記著 12.3.x 實測過的同一件事）。
 * panel plugin 拿不到現成的 `isEditing` 布林，`props.data.request.app` 是公開型別
 * （`@grafana/data` 的 `DataQueryRequest`）上唯一說得出「誰發起這次查詢」的欄位。
 *
 * 缺席時回 `false`（＝當作觀看模式，不顯示提示）。退化的方向是刻意的：牆面螢幕上多出
 * 一行設定錯誤的提示，比編輯者少看到一行提示糟得多 —— 前者打擾的是值班的人，而後者
 * 打開編輯面板就會再看一眼。這個取捨寫在 `src/README.md` 與 PR 描述裡。
 */
export function isPanelEditor(app: unknown): boolean {
  return app === PANEL_EDITOR_APP;
}

/**
 * 網址上的 `editPanel` 查詢參數指的是不是**本** panel（#100）。
 *
 * ⚠️ **查詢參數是字串、`PanelProps.id` 是數字**：`'3' === 3` 為 false，直接比會讓提示
 * 在自己的編輯器裡也不出現 —— 那正是本票要修的症狀換一個成因。所以這裡先轉型再比。
 *
 * 只認**純十進位整數**（`/^\d+$/`）：`Number('')` 是 0、`Number(' 7 ')` 是 7，
 * 用 `Number()` 當守門員的話 `?editPanel=` 這種空值會在 `id === 0` 的 panel 上誤判成編輯中。
 * 參數缺席（`null`／`undefined`，＝網址上沒有這一個鍵）一律回 false。
 *
 * 本支**不讀網址** —— 參數由元件邊界的 `useEditPanelParam()` 讀進來（本檔的不變量是
 * 「零 React、零 Grafana 相依的純文字決定」，`locationService` 來自 `@grafana/runtime`）。
 */
export function isEditPanelParamFor(editPanel: string | null | undefined, panelId: number): boolean {
  return typeof editPanel === 'string' && /^\d+$/.test(editPanel) && Number(editPanel) === panelId;
}

/**
 * 現在是不是在**編輯本 panel**（#100 取代 `isPanelEditor(data.request?.app)` 單打）。
 *
 * #81 當初只看 `data.request?.app === 'panel-editor'`。v0.4.0 發版前在 Grafana 12.4.12
 * 實測（`/d/rel030?editPanel=3`，該 panel 有 Prometheus query 所以 `data.request` 存在）：
 * **提示沒有出現** —— 12.x 的編輯器傳進來的 `app` 不是 `CoreApp.PanelEditor`。於是本支改成
 * 兩個訊號取**聯集**：
 *
 *  1. `app === 'panel-editor'`（舊訊號，留著 —— 它在哪些版本成立我們只實測過它在 12.4.12
 *     *不*成立，沒有證據說它在別處也不成立；拿掉等於多冒一次險）；
 *  2. 網址的 `editPanel` 等於本 panel 的 `id`（12.x 的編輯器網址是 `/d/<uid>?editPanel=<id>`）。
 *
 * `hasRequest` 這道閘門**刻意保留**（AC-3）：`data.request` 缺席時一律回 false，即使網址上
 * 有 `editPanel`。退化方向不變 —— 牆面螢幕上多一行設定錯誤的提示，比編輯者少看到一行糟得多。
 * 代價誠實記下：完全沒有 query 的 panel（`data.request` 從頭到尾不存在）在編輯器裡也看不到
 * 這一行，新訊號救不了它，因為救它就等於拆掉這道閘門。
 */
export function isPanelEditing(args: {
  /** `data.request?.app`。 */
  app: unknown;
  /** `data.request` 這個欄位存不存在（AC-3 的閘門；缺席＝當作觀看模式）。 */
  hasRequest: boolean;
  /** 網址上的 `editPanel`（由元件邊界讀進來；沒有這個鍵時是 `null`）。 */
  editPanel: string | null | undefined;
  /** 本 panel 的 `PanelProps.id`。 */
  panelId: number;
}): boolean {
  if (!args.hasRequest) {
    return false;
  }
  return isPanelEditor(args.app) || isEditPanelParamFor(args.editPanel, args.panelId);
}

/**
 * 別名設定被略過的項目 → 面板上那一行提示；沒有被略過的項目回 `null`。
 *
 * 回 `null` 而不是空字串，與 `feedRows.ts` 的 `emptyText` 同一個約定：呼叫端一個
 * `!== null` 就決定要不要渲染那個節點，不必自己判斷「空字串算不算有東西」。
 *
 * **要不要顯示**（編輯模式與否）不在這裡判斷 —— 那是 `isPanelEditor` 加元件那一處分支；
 * 本支只管「有沒有東西可說」。
 */
export function skippedAliasNotice(skipped: readonly SkippedAlias[], lang: AlertLang): string | null {
  return skipped.length === 0 ? null : describeSkippedAliases(skipped, lang);
}
