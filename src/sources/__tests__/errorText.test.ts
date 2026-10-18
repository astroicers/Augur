/**
 * `errorText` 的單元測試（#82）。
 *
 * 面板把它的輸出當成播報紀錄降級的那一行原因（ADR-006 決策 7）顯示出來，
 * 所以兩件事要成立：`Error` 走 message、`getBackendSrv()` 拒絕值的
 * `{ status, statusText, data.message }` 三欄要拼得出人看得懂的字串，
 * 而什麼都認不出來時不能回空字串（畫面上會變成「降級了但沒說為什麼」）。
 */
import { errorText } from '../errorText';

describe('#82：errorText', () => {
  test('Error 取 message', () => {
    expect(errorText(new Error('rules 端點 403'))).toBe('rules 端點 403');
  });

  test('backendSrv 的拒絕值把 status／statusText／data.message 串起來', () => {
    expect(errorText({ status: 403, statusText: 'Forbidden', data: { message: '沒有權限' } })).toBe(
      '403 Forbidden 沒有權限'
    );
  });

  test('只有部分欄位時只串有值的那幾欄', () => {
    expect(errorText({ status: 500 })).toBe('500');
    expect(errorText({ statusText: 'Bad Gateway' })).toBe('Bad Gateway');
    expect(errorText({ status: 404, data: { message: '找不到' } })).toBe('404 找不到');
  });

  test('空字串的欄位不佔位（不會留下多餘的空白）', () => {
    expect(errorText({ status: 502, statusText: '', data: { message: '上游壞了' } })).toBe('502 上游壞了');
  });

  test('認不出來的東西回「未知錯誤」而不是空字串', () => {
    expect(errorText(undefined)).toBe('未知錯誤');
    expect(errorText(null)).toBe('未知錯誤');
    expect(errorText({})).toBe('未知錯誤');
    expect(errorText({ data: {} })).toBe('未知錯誤');
  });
});
