/**
 * `src/dom/dashboardPanels.ts` 的單元測試。
 *
 * 這一層是本專案唯一 unsupported 的部分（模組檔頭），它的設計目標是「壞掉的時候壞得乾淨」——
 * 所以這支測試的重點不在「偵測得到」，在**偵測不到時回的是什麼**：
 * crossPanel 必須是 false、reason 必須寫得出原因、`panels()` / `panelAt()` 必須回空值而不是丟錯。
 *
 * 另一半是重試（附錄-7）：降級不等於永久判決。這裡驗的是重試**有界**、升回**只升一次**、
 * 以及 `stop()` 之後不留計時器 —— 後者是 MascotPanel 卸載時不漏計時器的前提。
 */

import {
  DOM_PROBE_RECHECK_MIN_INTERVAL_MS,
  DOM_PROBE_RETRY_INTERVAL_MS,
  DOM_PROBE_RETRY_LIMIT,
  probeDashboardDom,
  watchDashboardDom,
} from '../dashboardPanels';

/** 造一個 Grafana 的 panel 容器（屬性名與實測值一致，見模組檔頭）。 */
function addPanel(key: string, pluginId?: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-viz-panel-key', key);
  if (pluginId) {
    el.setAttribute('data-plugin-id', pluginId);
  }
  // 自己的內容物：probe 要靠 `contains(self)` 確認我們真的在 dashboard 樹裡。
  const inner = document.createElement('div');
  el.appendChild(inner);
  document.body.appendChild(el);
  return el;
}

function inner(panel: HTMLElement): Element {
  return panel.firstElementChild!;
}

/**
 * jsdom **完全沒有** `document.elementFromPoint`（連 not-implemented 的 stub 都沒有，
 * 所以 `jest.spyOn` 會說「property does not exist」）。要驗 `panelAt` 的反查接線就得自己裝一個。
 * 順帶一提：這也是真 jsdom 下 `panelAt` 固定回 null 的原因 —— 呼叫 undefined 丟 TypeError，
 * 被模組裡的 try/catch 接住。那個 catch 不是防禦性裝飾，它每天都在跑。
 */
function stubElementFromPoint(fn: (x: number, y: number) => Element | null): jest.Mock {
  const mock = jest.fn(fn);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, writable: true, value: mock });
  return mock;
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (document as unknown as Record<string, unknown>).elementFromPoint;
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 偵測成功
// ---------------------------------------------------------------------------

test('偵測成功：看得到兩個以上的 panel 且自己在清單裡 → crossPanel，reason 為空', () => {
  const mine = addPanel('panel-7', 'augur-mascot-panel');
  addPanel('panel-9', 'timeseries');

  const dom = probeDashboardDom(inner(mine));

  expect(dom.crossPanel).toBe(true);
  expect(dom.reason).toBe('');
  expect(dom.panels().map((p) => [p.key, p.panelId, p.pluginId])).toEqual([
    ['panel-7', 7, 'augur-mascot-panel'],
    ['panel-9', 9, 'timeseries'],
  ]);
});

test('偵測成功：key 解析不出數字時 panelId 是 null（不猜）', () => {
  const mine = addPanel('panel-7');
  addPanel('viz-weird-key');

  const dom = probeDashboardDom(inner(mine));

  expect(dom.crossPanel).toBe(true);
  expect(dom.panels().map((p) => p.panelId)).toEqual([7, null]);
});

test('panelAt：由座標反查最近的 panel 容器（elementFromPoint 尊重疊放順序）', () => {
  const mine = addPanel('panel-7');
  const other = addPanel('panel-9', 'timeseries');
  // jsdom 沒有排版，elementFromPoint 要自己給 —— 這裡驗的是「反查 + closest」的接線。
  stubElementFromPoint(() => inner(other));

  const hit = probeDashboardDom(inner(mine)).panelAt(900, 900);

  expect(hit?.key).toBe('panel-9');
  expect(hit?.pluginId).toBe('timeseries');
});

test('panelAt：座標下沒有 panel 容器（例：彈窗蓋住 dashboard 以外的地方）→ null', () => {
  const mine = addPanel('panel-7');
  addPanel('panel-9');
  const loose = document.createElement('div');
  document.body.appendChild(loose);
  stubElementFromPoint(() => loose);

  expect(probeDashboardDom(inner(mine)).panelAt(1, 1)).toBeNull();
});

// ---------------------------------------------------------------------------
// 偵測失敗（四條降級路徑）
// ---------------------------------------------------------------------------

test('偵測失敗：找不到任何 [data-viz-panel-key] → 降級，reason 寫明是 sandbox 或 DOM 變了', () => {
  const dom = probeDashboardDom(null);

  expect(dom.crossPanel).toBe(false);
  expect(dom.reason).toContain('找不到任何');
  expect(dom.panels()).toEqual([]);
});

test('偵測失敗：只看得到一個 panel → 降級（分不出「只有一個」與「被關起來」，而兩者行為相同）', () => {
  const mine = addPanel('panel-7');

  const dom = probeDashboardDom(inner(mine));

  expect(dom.crossPanel).toBe(false);
  expect(dom.reason).toContain('只看得到一個 panel');
  expect(dom.panels()).toEqual([]);
});

test('偵測失敗：看得到別人卻找不到自己 → 不信這棵樹（panels 也清空）', () => {
  addPanel('panel-7');
  addPanel('panel-9');
  const orphan = document.createElement('div'); // 不在任何 panel 容器裡

  const dom = probeDashboardDom(orphan);

  expect(dom.crossPanel).toBe(false);
  expect(dom.reason).toContain('找不到自己');
  expect(dom.panels()).toEqual([]);
});

test('偵測失敗：querySelectorAll 丟例外（sandbox）→ 降級且把例外寫進 reason，不往外丟', () => {
  jest.spyOn(document, 'querySelectorAll').mockImplementation(() => {
    throw new Error('blocked by sandbox');
  });

  const dom = probeDashboardDom(null);

  expect(dom.crossPanel).toBe(false);
  expect(dom.reason).toContain('blocked by sandbox');
});

test('降級時 panelAt 一律 null —— 連 elementFromPoint 都不呼叫', () => {
  const mine = addPanel('panel-7');
  const spy = stubElementFromPoint(() => null);

  expect(probeDashboardDom(inner(mine)).panelAt(10, 10)).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});

test('panelAt：elementFromPoint 丟例外時回 null，不往外丟', () => {
  const mine = addPanel('panel-7');
  addPanel('panel-9');
  stubElementFromPoint(() => {
    throw new Error('nope');
  });

  expect(probeDashboardDom(inner(mine)).panelAt(10, 10)).toBeNull();
});

// ---------------------------------------------------------------------------
// 重試（附錄-7）
// ---------------------------------------------------------------------------

describe('watchDashboardDom', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('一開始就看得到別人：不排任何計時器，也不會呼叫 onUpgrade', () => {
    const mine = addPanel('panel-7');
    addPanel('panel-9');
    const onUpgrade = jest.fn();

    const w = watchDashboardDom(inner(mine), onUpgrade);

    expect(w.current().crossPanel).toBe(true);
    expect(w.retriesLeft()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(onUpgrade).not.toHaveBeenCalled();
    w.stop();
  });

  test('降級後重試：之後 DOM 長出第二個 panel → 下一次重試就升回，onUpgrade 只呼叫一次', () => {
    const mine = addPanel('panel-7');
    const onUpgrade = jest.fn();

    const w = watchDashboardDom(inner(mine), onUpgrade);
    expect(w.current().crossPanel).toBe(false);
    expect(w.retriesLeft()).toBe(DOM_PROBE_RETRY_LIMIT);

    // 第一次重試：DOM 還沒變 → 仍降級，但 current() 不換（連 reason 都不動）。
    const before = w.current();
    jest.advanceTimersByTime(DOM_PROBE_RETRY_INTERVAL_MS);
    expect(w.current()).toBe(before);
    expect(onUpgrade).not.toHaveBeenCalled();

    addPanel('panel-9');
    jest.advanceTimersByTime(DOM_PROBE_RETRY_INTERVAL_MS);

    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(w.current().crossPanel).toBe(true);
    expect(onUpgrade.mock.calls[0]![0]).toBe(w.current());
    // 升回之後不再重試 —— 計時器也收乾淨了。
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10 * DOM_PROBE_RETRY_INTERVAL_MS);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  test('重試有界：上限次數用完就停，之後 DOM 再變也不靠計時器升回', () => {
    const mine = addPanel('panel-7');
    const onUpgrade = jest.fn();
    const w = watchDashboardDom(inner(mine), onUpgrade, { limit: 2, intervalMs: 100 });

    jest.advanceTimersByTime(1000);
    expect(w.retriesLeft()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);

    addPanel('panel-9');
    jest.advanceTimersByTime(10_000);
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(w.current().crossPanel).toBe(false);
  });

  test('recheck：計時器用完之後，事件驅動的重探仍能升回（節流窗內的那次不探）', () => {
    const mine = addPanel('panel-7');
    const onUpgrade = jest.fn();
    const w = watchDashboardDom(inner(mine), onUpgrade, { limit: 0 });

    addPanel('panel-9');
    // 節流窗還沒過 → 不探，所以還是降級。
    expect(w.recheck()).toBe(false);
    expect(w.current().crossPanel).toBe(false);

    jest.advanceTimersByTime(DOM_PROBE_RECHECK_MIN_INTERVAL_MS);
    expect(w.recheck()).toBe(true);
    expect(w.current().crossPanel).toBe(true);
    expect(onUpgrade).toHaveBeenCalledTimes(1);

    // 升回之後 recheck 是空操作（只升不降）。
    jest.advanceTimersByTime(10 * DOM_PROBE_RECHECK_MIN_INTERVAL_MS);
    expect(w.recheck()).toBe(false);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  test('recheck：DOM 沒變時回 false 且不呼叫 onUpgrade（節流窗外也一樣）', () => {
    const mine = addPanel('panel-7');
    const onUpgrade = jest.fn();
    const w = watchDashboardDom(inner(mine), onUpgrade, { limit: 0 });

    jest.advanceTimersByTime(DOM_PROBE_RECHECK_MIN_INTERVAL_MS);
    expect(w.recheck()).toBe(false);
    expect(onUpgrade).not.toHaveBeenCalled();
    w.stop();
  });

  test('stop()：計時器清光，之後 DOM 變了也不再呼叫 onUpgrade（卸載不漏計時器的前提）', () => {
    const mine = addPanel('panel-7');
    const onUpgrade = jest.fn();
    const w = watchDashboardDom(inner(mine), onUpgrade);
    expect(jest.getTimerCount()).toBe(1);

    w.stop();
    expect(jest.getTimerCount()).toBe(0);

    addPanel('panel-9');
    jest.advanceTimersByTime(100 * DOM_PROBE_RETRY_INTERVAL_MS);
    expect(onUpgrade).not.toHaveBeenCalled();
  });
});
