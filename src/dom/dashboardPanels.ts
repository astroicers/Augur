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
