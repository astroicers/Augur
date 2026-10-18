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
      .addTextInput({
        // #51。刻意不附內建別名表：猜一張表會讓現有使用者升版後行為改變。
        path: 'severityAliases',
        name: '嚴重度別名',
        description:
          '把自家的嚴重度 label 對到標準嚴重度（critical/error/warning/info/unknown），讓門檻與表情判得出來。格式 `別名=標準嚴重度`，用逗號分隔，例如 P1=critical, sev2=warning, disaster=critical。大小寫與前後空白不計（別名中間的空白算字元：sev 1 不會命中 sev1）。逗號、分號與等號的全形寫法照樣認得。留空 = 不做任何對應。格式錯誤的項目會被略過，其餘照常生效。',
        defaultValue: DEFAULT_OPTIONS.severityAliases ?? '',
        settings: { placeholder: 'P1=critical, sev2=warning' },
      })
      .addTextInput({
        // #69。Grafana 會用規則名覆蓋每個 instance 的 alertname，所以「一條總規則查整面
        // 值班牆」時每則告警的名字都一樣、去重後只念第一則（eks-infra#1210 實測）。
        path: 'alertNameLabel',
        name: '告警名稱取自哪個 label',
        description:
          '留空 = 用 alertname（與沒有這個選項時完全相同）。填一個 label 名稱，面板就改用每個 instance 的那個 label 當告警名與去重單位，於是一條總規則底下同時燒的每則告警各自播報，而不是只念第一則。用在「一條 Grafana 規則查整面值班牆（ALERTS{alertstate="firing"}）」的情形：Grafana 會用規則名覆蓋每個 instance 的 alertname，查詢端先用 label_replace(…, "wall_alertname", "$1", "alertname", "(.*)") 把原名保留成 instance label，這裡就填 wall_alertname。label 不存在時退回 alertname（連 alertname 也沒有才用規則名）—— 空字串與只有空白的值也一樣退回，所以同一條規則裡帶與不帶這個 label 的 instance 可以並存。這個 label 的值必須能唯一識別一則告警：值相同的告警會被當成同一則（例如填 instance，同一台機器上的兩則不同告警只會念一則）。改了這一欄要等下一輪 panel 重新整理才生效，屆時正在燒的告警會全部重新播報一次（包括名字其實沒變的）。',
        defaultValue: DEFAULT_OPTIONS.alertNameLabel ?? '',
        settings: { placeholder: 'wall_alertname' },
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
        // #71。刻意**不**加 `showIf: enableTTS`：關掉語音後播報紀錄（ADR-006）照樣
        // 顯示句子，這個開關對那些句子一樣生效，藏起來會讓人以為它只管語音。
        path: 'speakValue',
        name: '念出目前數值',
        description:
          '播報句與播報紀錄要不要帶「目前數值 N」這一段。條件只是 0／1 或查 ALERTS 時，數值沒有意義（查 ALERTS 的總規則值恆為 1，每一則都念「目前數值 1」只會把播報拖長），這時關掉。關掉只少這一段，其餘（名稱、嚴重度、受影響對象、摘要、恢復句）逐字不變。預設開著。',
        defaultValue: DEFAULT_OPTIONS.speakValue ?? true,
      })
      .addBooleanSwitch({
        path: 'enableTTS',
        name: '開啟語音',
        description: '關掉就只更新畫面不發聲。',
        defaultValue: DEFAULT_OPTIONS.enableTTS,
      })
      .addTextInput({
        // #63。**dashboard 層級**的靜音：與標題列那顆每瀏覽器的靜音鈕（ADR-007）是兩回事。
        path: 'quietHours',
        name: '值班靜音時段',
        description:
          '這段時間內畫面照常更新，但不念。格式 `HH:MM-HH:MM`，例如 22:00-07:00（跨午夜）或 12:00-13:00。起點算在內、終點不算（22:00 整開始安靜，07:00 整恢復出聲）。時段結束時不會把時段內的告警補念出來。這是 dashboard 的設定、所有觀看者共用，但判斷用的是**每個觀看者自己瀏覽器的本地時間**，所以跨時區的人各自落在不同的絕對時刻（日光節約轉換當天不保證）。與標題列那顆「我這台瀏覽器」的靜音鈕兩者並存，任一個成立就不念。留空 = 沒有排程靜音。格式錯誤（缺 `-`、時間不合法、起訖相同）視同留空。全形的冒號與減號照樣認得。',
        defaultValue: DEFAULT_OPTIONS.quietHours ?? '',
        settings: { placeholder: '22:00-07:00' },
        showIf: (c) => c.enableTTS,
      })
      .addBooleanSwitch({
        path: 'quietAllowCritical',
        name: '靜音時段內仍念 critical',
        description:
          '開了之後，靜音時段內 critical 的告警照常念（其餘照舊只更新畫面）。嚴重度經「嚴重度別名」對映後判斷，與最低播報嚴重度吃同一份設定。破靜音念過的 critical，恢復時也會念：既然已經把人叫醒，就該讓他聽到結局。反過來說，沒破過靜音念出來的告警（非 critical、或這個開關關著時）恢復時照舊不念 —— 不是所有 critical 的恢復都會念。只認同一段時段內的那一次：昨晚念過、撐到今晚才恢復的不念；標題列那顆靜音鈕按下去的那台瀏覽器因為一句都沒出聲，恢復句也不會念。只對上面這個時段生效：標題列那顆靜音鈕按下去時，critical 也不會念。',
        defaultValue: DEFAULT_OPTIONS.quietAllowCritical ?? false,
        showIf: (c) => c.enableTTS && (c.quietHours ?? '').trim() !== '',
      })
      .addNumberInput({
        // #64。命名注意：`src/avatar/flap.ts` 是嘴型開合，與這裡無關 —— 這一組一律 flapping。
        path: 'flappingThreshold',
        name: '抖動抑制：翻轉次數門檻',
        description:
          '同一則告警在下面那個窗長內 firing 與 resolved 之間翻幾次，就先不念它。例如門檻 4、窗長 10 分鐘：10 分鐘內翻 4 次就先不念，穩定 10 分鐘後恢復，而且恢復時念的是當下的實際狀態（還在燒就念告警、已經好了就念恢復）。達到門檻的那一次仍會念出來，之後的翻轉才不念。抑制期間畫面與清單照常更新。0 或留空 = 關閉，行為與沒有這個選項時完全相同。被最低播報嚴重度擋下的告警不計入翻轉次數。',
        defaultValue: DEFAULT_OPTIONS.flappingThreshold ?? 0,
        settings: { min: 0, max: 100, step: 1, integer: true },
        showIf: (c) => c.enableTTS,
      })
      .addNumberInput({
        path: 'flappingWindowMin',
        name: '抖動抑制：窗長（分鐘）',
        description:
          '翻轉次數在多長的窗內計算，同時也是「穩定多久就解除抑制」的長度。例如 10 = 10 分鐘內翻到門檻次數就先不念，之後維持同一個狀態滿 10 分鐘就解除。0、負數或留空 = 整個抖動抑制視同關閉（窗長 0 會讓「穩定滿窗」立刻成立，等於設了卻沒用）。',
        defaultValue: DEFAULT_OPTIONS.flappingWindowMin ?? 10,
        settings: { min: 1, max: 1440, step: 1, integer: true },
        showIf: (c) => c.enableTTS && (c.flappingThreshold ?? 0) > 0,
      })
      .addTextInput({
        path: 'ttsVoice',
        name: '指定聲線',
        description:
          '留空 = 自動挑（優先 zh-TW 且為本機引擎）。填聲線名稱的一段即可（例如 Zhiwei、Hanhan），面板上會顯示實際用到的聲線。',
        defaultValue: DEFAULT_OPTIONS.ttsVoice,
        settings: { placeholder: 'Zhiwei' },
        showIf: (c) => c.enableTTS,
      })
      .addSliderInput({
        path: 'ttsPitch',
        name: '音高',
        description: '1 = 聲線原本的音高。要像小男孩：選男聲、拉到 1.4–1.7。部分瀏覽器（例如 Edge）可能不支援調音高。',
        defaultValue: DEFAULT_OPTIONS.ttsPitch,
        settings: { min: 0, max: 2, step: 0.1 },
        showIf: (c) => c.enableTTS,
      })
      .addSliderInput({
        path: 'ttsRate',
        name: '語速',
        description: '1 = 原速。',
        defaultValue: DEFAULT_OPTIONS.ttsRate,
        settings: { min: 0.5, max: 2, step: 0.1 },
        showIf: (c) => c.enableTTS,
      })
      .addTextInput({
        // ADR-005。不加金鑰欄位：panel 選項存在 dashboard JSON（決策 4）。
        path: 'ttsEndpoint',
        name: '外部語音服務網址',
        description:
          '選填。填 OpenAI 相容的語音服務（例如 tools/tts-server 的年輕男聲），留空 = 用瀏覽器內建聲線。某一則失敗或逾時就改用內建聲線念，面板上的聲線標籤會寫明。填了之後「指定聲線」與「音高」只用在降級時；「語速」會送給服務，但 tools/tts-server 不支援（語速由它的參考音決定）。',
        defaultValue: DEFAULT_OPTIONS.ttsEndpoint,
        settings: { placeholder: 'http://localhost:8765' },
        showIf: (c) => c.enableTTS,
      })
      .addSliderInput({
        path: 'ttsTimeoutSec',
        name: '外部語音逾時（秒）',
        description:
          '從輪到某一句時起算，最多等它的音訊幾秒（先前預取時在服務端排的隊不算）。超過就從這一句起改用內建聲線念完這一則。',
        defaultValue: DEFAULT_OPTIONS.ttsTimeoutSec,
        settings: { min: 3, max: 60, step: 1 },
        showIf: (c) => c.enableTTS && (c.ttsEndpoint ?? '').trim() !== '',
      })
      .addTextInput({
        // SP-8.4：兩個 sprite URL。預設空字串 = 內建素材（不得寫死路徑，見 panelOptions.ts）。
        // 填了外部 URL，panel 會標「自訂圖，對齊未驗證」—— 機械驗收只涵蓋內建的兩張（SP-7.16）。
        // ⚠️ 不要在這裡加 mascotSize：stage 尺寸由 SP-1.8 依 panel 大小自動計算。
        path: 'directionsImgUrl',
        name: '視線精靈圖 URL',
        description: '3×3 directions sheet（正方形、邊長可被 3 整除）。留空 = 內建素材。自訂圖的對齊不經驗證。',
        defaultValue: DEFAULT_OPTIONS.directionsImgUrl,
        settings: { placeholder: '留空使用內建素材' },
      })
      .addTextInput({
        path: 'reactionsImgUrl',
        name: '表情精靈圖 URL',
        description: '3×3 reactions sheet，尺寸必須與視線精靈圖相同。留空 = 內建素材。',
        defaultValue: DEFAULT_OPTIONS.reactionsImgUrl,
        settings: { placeholder: '留空使用內建素材' },
      });
  });
