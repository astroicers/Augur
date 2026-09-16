# Augur — 架構總覽

> **Augur ＝ Grafana 告警 → 會講話有表情的動漫 avatar 播報**（SOC 資安氛圍播報 runtime）。
> 原 `airi-ops-bridge`（Grafana→文字→AIRI 橋），已升級為**瀏覽器 avatar 播報**。
>
> 本檔是**概覽**；每個決策的「為什麼」以 `docs/adr/` 為權威。**維護規則見文末。**
> 最後更新：2026-07-18。

## 一句話

Grafana webhook 進來 → 過濾/去重/格式化 → 產「播報計畫」`BroadcastPlan{text,severity,emotion}` →
Edge TTS 合成中文語音 → WebSocket 推前端 → **VRM/Live2D avatar 講出 + 依 severity 換表情 +
振幅 lip-sync + 播報 feed**。live 迴路**零 Python**。

## 資料流 / 架構

```
Grafana Alerting ──webhook(JSON)──▶ 導播（backend, Node/TS, Hono）
  POST /grafana/webhook  [:3001, bearer auth, async-200 → queueMicrotask]
     └ src/sources/grafana.ts   parseGrafanaWebhook → ParsedAlert[]
     └ src/core/severity.ts     meetsMin 過濾（firing）
     └ src/core/dedup.ts        同 fingerprint 防洪 + resolved 綁定
     └ src/core/format.ts       buildBroadcastPlan：formatAlert(text) + emotion
     └ src/core/emotion.ts      severityToEmotion（Live2D spec §6 映射；error→critical）
     └ src/tts/edgeTts.ts       createEdgeTTS（msedge-tts）→ base64 mp3
     └ src/sink/broadcastSink.ts  ws WebSocketServer [:3002] + TTS
            ▼ {type:'broadcast', plan, audio}（推所有前端）
  React 前端（web/, Vite + TS + Tailwind + Zustand）
     ├ src/avatar/AvatarController.ts   介面（avatar-agnostic；choice C 可換）
     ├ src/avatar/VrmController.ts      three-vrm 實作（含 T-pose→自然垂手）
     ├ src/avatar/Live2DController.ts   pixi-live2d-display 實作（未來 2D 皮）
     ├ src/avatar/AvatarStage.tsx       canvas + Web Audio(decodeAudioData→BufferSource
     │                                   →analyser 振幅 lip-sync) + 播報佇列
     ├ src/hooks/useBroadcastSocket.ts  WS 客戶端（收播 + dev-trigger）
     ├ src/store/broadcastStore.ts      Zustand（connected/emotion/severity/feed）
     └ src/components/                  SeverityIndicator / BroadcastFeed / GrafanaPanel(選配 iframe)

monitoring/  docker-compose：Grafana/Prometheus/Loki/Alloy + 告警規則 + webhook contactpoint
```

## 功能

- Grafana 告警即時語音播報（中文，Edge TTS `zh-TW-HsiaoChenNeural`）。
- severity → 表情（calm/warning/critical/resolved）+ 振幅 lip-sync。
- **avatar 可換**：`?avatar=vrm`（預設，three-vrm）/ `?avatar=live2d`（pixi-live2d + Hiyori）。
- 多告警**佇列**（逐則播、不疊音/截斷）；**mobile 響應**；選配 **Grafana 面板嵌入**。
- dev「測試播報」鈕（`ALLOW_DEV_TRIGGER` 控制，生產應關）。

## 關鍵設計（DI / 邊界）

- **後端 DI 乾淨**：`createServer(config, sink, dedup)`；sink 可抽換（`src/airi.ts` 保留 dormant，ADR-008 Superseded）。
- **avatar 抽象**：前端只依賴 `AvatarController` 介面 → 換 VRM/Live2D 不動 App/WS/lip-sync。
- **WS 分離埠**：Hono 守 webhook `:3001`、`ws` WebSocketServer 給前端 `:3002`。
- config 全 env（見 `.env.example`）。

## 設定（env）

`WEBHOOK_SECRET`(必) · `HOST`/`PORT`(3001) · `WS_PORT`(3002) · `ALERT_LANG`(zh) ·
`TTS_VOICE`(空=依 lang) · `ALLOW_DEV_TRIGGER`(dev true/生產 false) · `MIN_SEVERITY` ·
`DEDUP_WINDOW_SEC`(300) · `AIRI_*`(legacy/dormant, 選填)。前端：`VITE_WS_URL` · `VITE_GRAFANA_PANEL_URL`(選配)。

## ADR 索引（決策權威，`docs/adr/`）

| ADR | 主題 | 狀態 |
|---|---|---|
| ADR-001 | SOC 播報架構（瀏覽器 avatar + TS 導播 + React；替換 AIRI） | Accepted |
| ADR-002 | 表情導播 + lip-sync + `AvatarController` 可換介面 | Accepted |
| ADR-003 | 前端 visual-web-stack（React/Vite/Tailwind/Zustand） | Accepted |
| ADR-004 | **改為 Grafana Panel Plugin**（2D 精靈圖 + Web Speech，零後端）—— supersede ADR-001/002/003 | **Draft** |

> ⚠️ **ADR-004 為 `Draft`，尚未生效。** 定案前上表前三份仍是現行決策，本檔描述的架構仍然有效。
> ADR-004 一旦由人類授權升 Accepted，前三份轉 Superseded，本檔需整份重寫（資料流圖全數作廢）。

## 技術棧

Node + TypeScript · Hono + @hono/node-server · `ws` · `msedge-tts`（Edge TTS）·
React 18 + Vite + Tailwind + Zustand · `@pixiv/three-vrm` / `pixi-live2d-display-lipsyncpatch` ·
`node:test`（backend 20 測試）· pnpm。

## 與 l2d-factory 的關係

**分離 repo、鬆耦合**。l2d-factory ＝上游 2D 素材產線；Augur ＝播報 runtime。
現行 VRM avatar 由 VRoid 製作，**l2d 不在播報關鍵路徑**。未來若走 Live2D 皮（ADR-009 hand-rig 模板），
l2d 的 `character.psd`（canonical 512 框 + namei taxonomy）rig 成 moc3 → Augur `?avatar=live2d` 換皮。

## 待辦 / 已知限制

- viseme v1（母音精準嘴型）：需有 phoneme 時戳的 TTS（如 Azure，需金鑰）；現為 v0 振幅。
- WS token auth：WS 曝露於 localhost 之外時應加（現靠 `HOST` 綁定 + `ALLOW_DEV_TRIGGER`）。
- Grafana 面板嵌入 CSP：需 Grafana `allow_embedding = true`。

---

## 維護規則

- **決策改變 → 先動 ADR**（新增/supersede `docs/adr/`），再回頭同步本檔的「架構/功能/ADR 索引」。ADR 是權威,本檔是導覽。
- 動到 seam（新 source/sink/avatar controller、config、埠、資料流）時**同步更新對應區塊 + 檔案路徑**，並更新檔頭「最後更新」日期。
- 新增 avatar 格式 → 實作 `AvatarController` + 更新「avatar 可換」與資料流圖。
- 保持與 `README.md`（root）/ `web/README.md`（前端）/ `.env.example` 一致（設定表以 `.env.example` 為準）。
