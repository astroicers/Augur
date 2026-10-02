// SP-8.1 / SP-8.3：內建 sheet 的 URL 只能經 import 取得（production 檔名是 webpack 的 [hash][ext]，不得寫死）。
// ⚠️ 測試不得 import 本檔（SP-8.1）；檔名與 tools/check-sprite-sheets.mjs 的 SHEET_FILES 同一組常數。
// ⚠️ 不要改寫成 `export { default as X } from '*.png'`：2026-10-02 實測 webpack build 對那種寫法報
//    "export … was not found in './spriteAssets' (module has no exports)"，執行期 URL 是 undefined；
//    jest 的 CJS 轉譯卻保留它 —— 測試照樣綠。根因未查明（單獨用相同選項跑 swc，re-export 還在）。
import directionsUrl from '../img/sprite/directions.png';
import reactionsUrl from '../img/sprite/reactions.png';

export const DEFAULT_DIRECTIONS_URL: string = directionsUrl;
export const DEFAULT_REACTIONS_URL: string = reactionsUrl;
