import { PanelPlugin } from '@grafana/data';
import { MascotPanelOptions } from './panelOptions';
import { SimplePanel } from './components/SimplePanel';

export const plugin = new PanelPlugin<MascotPanelOptions>(SimplePanel)
  // 開啟 standard field config —— ADR-004 決策 2 要求 threshold 走
  // fieldConfig.defaults.thresholds 而非自訂 option，這行是前提。
  .useFieldConfig()
  // ⚠️ 沒有這一行，props.data.alertState 恆為 undefined。
  // 這是 alertState 能到達 panel 的四個硬前提之一（其餘三個在 dashboard 側：
  // panel 需至少一個 query target、alert rule 需帶 __dashboardUid__/__panelId__
  // 註解、dashboard 時間範圍結尾需為 now）。
  .setDataSupport({ alertStates: true, annotations: false })
  .setPanelOptions((builder) => {
    return builder
      .addTextInput({
        path: 'text',
        name: 'Simple text option',
        description: 'Description of panel option',
        defaultValue: 'Default value of text input option',
      })
      .addBooleanSwitch({
        path: 'showSeriesCount',
        name: 'Show series counter',
        defaultValue: false,
      })
      .addRadio({
        path: 'seriesCountSize',
        defaultValue: 'sm',
        name: 'Series counter size',
        settings: {
          options: [
            { value: 'sm', label: 'Small' },
            { value: 'md', label: 'Medium' },
            { value: 'lg', label: 'Large' },
          ],
        },
        showIf: (config) => config.showSeriesCount,
      });
  });
