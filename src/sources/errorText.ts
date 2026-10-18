/**
 * 丟出來的東西 → 給人看的一行原因（#82 從 `MascotPanel.tsx` 搬出來）。
 *
 * 住在 `src/sources/` 的理由：要認的那個非 `Error` 形狀是 `getBackendSrv()` 的拒絕值，
 * 而全專案只有這一層在打 Grafana 的 HTTP API（`rulesFetcher`／`historyFetcher`），
 * 所以「這個形狀長什麼樣」是來源層的知識。純函式：不碰 DOM、不讀時鐘、不 import React。
 */

/** 錯誤物件 → 給人看的一行原因。backendSrv 丟出來的是 `{ status, statusText, data: { message } }`。 */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  const r = e as { status?: number; statusText?: string; data?: { message?: string } } | undefined;
  const parts = [r?.status, r?.statusText, r?.data?.message].filter((x) => x !== undefined && x !== '');
  return parts.length ? parts.join(' ') : '未知錯誤';
}
