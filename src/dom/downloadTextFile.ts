/**
 * 把一段文字當檔案下載下來（匯出 CSV 的唯一一處 DOM 動作，#80；#101 從 `MascotPanel.tsx` 搬出來）。
 *
 * **刻意與 `feed/feedCsv.ts` 分開**（#80 AC-3）：「CSV 長什麼樣」是純函式的事、有自己的單元測試；
 * 這裡只有 Blob + `a[download]`。零後端（ADR-004）—— 檔案在瀏覽器裡生出來，沒有任何網路請求，
 * `createObjectURL` 的 `blob:` URL 也不會離開這個分頁。
 *
 * ⚠️ 與同目錄的 `dashboardPanels.ts` **不同族**：那一支是 unsupported 的跨 panel DOM 探測，
 * 本檔只碰自己造出來的元素，沒有任何對 Grafana DOM 形狀的假設。放一起只因為都是 DOM 動作。
 *
 * ## #101：為什麼多了一個 window 捕獲階段的 listener
 *
 * v0.4.0 發版前在 Grafana 12.4.12 實測：下載得到的檔名是 `<uuid>.csv`，不是 `a.download` 的值。
 * 同一段程式碼貼到空白頁上得到的是正確檔名。uuid 正是 `blob:` URL 的路徑段 —— 也就是說瀏覽器
 * 是在「`download` 屬性沒被採用」的情況下開了那個 blob，典型成因是頁面上有人把這個 `<a>` 的
 * 點擊接走（`preventDefault()` 後自己去導航 `href`）。Grafana 的頁面確實有這麼一個全域的
 * 連結攔截器（出處與未定之處見 `.asp/pr/101.md`）。
 *
 * 所以點擊派送期間在 **window 的捕獲階段**掛一個 listener，把這個點擊整個攔在這裡：
 *
 *  - 捕獲階段的順序是 window → document → … → `<a>`，**window 比 document 早**，
 *    所以不管頁面上那個攔截器掛在 document 的捕獲還是冒泡階段，它都收不到這個事件。
 *    （只靠 `<a>` 自己 `stopPropagation` 只擋得掉冒泡那一半。）
 *  - `stopImmediatePropagation()` **不會**取消預設動作：取消預設動作的是 canceled flag
 *    （`preventDefault()`），而預設動作（跟著連結走 ＝ 這裡的下載）在派送迴圈結束**之後**
 *    才依那個 flag 執行。出處：DOM 標準的 event dispatch 演算法，容器內可讀的實作是
 *    `node_modules/jsdom/lib/jsdom/living/events/EventTarget-impl.js:250–255`
 *    （`if (activationTarget !== null) { if (!eventImpl._canceledFlag) activationTarget._activationBehavior(…) }`）。
 *  - listener 只在 `a.click()` 這一次同步派送期間存在，而且**只吃 target 是這個 `<a>` 的事件** ——
 *    比我們早註冊的 window 捕獲 listener 若在這段時間內自己派送別的點擊，不該被我們吃掉。
 *
 * **已知的殘餘風險**：若有攔截器掛在 **window 的捕獲階段、而且比本函式早註冊**，它仍會先收到
 * 事件；`preventDefault()` 已經叫出去的話這裡救不回來。那種情況要換投遞方式（把 `<a>` 放進
 * 自己的 iframe document，讓頁面層的 listener 根本不在事件路徑上），本函式不預先做 ——
 * 詳見 `.asp/pr/101.md`〈哪一層要靠實測〉。
 */
export function downloadTextFile(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Firefox 要求這個 a 在 document 裡才會觸發下載；`display:none` ＋ 立刻移走，畫面上看不到它。
  a.style.display = 'none';
  document.body.appendChild(a);
  const shield = (e: Event) => {
    if (e.target === a) {
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('click', shield, true);
  try {
    a.click();
  } finally {
    // listener 與元素都是一次性的。`finally` 不為了某個已知的拋出路徑（listener 丟的錯由派送
    // 迴圈自己回報、不會往外傳），而是因為漏掉解除的症狀很安靜：上面那個 target 守門讓留下來的
    // listener 不會去吃別人的點擊，所以**畫面上什麼都看不出來**，只是每匯出一次就在 window 上
    // 多掛一個（連它閉包裡那個已經移走的 `<a>` 一起留著）。值班牆開一整天的匯出鈕按得不少。
    window.removeEventListener('click', shield, true);
    a.remove();
  }
  // 立刻 revoke 在部分瀏覽器會把還沒開始的下載取消掉，所以排到下一個 task 再回收 ——
  // 不回收的話這個 blob 會活到分頁關掉為止（匯出鈕是可以連按的）。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
