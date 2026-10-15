# Augur — `augur-mascot-panel`

一個 Grafana panel plugin：2D 精靈圖吉祥物住在 dashboard 裡，把本面板的告警念出來。
它對點擊有反應、依嚴重度換表情、說話會動嘴與眨眼，用瀏覽器內建的 Web Speech API 發聲
（也可選填外部語音服務，ADR-005），旁邊的清單是讀 Grafana 自己存的告警狀態歷史當**播報紀錄**（ADR-006）。
不需要後端，也不用跑任何常駐服務。

> 視線追蹤的計算在（`gaze.ts` 九格、兩層防抖），但**定稿素材不畫視線**
> （`features.gaze = false`，SP-0.10：眼睛半閉、虹膜只露約 6px，在顯示尺寸下看不出方向），
> 所以畫面上看不到眼睛跟著游標跑；降級用的 `DiagnosticAvatar` 仍會顯示視線格。
> 有視線的素材列在 `docs/ROADMAP.md` 的 P11。

> 本專案做過一次方向反轉。它原本是 `airi-ops-bridge`：一條
> 「Grafana webhook → Node 導播 → Edge TTS → WebSocket → 自架 React 頁的 3D VRM avatar」的推播管線。
> 那個播報頁跟大家實際盯著的 dashboard 是分開的，等於沒人看。
> ADR-004 把它改成 panel plugin，讓吉祥物直接住進 dashboard。
> 舊架構的程式碼已刪除（不封存），要找的話翻 `git log` 就有。

## 狀態

P2–P4 已完成：腳手架併入、`src/core/` 遷入、舊管線刪除、來源層與語音層接通、
跨 panel 互動層與 `AvatarController` 介面就位，5 個 POC gate 全數 PASS。

P8 已完成並發了三版：`v0.1.0`（首個 panel plugin 版本）、`v0.2.0`（播報紀錄，ADR-006）、
`v0.2.1`（看的人自己的語音開關）。逐條見 `CHANGELOG.md`。

本地檢查電池共 11 道（`bash tools/asp-test.sh`）：
typecheck / lint / .js 後綴 / monitoring 設定 / bundle 相依 / sprite 驗收 / sprite 工具自測 / 描邊估計器電池 / Grafana 版本 / tts-server 邏輯 / jest。
CI（`.github/workflows/ci.yml`）跑同樣這些，另外還有 build 與 e2e。
**測試數不寫在文件裡**（寫死就會漂，2026-10-14 的稽核裡三個數字全是錯的）——
現值看 `bash tools/asp-test.sh` 的輸出；`MIN_TESTS` 是閘門用的下限，增刪測試時要同步更新。

P5 已完成。角色是「藍鯨布偶裝的疲憊男孩」（2026-10-05 定稿）：專案主人用 Google Gemini 生成的原圖，
經 BiRefNet 去背、`python3 tools/sprite-gen/face-edits.py` 改出閉嘴／張嘴／閉眼，再由 `tools/sprite-gen/assemble.mjs` 組成兩張精靈圖，
通過整條 SP-7 機械驗收。會說話動嘴、眨眼，並依告警嚴重度換表情（汗滴、怒筋、腮紅、閃光）；視線格未畫（規格 SP-0.10，`features.gaze = false`）。
出處（含 prompt 原文與對第三方角色的揭露）見 `docs/asset-provenance.md` 與 `docs/sprite/SOURCE-PROMPTS.md`。

> ⚠️ 驗收鏈每次提交都會對 `src/img/sprite/` 的兩張圖真的跑一遍（摘要寫「sprites: 通過」），
> 不再走 `NOT-DELIVERED`。腳本畫的暫定圖（`tools/sprite-gen/whale-boy.mjs`）已隨定稿素材刪除；
> 檢查自己的回歸測試仍用合成假人（`tools/lib/syntheticSheet.mjs`）。
> **但三個門檻還沒用定稿素材校準**：格內覆蓋率與 128px 眉線對比目前只發 warn；
> 體積（SP-7.8）已經是硬失敗，但預算本身沒對真素材驗過；描邊估計器的偏差也要用同一批素材重量。
> 先校準，再當門檻用（`docs/ROADMAP.md`〈未完成項目〉B2-4、B2-6）。

avatar 預設是 `SpriteController`：四層 `<div>` 疊在方形 stage 上，底層是視線格，
上面三層是表情、嘴型與眨眼。stage 邊長不到 128px、或 directions 圖載入失敗或幾何不合時，
改掛 `DiagnosticAvatar`。它把契約的四個輸入（表情／講話／視線格／張口幅度）畫成儀表，
刻意做得不像吉祥物，免得有人誤認成角色設計。降級的原因會顯示在 panel 上。
兩張圖由 `src/avatar/spriteAssets.ts` 以 `import` 取 URL（SP-8.3），build 時以帶 hash 的檔名進 `dist/`。
> typecheck 與 jest 不受影響：型別由腳手架的 `*.png` 宣告承接，jest 把 png 換成 `tools/jest/fileMock.js`。

## ADR（決策權威，`docs/adr/`）

**索引在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 的〈ADR 索引〉那一節** ——
主題、狀態與日期只在那一處維護（本 repo 沒有 `docs/adr/README.md`）。
決策內文一律以 `docs/adr/` 的檔案為權威。

下面兩段是這份索引**不該複製**、但 repo 開發者需要知道的事：

ADR-004 是在 5 個 POC gate 全數 PASS 之後才升 Accepted。在那之前它刻意停在 `FIRM`，
不讓「POC 一個都還沒跑」被狀態值蓋過去。機械證據回填在該檔的 Verification Evidence。

ADR-002 有兩個抽象被 ADR-004 明文繼承，不隨 supersede 作廢：
`BroadcastPlan` 事件契約，以及 `AvatarController` 這個不綁定 avatar 格式的介面。

## 安裝（給要在自己的 Grafana 上跑這個 panel 的人）

> 前提：Grafana ≥ 12.3.0。兩道瀏覽器 e2e（plugin 載入、告警以規則名念出）
> 於 2026-10-01 在 12.3.0 / 12.3.11 / 12.4.0 / 13.0.1 / 13.2.2 實跑通過；
> Frontend Sandbox 那道（G-ADR004-4）只在 13.2.2 驗過。plugin 未簽署，Grafana Cloud 裝不了。
> 12.3.x 是修過才能用的：它的 `alertState` 欄位叫 `dashboardId`，12.4.0 才改名成
> `dashboardUID`。修正前 panel 在 12.3.x 載得起來，但每則告警都退成泛用句。
> 2026-10-07 加驗 **12.4.12**，包含「11.2.2 的資料庫原地升上來」這種情況，同樣通過。
>
> **12.3.0 這個下限是真的，不是腳手架的預設值。** 在 **11.2.2** 上 plugin 載得起來，
> 兩道 e2e 也會過，但 Grafana 只在頁面載入時抓一次告警狀態，之後就不再更新。
> 頁面打開之後才發生或解除的告警，吉祥物一則都不會念，要重新整理才看得到；
> 規則解除時還會多念一則泛用句。13.2.2 和 12.4.12 會隨 dashboard 的每次 refresh 更新。
> 驗法：在 11.2.2 上同樣用 10 秒 refresh，Grafana 拉告警狀態的請求從頭到尾只有 1 次；
> 13.2.2 與 12.4.12 則每 10 秒一次。

1. 拿到 zip：`npm run package` 會產出 `augur-mascot-panel-<版本>.zip`
   （或向專案要現成的檔案）。
2. 解壓到 Grafana 的 plugins 目錄（預設 `/var/lib/grafana/plugins`）：
   ```bash
   # <版本> 以 package.json 的 version 為準（目前 0.2.1）
   unzip augur-mascot-panel-<版本>.zip -d /var/lib/grafana/plugins/
   ```
   解出來的目錄名就是 plugin id（`augur-mascot-panel/`），不要改名。
3. 允許載入未簽署的 plugin，兩種寫法擇一：
   ```ini
   # grafana.ini
   [plugins]
   allow_loading_unsigned_plugins = augur-mascot-panel
   ```
   ```bash
   # 容器環境變數
   GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=augur-mascot-panel
   ```
4. 重啟 Grafana。它只在行程啟動時掃描 plugins 目錄，不重啟就等於沒裝。
   成功的話，啟動日誌會有一行 `Plugin registered pluginId=augur-mascot-panel`
   （前面會跟著一句 `Permitting unsigned plugin` 的警告，這是正常的）。
5. 在 dashboard 加一個 **Mascot** panel，並讓它的告警規則把
   `__dashboardUid__` 與 `__panelId__` 寫進 annotations，alertState
   才到得了 panel（範例見 `monitoring/grafana/provisioning/alerting/`）。
6. （選填）**換成更自然的男聲**：瀏覽器內建聲線由作業系統決定，只能調音高。要固定一個年輕男生的聲音，
   在一台有 NVIDIA GPU 的機器上跑 `tools/tts-server/`（Qwen3-TTS，步驟見該目錄的 README），
   再把 panel 選項「外部語音服務網址」填成它的位址。沒填就照舊用瀏覽器聲線；
   服務失敗或逾時的那一則也會自動改用瀏覽器聲線（ADR-005）。
7. **播報紀錄**（ADR-006）：吉祥物旁邊的清單讀的是 Grafana 自己存的告警狀態歷史，重新整理不會不見，
   每個人看到的都一樣，dashboard 沒開著時發生的事也查得到。每一條就是吉祥物念的那句話。
   改 dashboard 的時間範圍可以翻更早的紀錄（一次最多 200 條），上方的篩選框可以用規則名、內容、主機／pod 名過濾。
   紀錄只顯示、不會念。
   - 前提：Grafana 的告警歷史存在 annotations（`[unified_alerting.state_history] backend`，Grafana 的預設）。
     改成 loki 或 prometheus 時，panel 會寫明讀不到，並只列本分頁念過的句子；設成 `multiple` 時，要 annotations 是其中之一才完整。
   - Viewer 就讀得到，不需要額外權限。保存多久由 Grafana 決定（`[unified_alerting.state_history.annotations] max_age` 與 `max_annotations_to_keep`，預設都是永久）。
   - 舊紀錄的摘要是用規則**現在的**樣板填的：規則事後改過措辭，舊紀錄會顯示新的措辭。
8. **語音開關**：panel 標題列的「🔊 語音開／🔇 靜音中」只影響**自己這台瀏覽器**，重新整理後仍記得，
   同一頁的其他吉祥物 panel 會立刻跟著同步；靜音時表情與紀錄照常更新，只是不念，解除靜音後也不會補念靜音期間的告警。
   瀏覽器在你點過頁面之前不准發聲，被擋下時按鈕會寫「🔊 點一下啟用語音」，按下會補念最近 10 分鐘內被擋掉的句子
   （同一則只念最後的狀態），不會變成靜音；外部語音被自動播放政策擋下時也是同一個按鈕。
   panel 設定的「開啟語音」關掉、或面板小於 320×180 時，按鈕不顯示。

## 開發

```bash
npm install
npm run dev          # webpack watch，產出 dist/
npm run server       # build + 起 monitoring/ 的 Grafana，並確認 plugin 真的註冊了（Loki 預設不啟，見埠表）
npm run test:unit    # jest
npm run typecheck
npm run lint
npm run e2e          # playwright，預設打 http://127.0.0.1:3002
npm run package      # 產出可安裝的 zip

# sprite 交付相關（素材還沒進來也都能跑）
npm run check:sprites           # SP-7 素材驗收（manifest 不存在時印 NOT-DELIVERED 並回 0）
python3 tools/sprite-gen/face-edits.py <原圖> <輸出目錄>  # 從原圖改出嘴、眼與表情（原圖不進版控）
node tools/sprite-gen/assemble.mjs   # 由 assets/sprite-src/ 的母圖與變體組成兩張圖（原始檔不進版控）
npm run check:sprites:selftest  # 上面那支自己的回歸測試（合成基準 + 逐條變異體）
npm run blindtest               # SP-V.1 方向辨識盲測頁 → http://localhost:8787/
npm run blindtest:fixture       # 產編號假 sheet，用來驗盲測頁本身
```

開發環境開在 http://127.0.0.1:3002（不是 3000，原因見下方埠約定），跑的是 Grafana 13.2.2，
已開 unsigned 白名單，並帶一份 provisioned 的 POC dashboard
（`monitoring/grafana/provisioning/dashboards/augur-poc.json`），起來後就能直接看到 panel。

> ⚠️ 第一次跑之前先 `cp monitoring/.env.example monitoring/.env`。
> `monitoring/docker-compose.yml` 有 `env_file: ./.env`，少了這個檔 `docker compose` 會直接失敗。
>
> ⚠️ 要先 `npm run build` 再起 Grafana。compose 掛的是 `../dist`，那是建置產物；
> 沒建置過的話目錄不存在，Grafana 照樣起得來、UI 也進得去，只是選單裡沒有這個 plugin，
> 而且不會有任何錯誤訊息。`npm run server` 已經把 build 串在前面、也會在最後確認 plugin 有註冊，直接用它就好。
>
> e2e 用 `@grafana/plugin-e2e` 預設的 admin/admin 登入。`.env` 裡的密碼不是 admin 的話，
> 跑 e2e 要帶 `GRAFANA_ADMIN_PASSWORD=…`；要打別台 Grafana 就加 `GRAFANA_URL=…`。

### 埠約定（重要）

`monitoring/` 的埠刻意避開 3000，因為本機還有其他 stack 佔著 3000。

| 服務 | 對外 | 容器內 |
|---|---|---|
| Grafana | `127.0.0.1:3002` | 3000 |
| Prometheus | `127.0.0.1:9091` | 9090 |
| Loki | `127.0.0.1:3101` | 3100（`profiles: ["security"]`，預設不啟） |

### 只有一套開發環境

腳手架預設會給一份根層的 `docker-compose.yaml` 與 `provisioning/`，本專案刻意沒有採用。
開發環境只有 `monitoring/` 這一套，`npm run server` 指向它。理由有三個：

1. G-ADR004-2／-3 要驗的是真告警，需要真的 Prometheus 與 alert rule；腳手架配的 TestData 資料源在結構上驗不出來。
2. `.config/docker-compose-base.yaml` 是 `user: root`，而且掛 `..:/root/augur-mascot-panel`。
   併進本 repo 後，等於把含 `.env` 的整棵樹掛進一台匿名 Admin 的 Grafana。
3. 兩套 Grafana 並存，「plugin 到底裝在哪一台」會變成常態性的困惑。
   P3 把掛載加到 `monitoring/` 之後，答案必須只有一個。

所以 `.config/docker-compose-base.yaml` 與 `.config/Dockerfile` 是刻意閒置的託管檔，不要 extends。

### 禁止手改 `.config/`

`.config/` 由 `@grafana/create-plugin` 託管（`npx @grafana/create-plugin update` 會處理它）。
要擴充的話，改根層的 wrapper：`tsconfig.json`、`eslint.config.mjs`、`jest.config.js`、
`.prettierrc.js`、`playwright.config.ts`。

手改 `.config/` 的後果不是「被覆寫」，而是「靜默失效」。migration 全是
`if (!AST match) return` 的早退，改壞了比對點就會被無聲略過，你不會收到任何訊息。

## 這個 repo 的其他目錄

| 目錄 | 是什麼 |
|---|---|
| `src/core/` | 來源中立的核心邏輯：`ParsedAlert` 型別、嚴重度排名、表情映射、播報文字組句、去重防洪。不依賴瀏覽器或 Node，從舊架構整包繼承、`ParsedAlert` 這條邊界沒動——但**不是「零修改」**：`dedup.ts` 為兩次真實的永久靜音缺陷加過 `forget()` 與 `setWindow()`，`severity.ts` 補過缺值收斂。別再寫死行數。 |
| `monitoring/` | docker-compose 開發環境 + 8 條 Windows 主機 alert rule（3 條效能、5 條 Loki 事件），另有 2 條 POC 用的合成規則 |
| ~~`assets/`~~ | 已於 2026-09-21 退出版控：出處查不到，依 `docs/asset-provenance.md` 自訂的規則移除。角色定義改由 `live2d-template-spec-v1.md` §7 的文字描述 + `sprite-sheet-spec.md` SP-6.0 的色票表承擔，兩者都是本專案自己的產物。 |
| `live2d/_archive/` | 已廢棄的 Live2D 路線。但 `live2d-template-spec-v1.md` §6 仍在用：它定義了 calm/warning/critical/resolved 四個表情的視覺語意，是 sprite 反應圖的內容大綱。 |
| `avatar/` | VRM / THA 選型研究備忘錄（歷史，已不在關鍵路徑上） |
| `tools/` | `asp-test.sh`（11 道本地檢查電池）；它呼叫的 `check-js-suffix.sh`、`check-monitoring.mjs`、`check-bundle-deps.mjs`、`stroke-battery.mjs`；`check-sprite-sheets.mjs`（SP-7 素材驗收，零依賴）與它的 selftest；`lib/`（手寫 PNG / GIF 編解碼、檢查邏輯、合成假人）；`blind-test/`（SP-V.1 盲測頁）；`check-server.sh`（`npm run server` 的註冊確認）；`tts-server/`（ADR-005 的外部語音服務參考實作：Qwen3-TTS 年輕男聲，Python，不進 plugin）；`sprite-gen/`（`face-edits.py` 改臉、`assemble.mjs` 組圖，定稿素材的產製鏈）；`package.sh`（打包 zip）；`jest/fileMock.js`（jest 的圖片 stub，`jest.config.js` 引用） |
| `docs/sprite/` | 精靈圖規格（`sprite-sheet-spec.md`）、製作 SOP、manifest 樣板。發包給畫師時給這三份。 |
| `docs/handoff/` | 歷史交接文件。`remaining-plan.md` 已於 2026-10-02 退役，仍有效的項目在 `docs/ROADMAP.md`〈未完成項目〉 |

### 為什麼 `dedup.ts` 在 pull 模型下更重要

在 push 模型下，它防的是「Grafana 週期重送 firing」。
panel plugin 是 pull：每個 refresh interval（預設 30s）都會重新評估告警狀態，
沒有防洪的話，同一則告警每 30 秒就會被念一次。

### 一個會騙人的坑

`src/` 內的相對 import 不可以帶 `.js` 副檔名。
webpack 的 `resolve.extensions` 沒有 `extensionAlias`，jest 的 `moduleNameMapper` 也不做這個對映，
兩者都解析不到；但 `tsc` 會把 `.js` 自動對映回 `.ts`，所以 `npm run typecheck` 永遠是綠的。
真正抓得到的是 jest。`tools/check-js-suffix.sh` 就是為此而存在。

### 另一個會騙人的坑

`tools/check-sprite-sheets.mjs` 與它的 lib 不得呼叫任何 git 指令。
`git` 的任何一個子指令都會刷新 `.git/index` 的 mtime，
而 v4 ship-gate hook 的判定是「`.asp-test-result.json` 不得比 `.git/index` 舊」——
sprite 檢查很容易想用 `git ls-files` 去找素材，那會讓整個 commit 閘無聲失效。
`check-sprite-sheets.selftest.mjs` 有一條測試在釘這件事（剝掉註解後 grep）。
那支 hook 已於 2026-10-10 移除（見〈治理〉），所以這條禁令現在護的是**歷史判定**；
約束仍然保留——重新接上任何讀 mtime 的閘門時它就又生效，而且測試已經在釘了。

## 治理

本 repo 是 **asp-ng 的消費端**（2026-10-10 接入，`chore(asp): 接入 asp-ng 消費端…`）。
三個入口：

| 檔案 | 是什麼 |
|---|---|
| `asp-gate.yaml` | **單一事實源**。目前兩道 blocker：`gitleaks`（規則庫 vendored 自 asp-ng）與 `commit-format`（Conventional Commits）。 |
| `.asp/gate.sh`、`.asp/ci.sh`、`.github/workflows/asp-ci.yml` | 由 `asp render` 從上面那份產生的**渲染物，勿手改**（檔頭有 source / renderer 的 sha256）。本機 gate 與 CI 跑同一份，判定一致由構造保證。 |
| `AGENTS.md` | PR 與 commit 慣例：`Closes #<票號>`、AC 逐條對照、Conventional Commits、本 repo 的測試指令是 `npm run test:unit`。 |

型別、lint、測試、建置與 e2e 不在 asp 這一側——由本 repo 既有的
`.github/workflows/ci.yml` 在每個 PR 上跑。移除 `asp-gate.yaml`、`.asp/`、
`.github/workflows/asp-ci.yml`、`.mega-linter.yml` 即卸載。

**v4 的 ship-gate hook 已於 2026-10-10 移除**（`.claude/settings.json` 內指向
`~/.claude/asp/hooks` 的三支）。所以 `tools/asp-test.sh` 現在是**本機自願跑的完整檢查電池**
（上面〈狀態〉列的 11 道），不再有 hook 讀它寫出的 `.asp-test-result.json`；
那條「`git add -A` → `bash tools/asp-test.sh` → 立刻 `git commit`，中間不要插
`git status` / `git diff`」的順序要求，是為了那個已移除的 hook 比對
`.git/index` 與結果檔的 mtime —— 腳本與 `tools/` 底下的註解仍以它為背景在寫，
讀的時候把它當歷史脈絡。
