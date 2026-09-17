import { PanelPlugin } from '@grafana/data';
import { MascotPanelOptions, DEFAULT_OPTIONS } from './panelOptions';
import { isKnownSeverity } from './core/severity';
import { MascotPanel } from './components/MascotPanel';

export const plugin = new PanelPlugin<MascotPanelOptions>(MascotPanel)
  // 開啟 standard field config —— ADR-004 決策 2 要求 threshold 走
  // fieldConfig.defaults.thresholds 而非自訂 option，這行是前提。
  .useFieldConfig()
  // ⚠️ 沒有這一行，props.data.alertState 恆為 undefined。
  // 這是 alertState 能到達 panel 的四個硬前提之一（其餘三個在 dashboard 側：
  // panel 需至少一個 query target、alert rule 需帶 __dashboardUid__/__panelId__
  // 註解、dashboard 時間範圍結尾需為 now）。2026-09-17 實測確認。
  .setDataSupport({ alertStates: true, annotations: false })
  .setPanelOptions((builder) => {
    return builder
      .addSelect({
        path: 'minSeverity',
        name: '最低播報嚴重度',
        description: '只播 >= 此嚴重度的告警。空白 = 全播。',
        defaultValue: DEFAULT_OPTIONS.minSeverity,
        settings: {
          options: [
            { value: '', label: '全播（不過濾）' },
            { value: 'info', label: 'info 以上' },
            { value: 'warning', label: 'warning 以上' },
            { value: 'error', label: 'error 以上' },
            { value: 'critical', label: '只播 critical' },
          ],
        },
      })
      .addNumberInput({
        path: 'repeatFiringMin',
        name: '重播間隔（分鐘）',
        description: '同一則告警持續燒時每隔幾分鐘提醒一次。0 = 只念一次。',
        defaultValue: DEFAULT_OPTIONS.repeatFiringMin,
        settings: { min: 0, max: 1440, step: 1, integer: true },
      })
      .addSelect({
        path: 'fallbackSeverity',
        name: '取不到細節時的嚴重度',
        description: 'Alerting rules 端點無官方穩定性保證，取不到時用這個值播泛用句。',
        defaultValue: DEFAULT_OPTIONS.fallbackSeverity,
        settings: {
          options: ['critical', 'error', 'warning', 'info']
            .filter(isKnownSeverity)
            .map((v) => ({ value: v, label: v })),
        },
      })
      .addRadio({
        path: 'alertLang',
        name: '播報語言',
        defaultValue: DEFAULT_OPTIONS.alertLang,
        settings: {
          options: [
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
          ],
        },
      })
      .addBooleanSwitch({
        path: 'enableTTS',
        name: '開啟語音',
        description: '關掉就只更新畫面不發聲。',
        defaultValue: DEFAULT_OPTIONS.enableTTS,
      })
      .addTextInput({
        path: 'ttsVoice',
        name: '指定聲線',
        description: '留空 = 自動挑（優先 zh-TW 且為本機引擎）。填 voice 的完整名稱。',
        defaultValue: DEFAULT_OPTIONS.ttsVoice,
        settings: { placeholder: 'Microsoft Hanhan - Chinese (Traditional, Taiwan)' },
        showIf: (c) => c.enableTTS,
      });
  });
