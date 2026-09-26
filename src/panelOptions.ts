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
}

export const DEFAULT_OPTIONS: MascotPanelOptions = {
  minSeverity: '',
  repeatFiringMin: 0,
  fallbackSeverity: 'critical',
  alertLang: 'zh',
  enableTTS: true,
  ttsVoice: '',
};
