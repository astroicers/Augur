# Augur — `augur-mascot-panel`

一個 Grafana panel plugin：**2D 精靈圖吉祥物住在 dashboard 裡，把本面板的告警念出來**。
追蹤滑鼠視線、對點擊有反應、依嚴重度換表情，用瀏覽器內建的 Web Speech API 發聲。
**零後端** —— 不需要跑任何常駐服務。

> **本專案剛做過一次方向反轉。** 它原本是 `airi-ops-bridge`：一條
> 「Grafana webhook → Node 導播 → Edge TTS → WebSocket → 自架 React 頁的 3D VRM avatar」的推播管線。
> 那個播報頁與人實際盯著的 dashboard 是分離的，等於沒人看。
> ADR-004 把它翻成 panel plugin，讓吉祥物直接住進 dashboard。
> 舊架構的程式碼已刪除（不封存），`git log` 找得回來。

## 狀態

**P2–P4 完成**：腳手架併入、`src/core/` 遷入、舊管線刪除、來源層與語音層接通、
跨 panel 互動層與 `AvatarController` 介面就位。**5 個 POC gate 全數 PASS。**
60 個測試、9 個 suite，116 條 sprite 工具自測。commit 閘共 **9 道**：typecheck / lint / .js 後綴 / monitoring 設定 / bundle 相依 / sprite 驗收 / sprite 工具自測 / Grafana 版本 / jest。

**P5 的工具側完成、素材側未開工**：精靈圖規格（`docs/sprite/sprite-sheet-spec.md`）、
製作 SOP、SP-7 的機械驗收腳本、SP-V.1 的方向辨識盲測頁都已就位並自測通過。
**缺的是畫** —— 那需要一個會用分層繪圖軟體的人，見 `docs/handoff/remaining-plan.md` 的 B2。

**所以還沒有精靈圖** —— avatar 目前是 `DiagnosticAvatar`，它把契約的四個輸入
（表情／講話／視線格／張口幅度）畫成儀表，**刻意長得不像吉祥物**，
免得有人把它誤認成未完成的角色設計。
`SpriteController` 會是同一介面的第二個實作，屆時只換 class、上層一行不動。

## ADR（決策權威，`docs/adr/`）

| ADR | 主題 | 狀態 |
|---|---|---|
| **ADR-004** | **改為 Grafana Panel Plugin**（2D 精靈圖 + Web Speech，零後端） | **Accepted**（2026-09-18） |
| ADR-001 | SOC 播報架構（Node 導播 + WS + VRM avatar） | Superseded |
| ADR-002 | 表情導播 + lip-sync + `AvatarController` 介面 | Superseded |
| ADR-003 | 前端 visual-web-stack | Superseded |

ADR-004 的 5 個 POC gate 全數 PASS 後才升 Accepted —— 它先前刻意停在 `FIRM`，
是為了不讓「POC 一個都沒跑」被狀態值掩蓋。機械證據回填在該檔的 Verification Evidence。

ADR-002 有兩個抽象被 ADR-004 **明文繼承**，不隨 supersede 作廢：
`BroadcastPlan` 事件契約、`AvatarController` avatar-agnostic 介面。

## 開發

```bash
npm install
npm run dev          # webpack watch，產出 dist/
npm run server       # build + 起 monitoring/ 的 Grafana（Loki 預設不啟，見埠表）
npm run test:unit    # jest
npm run typecheck
npm run lint

# sprite 交付相關（素材未進來之前也都能跑）
npm run check:sprites           # SP-7 素材驗收；未交付時印 NOT-DELIVERED 並回 0
npm run check:sprites:selftest  # 上面那支自己的回歸測試（合成基準 + 逐條變異體）
npm run blindtest               # SP-V.1 方向辨識盲測頁 → http://localhost:8787/
npm run blindtest:fixture       # 產編號假 sheet，用來驗盲測頁本身
```

開發環境開在 **http://127.0.0.1:3002**（不是 3000，見下）。

> ⚠️ **第一次跑之前**：`cp monitoring/.env.example monitoring/.env`。
> `monitoring/docker-compose.yml` 有 `env_file: ./.env`，缺這個檔 `docker compose` 會直接失敗。
>
> ⚠️ **先 `npm run build` 再起 Grafana。** compose 掛的是 `../dist`，那是**建置產物**；
> 沒建置過的話目錄不存在，Grafana 會正常起來、UI 進得去，就是選單裡沒有這個 plugin，
> 而且**不會有任何錯誤訊息**。`npm run server` 已經把 build 串在前面，直接用它最省事。
>
> （2026-09-21 起 compose 是 Grafana **13.2.2**、已掛 `../dist`、已開 unsigned 白名單，
> 並有一份 provisioned 的 POC dashboard。先前這裡寫的「P3 之前裝不起來」已經過期。）

### 埠約定（重要）

`monitoring/` 的埠是**刻意避開 3000** 的 —— 本機還有其他 stack 綁著 3000。

| 服務 | 對外 | 容器內 |
|---|---|---|
| Grafana | `127.0.0.1:3002` | 3000 |
| Prometheus | `127.0.0.1:9091` | 9090 |
| Loki | `127.0.0.1:3101` | 3100（`profiles: ["security"]`，預設不啟） |

e2e 要指過去：`GRAFANA_URL=http://localhost:3002 npm run e2e`。

### 只有一套開發環境

腳手架預設會給一份根層 `docker-compose.yaml` 與 `provisioning/`，**本專案刻意沒有落地它們**。
開發環境只有 `monitoring/` 一套，`npm run server` 指向它。三個理由：

1. G-ADR004-2／-3 要驗的是**真告警**，需要真 Prometheus 與真 alert rule；腳手架配的 TestData 資料源結構上驗不出來。
2. `.config/docker-compose-base.yaml` 是 `user: root` 且掛 `..:/root/augur-mascot-panel` ——
   併進本 repo 後等於把含 `.env` 的整棵樹掛進一台匿名 Admin 的 Grafana。
3. 兩套 Grafana 並存會讓「plugin 到底裝在哪一台」變成常態性困惑 ——
   P3 把掛載加到 `monitoring/` 之後，答案必須只有一個。

`.config/docker-compose-base.yaml` 與 `.config/Dockerfile` 因此是**刻意閒置**的託管檔，不要 extends。

### 禁止手改 `.config/`

`.config/` 由 `@grafana/create-plugin` 託管（`npx @grafana/create-plugin update` 會處理它）。
要擴充就改根層的 wrapper：`tsconfig.json`、`eslint.config.mjs`、`jest.config.js`、
`.prettierrc.js`、`playwright.config.ts`。

手改 `.config/` 的後果**不是「被覆寫」而是「靜默失效」** —— migration 全是
`if (!AST match) return` 的早退，改壞比對點就會被無聲 skip，而你不會收到任何訊息。

## 這個 repo 的其他目錄

| 目錄 | 是什麼 |
|---|---|
| `src/core/` | 來源中立的核心邏輯（273 行）：`ParsedAlert` 型別、嚴重度排名、表情映射、播報文字組句、去重防洪。**零瀏覽器/Node 相依**，從舊架構整包繼承。 |
| `monitoring/` | docker-compose 開發環境 + 8 條 Windows 主機 alert rule（3 條效能、5 條 Loki 事件） |
| ~~`assets/`~~ | **已於 2026-09-21 退出版控** —— 出處查不到，依 `docs/asset-provenance.md` 自訂的規則移除。角色定義改由 `live2d-template-spec-v1.md` §7 的文字描述 + `sprite-sheet-spec.md` SP-6.0 的色票表承擔，兩者都是本專案自己的產物。 |
| `live2d/_archive/` | 已廢棄的 Live2D 路線。**但 `live2d-template-spec-v1.md` §6 仍在用** —— 它定義了 calm/warning/critical/resolved 四個表情的視覺語意，是 sprite 反應圖的內容大綱。 |
| `avatar/` | VRM / THA 選型研究備忘錄（歷史，已不在關鍵路徑） |
| `tools/` | `asp-test.sh`（commit 閘：typecheck + lint + js-suffix + sprite + jest）、`check-js-suffix.sh`、`check-sprite-sheets.mjs`（SP-7 素材驗收，零依賴）、`lib/`（手寫 PNG / GIF 編解碼與檢查邏輯）、`blind-test/`（SP-V.1 方向辨識盲測頁） |
| `docs/sprite/` | 精靈圖規格（`sprite-sheet-spec.md`）、製作 SOP、manifest 樣板。**發包給畫師時給這三份。** |
| `docs/handoff/` | `remaining-plan.md` —— 未完成項目的執行計畫，分「現在能做」與「卡在人」兩部分 |

### 為什麼 `dedup.ts` 在 pull 模型下更重要

push 模型下它防的是「Grafana 週期重送 firing」。
panel plugin 是 pull —— **每個 refresh interval（預設 30s）都會重新評估告警狀態**，
沒有防洪就會每 30 秒把同一則念一次。

### 一個會騙人的坑

`src/` 內的相對 import **不可以帶 `.js` 副檔名**。
webpack 的 `resolve.extensions` 沒有 `extensionAlias`、jest 的 `moduleNameMapper` 也不映，
兩者都解不到；但 `tsc` 會把 `.js` 自動對映回 `.ts`，所以 **`npm run typecheck` 永遠是綠的**。
真正抓得到的是 jest。`tools/check-js-suffix.sh` 就是為此而存在。

### 另一個會騙人的坑

`tools/check-sprite-sheets.mjs` 與它的 lib **不得呼叫任何 git 指令**。
理由不是潔癖：`git` 的任何一個子命令都會刷新 `.git/index` 的 mtime，
而 ASP 閘門的判定是「`.asp-test-result.json` 不得比 `.git/index` 舊」。
sprite 檢查很容易想用 `git ls-files` 去找素材 —— 那會讓整個 commit 閘無聲失效。
`check-sprite-sheets.selftest.mjs` 有一條測試在釘這件事（剝掉註解後 grep）。

## 治理

本 repo 受 ASP 治理。提交前的測試痕跡由 `tools/asp-test.sh` 產生，
**順序不能換**：`git add -A` → `bash tools/asp-test.sh` → 立刻 `git commit`。
中間插入任何 `git status` / `git diff` 都會刷新 `.git/index` 的 mtime 而讓閘門判定失效。
