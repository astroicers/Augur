/**
 * 來源層：把 panel 自己的 `props.data` 轉成來源中立的 `ParsedAlert[]`。
 *
 * 這是 ADR-004 決策 2 的實作。舊架構的對應物是 `src/sources/grafana.ts`
 * （webhook payload → ParsedAlert），seam 相同、方向相反：那邊是 push，這邊是 pull。
 *
 * 雙軌（實測依據見 `.asp-fact-check.md`「alertState / rules 端點實測」）：
 *  - **觸發訊號** `props.data.alertState` —— 便宜、即時，隨 panel data 一起到。
 *    但實測只有 `{state, id, panelId, dashboardUID}` 四欄，當不了內容來源。
 *  - **內容來源** `/api/prometheus/grafana/api/v1/rules?dashboard_uid&panel_id`
 *    —— 實測與 ParsedAlert 一對一，且 `labels.severity` 直接命中 severity.ts 的 RANK 表。
 *
 * 三個貫穿全檔的不變量：
 *  1. **episode 用複製而非重算**：resolved 事件一律由記住的 firing 事件 `{...ep, status}`
 *     產生。`dedup.shouldSpeak()` 的 resolved 綁狀態完全建立在「resolved 的 fingerprint
 *     與先前 firing 的逐字相同」之上，重算會把這個不變量交給兩段程式碼去巧合達成。
 *  2. **startsAt 釘死**：episode 首次觀測為 firing 的那一刻，之後永不重算。
 *     舊 adapter 有一條 `fingerprint: alertname:startsAt` 的 fallback —— 一旦把會變動的
 *     startsAt 餵進 fingerprint，dedup 整條失效，症狀是「每 30 秒念一次」。
 *  3. **每次評估都無條件 emit**：重複抑制完全交給 `dedup.ts`，本層不記「我播過了沒」。
 *     這讓 dedup 既有語意（6 個測試）原封不動就是對的。
 *
 * **告警名就是去重單位**：本層的 fingerprint 是 `alert:${名字}`，而名字默認取
 * `labels.alertname`。Grafana 會用規則名覆蓋每個 instance 的 `alertname`，所以
 * 「一條總規則查整面值班牆」時每則告警的名字都一樣、只念得到第一則 ——
 * `alertNameLabel`（#69）讓呼叫端指定改讀哪個 label，詳見 `alertNameOf()`。
 * 換這個選項時只有**名字真的變了**的 fingerprint 算被取代，詳見 `noteLabelChange()`（#85）。
 */
import type { ParsedAlert } from '../core/types';
import { panelRulesOf } from './panelRules';

/** `props.data.alertState` 的結構型別。
 *
 * 刻意**不** import `@grafana/data` 的 `AlertStateInfo` —— 它標 `@internal`，
 * 不在公開 API 契約內。Grafana 移除它時 import 會讓 typecheck 與 build 一起紅，
 * 而結構型別只會在 runtime 拿到 undefined 然後安靜降級 —— 後者才是我們要的行為。
 */
export interface AlertStateLike {
  state?: string;
  panelId?: number;
  dashboardUID?: string;
}

/**
 * 實測可達的狀態只有這三個。`promAlertStateToAlertState()` 是
 * firing→Alerting、pending→Pending、**其餘一律 OK**，所以 ADR-004 原文列的
 * `no_data` / `recovering` / `paused` 透過這條路徑永遠到不了（2026-09-17 實測確認）。
 */
export const REACHABLE_STATES = new Set(['alerting', 'pending', 'ok']);

/** rules 端點取回的單一規則細節。欄位名對齊 ParsedAlert 以利對照。 */
export interface RuleDetail {
  alertname: string;
  severity: string;
  summary?: string;
  value?: number;
  activeAt?: string;
}

/**
 * 取規則細節。第三個參數是「用哪個 label 當告警名」（#69），由來源層在**評估當下**
 * 從選項讀出後帶進來 —— fetcher 自己不持有設定，所以換選項不必重建 fetcher。
 * 既有的實作與測試替身只收前兩個參數也照樣成立（多餘的參數在 TS 與 JS 都合法）。
 */
export type RulesFetcher = (
  dashboardUid: string,
  panelId: number,
  alertNameLabel?: string
) => Promise<RuleDetail[]>;

export interface PanelAlertSourceOptions {
  panelId: number;
  /** 取規則細節。注入以利測試。 */
  fetchRules: RulesFetcher;
  /**
   * rules 端點取不到細節時用的嚴重度。
   *
   * **可以給函式** —— 它在 `evaluate` 當下才被讀,不是建構當下。
   * 呼叫端因此不必為了換這個值而重建整個 source,而重建 source 會把 `episodes`
   * 清空;若同一時間 dedup 沒有一起重建(兩個 effect 的 deps 不同),
   * 就會留下「episodes 空了而 lastFiring 還記得」的組合 —— 那是**永久靜音**:
   * 告警恢復時對著空的 episodes 比對,resolved 不播、key 不刪,
   * 而預設窗是 Infinity,於是這個 fingerprint 再也不會出聲。
   */
  fallbackSeverity: string | (() => string);
  /**
   * 用哪個 instance label 當告警名與去重單位（#69）。空字串／不給 = `alertname`，
   * 行為與沒有這個選項時**逐字相同**。
   *
   * **可以給函式** —— 理由與 `fallbackSeverity` 完全相同：它在 `evaluate` 當下才被讀，
   * 呼叫端不必為了換這個值而重建整個 source（重建會清空 `episodes`，那正是第 2 條
   * 不變量要擋的事）。換值本身要做的事在 `noteLabelChange()` 與差集迴圈的對帳（#85）。
   */
  alertNameLabel?: string | (() => string);
  /** 規則細節的快取秒數；同一個 episode 期間不必反覆打端點。 */
  ruleCacheSec?: number;
  /**
   * 某個 episode 被**取代**（而非恢復）時呼叫，讓 dedup 清掉它的狀態而不播任何東西。
   * 不接的話降級路徑會永久靜音 —— 理由見 `core/dedup.ts` 的 `forget()`。
   */
  onSupersede?: (fingerprint: string) => void;
  /** 注入時鐘（測試用）。 */
  now?: () => number;
}

export interface PanelAlertSource {
  /**
   * 評估一次 panel data，回傳這一輪要送進 dedup 的事件。
   * 呼叫端必須先確認 `data.state === LoadingState.Done`（見 MascotPanel 的守門）。
   */
  evaluate(alertState: unknown, dashboardUid: string | undefined): Promise<ParsedAlert[]>;
  /** 目前記住的 episode 數（除錯與測試用）。 */
  episodeCount(): number;
}

/** 把 rules 端點的原始回應攤平成 RuleDetail[]。回應形狀見 .asp-fact-check.md。
 *
 * 走訪與「綁在本 panel 嗎」的比對在 `panelRules.ts`（三個 parser 共用）；這裡只負責
 * 從一條規則取出 ParsedAlert 要的欄位。
 */
export function parseRulesResponse(
  raw: unknown,
  dashboardUid: string,
  panelId: number,
  alertNameLabel?: string
): RuleDetail[] {
  const nameLabel = normalizeNameLabel(alertNameLabel);
  const out: RuleDetail[] = [];
  for (const { rule, annotations: ann } of panelRulesOf<FiringRule>(raw, dashboardUid, panelId)) {
    const firing = (rule.alerts ?? []).filter((a) => String(a.state ?? '').toLowerCase() === 'alerting');
    for (const a of firing) {
      const labels = a.labels ?? rule.labels ?? {};
      const aAnn = a.annotations ?? ann;
      out.push({
        alertname: alertNameOf(labels, rule.name, nameLabel),
        severity: labels['severity'] ?? 'unknown',
        ...(aAnn['summary'] !== undefined ? { summary: aAnn['summary'] } : {}),
        // ⚠️ value 是**字串科學記號**（實測 "1e+00"），不是數字。
        ...(toNumber(a.value) !== undefined ? { value: toNumber(a.value)! } : {}),
        ...(a.activeAt !== undefined ? { activeAt: a.activeAt } : {}),
      });
    }
  }
  return out;
}

/**
 * 一個 instance 的告警名（#69）。
 *
 * **為什麼需要指定 label**：Grafana 會用**規則名覆蓋**每個 instance 的 `alertname`
 * （eks-infra#1210 實測）。所以「一條總規則查 `ALERTS{alertstate="firing"}`」這種值班牆
 * 用法，到 panel 手上每個 instance 的 `alertname` 全是同一個規則名 —— 名字相同，
 * fingerprint 就相同，於是一條規則底下不管燒幾則**只念第一則**。
 * 把原名用 `label_replace` 保留成另一個 label（例：`wall_alertname`）之後，
 * 這一欄指的就是「去讀那個 label」。
 *
 * 三條規則，順序有意義：
 *  1. `nameLabel` 為空 → 回 `labels.alertname ?? rule.name ?? 'unknown'`，
 *     與沒有這個選項時**逐字相同**（#69 AC-1 的機械保證：空字串走的是同一行運算式）。
 *  2. 指定的 label 在**這個 instance** 上有非空白的值 → 用它（修剪前後空白）。
 *     逐 instance 判斷，所以同一條規則裡帶與不帶的可以並存（AC-3）。
 *  3. 不存在、空字串或只有空白 → 退回第 1 條。**不留空名**：空名會讓 fingerprint
 *     變成 `alert:`、播報句念成「偵測到告警：」後面一片空白（#19→#30→#39→#46 同一族的缺值坑）。
 */
function alertNameOf(labels: Record<string, string>, ruleName: string | undefined, nameLabel: string): string {
  const fallback = labels['alertname'] ?? ruleName ?? 'unknown';
  if (!nameLabel) {
    return fallback;
  }
  // String() 而不是直接 .trim()：label 值在 runtime 沒有型別保證（回應是 JSON），
  // 拿到數字時 .trim() 會丟 TypeError，而這一層的契約是「形狀不對回空陣列、不丟例外」。
  const picked = String(labels[nameLabel] ?? '').trim();
  return picked !== '' ? picked : fallback;
}

/**
 * 選項字串 → 這一層真正使用的 label 名（#85 AC-1）。
 *
 * 兩件事，都是為了讓「等價的兩個寫法」在**同一行運算式**上等價，而不是靠兩條路徑
 * 巧合地算出同一個名字：
 *  1. 修前後空白 —— 在編輯器裡貼 label 名很容易帶到空白，而 ` alertname ` 比對不中任何
 *     label，於是每個 instance 都退回原名（#69 的第 3 條規則）。名字是對的，但那是
 *     「打字打到一半剛好 refresh」時走了一條完全不同的路徑才碰巧對上。
 *  2. **`alertname` 正規化成空字串** —— 填 `alertname` 與留空在 `alertNameOf()` 裡本來就
 *     幾乎等價（#69 AC-1 已有測試釘住解析結果），但「幾乎」不夠：label 名只要在字串上
 *     不同，`noteLabelChange()` 就會認定使用者換了取名規則，`rules()` 的快取鍵也跟著
 *     失效。於是「從留空改成填 `alertname`」這個**什麼都沒改變**的動作，會多打一次端點、
 *     並讓所有具名 episode 跑一趟取代與重建。
 *     在這裡收斂成同一個值之後，那一輪連「換過」都偵測不到（#85 AC-1）。
 *
 * 刻意**不**折大小寫：Prometheus 的 label 名區分大小寫，`Alertname` 是另一個 label。
 */
export function normalizeNameLabel(alertNameLabel: string | undefined): string {
  const trimmed = (alertNameLabel ?? '').trim();
  return trimmed === 'alertname' ? '' : trimmed;
}

/** `parseRulesResponse` 讀得到的欄位（rules 端點回應無型別保證，形狀宣告留在用它的地方）。 */
interface FiringRule {
  name?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  alerts?: Array<{
    state?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    value?: string;
    activeAt?: string;
  }>;
}

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined) {
    return undefined;
  }
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export function createPanelAlertSource(opts: PanelAlertSourceOptions): PanelAlertSource {
  const now = opts.now ?? Date.now;
  const cacheMs = Math.max(0, opts.ruleCacheSec ?? 10) * 1000;

  /** fingerprint → 該 episode 的 firing 事件本身（不變量 1 與 2 的載體）。 */
  const episodes = new Map<string, ParsedAlert>();
  /** 快取**連著取名用的 label 一起記**（#69）—— 理由見 `rules()` 裡的比對。 */
  let cache: { at: number; label: string; rules: RuleDetail[] } | null = null;

  /** 目前這一輪要用哪個 label 取名（#69）；函式型的選項在這裡才被讀。 */
  function nameLabel(): string {
    const v = typeof opts.alertNameLabel === 'function' ? opts.alertNameLabel() : opts.alertNameLabel;
    // 正規化（修空白、`alertname` 視同留空）在這裡做一次，於是快取鍵、要不要傳第三個參數、
    // 以及「label 換過了嗎」三處讀到的都是同一個值（#85 AC-1）。
    return normalizeNameLabel(v);
  }

  async function rules(dashboardUid: string): Promise<RuleDetail[]> {
    const t = now();
    const label = nameLabel();
    // ⚠️ 快取的命中條件**含 label**：手上那份清單的 `alertname` 是用**當時**那個 label
    // 取的，換了 label 之後整份都是舊命名（fingerprint 跟著錯），而預設快取窗是 10 秒。
    // 不比對 label 的話，剛改好選項的那 10 秒內看到的還是「只念第一則」的舊行為 ——
    // 使用者會以為選項沒生效。比對條件寫在這裡，而不是在別處記得去 `cache = null`。
    if (cache && cache.label === label && t - cache.at < cacheMs) {
      return cache.rules;
    }
    try {
      // ⚠️ label 為空時**連第三個參數都不傳**，讓呼叫與這個選項不存在時逐字相同（#69 AC-1）。
      // 不是美觀考量：既有的接線測試用 `toHaveBeenCalledWith('dash-1', 7)` 檢查這個呼叫，
      // 而 jest 的那個比對連參數個數都算 —— 多傳一個空字串就會讓它變紅，而 AC-1 要的是
      // 「留空時行為完全相同、既有測試不改」。於是預設路徑在「連呼叫形狀都一樣」這個
      // 層級上被釘住，而不只是「結果一樣」。
      const args: [string, number, string?] = label ? [dashboardUid, opts.panelId, label] : [dashboardUid, opts.panelId];
      const fetched = await opts.fetchRules(...args);
      cache = { at: t, label, rules: fetched };
      return fetched;
    } catch {
      // 端點無官方穩定性保證 —— 失敗是預期內的一種結果，不是例外。
      // 降級成單一泛用事件，由呼叫端照常播報。
      cache = { at: t, label, rules: [] };
      return [];
    }
  }

  /** 上一輪實際用來取名的 label；`null` = 還沒評估過（第一輪不算「換過」）。 */
  let lastLabel: string | null = null;
  /**
   * 「label 換過了，但手上的 episode 還沒跟新命名**對帳**過」（#85）。
   *
   * 旗標在對帳的那一輪才清掉 —— 不是在偵測到換值的那一刻。偵測到的那一輪可能走降級
   * 路徑（端點掛了、或 `dashboardUid` 還沒到，`detail` 是空的），那一輪沒有任何新命名的
   * 清單可以對；提早清掉旗標會讓下一輪把舊命名的 episode 當成恢復、念出一句假的恢復句
   * —— 那正是 #69 當初要擋的事。
   */
  let pendingRelabel = false;

  /**
   * 記下 `alertNameLabel` 換過了（#69 → #85）。
   *
   * 換掉取名用的 label 之後，手上那些 episode 的 fingerprint 是用**舊命名規則**算的。
   * 其中「名字真的變了」的那幾則不會出現在這一輪的 `detail` 裡，於是會掉進差集迴圈、
   * 被當成「恢復了」—— 使用者在編輯面板裡填上 `wall_alertname` 的那一刻，會先聽到一句
   * 「規則名 已恢復」（而告警其實一直在燒），然後才聽到新名字的 firing。
   * 這正是 `onSupersede` 存在的情境：**被取代，不是恢復**（降級路徑的泛用 episode 同理）。
   *
   * ⚠️ #69 的實作在這裡就把**所有**具名 episode 刪光。那過度了：名字其實沒變的那幾則
   * （沒帶指定 label 而退回原名的 instance、或留空↔`alertname` 這種等價改法）也被忘掉，
   * 下一輪整面重念一次。所以本函式只**記一個旗標**，真正的取捨留到差集迴圈 ——
   * 那時候手上已經有一份用新 label 取好名的清單，「這個 fingerprint 還在不在」
   * 就是「名字有沒有真的變」的現成答案（#85 AC-2）。
   *
   * 只在 `alerting` 那條路徑上呼叫：`ok` 的那一輪要用**舊名字**念恢復句
   * （念出去的是哪個名字，恢復就該是哪個名字），而 `resolvedAll()` 本來就會清空 episodes。
   */
  function noteLabelChange(): void {
    const label = nameLabel();
    if (lastLabel === label) {
      return;
    }
    const changed = lastLabel !== null;
    lastLabel = label;
    if (changed) {
      pendingRelabel = true;
    }
  }

  function resolvedAll(): ParsedAlert[] {
    // 不變量 1：複製而非重算。
    // 但 `value` 要丟掉 —— 它是 firing **當時**的值，而 format.ts 會把它念成
    // 「目前數值 N」。恢復時那個數字已經不是「目前」，念出來是錯的。
    // value 不參與 fingerprint，丟掉不影響 dedup 的 resolved 綁狀態。
    const out = Array.from(episodes.values()).map((ep) => {
      const { value: _ignored, ...rest } = ep;
      return { ...rest, status: 'resolved' as const };
    });
    // episode 結束就忘掉它。這不是「記我播過了沒」（那是 dedup 的事），
    // 是「這一段燒完了」；再燒起來就是新的 episode。
    episodes.clear();
    // ⚠️ **快取也要一起清。**
    // `alertState` 回到 `ok` 代表這個 panel 已經沒有任何規則在燒，
    // 所以手上那份 rules 清單在定義上就是過期的。不清的話，10 秒的快取窗內
    // 只要再有任何規則燒起來，這一輪拿到的是**含著剛恢復那些告警**的舊清單 ——
    // 於是一個從來沒有再燒過的告警會被當成又燒起來、播一次 firing，
    // 快取到期後再播一次 resolved。實測（ruleCacheSec: 10）：
    // A 燒 → A 恢復 → 1 秒後 B 燒 → 播出的是 A/firing 而不是 B/firing。
    //
    // 順帶一提，這個缺陷先前測不到，因為**每一條測試都傳 `ruleCacheSec: 0`**，
    // 等於把快取整個關掉 —— 而 production 用的是預設的 10 秒。
    cache = null;
    // episodes 清空了，就沒有用舊命名算的 fingerprint 要跟新 label 對帳（#85）。
    // 上面那些 resolved 用的是**舊名字**，而那正是先前念出去的名字 —— 對的。
    pendingRelabel = false;
    return out;
  }

  return {
    episodeCount: () => episodes.size,

    async evaluate(alertStateRaw: unknown, dashboardUid: string | undefined): Promise<ParsedAlert[]> {
      const alertState = alertStateRaw as AlertStateLike | undefined;
      const state = String(alertState?.state ?? '').toLowerCase();

      if (!REACHABLE_STATES.has(state)) {
        // 未知狀態（含 alertState 根本不存在）：不產生事件，也不清掉 episode。
        // ⚠️ 不能把「偵測不到 alertState」當降級訊號 —— 它是**黏著的**、永不回 undefined
        //    （實測確認），所以那個訊號不存在。降級要由 panel option 顯式強制。
        return [];
      }

      if (state === 'pending') {
        // pending 不播。ADR-004 選 alertState 的唯一理由就是它含 `for` duration 語意，
        // 在 pending 期間播報等於親手把那個理由丟掉；更糟的是 pending 與 alerting
        // 共用 fingerprint，先播 pending 會讓「真的燒起來」那一刻被 dedup 吞掉，
        // 把最重要的事件降級成「可能要燒」。
        return [];
      }

      if (state === 'ok') {
        return resolvedAll();
      }

      // state === 'alerting'
      noteLabelChange();
      const detail = dashboardUid ? await rules(dashboardUid) : [];
      const nowIso = new Date(now()).toISOString();

      if (!detail.length) {
        // 降級路徑：rules 端點取不到（失敗、或規則沒帶綁定本 panel 的註解，見 panelRules.ts）。
        // 仍然播報，只是內容是泛用的 —— 有聲音比沉默好。
        const fp = `alert:panel:${opts.panelId}`;
        const existing = episodes.get(fp);
        if (existing) {
          // ⚠️ severity 要**就地跟上目前的選項值**（2026-09-29 複審抓到）：
          // 降級 episode 的 severity 是猜的（不是事實），而它一旦建立就定格 ——
          // 最壞組合是 fallbackSeverity=info、minSeverity=warning 時告警被過濾掉，
          // 使用者發現沒聲音、把 fallbackSeverity 調高想救，**也救不回來**：
          // episode 還是舊的 info，直到 resolved 前永遠沉默。
          // 具名規則的 episode 不在此列 —— 它們的 severity 是 label 記錄的事實，
          // 「複製不重算」的不變量仍然成立；這裡改的只是自己合成的猜測值。
          existing.severity =
            typeof opts.fallbackSeverity === 'function' ? opts.fallbackSeverity() : opts.fallbackSeverity;
          return [existing];
        }
        const ep: ParsedAlert = {
          status: 'firing',
          source: 'grafana-alertstate',
          name: '告警',
          severity: typeof opts.fallbackSeverity === 'function' ? opts.fallbackSeverity() : opts.fallbackSeverity,
          startsAt: nowIso,
          fingerprint: fp,
        };
        episodes.set(fp, ep);
        return [ep];
      }

      // 到這裡手上有一份**用現在這個 label 取好名**的清單，於是換 label 這件事可以對帳了
      // （#85）。旗標在這一行消費掉，而不是在 `noteLabelChange()` 裡 —— 上面那條降級路徑
      // 會 `return`，而它沒有清單可對。
      const relabeled = pendingRelabel;
      pendingRelabel = false;

      const out: ParsedAlert[] = [];
      const stillFiring = new Set<string>();
      for (const d of detail) {
        // fingerprint 用 alertname —— 一個 panel 可以綁多條規則，用 panelId 會把它們併成一個。
        // 不含 startsAt（不變量 2）、不含 value（它每次 refresh 都在變）。
        //
        // `d.alertname` 自 #69 起是**逐 instance 取好的名字**（指定 label 時取那個 label
        // 的值，否則照舊是 `labels.alertname ?? rule.name`），所以一條總規則底下的每則
        // 告警各有自己的 fingerprint、各自成為一個 episode。
        // 反面也刻意不變：**名字相同就共用 fingerprint**，跨規則亦然（key 不含 panelId
        // 與規則名，見上一段）—— 同一個告警在兩條規則下燒，仍然只念一次。
        const fp = `alert:${d.alertname}`;
        stillFiring.add(fp);
        const existing = episodes.get(fp);
        if (existing) {
          // 不變量 3：持續 firing 期間每次都吐同一個事件，抑制交給 dedup。
          out.push(existing);
          continue;
        }
        const ep: ParsedAlert = {
          status: 'firing',
          source: 'grafana-alertstate',
          name: d.alertname,
          severity: d.severity,
          // 不變量 2：activeAt 是 Grafana 給的 episode 起點，比本地時鐘更準；沒有才退回本地。
          startsAt: d.activeAt ?? nowIso,
          fingerprint: fp,
          ...(d.summary !== undefined ? { summary: d.summary } : {}),
          ...(d.value !== undefined ? { value: d.value } : {}),
        };
        episodes.set(fp, ep);
        out.push(ep);
      }

      /**
       * ⚠️ **一個 panel 綁多條規則時，「部分恢復」不會讓 `alertState` 離開 `alerting`。**
       *
       * A5-4 把 3 條效能規則綁在 panel 4、5 條安全規則綁在 panel 5 之後，這條路徑才真的
       * 會被走到。情境：`WindowsAccountLockout`（critical）燒起來、播報了；兩分鐘後帳號解鎖，
       * 但 `WindowsFailedLogonBurst` 還在燒 —— panel 的 `alertState` 仍是 `alerting`，
       * 所以 `resolvedAll()` 不會被呼叫，那條 episode 就**一直留著**。
       * 操作者聽到「帳號被鎖定」之後再也沒聽到恢復，會以為帳號還鎖著。
       * 最糟的是它可能在二十分鐘後、最後一條規則也恢復時才跟著一起被念出來 ——
       * 一個早就過期的「已恢復」。
       *
       * `parseRulesResponse` 只保留 `state === 'alerting'` 的告警（實查該函式），
       * 所以 `detail` 就是「此刻仍在燒的」。差集即為「這一輪恢復的」。
       */
      for (const [fp, ep] of [...episodes]) {
        if (stillFiring.has(fp)) {
          continue;
        }
        if (fp === `alert:panel:${opts.panelId}` || relabeled) {
          // 兩種「不是恢復，是**被取代**」，處置相同（刪掉、請 dedup 忘掉、不播任何句子）：
          //
          //  1. 降級路徑留下的泛用 episode。現在拿得到細節了，它是被具名的那幾則取代 ——
          //     不要念一句「告警 已恢復」（那會在告警仍在燒的時候宣告恢復）。
          //  2. 這一輪換過取名用的 label，而這個 fingerprint 不在新命名的清單裡（#85）——
          //     同一則告警現在叫別的名字。舊名字的 episode 被新名字的取代，所以不念舊名字的
          //     恢復句（AC-3），新名字這一輪就會建立並照常念一次 firing。
          //     **只有落到這裡的才被取代**：名字沒變的那幾則（沒帶指定 label 而退回原名的
          //     instance、或 `alertname`↔留空這種等價改法）本來就在 `stillFiring` 裡，
          //     上面那個 `continue` 就把它們留住了，episode 照常延續、不重念（AC-2）。
          //     ⚠️ 已知取捨：換 label 的**同一輪**剛好不再燒的那一則，分不出「改名了」
          //     還是「恢復了」（手上只有新命名的清單），一律當成取代 —— 也就是少念一句
          //     恢復。這與 #69 的行為相同（那時候是整面都不念），而要分辨就得把每個
          //     instance 的 labels 一路帶到這一層，`RuleDetail` 的形狀得跟著改。
          //
          // ⚠️ 兩種都**不能只是刪掉自己這邊**：dedup 的 `lastFiring` 只在播出 resolved 時
          // 才清 key，而預設窗是 `Infinity`，所以光刪 `episodes` 會讓這個 fingerprint
          // 永久靜音 —— 之後端點再掛一次、真的有告警時，面板會完全不出聲。
          // 必須同時請 dedup 忘掉它。
          episodes.delete(fp);
          opts.onSupersede?.(fp);
          continue;
        }
        // 與 resolvedAll 同一個規則：丟掉 value（它是 firing 當時的值，恢復時已不是「目前」）。
        const { value: _ignored, ...rest } = ep;
        out.push({ ...rest, status: 'resolved' as const });
        episodes.delete(fp);
      }
      return out;
    },
  };
}
