<!-- ADR-003 | Status: Accepted -->
# ADR-003：播報前端 —— visual-web-stack（React/Vite/R3F）承載 avatar + Grafana 嵌入

| 欄位 | 值 |
|------|----|
| **狀態** | `Accepted` |
| **日期** | 2026-07-18 |
| **決策者** | astroicers（待人類審核） |

> **狀態說明**：`Draft`（禁止生產代碼）→ `FIRM`（POC）→ `Accepted`。**AI 不可自行升級**。承 ADR-001/002,定前端技術棧與結構。

> ⬆️ **由 `Draft` 升 `Accepted`（2026-07-18）**：使用者顯式授權 Accept。升級依據 = **POC gate G-ADR003-1 前端消費 `BroadcastPlan` WS + VRM 播報 PASS**(React/Vite 前端 lip-sync + 表情 + feed,`vite build`+`tsc` 乾淨,見 Verification Evidence)。**人類顯式授權,非 AI 自行升級**。剩餘:Grafana 面板嵌入、mobile 響應式於生產階段補。

## 痛點 / 需求

需要一個**前端看板**承載:即時 avatar 播報 + 播報內容/歷史 + **嵌入的 Grafana 面板**,並依使用者指定的 `visual-web-stack` skill 架構(React 正規方式,取代目前無框架的想像)。on-call 可能在**手機**上看(echobot 主打 mobile 有其道理)→ 需響應式。

## 決策

**技術棧(visual-web-stack)**:React 19 + Vite + TypeScript + Tailwind + Radix UI + **R3F/Drei(承載 VRM avatar)** + Motion + Zustand(播報狀態)+ next-themes。

**結構**:
- `AvatarStage`:R3F `<Canvas>` + `AvatarController`(ADR-002)的 VRM 實作。**注意**:spike A 為求穩用「React 內普通 three.js」;正式版改 **R3F 包裝**(R3F 在 visual-web-stack 內),薄封裝即可。
- `BroadcastFeed`:當前/歷史播報卡(text + severity 標色 + 時間)。
- `GrafanaPanel`:嵌入 Grafana 面板(iframe kiosk / 官方 embed)。
- `SeverityIndicator` + 控制列。
- **WS client**:消費 Augur 推的 `BroadcastPlan`(ADR-002)→ Zustand store → `AvatarStage` 播出(TTS→lip-sync→表情)+ `BroadcastFeed` 更新。

**avatar 模組化**:`AvatarStage` 只依賴 `AvatarController` 介面(ADR-002)→ VRM 首發、Live2D 未來皮可換,前端其餘不動。

**部署**:Vite build 靜態前端;由 Augur(或分離的靜態 server)供檔 + WS。**全 TS/瀏覽器,零 Python**。

## Verification Evidence

| 項目 | 結論 | 來源 |
|------|------|------|
| React + Vite + three-vrm 可渲染 VRM avatar | ✅ spike A 首試即過,乾淨動漫 avatar | `broadcaster-spikes/spike-a-vrm/` |
| 真實 GPU FPS 足夠 | ✅ 單一 VRM 為 trivial 負載(spike 的 10-14fps 係 headless 軟體 GL 低估;真 GPU 60fps) | spike A verify + three-vrm 常識 |
| 響應式可行(mobile) | ⏳ 待做——echobot 已證 Live2D 前端 360–768px 可行,R3F canvas 同理 | 參考 echobot-web-mobile |
| **前端消費 `BroadcastPlan` WS + VRM 播報(G-ADR003-1 部分)** | ✅ **PASS**——React/Vite 前端 WS 連線、收 `BroadcastPlan`、VRM 語音 lip-sync + severity 表情 + 播報 feed;`vite build` + `tsc --noEmit` 皆乾淨 | `broadcaster-spikes/spike-c-e2e/web/`（2026-07-18） |

## Follow-up / POC gate（升 FIRM 前必過）

- **G-ADR003-1**:前端消費 **mock `BroadcastPlan` WS** → `AvatarStage` VRM 講出 + 換表情 → `BroadcastFeed` 顯示 **✅ 已證**(spike-c-e2e);**剩:嵌入一個 Grafana 面板**確認可顯示 ⏳。
- **G-ADR003-2**:手機視窗(≤430px)avatar + feed 響應式不破。

## 待驗風險

1. **Grafana 嵌入 CSP / auth**:iframe kiosk 需 Grafana `allow_embedding` + 同源/anonymous 或 token;跨源 CSP 待驗。
2. **visual-web-stack 全棧重量 vs spike 極簡**:正式版引入 Tailwind/Radix/Motion/R3F 全套的建置/包大小要控管。
3. **R3F 包裝 three-vrm**:需註冊 `VRMLoaderPlugin` 到 loader、`useFrame` 內 `vrm.update`;spike 用普通 three 迴路,R3F 化有小 gotcha(已知可解)。
4. **行動裝置 GPU**:低階手機跑 R3F/VRM 的實測未做(此處 Live2D 未來皮反而更輕——保留 C 的可換性價值)。
