# Augur (`airi-ops-bridge`)

把運維系統的告警/事件正規化後推給桌面 AIRI，讓角色用語音講出來，成為 SOC 的環境感知幫手。
**現階段只實作 Grafana 一個來源**（架構預留之後可再接 Splunk/Kibana，但現在不蓋通用框架）。

## 架構（一條主幹）

```
Grafana Alerting ──webhook──► Augur ──input:text(WS)──► AIRI 桌面版
                              (正規化→過濾→格式)          (LLM brain + TTS → 角色語音)
```

- 來源系統負責「偵測」、Augur 負責「正規化/翻譯/傳遞」、AIRI 負責「表達」。
- 唯一抽象邊界是 `src/core/types.ts` 的 `ParsedAlert`。

## 技術選型

Node.js (LTS) + TypeScript、Hono、`@proj-airi/server-sdk`（pin `0.10.2`）、pnpm。去重狀態用記憶體即可（Phase 2）。

## 專案結構

```
src/
  index.ts          進入點：載 config → 連 AIRI → 啟動 server
  server.ts         HTTP 接收層（目前只有 /grafana/webhook）
  sources/grafana.ts  Grafana adapter：webhook → ParsedAlert[]
  core/types.ts     ParsedAlert（來源中立的邊界）
  core/format.ts    ParsedAlert → 給角色講的訊息字串
  airi.ts           AIRI sink：server-sdk 封裝，speakAlert()
  config.ts         環境變數集中管理
scripts/airi-smoke.ts   Phase 0 連線/講話驗證
scripts/mock-grafana.ts 擬真 Grafana 告警注入器（測 AIRI 播報，免真實 Grafana）
docs/airi-runbook.md    AIRI / LLM / Grafana 手動設定記錄（已驗證）
```

> 加新來源（後期）：在 `sources/` 新增一檔實作「該來源格式 → ParsedAlert」，在 `server.ts` 掛路由。`core/` 與 `airi.ts` 不用改。

## 快速開始

```bash
pnpm install
cp .env.example .env     # 依 docs/airi-runbook.md 填 AIRI_WS_URL / AIRI_AUTH_TOKEN / WEBHOOK_SECRET / ALERT_LANG
pnpm smoke               # Phase 0：驗證能連上 AIRI 且角色開口念測試語音
pnpm dev                 # 啟動接收層（tsx watch）
pnpm mock                # 另開終端：注入 5 筆擬真告警，看角色逐筆念出
```

## 驗證

**Phase 0**：`pnpm smoke` → 角色念出測試語音；Grafana contact point 按 Test → Augur 回 200 並 log 出 body。

**Phase 1（本地不需真實告警即可驗主幹）**：

```bash
# 起 server 後，用範例 payload 打進去
source .env
curl -s -X POST http://127.0.0.1:3001/grafana/webhook \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  --data @docs/sample-grafana-firing.json
# → 角色念出「偵測到告警：High CPU Usage，嚴重度 critical，受影響對象 prod-db-01，目前數值 95.20，CPU 使用率超過 90%。」
```

真實告警 firing 時，角色應在數秒內念出合理語音摘要。錯/缺 secret → 401。

> **播報語言**：`ALERT_LANG=zh|en`（預設 zh）。AIRI 端若只有英文 TTS 聲線（如本機 Kokoro），設 `en` 讓告警以英文唸出。
> **最快驗證**：起 `pnpm dev` 後另開終端 `pnpm mock`，送 5 筆擬真告警走完整 webhook→adapter→format→AIRI 流程，角色逐筆唸出（設定細節見 [docs/airi-runbook.md](docs/airi-runbook.md)）。

## 範圍

- ✅ Phase 0（環境準備可交付物）+ Phase 1（MVP 主幹）
- ⏭️ Phase 2（severity 過濾、去重防洪、resolved 通知）、Phase 3（AIRI 接 Grafana MCP 的對話式查詢，不在本專案程式內）
