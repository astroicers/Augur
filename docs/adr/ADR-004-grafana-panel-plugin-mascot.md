<!-- ADR-004 | Status: FIRM -->
# ADR-004：Augur 由獨立播報頁升級為 Grafana Panel Plugin —— 2D 精靈圖吉祥物 + 瀏覽器語音

| 欄位 | 值 |
|------|----|
| **狀態** | `FIRM` |
| **日期** | 2026-09-16 |
| **決策者** | astroicers |

> **狀態說明**：`Draft`（**禁止實作生產代碼**）→ `FIRM`（POC 驗證）→ `Accepted`（人類審核放行）。**AI 不可自行升級狀態**（ASP 鐵則）。
> 本 ADR **supersede ADR-001 / ADR-002 / ADR-003**（三份皆 Accepted, 2026-07-18）。

> ⬆️ **由 `Draft` 升 `FIRM`（2026-09-16）**：astroicers 經 `/asp:approve-adr 4` 授權。
> 看過的指令摘要項目：章節數 6、決策條目 7（**本 ADR 無附錄 A**，決策數取自 `###` 標題而非
> skill 指定的唯一來源）、Verification Evidence 在（9 列外部事實查證 + 6 項查不到）、
> **本次升級涉及的決策已回填機械證據 0 項**、無 `roadmap-ref`（四份 ADR 皆無，屬 repo 既有慣例）、
> diff 範圍為單一 commit `0c9f382`；缺項清單四條：**5 個 POC gate（G-ADR004-1～5）全數未跑**、
> Verification Evidence 是外部事實查證而**非本 ADR 七項決策的 POC 證據**、本 repo 無 `.asp/gate.sh`
> 故 skill 第 6 步的 `adr-draft`/`adr-index` 機械驗證跑不了、ADR 索引不在 `docs/adr/README.md`
> 而在 `docs/ARCHITECTURE.md`。
> 回覆逐字：**「升 FIRM」**。
>
> **升 FIRM 而非 Accepted 的理由**：`adr-draft.sh` 對 `FIRM` 是 exit 0 的 advisory（允許 commit，
> 需 Verification Evidence），故升 FIRM 已足以解除「Draft 禁止實作生產代碼」的鎖，
> **不需要為了動工而直升 Accepted**；而本 ADR 的 5 個 POC gate 本來就只能在 plugin 寫出來之後才跑得動。
> 「POC 未跑」這個事實因此誠實留在檔上，未被 Accepted 掩蓋。
> **人類顯式授權，非 AI 自行升級**（ASP 鐵則）。
>
> ⏭️ **升 Accepted 的條件**：G-ADR004-1～5 全綠並在 Verification Evidence 回填機械證據後，
> 再次由人類經 `/asp:approve-adr` 授權。

> ⚠️ **證據鏈告示**：ADR-001/002/003 的 Verification Evidence 大量引用 `broadcaster-spikes/`（spike A/B/C）與本 repo 的 `.asp-fact-check.md`。**兩者在本 repo 皆不存在**（`.asp-fact-check.md` 另被根 `.gitignore` 排除）。前三份 ADR 的 POC 證據**已無法複驗**。本 ADR 的外部查證改記於下方 Verification Evidence，並同步寫入 `.asp-fact-check.md`。

## 痛點 / 需求

ADR-001 把 Augur 定為「瀏覽器原生 SOC 播報 runtime」：Grafana webhook → Node 導播 → Edge TTS →
WebSocket → 自架 React 頁上的 VRM avatar。它能動（20 個後端測試全綠），但有兩個結構性問題：

1. **播報頁沒人看。** 它是一個**獨立網頁**，與 on-call 實際盯著的 Grafana dashboard 分離。
   要看 avatar 得另開分頁 —— 與「SOC 環境感知」的初衷直接衝突。
   ADR-003 用 `GrafanaPanel` iframe 把 Grafana **嵌進**播報頁來緩解，而 ADR-001 §待驗風險 ③
   正是「Grafana 面板嵌入 iframe CSP 與同源限制待驗」。**方向反了**。
2. **部署成本與價值不成比例。** 為了讓角色開口，要跑常駐 Node 服務、管 `WEBHOOK_SECRET`、
   開兩個埠（3001/3002）、維護 11 MB VRM 模型與 Live2D Cubism Core。

需求：讓吉祥物**直接活在 dashboard 裡**，對告警有反應、對使用者的操作有反應，
且**不需要任何後端**。互動性（追蹤視線、點擊區塊給介紹）是舊架構做不到的新價值。

## 決策

**Augur 由「獨立播報頁 + Node 導播」改為單一 Grafana Panel Plugin（`augur-mascot-panel`），零後端。**

### 1. 形態與技術棧
`@grafana/create-plugin` 腳手架（webpack，**非** Vite）+ React 18。
**執行期** Grafana 13.2.x；**編譯期** pin `@grafana/data|ui|runtime` **13.1.0**（腳手架預設）——
兩者可以不同，因為 `@grafana/*` 在 webpack 設定裡是 **externals**，不進 bundle，執行期由 Grafana 本體提供。
（原文寫「`@grafana/data|ui|runtime` 13.2.x」把編譯期與執行期混為一談，2026-09-17 修訂。）
樣式改用 `@grafana/ui` 的 `useStyles2` + theme token，**廢除 Tailwind**。
未簽署 plugin 以 `allow_loading_unsigned_plugins` 載入，plugin 目錄指向建置產物 `dist/`。

### 2. 告警來源：`alertState` 當觸發訊號、Alerting rules 端點當內容來源

> 🔬 **本節於 2026-09-17 依 POC 實測重寫。** 原文假設 `alertState` 本身就是告警內容來源，
> 那是錯的 —— 它只有四個欄位。實測記錄見 `.asp-fact-check.md`「alertState / rules 端點實測」一節。

**廢除整條 webhook → WS push 管線。** 改由 panel 自己 pull，**雙軌**：

**(a) 觸發訊號 —— `PanelProps.data.alertState`。** 實測（Grafana 13.2.2）它只回：
```json
{ "state": "alerting", "id": 0, "panelId": 1, "dashboardUID": "augur-poc" }
```
**僅此四欄。無 `ruleUID`、無 alertname、無 severity、無 summary。**
它便宜、即時、隨 panel data 一起到，適合當「狀態有沒有變」的訊號，**但當不了內容來源**。

⚠️ 狀態值只有 **`alerting` / `pending` / `ok`** 三種可達（`promAlertStateToAlertState()`
是 firing→Alerting、pending→Pending、**其餘一律 OK**）。原文列的六態（含 `no_data` /
`recovering` / `paused`）透過這條路徑永遠到不了。
⚠️ 它是**黏著的**（`alertState != null ? alertState : 上一次`），**永不回 `undefined`** ——
所以「偵測不到就降級」這個機制不成立，降級只能靠顯式的 panel option 強制。

**(b) 內容來源 —— `getBackendSrv().get('/api/prometheus/grafana/api/v1/rules', {dashboard_uid, panel_id})`。**
實測回傳與 `ParsedAlert` **一對一**：`alerts[].labels.alertname` → `name`、
`labels.severity` → `severity`（本例 `critical`，**直接命中 `severity.ts` 的 RANK 表**）、
`annotations.summary` → `summary`、`value` → `value`、`activeAt` → `startsAt`。
`dashboard_uid` + `panel_id` 過濾實測有效（全庫 9 條縮到 1 條），panel 只抓自己的規則。

**降級**：(b) 失敗時退回只用 (a) 播「有 N 條告警正在燒」的泛用句。這是天然的 fallback，不是另一條路。

**接受的風險**：該端點無官方文件保證穩定性（`.asp-fact-check.md` 標中高風險）。
但 Grafana 自己的 Alerting UI 就在用它，且我們已量過確切 payload 形狀，壞掉時降級路徑是現成的。

**實作時會咬人的三點**（實測）：
1. 狀態詞彙有三套且不可互比：`alertState.state` = `alerting`（小寫）、
   rule 層 `state` = `firing`、`alerts[].state` = `Alerting`（首字大寫）。
2. `value` 是**字串科學記號**（`"1e+00"`），要 `parseFloat` 才能餵給 `format.ts` 的 `formatNumber`。
3. `alertState` 能到達 panel 有**四個硬前提**，缺一則恆為空：
   `module.ts` 必須 `.useFieldConfig().setDataSupport({ alertStates: true, annotations: false })`；
   panel 在 dashboard JSON 必須至少一個 query target 且 `plugin.json` 不可設 `skipDataQuery`；
   alert rule 必須帶 `__dashboardUid__` / `__panelId__` **註解**；
   dashboard 時間範圍結尾必須是 `now`。
   另有 `hasAlertRules` latch —— 先載入 dashboard 再建規則的話必須整頁重新載入。
- 輔來源 `fieldConfig.defaults.thresholds`（standard field config，**不自訂 option**，
  以保留 overrides、原生編輯 UI 與 `getColorForValue`）。

### 3. avatar：2D 精靈圖，廢除 3D
3×3 sprite sheet（9 方向 + 9 反應）取代 VRM / Live2D。移除 `three`、`@pixiv/three-vrm`、
`pixi.js`、`pixi-live2d-display`。`mount()` 由 `HTMLCanvasElement` 放寬為 `HTMLElement`
（sprite 的自然實作是 `<div>` + `background-position` + `steps()`，不需要 canvas）。

### 4. 語音：Web Speech API —— **明文推翻 ADR-001/002 的選型**
ADR-001 §待驗風險 1 與 ADR-002 §4 曾評估並否決 Web Speech（「零後端但**音質/一致性差、難取振幅**」），
選 Edge TTS。**本 ADR 推翻該選型**，新理由只有一個：**panel plugin 形態不允許有後端**，
而 Edge TTS 的 `msedge-tts` 是 Node 套件。這是形態決定選型，不是重新評估後認為 Web Speech 變好了。

**接受的代價（明碼標價）**：
- 聲線由 Edge TTS 的 zh-TW Neural 降為**作業系統內建聲線**，且 zh-TW 是否存在由 OS 決定。
- **ADR-002 §3 的「v0 振幅 lip-sync」直接失效** —— Web Speech 不吐 audio buffer，接不上 `AnalyserNode`。
  故介面 `setMouth(open: number)` 改為 **`setSpeaking(boolean)`**，並新增**可選**成員
  `setMouthOpen?(open: number)` 承接幀級嘴型（未來若有拿得到 audio buffer 的 TTS，
  振幅 lip-sync 只要實作這個成員就能回來，不必再動一次契約）。

  > 🔬 **2026-09-17 POC 實測修訂**：原文與後續 review 都假設「中文不觸發 boundary，
  > 只能定速循環」，而 review 進一步以「boundary 模式下 speaking 每秒翻轉 5 次以上」為由
  > 主張 MVP 砍掉它。**那個頻率是假設，不是量測。**
  > 實測（Windows 11 / Chrome 152 / Microsoft Hanhan）：77 字句觸發 **21 次** `word` 事件，
  > `charLength` 介於 **1–14**（引擎在做真正的中文斷詞），頻率 **1.53 次/秒**，
  > 相鄰間隔平均約 **600ms**。
  > **結論：boundary 驅動嘴型可行，且優於定速循環** —— `charLength` 給出每組字數可決定擺動次數，
  > `charIndex` 另可驅動播報 feed 的逐詞高亮。P4 以 boundary 事件為**同步點**，
  > 兩事件之間跑嘴型循環；`setSpeaking` 保留為不觸發 boundary 的引擎的 fallback。
  > 另：語速基準 **5.6 字/秒**，典型告警句 77 字 ≈ 14 秒 —— 直接決定播報佇列的積壓速度。
- 放棄 Grafana 通知政策（`group_wait` / `repeat_interval`）的節流語意。
- ~~長播報需依時長 ≤10 秒切段~~ —— **2026-09-17 實測未重現「約 15 秒截斷」**
  （924 字連續發聲至 90 秒仍未中斷）。改為：**使用本機聲線（`localService === true`）時不切段；
  偵測到遠端聲線時才切段** —— 該 bug 歷史上與遠端聲線相關，而本次用的是本機 Hanhan，
  有風險的那一組沒測到。

### 5. 明文繼承 ADR-002 的兩個抽象
這兩個是前三份 ADR 最好的設計決定，**不隨 supersede 作廢**：
- **`BroadcastPlan` 事件契約**（ADR-002 §1）—— 導播與呈現之間的純資料邊界。
- **`AvatarController` avatar-agnostic 介面**（ADR-002 §2）—— 換 avatar 格式不動上層。
  本 ADR 對它做兩項修改：`mount` 放寬為 `HTMLElement`、`setMouth` → `setSpeaking`；
  並**新增 `setGaze(dx, dy)`**（9 方向格即其實作，含 dead zone 防抖）。

### 6. 跨 panel 互動：漸進降級（**風險承擔決策**）
「全局視線追蹤」與「區塊點擊偵測」需要伸手到自己 panel 以外的 DOM，**Grafana 官方不支援**。
決策：**預設嘗試全頁監聽，capability 偵測失敗時靜默退回本 panel 內**，
使升級壞掉時的後果是「少了跨區塊互動」而非「整個 plugin 崩潰」。
僅依賴有原始碼佐證的 `data-viz-panel-key` / `data-viz-panel-id` / `data-plugin-id`；
**禁用** `data-panelid`、`panel-container`、`react-grid-item`（現行原始碼查無）。

### 7. 保留與廢除
- **保留**：`src/core/*`（268 行，實測零 Node-only 相依，可直接在瀏覽器跑）
  與其 4 支測試；`monitoring/` 全套（升 Grafana 13.2.x、加 plugin 掛載、補 provisioned dashboard）。
- **廢除且刪除，不封存**：`server.ts`/`config.ts`/`index.ts`/`airi.ts`/`sources/`/`sink/`/`tts/`/
  `web/`/`scripts/`/`airi-ops-bridge-spec.md`。
  **不封存的理由**：`src/airi.ts` 就是反例 —— dormant 之後 `.env.example` 至今躺著 20 行 AIRI 設定、
  根 `README.md` 整份仍在講 AIRI。dormant 程式碼會持續污染文件與設定面。`git log` 找得回來。

## Supersede 對照

| ADR | 原決策 | 本 ADR 的處置 |
|---|---|---|
| ADR-001 | 瀏覽器原生播報 runtime：Node/TS 導播 + WS 推播 + React 前端 + VRM 首發 | **Superseded** —— 三根柱子（導播、WS、3D）全拔除。其 §待驗風險 ③（Grafana 嵌入 CSP）由「不嵌入，直接住進去」終結 |
| ADR-002 | `BroadcastPlan` 契約、`AvatarController` 介面、振幅 lip-sync、Edge TTS | **Superseded 但部分繼承** —— §1/§2 明文繼承（介面修改見決策 5）；§3/§4 失效 |
| ADR-003 | visual-web-stack（React 19 + Vite + Tailwind + Radix + R3F + Motion + Zustand + next-themes）、`GrafanaPanel` iframe 嵌入 | **Superseded** —— 建置鏈換成 webpack，樣式換成 Emotion，iframe 方向完全相反 |

> **前車之鑑（寫給本 ADR 自己）**：ADR-003 宣告了 9 項技術棧，**實際只裝了 4 項**
> （React/Vite/Tailwind/Zustand），Radix、R3F、Drei、Motion、next-themes 一項都沒裝，
> React 版本也是 18 而非宣告的 19。**決策文件與實作已脫節。**
> 本 ADR 只列真的打算裝的東西，且 POC gate 必須驗到裝了什麼。

## Verification Evidence

外部事實查證日期 **2026-09-16**（同步寫入 `.asp-fact-check.md`）。

| 項目 | 結論 | 來源 |
|------|------|------|
| panel plugin 拿得到真 alert 狀態 | ✅ `PanelData.alertState?: AlertStateInfo`；⚠️ 標 `@internal`（非 `@deprecated`），不在公開 API 契約內，但 Grafana 核心自己用它畫 panel header 告警圖示 | `grafana/grafana` `packages/grafana-data/src/types/alerts.ts` |
| panel 能否讀其他 panel 的資料 | ❌ **官方無此 API**。`props.data.series` 只有本 panel 的 query 結果。官方解是使用者把 query 設成內建 `-- Dashboard --` data source；`getDashboardSrv`/`DashboardScene` **未公開 export** | `packages/grafana-runtime/src/index.ts` 逐行檢查；Grafana share-query 官方文件 |
| 跨 panel DOM 屬性何者可用 | ✅ `data-viz-panel-key` / `data-viz-panel-id` / `data-plugin-id` 有原始碼佐證；❌ `data-panelid` / `panel-container` / `react-grid-item` **查無** | `@grafana/scenes` `VizPanelRenderer.tsx` |
| DOM 會不會隨版本變 | ⚠️ **會**。Grafana 自己的 e2e selector 每條綁版本號（`Panel.subtitle` 標 `13.2.0`、`VizLayout.container` 標 `13.1.0`） | `packages/grafana-e2e-selectors/src/selectors/components.ts` |
| Frontend Sandbox 會不會擋死全頁監聽 | ⚠️ **會**。Grafana ≥11.5 提供，明文阻止 plugin 修改指定區域外的介面。預設關閉，但官方對「允許使用者寫自訂 JS」類 plugin「strongly recommend」開啟。**隔離機制（iframe/Worker/membrane）官方未明說** | Grafana plugin-frontend-sandbox 官方文件 |
| 未簽署 plugin 安裝方式 | ✅ `allow_loading_unsigned_plugins` 仍可用；❌ **`git clone` 進 plugins 目錄不會被載入** —— Grafana 掃「含 `plugin.json` 的子目錄」，而 scaffold 的 `plugin.json` 在 `src/` 下。必須指向建置產物 `dist/`。殘留過期 `MANIFEST.txt` 會直接載不起來 | Grafana plugin-install / sign-a-plugin 官方文件 |
| Web Speech 可用性 | ✅ Baseline「Widely available」；⚠️ `getVoices()` **首呼可能回空陣列**，必須監聽 `voiceschanged` 後重取；zh-TW 由 OS 決定，需 runtime 偵測 + fallback | MDN `SpeechSynthesis` / `getVoices` |
| `src/core/` 可否直接在瀏覽器跑 | ✅ grep 全 `src/core/` 找 Node-only API **零命中**（唯一的 `timer.unref?.()` 已有 optional chaining 保護） | 本 repo 實查 |
| 靈感來源授權 | ✅ `nilbuild/page-mascot` 存在，**MIT © Kamran Ahmed**，做法為兩張 3×3 sprite sheet + dead zone 防抖 | github.com/nilbuild/page-mascot |

### 查不到（明確記錄，不臆測）
1. Frontend Sandbox 的**具體隔離機制**（官方只寫 "separate JavaScript context"）。
2. 「Grafana Cloud 不允許未簽署 plugin」的**官方一級來源**（僅社群來源）。
3. `speechSynthesis.speak()` 是否**規格上強制**需要 user gesture（防禦性假設需要）。
4. Chrome/Edge 對 **zh-TW 具體 voice 名稱**的保證可用性。
5. `@grafana/alerting` 套件是否提供 plugin 可用的 alert state 讀取 API。

## Follow-up / POC gate（升 FIRM 前必過）

- **G-ADR004-1（plugin 載入）✅ PASS（2026-09-17）**：`/api/plugins` 回
  `id=augur-mascot-panel name=Mascot type=panel enabled=true signature=unsigned`。
  環境為 `monitoring/` 升至 `grafana/grafana:13.2.2` 後掛 `../dist` + unsigned 白名單。
  附帶實測：**11.4.0 → 13.2.2 不需要砍 `grafana-data` volume**，沿用既有 volume
  直接啟動、DB migration 全部成功 —— 先前判定「需 `docker volume rm`」是靜態推理，不成立。
- **G-ADR004-2（真告警端到端）✅ PASS（2026-09-17）**：以合成規則 `PocAlwaysFiring`
  （`vector(1) > 0`）取代真實 Windows 指標 —— 要驗的是「panel 收不收得到並念得出來」，
  不是「CPU 會不會高」，而 Windows 側 9182 至今無 listener。
  實測（headless chromium 對 live Grafana）panel 產出：
  「偵測到告警：PocAlwaysFiring，嚴重度 critical，目前數值 1，POC 用的恆定告警…」
  —— alertname / severity / value / summary 全部到位，console 零錯誤。
  翻轉規則 `PocFlapping` 走完整圈：firing → 「告警已恢復：PocFlapping」→ 之後不再重複。
  （原文的 `WindowsHighCPU` 路徑仍未驗，待 Windows 側裝好 windows_exporter。）
- ~~**G-ADR004-2（原文）**~~：`rules-perf.yml` 的 `WindowsHighCPU` 觸發 →
  panel 收到 `data.alertState.state === 'alerting'` → 吉祥物換 critical 表情 + 開口念出。
- **G-ADR004-3（防洪）✅ PASS（2026-09-17）**：`PocAlwaysFiring` 在 10:28:05 播報一次後，
  接下來 **160 秒 / 16 個 refresh 週期再也沒有播報**。孤兒 resolved 也確實被吞掉
  （恢復後持續 `ok` 不會重複念「已恢復」）。`dedup.ts` **零修改**達成。
- **G-ADR004-4（漸進降級，本 ADR 的關鍵風險驗證）**：開啟
  `enable_frontend_sandbox_for_plugins` 後，plugin **降級而非崩潰**。
- **G-ADR004-5（語音）✅ PASS（2026-09-17）**：於使用者實際看 dashboard 的機器
  （Windows 11 / Chrome 152）實測 —— zh-TW 聲線 **4 個**（Hanhan 預設 / Yating / Zhiwei 三個為
  **本機**引擎）；`getVoices()` 首呼確實為空，單次 `voiceschanged` 於 +17ms 後給滿 25 個；
  **`speak()` 不需要 user gesture**（零點擊即發聲且使用者確認聽到，且是在沙箱 iframe 內）。
  ⚠️ Chrome 的自動播放政策對同一 origin 有黏性，工程上仍保留「啟用鈕」，但**不應阻擋首次播報**。

## 待驗風險

1. **`alertState` 的 `@internal` 標記**（風險：中）。Grafana 核心自用，無聲移除機率低，
   但無 deprecation 週期保證。~~緩解：偵測不到時退回 `fieldConfig.thresholds` 自算。~~
   **2026-09-17 修訂**：該緩解不成立 —— `alertState` 是黏著的、永不回 `undefined`，
   偵測不到這件事本身偵測不到。降級只能由顯式的 panel option 強制。
6. **`resolved` / `pending` / `recovering` 的實際表現未測**（新增，2026-09-17）。
   POC 用的是恆為 firing 的規則，只驗到 `alerting`。需要一條會翻轉的規則才測得到
   狀態轉換與 `for` duration 的 Pending 期。**列為 P4 硬前置** ——
   `dedup.ts` 的 resolved 綁狀態語意完全建立在能正確辨識「恢復」之上。
2. **跨 panel DOM 為 unsupported**（風險：中高）。緩解＝決策 6 的漸進降級 + 每次 Grafana
   minor 升級重跑 G-ADR004-4。README 須明寫不相容 Frontend Sandbox。
3. **`monitoring/` 落後兩個大版本**（Grafana 11.4.0 → 13.2.x）。升級本身可能牽動既有
   provisioning 格式（alerting rules schema），需實測。
4. **9 格 sprite 的內容設計尚未收斂**。`emotion.ts` 目前只有 4 個 emotion
   （calm/warning/critical/resolved），吃不滿 9 格，需擴充。
   內容大綱可承 `live2d/_archive/live2d-template-spec-v1.md` §6 的表情視覺語意定義。
5. **Web Speech 的使用者手勢限制未有規格層級答案**。防禦性設計：沿用既有
   `AvatarStage.unlockAudio` 的「一顆啟用鈕」。
