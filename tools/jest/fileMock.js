/**
 * jest 的圖片 stub。放 `tools/` 而不是 `src/` —— `.config/jest.config.js` 的
 * `testMatch` 涵蓋 `src/**`，放進去會被當成一支沒有測試的 suite 而讓 jest 紅。
 *
 * 只回一個字串就夠：測試不會去解碼圖，只會確認 `background-image` 的 URL 被填進去了。
 */
module.exports = 'sprite-sheet-stub.png';
