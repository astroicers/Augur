/**
 * #100 AC-1：編輯模式的新訊號 —— 網址上的 `editPanel`。
 *
 * **沒有 `jest.mock('@grafana/runtime')`**：本專案到 #100 之前一個 runtime 替身都沒有，
 * 這一支也沒有新增。`@grafana/runtime` 13.1.0 在 `NODE_ENV === 'test'` 下把
 * `locationService` 接到 memory history 上
 * （`dist/esm/services/LocationService.mjs`：`H.createMemoryHistory({ initialEntries: ['/'] })`），
 * 所以測試直接用公開介面的 `push()`／`replace()` 擺出編輯器網址就行 ——
 * 驗到的是**真的** `locationService.getSearch()`，不是我們自己寫的替身。
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import { locationService } from '@grafana/runtime';

import { EDIT_PANEL_PARAM, readEditPanelParam, useEditPanelParam } from '../useEditPanelParam';

/** 把 hook 的值掛到 DOM 上（缺席時是空字串，分得出 `null` 與 `''`）。 */
function Probe() {
  const param = useEditPanelParam();
  return <span data-testid="param">{param === null ? '(null)' : param}</span>;
}

/** 走公開介面換網址，並把訂閱觸發的 setState 包進 act。 */
function goTo(path: string) {
  act(() => {
    locationService.replace(path);
  });
}

afterEach(() => {
  // memory history 是整個測試檔共用的模組層狀態：收尾回到「觀看模式」的網址。
  locationService.replace('/');
});

test('AC-1：參數名就是 Grafana 編輯器網址上那個鍵', () => {
  // 出處不是推論：`@grafana/plugin-e2e` 3.13.0 的 PanelEditPage.goto() 以
  // `queryParams.append('editPanel', this.args.id)` 組編輯頁網址（dist/models/pages/PanelEditPage.js:44）。
  expect(EDIT_PANEL_PARAM).toBe('editPanel');
});

test('AC-1：編輯器網址（/d/<uid>?editPanel=<id>）下讀得到那個 id', () => {
  locationService.replace('/d/rel030?editPanel=3');
  expect(readEditPanelParam()).toBe('3');
});

test('AC-2：觀看模式的網址讀到 null —— 沒有這個鍵就是沒有', () => {
  locationService.replace('/d/rel030');
  expect(readEditPanelParam()).toBeNull();
  // 有別的查詢參數、但沒有 editPanel 的網址同理（例如時間範圍）。
  locationService.replace('/d/rel030?from=now-6h&to=now');
  expect(readEditPanelParam()).toBeNull();
});

test('AC-1：hook 在掛載當下就讀到值（不必等第一次 location 變動）', () => {
  locationService.replace('/d/rel030?editPanel=3');
  const view = render(<Probe />);
  expect(view.getByTestId('param').textContent).toBe('3');
});

/**
 * 票上留言 (c)：若只在 render 期間 imperative 讀一次而不訂閱，切進／切出編輯器時
 * 只要 Grafana 沒有重掛 panel，值就要等下一次重繪才變。這一支釘的是「不靠重掛」——
 * 同一個掛載的 Probe 從頭到尾沒有被卸載過，而值跟著網址走。
 */
test('AC-1：網址變了就跟著變 —— 同一次掛載內切進／切出編輯器都會重繪', () => {
  const view = render(<Probe />);
  expect(view.getByTestId('param').textContent).toBe('(null)');

  goTo('/d/rel030?editPanel=3');
  expect(view.getByTestId('param').textContent).toBe('3');

  goTo('/d/rel030?editPanel=9');
  expect(view.getByTestId('param').textContent).toBe('9');

  // 切回觀看模式（按返回／關閉編輯器）。
  goTo('/d/rel030');
  expect(view.getByTestId('param').textContent).toBe('(null)');
});

test('卸載後的網址變動不再更新（訂閱有解除，不留下 setState-after-unmount）', () => {
  const view = render(<Probe />);
  const node = view.getByTestId('param');
  view.unmount();

  // 卸載後再換網址：已經離開畫面的那個節點當然不會變，而且不得有未解除的訂閱
  // 在背景裡繼續 setState（React 18 對那件事是靜默的，所以這裡直接看副作用）。
  goTo('/d/rel030?editPanel=3');
  expect(node.textContent).toBe('(null)');
  expect(readEditPanelParam()).toBe('3');
});
