/**
 * `MascotPanel` 的 CSS（#82 從 `MascotPanel.tsx` 原樣搬過來，一個字元沒改）。
 *
 * 搬出來的理由只有閱讀性：元件那一支是「接線 + 呈現」，130 行的 emotion CSS 夾在
 * 常數與 hooks 中間，讀元件的人要先跳過它。**不是**為了共用——目前只有 `MascotPanel`
 * 一個呼叫端，形狀也刻意維持 `useStyles2(getStyles)`（不吃 theme 參數，見下）。
 *
 * ⚠️ 這裡的 class 由既有的 `MascotPanel.test.tsx` 間接驗（版面相關的斷言讀的是
 * `data-*` 屬性與 `getComputedStyle`），搬動時只准移動、不准順手整理。
 */
import { css } from '@emotion/css';

/**
 * 不吃 `theme` 參數 —— `useStyles2` 會傳進來，但本面板的顏色一律沿用容器的
 * `color`／`currentColor`（panel 在 dashboard 裡要跟著主題走，寫死色票會在
 * 淺色主題上糊掉）。簽名維持零參數，呼叫形狀 `useStyles2(getStyles)` 不變。
 */
export const getStyles = () => ({
  wrap: css`
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  `,
  chip: css`
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    letter-spacing: 0.02em;
  `,
  scopeChip: css`
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid currentColor;
    opacity: 0.75;
  `,
  body: css`
    display: flex;
    gap: 10px;
    flex: 1 1 auto;
    min-height: 0;
  `,
  /*
   * ⚠️ 這裡**不能**有 \`align-items: flex-start\`。
   * 它會讓 feed 這個 flex item 收縮成內容高度，於是 \`overflow-y: auto\` 永遠不觸發 ——
   * 在真 Grafana 上實測：602×398 的 panel 塞 20 行播報，feed 的 clientHeight 與
   * scrollHeight 都是 950px（不可捲動），而 panel 底只到 503px，**583px 的內容被切掉且沒有捲軸**。
   * stage 自己用 \`align-self: flex-start\` 固定在上緣，不需要父層代勞。
   */
  bodyStacked: css`
    flex-direction: column;
  `,
  /**
   * SP-1.8 的方形 stage。寬高由 `MascotPanel` 顯式設定（見下方 `stageSide`），
   * **契約不新增 `setSize()`** —— SP-8.17 明文要求避免再開一次 ADR-004 決策 5 的介面異動。
   * `aspect-ratio: 1` 是保險：顯式寬高已經是方的，但若日後有人只改一邊，這裡會把它拉回來。
   */
  stage: css`
    flex: 0 0 auto;
    aspect-ratio: 1;
    align-self: flex-start;
    /* SP-1.7：邊長要等於內容區，padding / border 一律為 0。 */
    padding: 0;
    border: 0;
    box-sizing: border-box;
  `,
  /** feed 欄：篩選框、提示與紀錄清單。min-width/min-height 歸零的理由同下方 feed。 */
  feedCol: css`
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,
  filter: css`
    font: inherit;
    font-size: 12px;
    padding: 3px 6px;
    border-radius: 3px;
    border: 1px solid rgba(127, 127, 127, 0.4);
    background: transparent;
    color: inherit;
  `,
  notice: css`
    font-size: 11px;
    opacity: 0.75;
  `,
  feed: css`
    flex: 1 1 auto;
    min-width: 0;
    /* flex item 的預設 min-height 是 auto（＝內容高度），不歸零的話 overflow 不會生效。 */
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  `,
  line: css`
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 3px 6px;
    border-radius: 3px;
    background: rgba(127, 127, 127, 0.1);
  `,
  when: css`
    font-family: ui-monospace, monospace;
    font-size: 10px;
    opacity: 0.6;
    flex-shrink: 0;
  `,
  /*
   * 「這句為什麼沒念」的標記（#81）。**自己一個 class，不動上面的 `line`** ——
   * 沒有 `suppressed` 的列要與先前逐字相同（AC-1），而 `line` 是每一列共用的。
   *
   * `flex-shrink: 0` ＋ `white-space: nowrap`：窄面板（:701 的切換點之下改成上下堆疊）
   * 時標記不折成兩行、也不被句子擠掉；句子本身是 flex item 裡的文字，照樣自己換行，
   * 所以擠的時候是句子多佔幾行而不是標記破版。檔頭 :78 那段 feed 的 overflow 踩坑
   * 與這裡無關（那是高度，這裡只動一列之內的水平配置）。
   */
  suppressedMark: css`
    font-size: 10px;
    font-weight: 600;
    padding: 0 5px;
    border-radius: 999px;
    border: 1px solid currentColor;
    opacity: 0.8;
    flex-shrink: 0;
    white-space: nowrap;
  `,
  empty: css`
    opacity: 0.55;
    font-size: 12px;
    font-style: italic;
  `,
  btn: css`
    font: inherit;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    /* 清單是空的時候匯出鈕是 disabled（#80 AC-4）—— 停用要看得出來，否則按不動像壞掉。 */
    &:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
  `,
});
