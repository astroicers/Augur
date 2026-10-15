/**
 * 導播 —— 從「這個 panel 現在有沒有在燒」到「要念哪幾句、哪幾句真的交給播報器」。
 *
 * 這是 `MascotPanel.tsx` 裡那條管線的搬家（#58）。先前它由元件裡四個 `useEffect`
 * 合作完成，而它的不變量靠 **effect 的宣告順序**維持（檔內三處註明「宣告順序有意義」）：
 * 同步設定的 effect 要排在 evaluate 之前、source 與 dedup 的 deps 必須一致、
 * 換去重視窗不能重建 dedup。那些條件在元件裡只能靠註解與紀律維持 —— 新增一個 effect、
 * 或把兩個 effect 調換位置，就會靜默破掉其中一條，而三條破掉的症狀都一樣：
 * **永久靜音**（告警真的在燒而面板一聲不吭，且不留任何錯誤訊息）。
 *
 * 搬到這裡之後，同樣的三件事改由**明確的呼叫順序與狀態**保證：
 *
 *  1. **設定由 `evaluate()` 的參數帶進來**，不是另一個 effect 同步的 ref。
 *     「改設定後的下一次 evaluate 讀到新設定」於是不是一條要遵守的規則，
 *     而是沒有別的可能 —— 導播沒有第二個存設定的地方，而每一輪都從參數讀。
 *  2. **source 與 dedup 同生同死**：兩者都在 `createBroadcastDirector()` 裡建立、
 *     在 `dispose()` 裡收掉，中間沒有任何路徑能只換掉一個。先前那個會永久靜音的組合
 *     （`episodes` 清了而 `lastFiring` 還記得）在這裡**建構不出來**。
 *  3. **換去重視窗一律走 `dedup.setWindow()`**：重建 dedup 的程式碼在本檔不存在，
 *     所以「重建會清掉 lastFiring、正在燒的告警被重播一次」沒有發生的餘地。
 *
 * 交付閘門也住在這裡（#63）：**每瀏覽器靜音**（ADR-007，注入的 `muted()`）與
 * **值班靜音時段**（`quietHours`，本檔的純函式判斷）走的是同一條路徑 ——
 * 照樣評估、照樣經過 dedup、照樣回 `items`（清單與表情要更新），只是不交給播報器。
 * 時段結束時因此不會把時段內的告警一口氣補念出來：那些告警早在時段內就被 dedup 收下了。
 *
 * 外加一條元件裡原本就有、但沒有名字的不變量：
 *
 *  4. **一輪評估是原子的**。設定在 `evaluate()` 進入時定格，非同步鏈還在跑時呼叫端
 *     再改設定，也不會讓同一輪的門檻與組句讀到兩套值；並發的第二次呼叫直接被擋下
 *     （回 `evaluated: false`，呼叫端不要動畫面）。
 *
 * **不依賴 React、不碰 DOM**（AC-1）：不 import `react`，不讀 `window`／`document`，
 * 時鐘與來源層一律注入 —— 它的單元測試不 render 任何東西（AC-5）。
 * 連 `fetchPanelRules` 都不 import（那支會拖進 `@grafana/runtime`，理由同
 * `sources/rulesFetcher.ts` 的檔頭）；正式的來源層工廠由呼叫端用 `panelAlertSource()`
 * 組好再傳進來。
 */
import type { AlertLang, BroadcastPlan, ParsedAlert } from '../core/types';
import { meetsMin } from '../core/severity';
import { parseSeverityAliases, resolveSeverity, type SeverityAliasMap } from '../core/severityAliases';
import { createDedup, type Dedup } from '../core/dedup';
import { buildBroadcastPlan } from '../core/format';
import { createPanelAlertSource, type RulesFetcher } from '../sources/panelAlerts';

/**
 * 導播要的來源能力 —— `PanelAlertSource` 的子集（只有 `evaluate`）。
 * 窄到這個程度是為了讓單元測試能用一個兩行的假 source 驅動整條管線（AC-5）。
 */
export interface AlertSource {
  evaluate(alertState: unknown, dashboardUid: string | undefined): Promise<ParsedAlert[]>;
}

/**
 * 導播交給來源層的兩個掛鉤。兩者都**在來源層需要時才被讀**，不是建構當下：
 *
 * - `fallbackSeverity`：rules 端點取不到細節時的嚴重度。走函式而不是值，呼叫端才
 *   不必為了換這個選項而重建整個 source —— 重建 source 會清掉 `episodes`，
 *   而那正是第 2 條不變量要擋的事（詳見 `sources/panelAlerts.ts` 的同名選項註解）。
 * - `onSupersede`：某個 episode 被**取代**（不是恢復）時，dedup 也要忘掉它，
 *   否則降級路徑永久靜音（詳見 `core/dedup.ts` 的 `forget()`）。
 *   導播把它接到自己那一份 dedup 上，呼叫端接不接線都不影響。
 */
export interface SourceHooks {
  fallbackSeverity: () => string;
  onSupersede: (fingerprint: string) => void;
}

/**
 * 導播交付的對象 —— `speech/speaker.ts` 的 `Speaker` 的子集。
 * 導播只需要「排進佇列」與「佇列有多長」，不需要瀏覽器語音的任何其他能力，
 * 所以單元測試拿一個 `{ enqueue, pending }` 的假物件就能驅動（AC-5）。
 */
export interface BroadcastSink {
  enqueue(plan: BroadcastPlan): void;
  pending(): number;
}

/** 一輪評估用的設定。全部由 `evaluate()` 的參數帶進來（第 1 條不變量）。 */
export interface DirectorSettings {
  /** 只播 >= 此嚴重度；`resolved` 不受門檻影響。 */
  minSeverity: string;
  /** 持續燒時的重播間隔（分）；`0` = 永不重播。 */
  repeatFiringMin: number;
  /** rules 端點取不到細節時的嚴重度。 */
  fallbackSeverity: string;
  /** 組句語言。 */
  alertLang: AlertLang;
  /**
   * 嚴重度別名的**設定字串**（不是解析好的 `Map`）。
   *
   * 刻意收字串：解析結果是 `Map`，每次呼叫都是新的物件參考，交給 React 的相依陣列
   * 會讓呼叫端每輪 render 都重跑一次評估。解析只是幾次 `split`，而且本檔對同一個
   * 字串只解析一次（見 `aliasesFor`）。
   */
  severityAliasSpec: string;
  /**
   * 值班靜音時段的**設定字串**（`22:00-07:00`）；空字串／缺鍵 = 不排程靜音（#63）。
   *
   * 收字串而不是解析好的 `QuietRange`，理由同 `severityAliasSpec`：解析結果是物件，
   * 每次呼叫都是新的參考，交給 React 的相依陣列會讓呼叫端每輪 render 都重跑一次評估。
   * 解析是兩次 `split`，而且本檔對同一個字串只解析一次（見 `quietRangeFor`）。
   *
   * **選填（`?`）而非必填**，理由同 `panelOptions.ts` 的 `severityAliases`：這兩欄是
   * 後來加的，宣告成必填會讓既有的 `DirectorSettings` 字面值（含測試 fixture）
   * 全部得補一行，而 #63 AC-1 要的正是「既有測試一行不改」。讀的那一側一律 `?? ''`。
   */
  quietHours?: string;
  /**
   * 排程靜音時段內，`critical` 的 firing 照常交付（#63 AC-3）。預設 `false`。
   *
   * **只對排程靜音生效，不覆蓋 ADR-007 的每瀏覽器靜音**：那是觀看者自己按下的開關，
   * dashboard 的設定不該蓋過它（AC-6 的「任一個成立就不念」）。
   */
  quietAllowCritical?: boolean;
}

/** 一則要播報的事：來源事件、組好的播報計畫，以及導播決定它的時刻。 */
export interface BroadcastItem {
  alert: ParsedAlert;
  plan: BroadcastPlan;
  /** 導播決定播報的時刻（epoch ms，取自注入的時鐘）。 */
  at: number;
}

/** 一輪評估的結果。 */
export interface BroadcastRound {
  /** 本輪要播報的項，**時間順序**（最早的在前）。 */
  items: readonly BroadcastItem[];
  /**
   * 這一輪是否真的評估過。`false` = 被並發守門或 `dispose()` 擋下，
   * 呼叫端不要動畫面（與「評估過但沒有要播的事」是兩回事）。
   */
  evaluated: boolean;
  /**
   * 交付之後播報器的佇列長度；這一輪沒有交付任何一則時是 `null`
   * （靜音、沒有播報器、或本輪無事）。`null` 表示「沒有新的佇列長度可報」。
   */
  pending: number | null;
}

export interface BroadcastDirector {
  /**
   * 評估一輪。
   *
   * 呼叫端必須先確認 `data.state === LoadingState.Done` —— 載入中或查詢失敗時
   * `data.series` 可能是空的，在 threshold 路徑上會被讀成「全部回到 base step」，
   * 於是資料庫連不上竟然播「告警已恢復」。這是 pull 模型最容易踩的誤報，
   * 守門留在呼叫端（它才看得到 `data.state`）。
   */
  evaluate(input: EvaluateInput, settings: DirectorSettings): Promise<BroadcastRound>;
  /** 收掉導播（source 與 dedup 一起）。之後的 `evaluate()` 一律回 `evaluated: false`。 */
  dispose(): void;
}

export interface EvaluateInput {
  /** `props.data.alertState` 的原值（形狀不可信，交給來源層判讀）。 */
  alertState: unknown;
  /** dashboard uid；取不到時來源層走泛用降級。 */
  dashboardUid: string | undefined;
}

export interface BroadcastDirectorOptions {
  /**
   * 建立來源層。導播在建構當下呼叫**一次**，並把 `SourceHooks` 交給它 ——
   * source 與 dedup 同生同死（第 2 條不變量）的機械保證就在這裡：
   * 導播沒有「只重建 source」的入口。
   *
   * 正式用 `panelAlertSource(panelId, fetchPanelRules)`；測試傳假 source（AC-5）。
   */
  createSource: (hooks: SourceHooks) => AlertSource;
  /**
   * 目前的播報器；`null` = 這一刻沒有播報器（語音選項關掉、或環境沒有語音）。
   * **每輪交付當下才讀**，所以呼叫端換播報器不必、也不該重建導播。
   */
  speaker: () => BroadcastSink | null;
  /**
   * 這台瀏覽器是否靜音（ADR-007）。同樣是交付當下才讀。
   * 靜音時這一輪照樣評估、照樣回 `items`（清單與表情要更新），只是不交給播報器。
   */
  muted?: () => boolean;
  /** 注入時鐘（測試用），預設 `Date.now`。也會交給 dedup，兩者看到同一個時間。 */
  now?: () => number;
}

/**
 * `repeatFiringMin = 0` → 永不重播 → 防洪窗是 `Infinity`。
 * 來源層與 dedup 共用這個換算，所以它只有一份，住在導播裡。
 */
export function windowSecFor(repeatFiringMin: number): number {
  return repeatFiringMin > 0 ? repeatFiringMin * 60 : Number.POSITIVE_INFINITY;
}

/** 正式的來源層工廠：`createPanelAlertSource` 綁上 panelId 與 rules fetcher。 */
export function panelAlertSource(panelId: number, fetchRules: RulesFetcher): (hooks: SourceHooks) => AlertSource {
  return (hooks) =>
    createPanelAlertSource({
      panelId,
      fetchRules,
      fallbackSeverity: hooks.fallbackSeverity,
      onSupersede: hooks.onSupersede,
    });
}

// ---------------------------------------------------------------------------
// 值班靜音時段的純函式（#63）
//
// **為什麼住在本檔而不是 `src/core/quietHours.ts`**：`BroadcastDirector.test.ts` 的
// `AC-1：導播不 import react、不碰 DOM` 逐項比對本檔的 import 清單（#58 的機械承接），
// 多一個 import 就會讓那支既有測試變紅 —— 而本票 AC-1 要的是「既有測試一行不改且全綠」。
// 兩條都想要的話只有兩種走法：拆檔並改那支測試一行，或把純函式放進本檔。
// 選後者，因為它不動既有測試，而且這幾個函式唯一的呼叫端就是下面那個交付閘門。
// 日後若要拆成 `core/` 的模組（例如別處也要判時段），改動就是那一行 import 清單。
//
// 這些函式**不碰 DOM、不讀 `Date.now()`**：時刻一律由呼叫端帶進來（注入的時鐘），
// 所以測試能把任意一天的任意時刻餵進來，不必等到真的半夜。
// ---------------------------------------------------------------------------

/** 時段一律以「當天的第幾分鐘」表示：`0` = 00:00、`1439` = 23:59。 */
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * 解析成功的靜音時段。
 *
 * **端點規則：起點含、終點不含**（`[startMin, endMin)`）。`22:00-07:00` 於是在 22:00
 * 整就靜音、07:00 整就恢復出聲；相鄰的兩段（`07:00-12:00` 與 `12:00-22:00`）接得起來
 * 而不重疊。這條規則不是「例如」—— 下面 `isQuietAt` 的兩個比較與它的測試把它釘死。
 */
export interface QuietRange {
  /** 起點（**含**），當天的第幾分鐘。 */
  startMin: number;
  /** 終點（**不含**），當天的第幾分鐘。`endMin < startMin` = 跨午夜（相同的起訖解析不出來）。 */
  endMin: number;
}

/**
 * 設定沒能解析成一個時段的原因。格式錯誤一律**視同沒設定**（不拋例外）——
 * 設定來自 dashboard JSON，任何輸入都只該讓這一個選項失效，不該讓播報中斷。
 */
export type QuietHoursProblem = 'empty' | 'not-a-range' | 'bad-time' | 'same-endpoints';

export interface QuietHoursConfig {
  /** 解析成功的時段；`null` = 沒設定或格式錯誤（兩者行為相同：不排程靜音）。 */
  range: QuietRange | null;
  /** `range` 為 `null` 時的原因；解析成功時是 `null`。 */
  problem: QuietHoursProblem | null;
}

/**
 * 全形 ASCII（U+FF01–U+FF5E）整段換成半形，全形空白換成半形空白。
 *
 * **接受全形**（`２２：００－０７：００` 照樣認得），理由與 `core/severityAliases.ts`
 * 的分隔符同一條：編輯器的說明是中文，使用者在中文輸入法下打出來的冒號是 `：`（U+FF1A）、
 * 減號是 `－`（U+FF0D）。只認半形的話整個選項會靜默失效 —— 面板毫無反應而使用者看不出哪裡錯。
 * 換算是整段偏移 0xFEE0，所以全形數字 `０`–`９` 一併認得。
 */
function toHalfWidth(text: string): string {
  return text.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}

/** `HH:MM`（時可以只寫一位：`7:00`）。分必須兩位 —— `7:5` 是打錯而不是 07:05。 */
const CLOCK = /^(\d{1,2}):(\d{2})$/;

/** `HH:MM` → 當天的第幾分鐘；不合法回 `null`。 */
function parseClock(text: string): number | null {
  const m = CLOCK.exec(text.trim());
  if (m === null) {
    return null;
  }
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * MINUTES_PER_HOUR + minutes;
}

/**
 * 解析 `22:00-07:00` 這種設定字串。**純函式、不拋例外**（#63 AC-4）。
 *
 * - 空字串、只有空白、非字串（舊 dashboard 的 JSON 沒有這個鍵）→ `'empty'`，視同沒設定。
 * - 不是用一個 `-` 分成兩段（缺 `-`、或有兩個以上）→ `'not-a-range'`。
 * - 任一端不是合法的 24 小時制 `HH:MM`（`25:00`、`12:60`、`7:5`、`2200`）→ `'bad-time'`。
 * - 起訖相同（`22:00-22:00`）→ `'same-endpoints'`：照端點規則那是「整天都不靜音」，
 *   但使用者寫下它時想的幾乎一定是「整天都靜音」。兩種讀法都說得通的設定不猜，
 *   視同沒設定並回報原因。要整天靜音請把語音選項關掉（`enableTTS`）。
 *
 * 跨午夜不是錯誤而是正常情形：`endMin < startMin` 就是跨午夜（見 `isQuietAt`）。
 */
export function parseQuietHours(spec: unknown): QuietHoursConfig {
  const none = (problem: QuietHoursProblem): QuietHoursConfig => ({ range: null, problem });
  if (typeof spec !== 'string') {
    return none('empty');
  }
  const text = toHalfWidth(spec).trim();
  if (text === '') {
    return none('empty');
  }
  const parts = text.split('-');
  if (parts.length !== 2) {
    return none('not-a-range');
  }
  const startMin = parseClock(parts[0]!);
  const endMin = parseClock(parts[1]!);
  if (startMin === null || endMin === null) {
    return none('bad-time');
  }
  if (startMin === endMin) {
    return none('same-endpoints');
  }
  return { range: { startMin, endMin }, problem: null };
}

/**
 * 某個時刻（epoch ms）在**觀看者這台瀏覽器的本地時間**裡是當天的第幾分鐘。
 *
 * 本地時間是刻意的（#63 AC-2）：值班的人設「22:00 到 07:00 別念」指的是他自己牆上的
 * 22:00。代價寫在選項說明與文件裡 —— 跨時區的兩個觀看者會各自落在不同的絕對時刻，
 * 而日光節約轉換當天那一小時會被跳過或重複（例如 02:00 不存在時，`02:00-03:00` 當天不成立）。
 * 要全站同一個絕對時段的話得改成帶時區的設定，那是另一張票。
 */
export function minuteOfDayAt(epochMs: number): number {
  const at = new Date(epochMs);
  return at.getHours() * MINUTES_PER_HOUR + at.getMinutes();
}

/**
 * 這個時刻（當天的第幾分鐘）是否落在時段內。**起點含、終點不含。**
 *
 * `range` 為 `null`（沒設定或格式錯誤）→ 一律 `false`，也就是「行為與沒有這個選項時相同」。
 * `startMin > endMin` = 跨午夜 → 條件是**或**而不是且（`22:00-07:00` 要同時涵蓋 23:00 與 03:00）。
 */
export function isQuietAt(range: QuietRange | null, minuteOfDay: number): boolean {
  if (range === null) {
    return false;
  }
  const at = ((Math.floor(minuteOfDay) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return range.startMin < range.endMin
    ? at >= range.startMin && at < range.endMin
    : at >= range.startMin || at < range.endMin;
}

const QUIET_PROBLEM_TEXT: Record<QuietHoursProblem, string> = {
  empty: '',
  'not-a-range': '要用一個 `-` 分成起訖兩段，例如 22:00-07:00',
  'bad-time': '兩端都要是 24 小時制的 HH:MM（00:00–23:59）',
  'same-endpoints': '起點與終點相同；要整天不念請關掉語音選項',
};

/**
 * 把解析失敗講成一句人看得懂的話（#63 AC-4 的「回報原因」）；沒設定或解析成功回空字串。
 *
 * 純函式、不碰 DOM —— 面板要顯示就直接用。目前沒有任何 UI 消費它，與
 * `core/severityAliases.ts` 的 `describeSkippedAliases` 同一個狀態。
 */
export function describeQuietHours(problem: QuietHoursProblem | null): string {
  if (problem === null || problem === 'empty') {
    return '';
  }
  return `值班靜音時段的設定無效，視同沒設定：${QUIET_PROBLEM_TEXT[problem]}`;
}

/**
 * 這一則能不能在**排程靜音時段內**破靜音（#63 AC-3）。
 *
 * 只有一種：`quietAllowCritical` 開著、而且它是一則 **`critical` 的 firing**。
 * 嚴重度走 `resolveSeverity` + `meetsMin`，與門檻**吃同一份別名解析結果**（`aliases`）
 * 與同一套排名、大小寫與前後空白規則 —— 兩邊各自比字串遲早會漂成
 * 「門檻放它過卻破不了靜音」。`critical` 是排名最高的那一級，所以 `meetsMin(…, 'critical')`
 * 就等於「它是 critical」。
 *
 * **`resolved` 不破靜音**，與門檻那條「resolved 不受門檻影響」刻意相反：那條的理由是
 * 「播過 firing 就該播恢復」，而這裡的語意是「半夜只有需要有人起來處理的事才出聲」，
 * 恢復不需要有人起來。代價誠實記下：破過靜音的那則 critical 在時段內恢復時不會有人聽到，
 * 要到早上看清單（清單在時段內照常更新）。
 */
function breaksQuiet(item: BroadcastItem, settings: DirectorSettings, aliases: SeverityAliasMap): boolean {
  if (settings.quietAllowCritical !== true || item.alert.status !== 'firing') {
    return false;
  }
  return meetsMin(resolveSeverity(item.alert.severity, aliases), 'critical');
}

/** 被擋下的那一輪（並發或已 dispose）。沒有要播的事，也沒有新的佇列長度可報。 */
const BLOCKED_ROUND: BroadcastRound = { items: [], evaluated: false, pending: null };

export function createBroadcastDirector(opts: BroadcastDirectorOptions): BroadcastDirector {
  const now = opts.now ?? Date.now;
  const isMuted = opts.muted ?? (() => false);

  /**
   * 最後一次 `evaluate()` 帶進來的設定（唯一的那一份）。`null` = 還沒評估過。
   *
   * 讀它的只有兩個地方：`applySettings()`（比對換窗）與來源層的 `fallbackSeverity`
   * 掛鉤（在 `evaluate` 的非同步鏈裡被讀）。管線本身讀的是 `evaluate()` 內
   * 定格的那份區域變數，不是這個可變狀態 —— 第 4 條不變量。
   */
  let settings: DirectorSettings | null = null;
  let busy = false;
  let disposed = false;

  /**
   * 防洪窗的初值取「永不重播」（`repeatFiringMin: 0`，也是 panel 的預設值）：
   * 這是最保守的那一側，而且第一次 `evaluate()` 必定先用呼叫端的設定覆蓋它
   * （`applySettings` 在 `settings === null` 時無條件 `setWindow`）。
   *
   * `startCleanup: false`：清理 timer 不開。`createDedup` 的 `pruneIntervalMs()`
   * 註解記著開它的後果 —— 預設窗是 `Infinity`，而 `setInterval(fn, Infinity)`
   * 會被夾成 CPU 熱迴圈。導播是前景元件的一部分，生命週期跟著 panel，不需要週期回收。
   */
  const dedup: Dedup = createDedup(windowSecFor(0), { startCleanup: false, now });

  const source = opts.createSource({
    // `applySettings` 必定在 `source.evaluate()` 之前跑完，所以來源層讀到的永遠是
    // 本輪的設定；`?? ''` 只是不寫 non-null 斷言（空字串在 `severity.ts` 等同 unknown）。
    fallbackSeverity: () => settings?.fallbackSeverity ?? '',
    onSupersede: (fingerprint) => dedup.forget(fingerprint),
  });

  /** 靜音時段設定字串 → 解析結果的一格快取。同一個字串只解析一次。 */
  let quietSpec: string | null = null;
  let quietRange: QuietRange | null = null;
  function quietRangeFor(spec: string): QuietRange | null {
    if (spec !== quietSpec) {
      quietSpec = spec;
      quietRange = parseQuietHours(spec).range;
    }
    return quietRange;
  }

  /** 別名設定字串 → 解析結果的一格快取。同一個字串只解析一次。 */
  let aliasSpec: string | null = null;
  let aliasMap: SeverityAliasMap = new Map();
  function aliasesFor(spec: string): SeverityAliasMap {
    if (spec !== aliasSpec) {
      aliasSpec = spec;
      aliasMap = parseSeverityAliases(spec).aliases;
    }
    return aliasMap;
  }

  /**
   * 套用新設定。**換窗而不重建**（第 3 條不變量）—— `createDedup` 在本函式裡
   * 叫不到，重建一個 dedup 等於清掉 `lastFiring`，對面正在燒的告警於是被重播一次。
   */
  function applySettings(next: DirectorSettings): DirectorSettings {
    if (settings === null || next.repeatFiringMin !== settings.repeatFiringMin) {
      dedup.setWindow(windowSecFor(next.repeatFiringMin));
    }
    settings = { ...next };
    return settings;
  }

  async function evaluate(input: EvaluateInput, next: DirectorSettings): Promise<BroadcastRound> {
    if (disposed || busy) {
      return BLOCKED_ROUND;
    }
    busy = true;
    try {
      // 設定先定格：以下整條管線（門檻、別名、組句）讀的都是這一份區域變數。
      const round = applySettings(next);
      const aliases = aliasesFor(round.severityAliasSpec);
      const alerts = await source.evaluate(input.alertState, input.dashboardUid);
      // await 期間可能被 dispose（StrictMode 的 mount → unmount → mount、panel id 改變）。
      // 舊導播此時若照常交付，會與接手的新導播各念一次同一則告警。
      if (disposed) {
        return BLOCKED_ROUND;
      }

      const items: BroadcastItem[] = [];
      for (const alert of alerts) {
        // 順序與舊 `server.ts` 相同：先過濾、再防洪、最後才組播報計畫。
        //
        // ⚠️ **過濾在防洪之前，不能對調。** 被門檻擋下的告警不得進 dedup ——
        // 進了就等於「播過」，等它恢復時 `shouldSpeak` 會放行一句「已恢復」，
        // 而使用者從來沒聽過它燒起來。更糟的是門檻之後調低時，那個 fingerprint
        // 的 `lastFiring` 已經記著了，預設窗是 `Infinity` → 它永遠不會出聲。
        //
        // `resolved` 不受嚴重度門檻影響（`status === 'firing' &&` 這個前綴的全部理由）：
        // 播過 firing 就該播恢復，否則調高門檻會讓「播了警告卻永遠不播恢復」。
        //
        // 別名（#51）在過濾**之前**生效，且門檻與表情吃的是同一次解析結果 ——
        // 兩邊各自套別名遲早會漂成「排名達標但表情不對」。
        if (alert.status === 'firing' && !meetsMin(resolveSeverity(alert.severity, aliases), round.minSeverity)) {
          continue;
        }
        if (!dedup.shouldSpeak(alert)) {
          continue;
        }
        items.push({ alert, plan: buildBroadcastPlan(alert, round.alertLang, aliases), at: now() });
      }

      if (items.length === 0) {
        return { items, evaluated: true, pending: null };
      }
      // 靜音或沒有播報器時照樣回 items（呼叫端要更新清單與表情），只是不交付。
      const sink = opts.speaker();
      if (sink === null || isMuted()) {
        return { items, evaluated: true, pending: null };
      }
      // 排程靜音（#63）：**每瀏覽器靜音之後才判**，所以 `quietAllowCritical` 不可能
      // 蓋過觀看者自己按下的開關（上面那個 `return` 已經先走掉了）。
      //
      // ⚠️ 這道閘門在 dedup **之後**，而且刻意不能提前到過濾那一段：時段內的告警要照樣
      // 被 dedup 收下（記成「播過」），時段結束時才不會一口氣補念出來（AC-2 第三點）。
      // 移到門檻那裡的話，那些被吞掉的告警不但沒進 dedup，等它們恢復時還會冒出一句
      // 「已恢復」—— 與「被門檻擋下的告警不得進 dedup」正好相反的理由，同一個坑。
      //
      // 時刻一輪只讀一次（第 4 條不變量的延伸）：同一輪的每一則吃同一個時段判斷，
      // 不會出現「這一批有幾則在時段內、有幾則在時段外」。
      const quiet = isQuietAt(quietRangeFor(round.quietHours ?? ''), minuteOfDayAt(now()));
      const outgoing = quiet ? items.filter((item) => breaksQuiet(item, round, aliases)) : items;
      if (outgoing.length === 0) {
        return { items, evaluated: true, pending: null };
      }
      // **時間順序交付**：最早的那一則先念。呼叫端要「新的在上」請自己複製再反轉，
      // 不要就地 `reverse()` 這個陣列 —— 它同時是表情（`items[0]`）的來源。
      for (const item of outgoing) {
        sink.enqueue(item.plan);
      }
      return { items, evaluated: true, pending: sink.pending() };
    } finally {
      busy = false;
    }
  }

  return {
    evaluate,
    dispose() {
      disposed = true;
      dedup.close();
    },
  };
}
