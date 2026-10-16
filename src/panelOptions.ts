import type { AlertLang } from './core/types';

/**
 * Panel 設定。欄位清單承自舊架構 `src/config.ts` 的環境變數
 * （alertLang / minSeverity / dedupWindowSec / ttsVoice）—— 同樣的旋鈕，
 * 從「部署時的 env」變成「每個 panel 各自可調的 option」。
 *
 * threshold **不在這裡** —— ADR-004 決策 2 要求走 standard field config
 * (`fieldConfig.defaults.thresholds`)，自訂 option 會失去 overrides、
 * 原生編輯 UI 與 getColorForValue。
 */
export interface MascotPanelOptions {
  /** 只播 >= 此嚴重度；空字串 = 不過濾。值域為 severity.ts 的 RANK key。 */
  minSeverity: string;
  /**
   * 嚴重度別名（#51）：`P1=critical, sev2=warning, disaster=critical`。
   * 空字串 = 沒有任何別名，行為與沒有這個選項時完全相同（不附內建別名表，
   * 猜一張表會讓現有使用者升版後行為改變）。解析見 `core/severityAliases.ts`。
   *
   * **選填（`?`）而非必填**，與其他欄位的慣例不同，理由是這一欄是後來加的：
   * 舊 dashboard 存下來的 panel JSON 沒有這個鍵。宣告成必填會讓既有的
   * `MascotPanelOptions` 字面值（含測試 fixture）全部得補一行，而 AC-1 要的正是
   * 「既有測試不改」。讀的那一側一律 `?? ''`，與 `ttsEndpoint` 的防禦同一招。
   */
  severityAliases?: string;
  /**
   * 用哪個 instance label 當**告警名與去重單位**（#69）：`wall_alertname`。
   * 空字串 = 用 `alertname`，行為與沒有這個選項時完全相同。
   *
   * 為什麼需要它：Grafana 會用**規則名覆蓋**每個 instance 的 `alertname`，所以
   * 「一條總規則查整面值班牆（`ALERTS{alertstate="firing"}`）」時每則告警的名字都一樣，
   * 而去重 key 是 `alert:${名字}` —— 一條規則底下不管燒幾則**只念第一則**
   * （eks-infra#1210 實測）。查詢端用
   * `label_replace(…, "wall_alertname", "$1", "alertname", "(.*)")` 把原名保留成
   * instance label 之後，這一欄填上那個 label 名就能逐則播報。
   *
   * 指定的 label 在某個 instance 上不存在、是空字串或只有空白時，**那一個 instance**
   * 退回 `labels.alertname ?? 規則名`；同一條規則裡帶與不帶的可以並存。
   * 解析（其實只有取值與修剪空白）在 `sources/panelAlerts.ts` 的 `alertNameOf`。
   *
   * **選填（`?`）而非必填**，理由同 `severityAliases`：舊 dashboard 存下來的 panel JSON
   * 沒有這個鍵，宣告成必填會讓既有的 `MascotPanelOptions` 字面值（含測試 fixture）
   * 全部得補一行，而 #69 AC-1 要的正是「既有測試不改」。讀的那一側一律 `?? ''`。
   */
  alertNameLabel?: string;
  /**
   * 同一則告警持續燒時，每隔幾分鐘重播一次。0 = 永不重播。
   * 這把 ADR-004 決策 4 宣告「放棄」的 Grafana repeat_interval 補了回來。
   */
  repeatFiringMin: number;
  /** rules 端點取不到細節時的嚴重度（該端點無官方穩定性保證，失敗是預期內的）。 */
  fallbackSeverity: string;
  /** 播報語言。 */
  alertLang: AlertLang;
  /** 關掉就只更新畫面不發聲。 */
  enableTTS: boolean;
  /**
   * 值班靜音時段（#63）：`22:00-07:00`。空字串 = 沒有排程靜音，行為與沒有這個選項時
   * 完全相同。**起點含、終點不含**；跨午夜（`22:00-07:00`）與不跨午夜（`12:00-13:00`）
   * 都支援。時段內照樣更新清單與表情，只是不念 —— 時段結束時也不會補念。
   *
   * 這是 **dashboard 層級**的設定（存在 dashboard JSON，所有觀看者共用），
   * 與 ADR-007 那顆「我這台瀏覽器」的靜音鈕是兩回事；兩者同時存在時
   * **任一個成立就不念**。判斷用的是**每個觀看者自己瀏覽器的本地時間**，
   * 所以跨時區的觀看者會各自落在不同的絕對時刻（日光節約轉換當天不保證）。
   *
   * 格式錯誤（缺 `-`、時間不合法、起訖相同）一律**視同沒設定**、不拋例外，
   * 原因由 `director/BroadcastDirector.ts` 的 `describeQuietHours` 回報。
   *
   * **選填（`?`）而非必填**，理由同 `severityAliases`：舊 dashboard 存下來的 panel JSON
   * 沒有這個鍵，宣告成必填會讓既有的 `MascotPanelOptions` 字面值（含測試 fixture）
   * 全部得補一行，而 #63 AC-1 要的正是「既有測試不改」。讀的那一側一律 `?? ''`。
   */
  quietHours?: string;
  /**
   * 排程靜音時段內，`critical` 的 firing 照常念（#63）。預設 `false`。
   * 嚴重度判斷經 `severityAliases`（#51），與門檻吃同一份解析結果。
   *
   * **只在排程靜音時段內生效，不覆蓋 ADR-007 的每瀏覽器靜音**：觀看者自己按了靜音，
   * critical 也不該念。`resolved` 不破靜音（半夜只有需要有人處理的事才出聲）。
   */
  quietAllowCritical?: boolean;
  /**
   * 抖動抑制（#64）：同一則告警在窗內 firing↔resolved 翻轉幾次就先不念。
   * `0` 或留空 = **關閉**，行為與沒有這個選項時完全相同。
   *
   * 例：門檻 4、窗長 10 —— 10 分鐘內翻 4 次就先不念，穩定 10 分鐘後恢復，
   * 而且恢復時念的是**當下的實際狀態**（還在燒就念 firing、已經好了就念 resolved）。
   *
   * 判斷在 `director/BroadcastDirector.ts`（`parseFlapping`／`createFlappingTracker`，
   * 以注入的時鐘），不在元件裡。抑制中的項目照樣進清單並帶 `suppressed: 'flapping'`。
   *
   * **選填（`?`）而非必填**，理由同 `quietHours`：舊 dashboard 存下來的 panel JSON
   * 沒有這個鍵，宣告成必填會讓既有的字面值（含測試 fixture）全部得補一行，
   * 而 #64 AC-1 要的正是「既有測試不改」。
   */
  flappingThreshold?: number;
  /**
   * 抖動抑制的窗長（分鐘），預設 10：翻轉次數在這個長度的窗內計算，
   * 也是「穩定多久就解除抑制」的長度。
   *
   * 不是大於 0 的數字（`0`、負數、留空）→ **整個抖動抑制視同關閉**。窗長 0 會讓
   * 「穩定滿窗」在定義上立即成立（抑制進得去、下一輪就解除），那不是任何人想要的設定，
   * 所以不猜 —— 與 `quietHours` 的「格式錯誤視同沒設定」同一條規則。
   */
  flappingWindowMin?: number;
  /** 指名聲線；空字串 = 自動挑（優先 zh-TW 且為本機引擎）。 */
  ttsVoice: string;
  /** 音高 0–2，1 = 聲線原本的音高。拉高讓大人的聲線聽起來像小孩。 */
  ttsPitch: number;
  /** 語速 0.5–2，1 = 原速。 */
  ttsRate: number;
  /**
   * 外部語音服務（OpenAI 相容 `/v1/audio/speech`）的位址；空字串 = 只用 Web Speech（ADR-005）。
   * ⚠️ 不收金鑰：panel 選項存在 dashboard JSON，看得到 dashboard 就看得到它（ADR-005 決策 4）。
   */
  ttsEndpoint: string;
  /** 外部語音逾時秒數：輪到某一句時起算，超過就從那一句起改用 Web Speech 念完該則。 */
  ttsTimeoutSec: number;
  /**
   * directions 精靈圖（視線 9 格）的 URL；空字串 = plugin 內建素材（SP-8.4）。
   * 接受任意 URL —— Grafana 的 CSP 預設關閉、開了 `img-src` 也是 `* data:`（規格 §10〈已有答案〉第 12 條）。
   * ⚠️ 預設值**必須**是空字串而不是路徑：production 建置的檔名是 webpack 的 `[hash][ext]`，
   * 由 `SpriteController` 在空字串時改用 `spriteAssets.ts` 的 import 值。
   */
  directionsImgUrl: string;
  /** reactions 精靈圖（表情 / 嘴 / 眨眼 9 格）的 URL；空字串 = 內建素材。同上。 */
  reactionsImgUrl: string;
}

export const DEFAULT_OPTIONS: MascotPanelOptions = {
  minSeverity: '',
  severityAliases: '',
  alertNameLabel: '',
  repeatFiringMin: 0,
  fallbackSeverity: 'critical',
  alertLang: 'zh',
  enableTTS: true,
  quietHours: '',
  quietAllowCritical: false,
  flappingThreshold: 0,
  flappingWindowMin: 10,
  ttsVoice: '',
  ttsPitch: 1,
  ttsRate: 1,
  ttsEndpoint: '',
  ttsTimeoutSec: 30,
  directionsImgUrl: '',
  reactionsImgUrl: '',
};
