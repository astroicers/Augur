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
 */
import type { ParsedAlert } from '../core/types';

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

export type RulesFetcher = (dashboardUid: string, panelId: number) => Promise<RuleDetail[]>;

export interface PanelAlertSourceOptions {
  panelId: number;
  /** 取規則細節。注入以利測試。 */
  fetchRules: RulesFetcher;
  /** rules 端點取不到細節時用的嚴重度。 */
  fallbackSeverity: string;
  /** 規則細節的快取秒數；同一個 episode 期間不必反覆打端點。 */
  ruleCacheSec?: number;
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

/** 把 rules 端點的原始回應攤平成 RuleDetail[]。回應形狀見 .asp-fact-check.md。 */
export function parseRulesResponse(raw: unknown, dashboardUid: string, panelId: number): RuleDetail[] {
  const groups = (raw as { data?: { groups?: unknown[] } })?.data?.groups;
  if (!Array.isArray(groups)) {
    return [];
  }
  const out: RuleDetail[] = [];
  for (const g of groups) {
    const rules = (g as { rules?: unknown[] })?.rules;
    if (!Array.isArray(rules)) {
      continue;
    }
    for (const r of rules) {
      const rule = r as {
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
      };
      const ann = rule.annotations ?? {};
      // 端點支援 dashboard_uid/panel_id 過濾，但再比對一次：過濾參數若被忽略，
      // 我們會把整個 dashboard 的告警都念出來。
      if (ann['__dashboardUid__'] !== dashboardUid || ann['__panelId__'] !== String(panelId)) {
        continue;
      }
      const firing = (rule.alerts ?? []).filter((a) => String(a.state ?? '').toLowerCase() === 'alerting');
      for (const a of firing) {
        const labels = a.labels ?? rule.labels ?? {};
        const aAnn = a.annotations ?? ann;
        out.push({
          alertname: labels['alertname'] ?? rule.name ?? 'unknown',
          severity: labels['severity'] ?? 'unknown',
          ...(aAnn['summary'] !== undefined ? { summary: aAnn['summary'] } : {}),
          // ⚠️ value 是**字串科學記號**（實測 "1e+00"），不是數字。
          ...(toNumber(a.value) !== undefined ? { value: toNumber(a.value)! } : {}),
          ...(a.activeAt !== undefined ? { activeAt: a.activeAt } : {}),
        });
      }
    }
  }
  return out;
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
  let cache: { at: number; rules: RuleDetail[] } | null = null;

  async function rules(dashboardUid: string): Promise<RuleDetail[]> {
    const t = now();
    if (cache && t - cache.at < cacheMs) {
      return cache.rules;
    }
    try {
      const fetched = await opts.fetchRules(dashboardUid, opts.panelId);
      cache = { at: t, rules: fetched };
      return fetched;
    } catch {
      // 端點無官方穩定性保證 —— 失敗是預期內的一種結果，不是例外。
      // 降級成單一泛用事件，由呼叫端照常播報。
      cache = { at: t, rules: [] };
      return [];
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
      const detail = dashboardUid ? await rules(dashboardUid) : [];
      const nowIso = new Date(now()).toISOString();

      if (!detail.length) {
        // 降級路徑：rules 端點取不到（失敗、或規則沒帶 __dashboardUid__/__panelId__ 註解）。
        // 仍然播報，只是內容是泛用的 —— 有聲音比沉默好。
        const fp = `alert:panel:${opts.panelId}`;
        const existing = episodes.get(fp);
        if (existing) {
          return [existing];
        }
        const ep: ParsedAlert = {
          status: 'firing',
          source: 'grafana-alertstate',
          name: '告警',
          severity: opts.fallbackSeverity,
          startsAt: nowIso,
          fingerprint: fp,
        };
        episodes.set(fp, ep);
        return [ep];
      }

      const out: ParsedAlert[] = [];
      const stillFiring = new Set<string>();
      for (const d of detail) {
        // fingerprint 用 alertname —— 一個 panel 可以綁多條規則，用 panelId 會把它們併成一個。
        // 不含 startsAt（不變量 2）、不含 value（它每次 refresh 都在變）。
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
        if (fp === `alert:panel:${opts.panelId}`) {
          // 降級路徑留下的泛用 episode。現在拿得到細節了，它是被**取代**而不是恢復 ——
          // 靜默清掉，不要念一句「告警 已恢復」。
          episodes.delete(fp);
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
