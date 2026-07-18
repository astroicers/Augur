# Augur Web — SOC 播報前端

visual-web-stack（React + Vite + TS + Tailwind + Zustand）。連上導播 WS（`:3002`）接收
`BroadcastPlan`，用瀏覽器 avatar（VRM / Live2D）做 TTS 振幅 lip-sync + severity→emotion
表情 + 播報 feed。實作 ADR-001 / 002 / 003。

## 開發

```bash
pnpm install
bash scripts/fetch-assets.sh   # 下載 avatar 資產（不進 git：VRM / Cubism Core / Hiyori）
pnpm dev                       # http://localhost:5173
```

需要導播（backend）在跑：`cd .. && pnpm dev`（webhook `:3001` + 前端 WS `:3002`）。
灌告警：`cd .. && pnpm mock`，或用頁面上的「測試播報」鈕（dev-trigger）。

## 切換 avatar（ADR-002 choice C：可換）

- `?avatar=vrm`（預設，`@pixiv/three-vrm`）
- `?avatar=live2d`（`pixi-live2d-display` + Hiyori；需先跑 `fetch-assets.sh`）

avatar 由 `src/avatar/AvatarController` 介面抽象，App / WS / lip-sync 不變、只換 controller。

## 結構

- `src/avatar/`：`AvatarController`（介面）、`VrmController` / `Live2DController`（實作）、`AvatarStage`（canvas + 音訊圖 + RMS→嘴迴圈）。
- `src/store/broadcastStore.ts`：Zustand（連線/嚴重度/feed）。
- `src/hooks/useBroadcastSocket.ts`：導播 WS（收 broadcast、送 dev-trigger）。
- `src/components/`：`SeverityIndicator`、`BroadcastFeed`。
