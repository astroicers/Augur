/**
 * 跨 panel 的 DOM 能力層 —— ADR-004 決策 6「漸進降級」的實作。
 *
 * 這是本專案**唯一** unsupported 的部分。Grafana 沒有任何官方 API 讓 panel plugin
 * 知道其他 panel 的存在，而「全局視線追蹤」與「區塊點擊偵測」兩個功能都需要它。
 * 所以這一層的設計目標不是「能用」，是**壞掉的時候壞得乾淨**。
 *
 * 只依賴三個有原始碼佐證且 2026-09-18 於 Grafana 13.2.2 實測存在的屬性：
 *   `data-viz-panel-key`（值為 `panel-<id>`）、`data-viz-panel-id`、`data-plugin-id`。
 * **禁用** `data-panelid`、`panel-container`（實測皆為 0 命中）、
 * `react-grid-item`（雖然實測存在，但它是 react-grid-layout 的 class，
 * Grafana 12 起的 AutoGridLayout 下未必有 —— 不值得賭）。
 *
 * 已知會讓它失效的兩件事，兩件都是**預期內**而非錯誤：
 *  1. **Plugin Frontend Sandbox**（Grafana ≥11.5）：明文阻止 plugin 碰自己區域以外的
 *     介面。預設關閉，但官方對「允許使用者寫自訂 JS」類 plugin「strongly recommend」開啟。
 *  2. Grafana 改 DOM。它自己的 e2e selector 每條都綁版本號，等於官方承認會變。
 */

export interface PanelRef {
  /** `data-viz-panel-key` 的原值，例如 `panel-3`。 */
  key: string;
  /** 從 key 解析出的數字 id；解析不出來是 null。 */
  panelId: number | null;
  pluginId: string | null;
  el: Element;
}

export interface DashboardDom {
  /**
   * 能不能看到自己以外的 panel。
   * false = 已降級（sandbox 開著、或 DOM 變了），呼叫端應把互動限縮在自己的容器內。
   */
  readonly crossPanel: boolean;
  /** 為什麼降級（給診斷用，不給使用者看）。 */
  readonly reason: string;
  panels(): PanelRef[];
  /** 座標落在哪個 panel 上。crossPanel 為 false 時只可能回自己或 null。 */
  panelAt(x: number, y: number): PanelRef | null;
}

const KEY_ATTR = 'data-viz-panel-key';
const ID_ATTR = 'data-viz-panel-id';
const PLUGIN_ATTR = 'data-plugin-id';

function toRef(el: Element): PanelRef {
  const key = el.getAttribute(KEY_ATTR) ?? el.getAttribute(ID_ATTR) ?? '';
  // 實測格式是 `panel-<id>`；解析不出來就給 null 而不是猜。
  const m = /(\d+)\s*$/.exec(key);
  return {
    key,
    panelId: m ? Number.parseInt(m[1]!, 10) : null,
    pluginId: el.getAttribute(PLUGIN_ATTR),
    el,
  };
}

/**
 * 能力偵測。`self` 是本 panel 內的任一元素（用來確認我們真的在 dashboard 樹裡）。
 *
 * 判定刻意保守：**看得到兩個以上的 panel** 才算 crossPanel 可用。
 * 只看得到一個時無法分辨「dashboard 上真的只有一個 panel」與「被 sandbox 關起來了」，
 * 而這兩種情況下正確行為相同（只管自己），所以不必分辨。
 */
export function probeDashboardDom(self: Element | null): DashboardDom {
  let found: Element[] = [];
  let reason = '';
  try {
    found = Array.from(document.querySelectorAll(`[${KEY_ATTR}]`));
  } catch (e) {
    // sandbox 可能讓 document 查詢直接丟例外。
    reason = 'querySelectorAll threw: ' + String(e);
  }

  if (!reason && found.length === 0) {
    reason = `找不到任何 [${KEY_ATTR}] —— sandbox 或 DOM 已變`;
  } else if (!reason && found.length < 2) {
    reason = '只看得到一個 panel —— 無法跨 panel（或 dashboard 本來就只有一個）';
  } else if (!reason && self && !found.some((el) => el.contains(self))) {
    // 看得到別人卻找不到自己 = 我們拿到的不是真的 dashboard 樹，別信它。
    reason = '在 panel 清單中找不到自己 —— DOM 結構與預期不符';
    found = [];
  }

  const crossPanel = reason === '';
  const refs = () => (crossPanel ? Array.from(document.querySelectorAll(`[${KEY_ATTR}]`)).map(toRef) : []);

  return {
    crossPanel,
    reason,
    panels: refs,
    panelAt(x: number, y: number): PanelRef | null {
      if (!crossPanel) {
        return null;
      }
      // 由座標反查，而不是掃全部 panel 算矩形 —— elementFromPoint 尊重疊放順序，
      // panel 被彈窗或 tooltip 蓋住時不會誤判成點到下面那個。
      let el: Element | null = null;
      try {
        el = document.elementFromPoint(x, y);
      } catch {
        return null;
      }
      const host = el?.closest(`[${KEY_ATTR}]`) ?? null;
      return host ? toRef(host) : null;
    },
  };
}

/**
 * 降級後的重試政策（附錄-7）。
 *
 * 為什麼要重試：`probeDashboardDom` 在 mount 當下照一張快照，而 dashboard 的 DOM 在
 * mount 之後還會長出東西 —— 其他 panel 還沒 render 完、使用者展開一個收起來的 row、
 * 或本 panel 被加進一個原本只有它自己的 dashboard。只探一次的話那張快照會變成永久判決：
 * 明明看得到別人了，chip 仍停在「限本 panel」。
 *
 * 兩條觸發來源刻意分開，因為它們補的洞不同：
 *  - **有界的計時器重試**（`LIMIT` 次 × `INTERVAL_MS`，共 6 秒）：補「使用者完全不動滑鼠」
 *    的情況。有界是因為超過這個窗還看不到別人，絕大多數是真的只有一個 panel 或 sandbox
 *    開著 —— 那不是暫時狀態，無限輪詢只是每隔幾秒燒一次 `querySelectorAll` 卻永遠得到同一個答案。
 *  - **事件驅動的 `recheck()`**（由呼叫端在 pointermove 裡呼叫，節流 `RECHECK_MIN_INTERVAL_MS`）：
 *    補「6 秒之後才出現其他 panel」的情況。這條不設次數上限 —— 它只在使用者真的在動游標時
 *    才跑，且每次就是一個 `querySelectorAll`，成本上界由節流窗而非次數決定。
 *
 * 只升不降：升回之後 watcher 就停了。偵測到別人之後又「看不到」只可能是 panel 被移除，
 * 而那種情況下 `panelAt` 自己會回 null，不需要把能力再降一級（降級會牽動 listener 的
 * target 重綁，為一個不會發生的狀態付複雜度）。
 *
 * ⚠️ **節流窗量的是 `performance.now()` 而不是 `Date.now()`。** 牆鐘會往回跳
 * （NTP 校正、使用者改系統時間、VM 從 snapshot 恢復），而 `recheck()` 的條件是
 * 「距離上次重探不足一個窗就不探」—— 牆鐘往回撥一小時，差值就變成 −3600000，
 * 永遠小於節流窗，於是 `recheck()` 一路回 false **直到牆鐘追回來**。
 * 這條路徑在計時器的有界重試窗過後是唯一的升回途徑，卡住就等於永久降級。
 * `performance.now()` 是單調的（同一個 time origin 起算，不受系統時鐘調整影響），差值不可能為負。
 */
export const DOM_PROBE_RETRY_LIMIT = 4;
export const DOM_PROBE_RETRY_INTERVAL_MS = 1500;
export const DOM_PROBE_RECHECK_MIN_INTERVAL_MS = 1000;

export interface DashboardDomWatcher {
  /** 目前的能力。升回之後回的是新的那一份。 */
  current(): DashboardDom;
  /** 外部事件（例：pointermove）觸發的即時重探。節流窗內直接回 false。回傳「這次有沒有升回」。 */
  recheck(): boolean;
  /** 還剩幾次計時器重試（診斷與測試用）。 */
  retriesLeft(): number;
  /**
   * 清掉計時器並**永久停用這個 watcher**：之後 `recheck()` 一律回 false、不呼叫 `onUpgrade`。
   * 呼叫端的 unmount 一定要叫。
   */
  stop(): void;
}

/**
 * 包一層「會重試的能力偵測」。`self` 與 `probeDashboardDom` 同義。
 *
 * `onUpgrade` 只會被呼叫**至多一次**，且只在降級 → 升回時。
 * 呼叫端必須在這個 callback 裡**同時**更新顯示與重綁 listener target ——
 * 兩者分開更新就會出現「chip 說全頁追蹤、事件卻只來自自己容器」。
 */
export function watchDashboardDom(
  self: Element | null,
  onUpgrade: (dom: DashboardDom) => void,
  opts: { limit?: number; intervalMs?: number; minRecheckIntervalMs?: number } = {}
): DashboardDomWatcher {
  const limit = opts.limit ?? DOM_PROBE_RETRY_LIMIT;
  const intervalMs = opts.intervalMs ?? DOM_PROBE_RETRY_INTERVAL_MS;
  const minRecheckIntervalMs = opts.minRecheckIntervalMs ?? DOM_PROBE_RECHECK_MIN_INTERVAL_MS;

  let dom = probeDashboardDom(self);
  let timer = 0;
  let left = dom.crossPanel ? 0 : limit;
  let lastProbeAt = performance.now();
  let stopped = false;

  /** 只收計時器，不動 `stopped` —— 升回時走這條（watcher 功成身退，不是被呼叫端停掉）。 */
  const cancelRetries = () => {
    left = 0;
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
  };

  const stop = () => {
    stopped = true;
    cancelRetries();
  };

  /** 重探一次。只有升回才改狀態 —— 還是降級時連 reason 都不換，省掉一次沒有意義的 re-render。 */
  const probe = (): boolean => {
    lastProbeAt = performance.now();
    const next = probeDashboardDom(self);
    if (!next.crossPanel) {
      return false;
    }
    dom = next;
    cancelRetries();
    onUpgrade(next);
    return true;
  };

  const schedule = () => {
    if (left <= 0) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = 0;
      left--;
      if (!probe()) {
        schedule();
      }
    }, intervalMs);
  };

  schedule();

  return {
    current: () => dom,
    recheck: () => {
      // `stopped` 擺第一個：`stop()` 之後這個 watcher 就不該再有任何動作。
      // 這是防禦未來的呼叫端：目前 MascotPanel 的清理在同一個同步區塊裡依序
      // `watcher.stop()`、`cancelAnimationFrame`、解綁 listener，殘留的那一拍不會執行。
      // 但若有呼叫端 stop 之後仍有排好的 rAF／listener 呼叫 recheck，那一拍若還能升回，
      // `onUpgrade` 就會對著已卸載的 React 樹 setState——這個旗標讓它不可能發生。
      if (stopped || dom.crossPanel || performance.now() - lastProbeAt < minRecheckIntervalMs) {
        return false;
      }
      return probe();
    },
    retriesLeft: () => left,
    stop,
  };
}
