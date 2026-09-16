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

**P2 完成**：腳手架併入、`src/core/` 遷入、舊管線刪除。
**plugin 目前還是腳手架的預設畫面** —— 吉祥物、語音、視線追蹤都還沒實作（P4）。
ADR-004 的 5 個 POC gate（G-ADR004-1～5）一個都還沒跑。

## ADR（決策權威，`docs/adr/`）

| ADR | 主題 | 狀態 |
|---|---|---|
| ADR-001 | SOC 播報架構（瀏覽器 avatar + TS 導播 + React） | Accepted（待 ADR-004 定案後轉 Superseded） |
| ADR-002 | 表情導播 + lip-sync + `AvatarController` 介面 | 同上 |
| ADR-003 | 前端 visual-web-stack | 同上 |
| **ADR-004** | **改為 Grafana Panel Plugin**（2D 精靈圖 + Web Speech，零後端） | **FIRM** |

ADR-004 supersede 前三份，但**要等它自己升 Accepted** 才生效 —— 在那之前前三份仍掛 Accepted。
ADR-004 升 FIRM 而非直升 Accepted，是為了不讓「POC 一個都沒跑」被狀態值掩蓋。

ADR-002 有兩個抽象被 ADR-004 **明文繼承**，不隨 supersede 作廢：
`BroadcastPlan` 事件契約、`AvatarController` avatar-agnostic 介面。

## 開發

```bash
npm install
npm run dev          # webpack watch，產出 dist/
npm run server       # build + 起 monitoring/ 的 Grafana（含 Prometheus/Loki）
npm run test:unit    # jest
npm run typecheck
npm run lint
```

開發環境開在 **http://127.0.0.1:3002**（不是 3000，見下）。

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
3. 兩套 Grafana 並存只會讓「plugin 到底裝在哪一台」變成常態性困惑。

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
| `src/core/` | 來源中立的核心邏輯（268 行）：`ParsedAlert` 型別、嚴重度排名、表情映射、播報文字組句、去重防洪。**零瀏覽器/Node 相依**，從舊架構整包繼承。 |
| `monitoring/` | docker-compose 開發環境 + 8 條 Windows 主機 alert rule（3 條效能、5 條 Loki 事件） |
| `assets/` | Augur 角色立繪與 l2d-factory 拆出的分層 PNG（sprite 素材來源） |
| `live2d/_archive/` | 已廢棄的 Live2D 路線。**但 `live2d-template-spec-v1.md` §6 仍在用** —— 它定義了 calm/warning/critical/resolved 四個表情的視覺語意，是 sprite 反應圖的內容大綱。 |
| `avatar/` | VRM / THA 選型研究備忘錄（歷史，已不在關鍵路徑） |
| `tools/` | `check-js-suffix.sh`（守門）、`asp-test.sh`（產 ASP 閘要的測試痕跡） |

### 為什麼 `dedup.ts` 在 pull 模型下更重要

push 模型下它防的是「Grafana 週期重送 firing」。
panel plugin 是 pull —— **每個 refresh interval（預設 30s）都會重新評估告警狀態**，
沒有防洪就會每 30 秒把同一則念一次。

### 一個會騙人的坑

`src/` 內的相對 import **不可以帶 `.js` 副檔名**。
webpack 的 `resolve.extensions` 沒有 `extensionAlias`、jest 的 `moduleNameMapper` 也不映，
兩者都解不到；但 `tsc` 會把 `.js` 自動對映回 `.ts`，所以 **`npm run typecheck` 永遠是綠的**。
真正抓得到的是 jest。`tools/check-js-suffix.sh` 就是為此而存在。

## 治理

本 repo 受 ASP 治理。提交前的測試痕跡由 `tools/asp-test.sh` 產生，
**順序不能換**：`git add -A` → `bash tools/asp-test.sh` → 立刻 `git commit`。
中間插入任何 `git status` / `git diff` 都會刷新 `.git/index` 的 mtime 而讓閘門判定失效。
