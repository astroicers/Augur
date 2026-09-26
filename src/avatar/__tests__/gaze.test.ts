import { CENTER_CELL, DEFAULT_GAZE, cellToBackgroundPosition, gazeCell } from '../gaze';

const opts = DEFAULT_GAZE;

test('dead zone 內一律回中央格', () => {
  expect(gazeCell(0, 0, CENTER_CELL, opts)).toBe(CENTER_CELL);
  expect(gazeCell(20, 10, 0, opts)).toBe(CENTER_CELL); // 距離 22.4 < 28
});

test('八個方向各自對到正確的格（螢幕 y 向下為正）', () => {
  const far = 200;
  // 從中央格出發不套遲滯，所以每次都用 CENTER_CELL 當 current。
  expect(gazeCell(far, 0, CENTER_CELL, opts)).toBe(5); // 右
  expect(gazeCell(-far, 0, CENTER_CELL, opts)).toBe(3); // 左
  expect(gazeCell(0, -far, CENTER_CELL, opts)).toBe(1); // 上（螢幕 y 為負）
  expect(gazeCell(0, far, CENTER_CELL, opts)).toBe(7); // 下
  expect(gazeCell(far, -far, CENTER_CELL, opts)).toBe(2); // 右上
  expect(gazeCell(-far, -far, CENTER_CELL, opts)).toBe(0); // 左上
  expect(gazeCell(-far, far, CENTER_CELL, opts)).toBe(6); // 左下
  expect(gazeCell(far, far, CENTER_CELL, opts)).toBe(8); // 右下
});

test('遲滯：剛跨過交界不換格，深入新扇區才換', () => {
  // 交界在 22.5°。從「右」(5) 出發。
  const r = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return gazeCell(Math.cos(rad) * 200, -Math.sin(rad) * 200, 5, opts);
  };
  expect(r(0)).toBe(5); // 扇區正中
  expect(r(20)).toBe(5); // 還沒到交界
  expect(r(30)).toBe(5); // 跨過交界但在遲滯帶內 —— 維持原狀
  expect(r(44)).toBe(2); // 深入右上扇區 → 換
});

test('遲滯不會把視線鎖死：從中央格出發一定會跟上', () => {
  expect(gazeCell(200, -8, CENTER_CELL, opts)).toBe(5);
});

test('cellToBackgroundPosition 對到 3×3 的九宮格', () => {
  // ⚠️ **九格全測，不要只挑 0 / 4 / 8。**
  // 那三格正好是對角線 —— 轉置下不變的那三格。把 col 與 row 兩項對調
  // （一個 token 的錯誤），九格裡有六格會變，而 0/4/8 一格都不在其中：
  // jest 全綠、閘門放行，而吉祥物每一個非中央方向都顯示錯的格。
  //
  // 這支是 **panel 實際 render 用的那一份**。tools/blind-test/scoring.mjs 有一份
  // 同義的複本（刻意不共用 —— 那個檔要能在瀏覽器裡直接以 ES module 載入），
  // 兩邊都必須逐格釘住，否則修了一邊等於沒修。
  const WANT = ['0% 0%', '50% 0%', '100% 0%', '0% 50%', '50% 50%', '100% 50%', '0% 100%', '50% 100%', '100% 100%'];
  for (let c = 0; c < 9; c++) {
    expect(cellToBackgroundPosition(c)).toBe(WANT[c]);
  }
  // 越界不該算出負值或超過 100%
  expect(cellToBackgroundPosition(-3)).toBe('0% 0%');
  expect(cellToBackgroundPosition(99)).toBe('100% 100%');
});
