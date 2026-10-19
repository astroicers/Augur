/**
 * 「網址上的 `editPanel` 是哪一個 panel」—— 編輯模式判定的新訊號（#100）。
 *
 * **為什麼不放 `src/feed/feedNotices.ts`**：那支是純文字模組（零 React、零 Grafana 相依，
 * 它自己的測試有一條掃原始碼的斷言在釘這件事），而這個訊號要讀 `@grafana/runtime` 的
 * `locationService`。理由與 `src/sources/rulesFetcher.ts` 的檔頭同一條：把 runtime 的
 * 相依關在**一支薄檔**裡，別的模組才不必為了被測而長出替身。本專案到 #100 之前
 * 一個 `jest.mock('@grafana/runtime')` 都沒有，這支也沒有讓它多出一個 ——
 * jest 環境下 `locationService` 是 `HistoryWrapper` 包的 memory history
 * （`@grafana/runtime` 13.1.0 `dist/esm/services/LocationService.mjs`：
 * `process.env.NODE_ENV === 'test' ? H.createMemoryHistory(...) : H.createBrowserHistory(...)`），
 * 測試用 `locationService.push('/d/x?editPanel=7')` 就能擺出編輯器網址。
 *
 * **出處**（AC-1 要求附依據，不靠推論）：
 *
 *  - `locationService: LocationService` 由 `@grafana/runtime` 的根 export 公開
 *    （`node_modules/@grafana/runtime/dist/types/services/LocationService.d.ts:50`，
 *    經 `services/index.d.ts:7` 的 `export * from './LocationService'` 轉出），
 *    介面上 `getSearch(): URLSearchParams` 與 `getLocationObservable(): Observable<Location>`
 *    都標 `@public`（同檔 10–24 行）。13.1.0 已在 `dependencies`，不新增相依。
 *  - 編輯器網址的查詢參數叫 `editPanel`、值是 panel id：`@grafana/plugin-e2e` 3.13.0 的
 *    `PanelEditPage.goto()` 以 `options.queryParams.append('editPanel', this.args.id)`
 *    組出編輯頁網址（`dist/models/pages/PanelEditPage.js:44`），而 `DashboardPage` 反過來用
 *    `new URLSearchParams(window.location.search).get('editPanel')` 取回新 panel 的 id
 *    （`dist/models/pages/DashboardPage.js:200–202`）。這是 Grafana 官方的 e2e 套件在
 *    對真實 Grafana 做的事，不是我們的推論。
 *
 * **訂閱而不是 render 期間讀一次**：切進／切出編輯器時 Grafana 不保證重掛 panel（我們沒有
 * 這件事的依據，而 AC-1 要求有依據才寫），所以這裡訂閱 `getLocationObservable()` ——
 * 重掛與否都不影響正確性，省掉一個沒有證據的假設。
 */
import { useEffect, useState } from 'react';
import { locationService } from '@grafana/runtime';

/** 編輯器網址上那個查詢參數的名字（`/d/<uid>?editPanel=<id>`）。 */
export const EDIT_PANEL_PARAM = 'editPanel';

/**
 * 現在網址上的 `editPanel`；沒有這個鍵時是 `null`。
 *
 * 整支包 try/catch 並退回 `null`：`locationService` 是 Grafana 在啟動時裝上去的
 * 全域服務，而本外掛的退化方向是「少顯示一行」而不是「整個 panel 白掉」——
 * 宿主沒裝、或哪一版換了介面，這裡回 `null` 等於當作觀看模式。
 */
export function readEditPanelParam(): string | null {
  try {
    return locationService.getSearch().get(EDIT_PANEL_PARAM) ?? null;
  } catch {
    return null;
  }
}

/**
 * `readEditPanelParam()` 的 React 版：值變了就重繪。
 *
 * `getLocationObservable()` 底下是 `BehaviorSubject`，訂閱當下就會發一次現值
 * （同一個值 `setState` 不會多繪一輪），所以初值與訂閱不會打架。
 */
export function useEditPanelParam(): string | null {
  const [param, setParam] = useState<string | null>(readEditPanelParam);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    try {
      sub = locationService.getLocationObservable().subscribe(() => setParam(readEditPanelParam()));
    } catch {
      // 宿主沒有這個服務（或沒有這個方法）：維持掛載當下讀到的值，不重繪。
      return;
    }
    return () => sub?.unsubscribe();
  }, []);

  return param;
}
