/**
 * Grafana rules 回應的**走訪**單一出處：groups → rules → 「這條規則綁在本 panel 嗎」。
 *
 * 這段走訪原本在 `panelAlerts.ts` 的 `parseRulesResponse`、`history.ts` 的
 * `parseRuleTemplates` 與 `parseRulerConditions` 各寫一份。三份都只是「攤平巢狀結構、
 * 再比對一次綁定註解」，取出來的欄位才是各自的差別 —— 所以走訪抽到這裡，
 * 三個 parser 只留下「從一條規則取什麼」。
 *
 * ⚠️ 為什麼非合不可：Grafana 改欄位名這件事**已經發生過**（12.4.0 的 `dashboardUID` 改名）。
 * 分散三份時，改對兩份、漏掉第三份的症狀不是紅燈，是那條路徑安靜地一條規則都比對不中 ——
 * panel 降級成泛用句、歷史少了摘要與數值，都還是「有東西顯示」。
 *
 * 兩個端點的外層形狀不同（故兩支進入點），但內層一模一樣：
 *  - Prometheus rules（`/api/prometheus/grafana/api/v1/rules`）：`{ data: { groups: [...] } }`
 *  - ruler（`/api/ruler/grafana/api/v1/rules`）：`{ <資料夾>: [...] }`（12.4.12 實測）
 *
 * 回傳 generator 而不是陣列：三個 parser 的輸出型別各不相同（陣列、兩種 Map），
 * 中間不必先長出一份用完即丟的清單。
 */

/**
 * 「這條規則綁在哪個 panel」的註解鍵名 —— Grafana 在規則綁定 panel 時自動寫入。
 * **全專案只有這裡比對它們**；改名時只有這兩個常數要動。
 */
export const DASHBOARD_UID_ANNOTATION = '__dashboardUid__';
export const PANEL_ID_ANNOTATION = '__panelId__';

/** 走訪吐出的一條規則：原始物件，加上已取好的（必定存在的）annotations。 */
export interface PanelRule<T> {
  rule: T;
  /** `rule.annotations`，沒有就是空物件 —— 呼叫端不必再 `?? {}` 一次。 */
  annotations: Record<string, string>;
}

/**
 * 端點支援 `dashboard_uid` / `panel_id` 過濾，但三個 parser 都再比對一次：
 * 過濾參數若被忽略，我們會把整個 dashboard 的告警都念出來（或把別的 panel 的
 * 規則寫進歷史的摘要表）。`panelId` 在註解裡是字串。
 */
export function boundToPanel(annotations: Record<string, string>, dashboardUid: string, panelId: number): boolean {
  return annotations[DASHBOARD_UID_ANNOTATION] === dashboardUid && annotations[PANEL_ID_ANNOTATION] === String(panelId);
}

/** 走訪一組 group 清單（兩種形狀共用的內層）。形狀不對的 group / rules 一律跳過，不丟例外。 */
function* panelRulesInGroupLists<T>(
  groupLists: readonly unknown[],
  dashboardUid: string,
  panelId: number
): Generator<PanelRule<T>> {
  for (const groups of groupLists) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const g of groups) {
      const rules = (g as { rules?: unknown[] } | null)?.rules;
      if (!Array.isArray(rules)) {
        continue;
      }
      for (const r of rules) {
        const annotations = (r as { annotations?: Record<string, string> } | null)?.annotations ?? {};
        if (!boundToPanel(annotations, dashboardUid, panelId)) {
          continue;
        }
        yield { rule: r as T, annotations };
      }
    }
  }
}

/**
 * 走訪 Prometheus rules 端點回應（`{ data: { groups } }`）裡綁在本 panel 的規則。
 *
 * `T` 由呼叫端指定自己要讀的欄位 —— 回應沒有型別保證，形狀宣告留在用得到那些欄位的地方。
 */
export function panelRulesOf<T>(raw: unknown, dashboardUid: string, panelId: number): Generator<PanelRule<T>> {
  const groups = (raw as { data?: { groups?: unknown[] } } | null | undefined)?.data?.groups;
  return panelRulesInGroupLists<T>([groups], dashboardUid, panelId);
}

/**
 * 走訪 ruler API 回應（`{ <資料夾>: [group] }`）裡綁在本 panel 的規則。
 * 外層是以資料夾名為鍵的物件，所以先攤平成多份 group 清單。
 */
export function panelRulerRulesOf<T>(raw: unknown, dashboardUid: string, panelId: number): Generator<PanelRule<T>> {
  if (!raw || typeof raw !== 'object') {
    return panelRulesInGroupLists<T>([], dashboardUid, panelId);
  }
  return panelRulesInGroupLists<T>(Object.values(raw as Record<string, unknown>), dashboardUid, panelId);
}
