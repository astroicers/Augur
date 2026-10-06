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
  repeatFiringMin: 0,
  fallbackSeverity: 'critical',
  alertLang: 'zh',
  enableTTS: true,
  ttsVoice: '',
  ttsPitch: 1,
  ttsRate: 1,
  ttsEndpoint: '',
  ttsTimeoutSec: 30,
  directionsImgUrl: '',
  reactionsImgUrl: '',
};
