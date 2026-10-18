# Augur — 架構總覽

> **Augur ＝ 一個 Grafana panel plugin，讓吉祥物住在 dashboard 裡把告警念出來。**
> 本檔是**導覽**；每個決策的「為什麼」以 `docs/adr/` 為權威。**維護規則見文末。**
> 最後更新：2026-10-18（#81：清單列標出「這句為什麼沒念」——導播算好的 `suppressed`
> （#63 的靜音時段／#64 的抖動抑制）原樣轉手到 `FeedRow`，那一列多一個 `data-suppressed`
> 屬性與一個標記；別名設定寫錯的項目在**編輯模式**下顯示一行提示（`describeSkippedAliases`
> 自此有了 UI 消費端）。兩者的文字由新的純函式 `src/feed/feedNotices.ts` 決定、跟著
> `alertLang`；`SuppressReason` 的定義一併移到 `src/core/types.ts`，導播照舊 re-export）。
> 同日（#80：播報紀錄匯出 CSV——新增純函式 `src/feed/feedCsv.ts`
> （RFC 4180 跳脫、以單引號前綴防公式注入、UTC 的 ISO 8601 時間欄、檔名安全化），
> 下載動作（Blob + `a[download]`）留在 `MascotPanel.tsx` 且與它分開；匯出的是
> `buildFeedRows` 的同一份輸出，所以「匯出的就是畫面上那幾列」）。
> 同日（#84：`quietAllowCritical` 開著時，在時段內破靜音**念出來**的
> critical，它的恢復句在同一段時段內也念——導播記下「真的交付過」的 fingerprint，
> 離開時段／關掉功能／`onSupersede`／`dispose()` 都會清）。
> 同日（#79：feed 列的合併、篩選與空清單判斷抽成純函式
> `src/feed/feedRows.ts`——`MascotPanel` 只把結果映射成 JSX，對外行為不變）。
> 前一次是 2026-10-16（#70：播報紀錄的名字也跟著 `alertNameLabel`——紀錄端與播報端
> 同一個選項、同一個時機讀，所以同一則告警在兩邊同名）。
> 前一次是 2026-10-15（#69：新增 `alertNameLabel`——以指定的 instance label 當告警名與
> 去重單位，一條總規則底下的每則告警各自播報；#64：新增 `flappingThreshold`／`flappingWindowMin`
> 兩個選項——抖動抑制，判斷在導播的交付閘門上、排在值班靜音時段之前；#71：新增 `speakValue`
> ——關掉就不念「目前數值」子句，播報與播報紀錄共用 `buildBroadcastPlan` 的同一個開關）。
> 前一次是 2026-10-15（#63：新增 `quietHours`／`quietAllowCritical` 兩個選項——
> dashboard 層級的值班靜音時段，判斷在導播的交付閘門上）。

## 一句話

panel 讀自己的 `props.data` → 判斷有沒有在燒 → 打 Alerting rules 端點補細節 →
severity 過濾 → dedup 防洪 → 產 `BroadcastPlan` → 念出來（預設瀏覽器 Web Speech，
可選填外部語音服務）+ avatar 換表情、動嘴；旁邊的 feed 讀 Grafana 自己存的告警狀態歷史
當**播報紀錄**（唯讀、只顯示不播）。**零後端、零常駐服務。**

> 現行素材 `features.gaze = false`（SP-0.10），所以視線追蹤的計算仍在、畫面上看不出來；
> 降級用的 `DiagnosticAvatar` 仍會顯示視線格。

## 資料流

```
Grafana（panel plugin 與 dashboard 同一個 document，不是 iframe）
  │
  ├─ props.data.alertState ──────┐  觸發訊號：只有 {state,id,panelId,dashboardUID} 四欄
  │  （alerting / pending / ok）  │  ⚠️ 黏著，永不回 undefined
  │                              ▼
  │                      src/sources/panelAlerts.ts
  │                        ├ alerting → 打 rules 端點補細節，建立／沿用 episode
  │                        │            （告警名＝`alertname`，或 `alertNameLabel`
  │                        │              指定的 instance label；名字就是去重單位，#69）
  │                        ├ pending  → 不產生事件（見 ADR-004 決策 2）
  │                        └ ok       → 由記住的 episode 複製出 resolved
  │                              │
  └─ /api/prometheus/grafana/api/v1/rules?dashboard_uid&panel_id
       （src/sources/rulesFetcher.ts；內容來源，與 ParsedAlert 一對一）
                                 │
                                 ▼  ParsedAlert[]
                 src/director/BroadcastDirector.ts（導播；不依賴 React）
                        ├ core/severityAliases.ts  resolveSeverity 前置正規化（別名 → 標準嚴重度）
                        ├ core/severity.ts   meetsMin 過濾（resolved 不受門檻影響）
                        ├ core/dedup.ts      shouldSpeak 防洪 + resolved 綁狀態
                        └ core/format.ts     buildBroadcastPlan → {text, emotion, …}
                        交付閘門（依序）：抖動抑制（#64，窗內翻太多次就先不念，穩定滿窗後
                          解除並補念當下狀態）→ 值班靜音時段（#63，dashboard 層級，瀏覽器
                          本地時間；quietAllowCritical 放 critical 的 firing 過，#84 起
                          連同「破靜音念出來過」的那幾則的恢復句）
                          → 每瀏覽器靜音（ADR-007，整輪的開關）
                          任一個成立就不交給播報器 —— items 照回（前兩道會留 suppressed
                          標記：'flapping'／'quiet'），清單與表情照常更新
                                 │  BroadcastItem[]（時間順序）
                      src/components/MascotPanel.tsx（接線＋呈現）
                        每輪 panel data 餵一次 evaluate(input, settings)
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
   src/speech/speaker.ts                  src/avatar/AvatarController
     佇列、逐則播、不疊音                    setEmotion / setSpeaking
     onboundary → 嘴型同步點                setGaze / setMouthOpen?
     watchdog（先 cancel 再 finish）         預設：SpriteController（四層疊合）
              │                             stage < 128px 或圖壞掉：DiagnosticAvatar
              │ ttsEndpoint 非空時改走                 ▲
              ▼ 這一支（ADR-005）         src/dom/dashboardPanels.ts
   src/speech/remoteSpeaker.ts             跨 panel 能力偵測 + 漸進降級
     POST {endpoint}/v1/audio/speech       （看得到別的 panel → 追全頁滑鼠；
     （OpenAI 相容），逐句取音訊              看不到 → 只管自己的容器）
     → Web Audio 播；音量包絡 ─▶ setMouthOpen（幀級，繞過 flap）
     那一則失敗／逾時 → 退回 speaker.ts 念完該則

   speaker.ts 的 onboundary ─▶ src/avatar/flap.ts ─▶ setMouthOpen
     一次 boundary 換 N 次張合（ADR-004 決策 4 的「擺動次數」，不是振幅）；
     引擎不吐 boundary 時退回 flap.idle() 的定速擺動

播報紀錄（ADR-006；唯讀，與上面的語音佇列完全分離）
  /api/annotations?dashboardUID&panelId      狀態歷史（Grafana 自己在存的）
  + /api/prometheus/grafana/api/v1/rules     嚴重度與摘要樣板
  + /api/ruler/grafana/api/v1/rules          條件欄（rules 端點沒有這個欄位）
       （src/sources/historyFetcher.ts 抓 → src/sources/history.ts 轉）
                                 │
                                 ▼  HistoryEntry[]（顯示上限 200，取 500 筆原始紀錄）
                      MascotPanel 的 feed —— 組句走同一支 buildBroadcastPlan，
                      所以紀錄句與播報句逐字相同；**永不進語音佇列**（決策 5）
                      名字跟著 `alertNameLabel`（#70），與播報端同一個選項
                      ▼ 要顯示哪幾列（與本分頁念過的句子合併、篩選、空清單提示）
                      src/feed/feedRows.ts（純函式，#79）→ 元件只映射成 JSX
                      ▼ 那一列上寫什麼（標記與提示的文字，跟著 alertLang）
                      src/feed/feedNotices.ts（純函式，#81）
                        suppressed（導播算好的）→ 標記＋data-suppressed="flapping|quiet"
                        describeSkippedAliases（#51）→ 編輯模式才顯示的那一行
                      ▼ 同一份 rows 再走一條（按下「匯出 CSV」才發生，#80）
                      src/feed/feedCsv.ts（純函式：跳脫、防公式注入、檔名）
                      → MascotPanel 的 Blob + a[download]（零網路請求，檔案在分頁裡生出來）
```

## 檔案

| 路徑 | 職責 |
|---|---|
| `src/module.ts` | `PanelPlugin` 註冊。**缺 `.setDataSupport({alertStates:true})` 的話 `alertState` 恆為空** |
| `src/panelOptions.ts` | panel 設定。承自舊架構 `config.ts` 的環境變數清單 |
| `src/director/BroadcastDirector.ts` | **導播**（#58）。取告警結果 → 別名前置正規化 → 嚴重度門檻 → 去重防洪 → `BroadcastPlan` → 決定交給 speaker 的內容，整條管線在這一支。**不依賴 React**（不 import `react`、不碰 DOM，時鐘與來源層注入），所以它的單元測試不 render 任何東西。先前靠 effect 宣告順序維持的三條不變量改由明確的呼叫順序與狀態保證（檔頭逐條列出）。**交付閘門**（逐則：#64 的抖動抑制 → #63 的值班靜音時段；整輪：每瀏覽器靜音，排在交付之前）也在這一支，連同兩組純函式：時段解析（`parseQuietHours`／`isQuietAt`／`minuteOfDayAt`／`describeQuietHours`／`createQuietBreakLog`）與抖動（`parseFlapping`／`describeFlapping`／`createFlappingTracker`） |
| `src/components/MascotPanel.tsx` | 接線 + 呈現。panel props → 導播，導播結果 → feed／表情／播報器；另含 avatar、靜音（ADR-007）、跨 panel 互動與播報紀錄的 UI。導播本體自 #58 起不在這裡，feed 的合併／篩選／空清單判斷自 #79 起也不在這裡（`src/feed/feedRows.ts`，元件只映射成 JSX）。#81 的兩處畫面行為同樣只是接線：清單列的 `data-suppressed` 與標記、編輯模式（`isPanelEditor(data.request?.app)`）才渲染的那一行別名提示——文字全在 `src/feed/feedNotices.ts`。#80 的匯出在這裡只有兩支模組層函式：`exportFeedRowsAsCsv`（讀「現在」當檔名的時間戳）與 `downloadTextFile`（Blob + `a[download]`，全專案唯一一處下載動作）——CSV 的格式與檔名規則在 `src/feed/feedCsv.ts` |
| `src/sources/panelAlerts.ts` | 來源層。**唯一產生 `ParsedAlert` 的地方** |
| `src/sources/rulesFetcher.ts` | Alerting rules 端點的正式實作。獨立成一支，好讓來源層能用假 fetcher 做單元測試 |
| `src/sources/history.ts` | 播報紀錄的純邏輯（ADR-006）：annotation 文字解析、規則樣板填值、條件欄挑選、取名（`historyAlertNameOf`，跟著 `alertNameLabel`，#70）、`HistoryEntry[]` 組裝。組句一律走 `buildBroadcastPlan`，**不另寫一套措辭** |
| `src/sources/historyFetcher.ts` | 紀錄的資料來源（annotations + rules + ruler 三個端點）。獨立成一支的理由同 `rulesFetcher.ts`：讓 `history.ts` 能在 jest 裡不拖進 `@grafana/runtime` 地測 |
| `src/feed/feedRows.ts` | feed 要顯示哪幾列（#79）：本分頁念過的句子與播報紀錄的合併（同文字**而且**時間在 `SESSION_MATCH_WINDOW_MS` 內才算同一件事）、篩選（大小寫不敏感，同時比對句子與 label 值）、三種空清單提示。**純函式**：不 import React、不碰 DOM；合併與篩選只比兩個既有時間戳、不讀「現在」，唯一讀時鐘的 `formatHistoryWhen`（分辨今天）可從參數注入。`FeedLine`／`FeedRow` 另帶 `suppressed`（#81，導播算好的原樣轉手；**只有本分頁的列可能有值** —— 紀錄列來自 Grafana 的狀態歷史，那份資料不知道這個分頁念了沒有） |
| `src/feed/feedNotices.ts` | 清單列上的標記與編輯模式那一行提示的**文字**（#81）：`suppressedMark`（`'flapping'`／`'quiet'` × `zh`／`en` 的 label 與 title）、`skippedAliasNotice`（轉手 `core/severityAliases.ts` 的 `describeSkippedAliases`，沒有被略過的項目回 `null`）、`isPanelEditor`／`PANEL_EDITOR_APP`（`data.request?.app === CoreApp.PanelEditor`；**`data.request` 會缺**，缺席時回 `false` ＝ 退化成觀看模式）。**純函式**：只 import `core/types` 與 `core/severityAliases`，不 import React、不 import `@grafana/data`（那個字串由測試對著 `CoreApp.PanelEditor` 比對）、不碰 DOM、不讀時鐘 |
| `src/feed/feedCsv.ts` | 播報紀錄匯出 CSV（#80）：`feedRowsToCsv`（BOM＋標題列＋每列「UTC 的 ISO 8601 時間／來源／句子」）、`csvCell`（RFC 4180 的引號與雙引號加倍，**另**對 `=`／`+`／`-`／`@`、定位字元、CR 開頭的儲存格加單引號前綴防公式注入）、`feedCsvFilename`（`augur-broadcast-<uid>-panel<id>-<UTC 戳記>.csv`，只留 `A-Za-z0-9_-`，uid 或時間戳取不到就省略那一段）。**純函式**：只 `import type` 一個 `FeedRow`，不 import React、不碰 DOM、不讀時鐘（時間一律從參數進來）。下載動作刻意不在這裡 |
| `src/core/severityAliases.ts` | 嚴重度別名的解析與前置正規化（#51）。純函式、只 import `severity.ts`；格式錯誤的項目略過不拋，`describeSkippedAliases` 回報（#81 起**面板真的在用它**：編輯模式下的那一行提示，並多一個 `lang` 參數，預設 `'zh'` ＝ #81 之前的輸出逐字相同） |
| `src/core/` | 來源中立的核心。**從舊 push 架構整包繼承**，`ParsedAlert` 這條邊界未動；之後內部改過，例：為真實 bug 加過 `dedup.forget()`／`setWindow()`、`severity` 的缺值收斂、`format.ts` 的髒值處理與別名參數（#39、#46、#51）；#51 另新增 `severityAliases.ts`（上一列）。行數會變，別寫死 |
| `src/speech/speaker.ts` | Web Speech 封裝。常數全部來自實測 |
| `src/speech/remoteSpeaker.ts` | 外部語音服務的播報器（ADR-005）。同一個 `Speaker` 介面；逐句取音訊、Web Audio 播放（CSP 的 `media-src 'none'` 會擋 `<audio>`）、音量包絡驅動嘴型；任何一則失敗或逾時就把**那一則**交回 Web Speech |
| `src/avatar/AvatarController.ts` | avatar-agnostic 契約（繼承 ADR-002 §2） |
| `src/avatar/gaze.ts` | 視線格計算。兩層防抖：dead zone + 角度遲滯 |
| `src/avatar/flap.ts` | 嘴型擺動驅動：一次 `onboundary` 換 N 次張合。**是擺動次數不是振幅**（ADR-004 決策 4），上限 5 來自 boundary 平均間隔的實測 |
| `src/avatar/DiagnosticAvatar.ts` | 契約的第一個實作。**刻意不是吉祥物**，把四個輸入畫成儀表。現在是退路：stage < 128px 或 sprite 載入失敗時掛它 |
| `src/avatar/spriteSheet.ts` | 18 格精靈圖的純計算層（格號、expr 優先序、嘴型幀、眨眼排程、尺寸）。零圖片 import、零 DOM |
| `src/avatar/SpriteController.ts` | 契約的第二個實作（SP-8）。四層 div 疊合、眨眼與定速嘴型的時序、載入與四條降級 |
| `src/avatar/spriteAssets.ts` | 只有兩行 png import，取內建 sheet 的 URL（SP-8.3）。**測試不得 import** |
| `src/dom/dashboardPanels.ts` | 跨 panel DOM 能力偵測。本專案**唯一** unsupported 的部分 |
| `monitoring/` | docker-compose 開發環境 + alert rules + provisioned dashboard |
| `tools/` | `asp-test.sh`（11 道本地檢查電池）與它呼叫的守門腳本、`sprite-gen/`（素材產製）、`tts-server/`（ADR-005 的外部語音參考實作，不進 plugin）。逐項說明見 `README.md`〈這個 repo 的其他目錄〉 |

## 關鍵設計

**唯一的抽象邊界是 `ParsedAlert`**（`src/core/types.ts`）。來源層把任何來源轉成它，
`core/` 只認得它。這條線在 push → pull 的方向反轉中**完好無損** ——
`src/core/` 整包繼承、介面一行沒改就承接了新架構。
（`SuppressReason` 自 #81 起也住在這裡：清單列要標出「這句為什麼沒念」，於是 `feed/` 與導播
兩邊都得認得它，而放進這條邊界旁邊，兩邊就都只讀 `core/types`。導播照舊 re-export 它。）
（**內部改過**：之後為兩次真實的永久靜音缺陷加了 `dedup.forget()`（commit
「fix(sources): 泛用 episode 被取代後，降級路徑會永久靜音」）與 `setWindow()`（commit
「fix(panel): 會讓面板永久靜音的三條路徑，以及 speaker.ts 的第一份測試」），
`severity` 也補了缺值收斂，`format.ts` 改過髒值處理與別名參數（#39、#46、#51）等。改的是內部行為，`ParsedAlert` 這條邊界沒動。）

**來源層的三個不變量**（`panelAlerts.ts` 檔頭有完整說明）：episode 用複製而非重算、
`startsAt` 釘死、每次評估都無條件 emit 而把抑制交給 dedup。
第三條讓 `dedup.ts` 既有的「同一則只念一次」語意直接沿用就是對的。

**導播不依賴 React**（#58）。它的四條不變量（設定隨呼叫帶進來、source 與 dedup 同生同死、
換去重視窗一律 `setWindow` 不重建、一輪評估是原子的）先前靠 `MascotPanel.tsx` 裡
**effect 的宣告順序**維持，而三條破掉的症狀都一樣：**永久靜音**（告警在燒而面板一聲不吭，
不留任何錯誤）。收成深模組之後，那些條件由呼叫順序與狀態保證 —— 新增 effect 或調換位置
都不可能破掉它們，後續功能（靜音／值班時段、抖動抑制）也接在這一支上而不是再加一個 effect。

**avatar 可換**：上層只依賴 `AvatarController` 介面。換實作不動導播、不動語音、不動 DOM 層。

**漸進降級**（ADR-004 決策 6）：跨 panel 互動是 unsupported 的，
所以降級的全部實作就是「監聽 `document` 還是只監聽自己的容器」一行分支 ——
其餘邏輯完全相同。壞掉時是少一個功能，不是整個 plugin 炸掉。

## 設定

Panel options 共 **19 個**。權威是 `src/module.ts` 的 `setPanelOptions`（型別與預設值在
`src/panelOptions.ts`）—— 這裡只是導覽，加減選項時兩邊一起改。這個數字與下表的每一列
由 `src/__tests__/module-options.test.ts` 對著註冊面機械比對（#69），漏改會紅：

| option | 預設 | 作用 |
|---|---|---|
| `minSeverity` | `''`（全播） | 只播 >= 此嚴重度；resolved 不受門檻影響 |
| `severityAliases` | `''`（無別名） | 把自家的 label 接到標準嚴重度：`P1=critical, sev2=warning`。**不附內建別名表**，留空即與沒有這個選項時完全相同 |
| `alertNameLabel` | `''`（用 `alertname`） | 改用哪個 **instance label** 當告警名與去重單位：`wall_alertname`（#69）。一條總規則底下同時燒的每則告警於是各自播報，**播報紀錄的名字也跟著它**（#70）。label 不存在、空字串或只有空白時，**那一個 instance**（紀錄則是**那一筆**）退回 `alertname`（再沒有才用規則名）。留空即與沒有這個選項時完全相同。**這個 label 的值必須能唯一識別一則告警**：值相同的告警會被併成一則（去重單位就是名字）。改這一欄時，**只有名字真的改變的**那幾則以新名字重新播報一次（舊名字算被取代，不念恢復句）；名字沒變的（例如沒帶那個 label、退回 `alertname` 的 instance）照常延續、不重念。填 `alertname` 視同留空，兩者之間切換不算改動（#85） |
| `repeatFiringMin` | `0`（不重播） | 持續燒時的重播間隔（分），補回 ADR-004 決策 4 放棄的 `repeat_interval` |
| `fallbackSeverity` | `critical` | rules 端點取不到細節時的嚴重度（該端點無穩定性保證，失敗是預期內的） |
| `alertLang` | `zh` | 播報語言 |
| `speakValue` | `true`（念） | 播報句與播報紀錄要不要帶「目前數值 N」子句（#71）。條件只是 0／1 或查 `ALERTS`（值恆為 1）時數值沒有意義，關掉只少那一段、其餘子句逐字不變 |
| `enableTTS` | `true` | 關掉就只更新畫面不發聲（對所有觀看者生效；panel 標題列的語音開關只管自己這台瀏覽器） |
| `quietHours` | `''`（無排程） | 值班靜音時段 `22:00-07:00`：時段內照樣更新畫面，只是不念（#63）。**起點含、終點不含**；跨午夜與不跨午夜都支援。留空或格式錯誤即與沒有這個選項時完全相同 |
| `quietAllowCritical` | `false` | 排程靜音時段內仍念 `critical` 的 firing。嚴重度經 `severityAliases` 對映後判斷，與門檻同一份解析結果。**破靜音念過的 critical，恢復時也會念**（#84）；反面同樣成立——沒破過靜音念出來的告警（非 critical、或這個開關關著）恢復時照舊不念 |
| `flappingThreshold` | `0`（關閉） | 抖動抑制（#64）：同一則在窗內 firing↔resolved 翻幾次就先不念。例「10 分鐘內翻 4 次就先不念，穩定 10 分鐘後恢復」。**達到門檻的那一次仍會念**，之後的翻轉才不念。`0` 或留空即與沒有這個選項時完全相同 |
| `flappingWindowMin` | `10` | 抖動抑制的窗長（分），同時是「穩定多久就解除抑制」的長度。不是大於 0 的數字（含 `0`）→ 整個抖動抑制視同關閉 |
| `ttsVoice` | `''`（自動） | 指名聲線，**可只填名稱的一段**；空字串優先挑 zh-TW 本機引擎 |
| `ttsPitch` | `1` | 音高 0–2。拉到 1.4–1.7 讓男聲像小男孩；部分瀏覽器不支援 |
| `ttsRate` | `1` | 語速 0.5–2。會送給外部服務，但 `tools/tts-server` 的語速由參考音決定 |
| `ttsEndpoint` | `''`（只用 Web Speech） | 外部語音服務位址（ADR-005）。**刻意沒有金鑰欄位**：panel 選項存在 dashboard JSON（決策 4） |
| `ttsTimeoutSec` | `30` | 外部語音逾時（輪到某一句時起算）。逾時就從那一句起改用 Web Speech 念完該則 |
| `directionsImgUrl` | `''`（內建素材） | directions 精靈圖 URL |
| `reactionsImgUrl` | `''`（內建素材） | reactions 精靈圖 URL |

`severityAliases`（#51）的解析在 `core/severityAliases.ts`（純函式；格式錯誤的項目略過不拋，
`describeSkippedAliases` 可回報）。分隔符與 `=` 的全形寫法照樣認得——編輯器說明是中文，
只認半形會讓整組設定靜默失效。別名以**前置正規化**的形式生效：導播層先 `resolveSeverity`
再餵給 `rankOf`/`meetsMin`/`severityToEmotion`，那三個純函式一律不收設定參數
（延續 2026-09-18 不擴 `Emotion` 那次裁定所依據的純函式語意）。
播報句與 `BroadcastPlan.severity` 保留原始 label（仍走 #39 的 `speakableSeverity`：去掉前後空白、
轉小寫，缺值、空白與非字串一律收斂成 `unknown`，見 `src/core/format.ts`）。

`speakValue`（#71）的判斷在 `core/format.ts`（`spokenValue`：`false` 才省略，缺鍵／`undefined` 與 `true` 同義，
所以舊 dashboard 的句子逐字不變），中英兩套共用同一份。選項**不經** `showIf: enableTTS`：
關掉語音後播報紀錄照樣顯示句子，那些句子一樣吃這個開關 —— 導播與紀錄兩條路都走
`buildBroadcastPlan` 並把它原樣轉手，紀錄句與播報句因此仍然逐字相同（G-ADR006-2）。
`BroadcastPlan.value` 欄位不受影響（那是給 feed／除錯讀的原值，不是念出來的那一段）。

`alertNameLabel`（#69）動的是**名字**，而名字就是**去重單位**：來源層的 fingerprint 是
`alert:${名字}`（不含 panelId 也不含規則名，所以同名的告警跨規則仍然只念一次）。
Grafana 會用**規則名覆蓋**每個 instance 的 `alertname`，所以「一條總規則查整面值班牆
（`ALERTS{alertstate="firing"}`）」時每則告警的名字都一樣、只念得到第一則（eks-infra#1210 實測）；
查詢端用 `label_replace(…, "wall_alertname", "$1", "alertname", "(.*)")` 把原名保留成 instance
label，這個選項再指定去讀它。取名是**逐 instance** 的（`sources/panelAlerts.ts` 的 `alertNameOf`），
所以同一條規則裡帶與不帶那個 label 的 instance 可以並存，各自成為一個 episode、
各自恢復。`MascotPanel.tsx` 與導播都只是把這個字串原樣往下帶，不解析也不判斷。
改這一欄會讓某些既有 episode 的 fingerprint 失效，所以來源層把**那幾則**當
**被取代**（`onSupersede`，不念恢復句）而不是恢復 —— 與降級路徑那顆泛用 episode 同一條理由。
判定依據是換 label 之後的第一份清單：fingerprint 還在裡面的就是名字沒變，episode 照常延續、
不重念；不在裡面的才是改了名（#85，`noteLabelChange()` 與差集迴圈的對帳）。`alertname` 與留空
在讀取時就正規化成同一個值（連前後空白一起修掉），所以兩者之間切換連「換過」都偵測不到。
已知取捨：**在換 label 與第一份新命名的清單到手之間**剛好不再燒的那一則，分不出改名與恢復，
一律當成被取代（少念一句恢復，與 #85 之前的行為相同）。那通常就是換 label 的同一輪，
但端點掛著時對帳會晚幾輪，窗口跟著變長。

**播報紀錄（ADR-006）也吃同一個選項**（#70）：紀錄端的取名是 `sources/history.ts` 的
`historyAlertNameOf`，讀的是 annotation 自由文字 `RuleName {labels} - values` 裡 `{labels}` 段的
那個 label（`parseAnnotationText` 拆出來的），取不到就退回規則名。**取名是取名，查樣板是查樣板**：
摘要樣板、條件欄與規則層嚴重度一律用**規則名**查（`templates.get(ruleName)`），念名與規則身分
是兩件事，拿 label 值去查只會整組查不到而靜默掉摘要與數值。紀錄端與播報端讀這個選項的
**時機也一致**（兩個 effect 都只在 `data` 刷新時讀，所以 `alertNameLabel` 刻意不進紀錄 effect 的
相依陣列）—— 不一致的那個瞬間，同一則告警在兩邊叫不同名字，`MascotPanel` 合併 sessionOnly 列
是比對**句子**，於是會把同一則列兩次。代價是改了這一欄要等下一輪 refresh 才生效。
⚠️ `{labels}` 段的格式沒有文件保證：label 值裡含 `, <名稱>=` 時 `parseAnnotationText` 會拆錯，
念出來的名字可能被截斷（含 `=` 或空白的值不受影響）。三種值的實際行為由 `history.test.ts` 釘住。

`quietHours`（#63）的解析與「現在算不算時段內」是 `director/BroadcastDirector.ts` 裡的純函式
（`parseQuietHours`／`isQuietAt`／`minuteOfDayAt`／`describeQuietHours`；不碰 DOM、時刻由注入的時鐘帶進來），
判斷**不在** `MascotPanel.tsx` 的 effect 裡 —— 元件只把兩個選項原樣帶進每一輪的設定。
**端點規則：起點含、終點不含**（`22:00-07:00` 在 22:00 整靜音、07:00 整恢復出聲），
所以相鄰的兩段接得起來而不重疊。格式錯誤（缺 `-`、時間不合法、起訖相同）**視同沒設定**、不拋例外。

兩種靜音是**不同層級**的開關，走同一條交付閘門、**任一個成立就不念**：
`quietHours` 存在 dashboard JSON（所有觀看者共用，要編輯權限才改得動），
ADR-007 那顆鈕存在 `localStorage`（每個瀏覽器各自，viewer 帳號也按得動）。
兩者都是「照樣評估、照樣經過 dedup、照樣回 `items`，只是不交付」——
所以時段結束時不會把時段內的告警一口氣補念出來。`quietAllowCritical` **只對排程靜音生效**：
觀看者自己按了靜音，critical 也不念。

`quietAllowCritical` 開著時還有恢復側的一條（#84）：**在時段內破靜音念出來的那則 critical，
它的恢復句在同一段時段內也念** —— 使用者既然已經被叫醒，就該聽到結局，而不是起身去看螢幕。
反面同樣是規格的一部分：**沒破過靜音念出來的告警（非 critical、或開關關著）恢復時照舊不念**，
所以這不是「所有 critical 的恢復都會念」。導播為此記一份 fingerprint 的集合
（`createQuietBreakLog`，與 dedup、抖動狀態同生同死）：

- **鍵是實際交付，不是 `breaksQuiet()` 的判定。** 寫入點在 `sink.enqueue()` 之後，
  所以 ADR-007 的靜音鈕按下去的那台瀏覽器（判定得出「破得了靜音」卻一句都沒出聲）
  不會記下任何東西 —— 否則它解除靜音後會冒出一句沒有前文的「已恢復」，
  而同一面牆上沒按靜音的那台行為還不一樣。
- **只在一段時段內有效**，四個出口都會清：離開時段或關掉 `quietAllowCritical`（每一輪都查，
  **排在「這一輪無事」的早退之前** —— 時段是被時鐘跨出去的，不是被告警跨出去的）、
  恢復句在閘門上拿到通行證（**這一側不等交付**：等交付的話，恢復句被每瀏覽器靜音擋下的
  那一輪會留下一筆過期的通行證，之後同一個名字那個破不了靜音的 episode 會拿它出聲）、
  來源層 `onSupersede`、`dispose()`。昨晚念過的 critical 撐到今晚才恢復時
  因此不會破今晚的靜音。上限 256 筆（滿了丟最舊的）是對付「fingerprint 每輪都變」的 backstop。
- **時段外念出的 firing、時段內恢復 → 仍然不念**（記錄只在時段內累積）。那個人沒有被吵醒，
  不需要在半夜被告知結局；要改成「念」的話，得先決定記錄要往回追多久，那是另一張票。

時段用的是**每個觀看者瀏覽器的本地時間**（`new Date(ms).getHours()`），
代價是跨時區的觀看者各自落在不同的絕對時刻、日光節約轉換當天不保證 ——
要全站同一個絕對時段得改成帶時區的設定，那是另一張票。

`flappingThreshold`／`flappingWindowMin`（#64）的解析與整個狀態機也在
`director/BroadcastDirector.ts`（`parseFlapping`／`describeFlapping`／`createFlappingTracker`；
不碰 DOM、時鐘注入），判斷**不在** `MascotPanel.tsx` 的 effect 裡 —— 元件只把兩個數字原樣
帶進每一輪的設定。**它與 dedup 是兩回事**：`core/dedup.ts` 管「持續燒的重播間隔」，
而翻轉的每一次都是狀態真的變了，照 dedup 的語意本來就該放行；抖動抑制管的是「反覆翻」。
⚠️ 命名：`src/avatar/flap.ts` 是**嘴型開合**，與這一組選項無關。

交付閘門的順序寫在 `evaluate()` 的註解裡並由測試釘住：**逐則**判斷的兩道是
**抖動抑制 → 值班靜音時段**（各自在 `items` 上留 `suppressed` 標記），**整輪**的開關
（沒有播報器／每瀏覽器靜音）排在交付之前 —— 所以 `quietAllowCritical` 在結構上
蓋不過觀看者自己按下的靜音鈕。抖動排在時段之前，所以兩者同時成立時標記是 `'flapping'`
而不是 `'quiet'`，而且 `quietAllowCritical` 救不回一則正在抖動的 critical ——
一則在 10 分鐘內翻 4 次的 critical 正是這個選項要安靜掉的噪音。#84 的恢復側語意同樣
越不過抖動那一道：被抖動抑制擋下的恢復句連靜音閘門都走不到（它在 `candidates` 之外）。
抑制期間照樣經過 dedup（理由同靜音時段），但**解除**是三道閘門裡唯一會「多念一句」的：
維持同一個狀態滿一個窗沒再翻轉就解除，而且**解除當下**就念當下的實際狀態
（與抑制前最後念出去的那個狀態不同時）。不這樣做的話，抑制期間翻完、最後停在 resolved
的那一則之後不會再有任何事件，「等下一次狀態變化」等於永遠不念那句恢復。
那一句刻意**不走 `dedup.shouldSpeak()`**：預設 `repeatFiringMin: 0` → 防洪窗是 `Infinity`，
它必定被擋下（`core/dedup.ts` 的 `forget()` 註解記著同一個坑），所以解除時由導播自己
把 dedup 的狀態對回實際狀態。

兩個 sprite URL 的預設**必須**是空字串而不是路徑：production 建置的檔名是 webpack 的
`[hash][ext]`，空字串時由 `SpriteController` 改用 `spriteAssets.ts` 的 import 值。
填了外部 URL，panel 會標「自訂圖，對齊未驗證」（SP-7.16）。
**沒有尺寸選項**，stage 邊長由 SP-1.8 自動算。

**Threshold 不在這裡** —— ADR-004 決策 2 要求走 standard field config
（`fieldConfig.defaults.thresholds`），自訂 option 會失去 overrides 與原生編輯 UI。

開發環境設定在 `monitoring/.env`（由 `.env.example` 複製）。埠與啟動方式見 `README.md`。

## ADR 索引（決策權威，`docs/adr/`）

> **本節是 ADR 索引的唯一維護處。** 本 repo 沒有 `docs/adr/README.md`；
> 根 `README.md` 與各 ADR 一律連到這裡，不再各自維護一份清單
> （ADR-004 與 ADR-006 的升級紀錄內原本兩種說法，已於 2026-10-14 統一）。

| ADR | 主題 | 狀態 |
|---|---|---|
| **ADR-004** | **改為 Grafana Panel Plugin**（2D 精靈圖 + Web Speech，零後端） | **Accepted**（2026-09-18） |
| ADR-005 | 選填的外部語音服務（OpenAI 相容 TTS，參考服務為 Qwen3-TTS 年輕男聲），Web Speech 保留為預設與降級；修訂 ADR-004 決策 4 | **Accepted**（2026-10-06） |
| ADR-006 | 播報紀錄：以 Grafana 告警狀態歷史當吉祥物的持久紀錄（唯讀、零後端）；修訂 ADR-004 決策 2 | **Accepted**（2026-10-14） |
| ADR-007 | 語音開關：每個瀏覽器各自靜音（localStorage），被 autoplay 擋下的句子 10 分鐘內可補念、同一則只補最後狀態；修訂 ADR-004 決策 4 | **Retrospective**（2026-10-14，v0.2.1 的回溯紀錄）|
| ADR-001 | SOC 播報架構（Node 導播 + WS + VRM avatar） | Superseded |
| ADR-002 | 表情導播 + lip-sync + `AvatarController` 介面 | Superseded（**§1／§2 被 ADR-004 決策 5 明文繼承**） |
| ADR-003 | 前端 visual-web-stack | Superseded |

ADR-004 的 5 個 POC gate 全數 PASS，機械證據回填在該檔的 Verification Evidence。
ADR-006 的 6 個 POC gate 全數 PASS（G-ADR006-6 於 EKS 實機）。
ADR-001／002 引用的 `broadcaster-spikes/` 在 repo 中已不存在，那兩份的 POC 證據無法複驗。

ADR-007 標 `Retrospective`：記的是 v0.2.1 **已上線**的決策（當時只寫進 CHANGELOG 與 README，沒有 ADR），
屬回溯補寫，不在 `Draft` → `FIRM` → `Accepted` 這條審核線上。是否轉 `Accepted` 由專案主人裁定。

## 技術棧

`@grafana/create-plugin` 7.11.0 腳手架（**webpack**，非 Vite）·
執行期 Grafana **13.2.x**、編譯期 pin `@grafana/*` **13.1.0**（externals，不進 bundle）·
React 18 · Emotion（`@grafana/ui` 的 `useStyles2`）· Jest + @swc/jest · npm。

**測試數不寫在文件裡。** 現值看 `bash tools/asp-test.sh` 的輸出（jest 那一行，
外加不走 jest 的 sprite 工具自測、描邊估計器電池與 tts-server 邏輯）。
`tools/asp-test.sh` 的 `MIN_TESTS` 是閘門用的下限，增刪測試時要同步更新。

**`.config/` 由 create-plugin 託管，禁止手改** —— 手改的後果不是被覆寫而是**靜默失效**
（migration 全是 `if (!AST match) return` 的早退）。要擴充就改根層的 wrapper。

## 已知缺口

- **視線格未畫** —— 現行素材 `features.gaze = false`（SP-0.10：眼睛半閉，虹膜只露約 6px，
  在顯示尺寸下看不出方向）。`gaze.ts` 的計算與 `DiagnosticAvatar` 仍在用。
  有視線的素材列在 `docs/ROADMAP.md` 的 P11。
- **手繪素材的門檻尚未校準** —— 覆蓋率與 128px 眉線對比目前只發 warn，體積（SP-7.8）已是硬失敗
  但預算沒對手繪圖驗過（ROADMAP B2-4、B2-6）。
- **真實 Windows 指標路徑未驗** —— 9182 無 listener，POC 以合成規則 `vector(1)` 繞開。
- **sandbox 開啟時語音是否可用未驗** —— headless 無聲線，測不出來。
- `alertState` 標 `@internal`、rules 端點無官方穩定性保證。兩者都有降級路徑。
- 跨 panel DOM 隨 Grafana 版本變動的風險 —— 每次 minor 升版應重跑 G-ADR004-4：
  `SANDBOX_PLUGINS=augur-mascot-panel docker compose -f monitoring/docker-compose.yml up -d`

---

## 維護規則

- **決策改變 → 先動 ADR**（新增／supersede `docs/adr/`），再回頭同步本檔。
  ADR 是權威，本檔是導覽。
- 動到 seam（新 source、新 `AvatarController` 實作、新 panel option、資料流改向）時
  **同步更新上方的資料流圖與檔案表**，並更新檔頭「最後更新」日期。
- 保持與 `README.md`（給 repo 開發者）與 `src/README.md`（給裝 plugin 的人）一致。
  兩份受眾不同，不要互相複製。**ADR 索引只在本檔維護**，那兩份連過來。
- **不要寫死會漂的數字**（測試數、檔案行數、斷言數）。要講規模就指向產生它的指令。
  2026-10-14 的稽核裡，寫死的測試數與 `src/core` 行數全部是錯的。
- **實測優於推理。** 這個專案已經有五次「靜態推理得出的結論實測不成立」
  （見 `.asp-fact-check.md`）。寫進本檔的行為描述應該是跑過的，不是推出來的。
