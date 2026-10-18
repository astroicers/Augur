/**
 * 每個瀏覽器自己的靜音開關（存在本機）。值班牆要出聲、座位上的人可能想安靜 —— 這不是 dashboard 的設定，
 * 是「我這台」的偏好，所以不放 panel 選項。同一個瀏覽器裡所有吉祥物 panel 共用。
 * 本機儲存可能被封鎖（無痕、清除網站資料），讀寫都包 try/catch，失敗就當作沒靜音、只在這次分頁內記得。
 *
 * #82 從 `MascotPanel.tsx` 搬出來：**不 import React**，只碰 `window`
 * （`localStorage` 與事件），所以同頁／跨分頁的同步條件各自驗得到。
 *
 * ⚠️ 鍵名與事件名是 ADR-007 的相容面：改了的話同一個瀏覽器裡升級前存下的靜音
 * 會讀不回來、而舊版與新版的 panel 在同一頁上不會互相同步。不得更名。
 */

/** 本機儲存的鍵名（ADR-007 相容面，不得更名）。`'1'` ＝ 靜音，其他值（含缺席）＝ 語音開。 */
export const MUTE_STORAGE_KEY = 'augur-mascot-panel.muted';
/**
 * 同一頁其他吉祥物 panel 的靜音同步事件（同分頁）；跨分頁靠瀏覽器的 storage 事件（複審 F4）。
 * ADR-007 相容面，不得更名。
 */
export const MUTE_EVENT = 'augur-mascot-panel:muted';

/** 本機存的靜音狀態。讀不到、或 `localStorage` 被封鎖（拋例外）一律當作沒靜音。 */
export function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 把靜音狀態寫進本機。寫不進去（無痕模式、配額滿）**不往外拋** ——
 * 靜音是「按下去就要立刻生效」的開關，持久化失敗只該讓它這次分頁內有效，
 * 不該把整個 handler 連帶炸掉（ADR-007：這一段最不該壞）。
 */
export function writeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* 存不了就只在這次分頁內有效 */
  }
}

/**
 * 切換靜音後要做的兩件外部動作：寫本機、通知同一頁的其他吉祥物 panel。
 * 寫入失敗照樣發事件 —— 同頁同步不依賴本機儲存成功。
 */
export function publishMuted(muted: boolean): void {
  writeMuted(muted);
  window.dispatchEvent(new CustomEvent<boolean>(MUTE_EVENT, { detail: muted }));
}

/**
 * 其他分頁的 storage 事件 → 新的靜音狀態；**不是**我們這個鍵就回 `null`。
 * 過濾條件留在這裡而不是呼叫端：storage 事件是全域的，同一頁其他東西
 * （Grafana 自己、別的 plugin）寫本機都會進來，比錯鍵就會被別人的設定靜音。
 */
export function mutedFromStorageEvent(e: StorageEvent): boolean | null {
  return e.key === MUTE_STORAGE_KEY ? e.newValue === '1' : null;
}

/**
 * 訂閱靜音變動：同一頁其他 panel 按了開關（`MUTE_EVENT`），或另一個分頁改了本機儲存
 * （`storage` 事件）。回傳解除訂閱的函式。
 *
 * 不讀初始值 —— 掛載時的初始值由 `readMuted()` 自己取（React 的 `useState` 初始值）。
 */
export function watchMuted(onChange: (muted: boolean) => void): () => void {
  const onMute = (e: Event) => onChange(Boolean((e as CustomEvent<boolean>).detail));
  const onStorage = (e: StorageEvent) => {
    const next = mutedFromStorageEvent(e);
    if (next !== null) {
      onChange(next);
    }
  };
  window.addEventListener(MUTE_EVENT, onMute);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(MUTE_EVENT, onMute);
    window.removeEventListener('storage', onStorage);
  };
}
