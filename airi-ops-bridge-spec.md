# Augur（`airi-ops-bridge`）— AIRI 運維事件語音橋接層 — Spec & Roadmap

> **一句話:** 把各種運維系統的告警/事件,正規化後推給桌面 AIRI,讓角色用語音講出來,成為 SOC 的環境感知幫手。
> **Grafana 是第一個來源**,架構設計成之後可再接 Splunk、Kibana 等,但**現階段只實作 Grafana**。
>
> 專案名稱 `Augur` 是佔位 codename(可換)。技術識別用 `airi-ops-bridge`。商業階段若要正式命名,請避開已被佔用的名字(例如 Sentinel = Microsoft Sentinel)。

---

## 0. 給 Claude Code 的話(請先讀)

- **先解決第 10 節「調查項目」**,裡面有幾個 API/位址細節需要你去讀原始碼/設定確認,不要用猜的。
- 嚴格照第 12 節 Roadmap 分階段做,**先把 Phase 1 主幹跑通**(一條 Grafana 告警能讓角色開口),再加料。
- **務必遵守第 3 節「設計原則」**——特別是「現在只做 Grafana 一個 adapter,不要蓋通用外掛框架」。名稱雖然是泛用的,但這不是要你現在就抽象化。

---

## 1. 這個專案是什麼(目的)

**它不是一套「AI 監控系統」,而是一個可插拔來源的「事件 → 語音」轉接層。** 三方各司其職:

| 角色 | 負責 | 由誰做 |
|---|---|---|
| 來源系統(Grafana…) | **偵測**:閾值、評估頻率、什麼叫「大數值變化」 | 來源系統原生 alerting,不重做 |
| 本專案(Augur) | **正規化 + 翻譯 + 傳遞**:接住事件,轉成統一格式,推給 AIRI | 你要寫的東西 |
| AIRI | **表達**:用角色語音講出來,並可被追問 | AIRI 桌面版,現成 |

更高層的說法:你在做的是**讓 AIRI 成為運維系統的「語音前端 / 感知層」**。AIRI 本來對你的系統一無所知,這個專案就是讓它「感知到外面發生什麼事」的那條線。

---

## 2. 專案定位與分期

- **前期(現在做):自己 SOC 內部用的工具。** 目的是跑通,並驗證「AIRI 當地基」值不值得(AIRI 跟著更新穩不穩、語音播報是幫手還是噪音)。
- **後期:商業產品。** 賣給客戶。

**對 Claude Code 的影響:** 現在要的是「**跑通 + 產品化友善的結構**」,但**不要為後期過度工程**——不做 provisioning 自動化、不做打包安裝、不做多租戶。那些全部留到後期。

---

## 3. 設計原則(重要 — 避免過度設計)

1. **名稱泛用,實作收窄。** 名稱涵蓋多來源,但**現在只實作 Grafana 一個 adapter**。
2. **不要蓋通用「來源外掛框架」**,直到有第二個真實來源在推這個設計。先做一個、再做第二個,有了兩個真實案例才知道該怎麼抽象。
3. **唯一的抽象邊界是 `ParsedAlert`。** adapter 只做「來源格式 → `ParsedAlert`」;core 只吃 `ParsedAlert`,完全不認得來源是誰。日後加來源 = 在 `sources/` 下新增一個檔,其餘不動。
4. **不要 fork / 改 AIRI 原始碼。** AIRI 當成 pin 住版本的外部相依,只用 `server-sdk` + MCP 這層公開介面。為了內部工具去改 AIRI 內部,會養出維護分支,後期升級全卡死。
5. **所有部署相關的值放 config,不寫死**(AIRI 位址、Grafana URL、secret、門檻)。

---

## 4. 範圍 (Scope)

**In scope(本次):**
- HTTP 接收層
- **Grafana adapter**(webhook → `ParsedAlert`)
- 核心:正規化、訊息格式、(Phase 2)去重/路由/限流
- AIRI sink:透過 `@proj-airi/server-sdk` 推送,觸發語音
- 嚴重度過濾、去重防洪、resolved 通知
- (Phase 3)把 AIRI MCP 模組接上 Grafana MCP server,做對話式即時查詢

**Out of scope(這次不做,但結構要預留):**
- Splunk / Kibana 等其他來源(架構相同,日後在 `sources/` 加 adapter)
- AIRI provisioning 自動化、打包/安裝程式、多租戶、reskin(全是後期商業階段)
- 自建排程輪詢(定時由來源的 alert rule 評估頻率負責)
- 用視覺(vision)讀面板數字 ← 明確不採用,精確數值一律走 API/webhook

---

## 5. 架構 (Architecture)

```
  可插拔來源(現在只有 Grafana)
┌──────────────┐
│   Grafana    │─┐  webhook
│  Alerting    │ │  (JSON)
└──────────────┘ │
┌──────────────┐ │            ┌─────────────────────────┐  server-sdk  ┌──────────────┐
│ Splunk(後期) │─┼──POST────► │        Augur 核心        │ ────push───► │  AIRI 桌面版  │
└──────────────┘ │            │ sources → ParsedAlert    │  (WebSocket) │ LLM + TTS     │
┌──────────────┐ │            │ → 過濾/去重/格式 → sink   │              │  → 角色語音    │
│ Kibana(後期) │─┘            └─────────────────────────┘              └──────────────┘
└──────────────┘

                          (Phase 3,獨立的第二條線)
┌──────────────┐    MCP        ┌──────────────┐
│ Grafana MCP  │ ◄───────────► │ AIRI MCP 模組 │   ← 你開口問,即時撈值回答
│   server     │   query       │              │     (這條是 AIRI 自帶能力,不在本專案)
└──────────────┘               └──────────────┘
```

兩條線彼此獨立:
- **告警推送(主幹,本專案):** 單向,來源主動觸發 → 你被通知。
- **對話式查詢(Phase 3):** 雙向,你主動問 → AIRI 的 MCP 模組直接連 Grafana MCP server。**這條不在本專案程式裡**,你只是去設定 AIRI 要連哪。

---

## 6. 技術選型 (Tech Stack)

- **Runtime:** Node.js (LTS) + TypeScript
- **HTTP framework:** Hono(輕量、現代);偏好 Express 亦可
- **AIRI 整合:** `@proj-airi/server-sdk`
- **套件管理:** pnpm
- **狀態:** MVP 不需資料庫,去重狀態用記憶體(`Map<fingerprint, timestamp>`)即可

---

## 7. 專案結構 (Project Structure)

```
airi-ops-bridge/
├── src/
│   ├── index.ts          # 進入點:載 config → 連 AIRI → 啟動 server
│   ├── server.ts         # HTTP 接收層 + 路由(目前只有 Grafana webhook route)
│   ├── sources/
│   │   └── grafana.ts     # Grafana adapter:webhook payload → ParsedAlert(目前唯一)
│   ├── core/
│   │   ├── types.ts       # ParsedAlert 等核心型別(來源中立的「邊界」)
│   │   ├── format.ts      # ParsedAlert → 給角色講的訊息字串
│   │   └── dedup.ts       # (Phase 2) 去重 / 限流
│   ├── airi.ts            # AIRI sink:server-sdk 封裝,speakAlert()
│   └── config.ts          # 環境變數集中管理
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

| 路徑 | 職責 |
|---|---|
| `index.ts` | 載 config → 連 AIRI(`airi.ts`)→ 啟動 HTTP server(`server.ts`) |
| `server.ts` | HTTP 接收層;開路由,驗 secret,把 body 交給對應 source adapter,再丟核心處理。目前只掛 `POST /grafana/webhook` |
| `sources/grafana.ts` | **Grafana adapter**:把 Grafana webhook JSON 轉成 `ParsedAlert[]`。這是唯一認得 Grafana 格式的地方 |
| `core/types.ts` | `ParsedAlert` 與相關型別。這是 adapter 與 core 之間的契約 |
| `core/format.ts` | `ParsedAlert` → 一句精簡訊息。**保持笨**:不接 LLM,自然語氣交給 AIRI |
| `core/dedup.ts` | Phase 2:同 `fingerprint` 在時間窗內只播一次 |
| `airi.ts` | **AIRI sink**:用 server-sdk 連 AIRI,實作 `speakAlert(text)`(見第 10 節) |
| `config.ts` | 讀 env、驗必填、匯出 typed config |

**加新來源的方法(後期):** 在 `sources/` 新增一個檔(例如 `splunk.ts`),實作「該來源格式 → `ParsedAlert`」,在 `server.ts` 掛上對應的接收路由。`core/` 與 `airi.ts` 完全不用改。這就是整個架構的重點。

---

## 8. 元件規格 (Component Specs)

### 8.1 HTTP 接收層(`server.ts`)
- 起一個輕量 HTTP server,綁 `127.0.0.1` 或內網,不對公網開放
- 目前掛一個路由:`POST /grafana/webhook`
- 驗證:比對 `Authorization` header 與 `WEBHOOK_SECRET`,不符回 `401`
- 流程:收 body → 交 `sources/grafana.ts` 解析 → 對每個 `ParsedAlert` 走核心處理(過濾→去重→格式→sink)
- 永遠快速回 `200`(避免來源重送);實際推送非同步進行,失敗只記 log

### 8.2 Grafana adapter(`sources/grafana.ts`)
- 輸入:Grafana Alerting webhook body(見 9.1)
- 輸出:`ParsedAlert[]`
- 取值規則:
  - `status`:`firing` / `resolved`
  - `name`:`labels.alertname`
  - `severity`:`labels.severity`,缺省 `'unknown'`
  - `instance`:`labels.instance`(可選)
  - `summary`:`annotations.summary`(可選)
  - `value`:從 `values` 取代表性數值(先取第一個數值型)
  - `fingerprint`:每個 alert 的 `fingerprint`(去重用)

### 8.3 核心型別(`core/types.ts`)
- 定義 `ParsedAlert`(見 9.2)。這是 adapter 與 core 唯一的契約,**不得包含任何來源特定欄位**。

### 8.4 訊息格式(`core/format.ts`)
- 輸入:`ParsedAlert`;輸出:一句字串。範例:
  - firing:`「critical 告警:prod-db-01 的 High CPU,CPU 超過 90%,目前 95.2」`
  - resolved:`「prod-db-01 的 High CPU 已恢復」`
- 不接 LLM、不加修飾。語氣自然化交給 AIRI 端模型。

### 8.5 AIRI sink(`airi.ts`)— **見第 10 節**
- `const client = new Client({ name: 'airi-ops-bridge' })`
- `export async function speakAlert(text: string)`:把 `text` 送進 AIRI 觸發語音
- 確切事件/方法與模式選擇是調查項目,見第 10 節

### 8.6 設定(`config.ts` / `.env.example`)
```bash
# .env.example
PORT=8787
WEBHOOK_SECRET=change-me-to-a-long-random-string
AIRI_WS_URL=ws://127.0.0.1:<PORT>   # ⚠️ TBD: 從 AIRI 桌面版設定/原始碼確認實際位址與埠號
MIN_SEVERITY=warning                # Phase 2:只播報 >= 此等級
DEDUP_WINDOW_SEC=300                # Phase 2:同 fingerprint 在此秒數內只播一次
```

---

## 9. 資料契約 (Data Contracts)

### 9.1 Grafana webhook payload(代表性,**請以你環境的實際 payload 為準**)
```jsonc
{
  "receiver": "airi-ops-bridge",
  "status": "firing",                    // firing | resolved
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "High CPU Usage",
        "severity": "critical",          // ← 過濾用
        "instance": "prod-db-01"
      },
      "annotations": { "summary": "CPU usage above 90%" },
      "values": { "B": 95.2 },           // ← 實際數值在此
      "valueString": "[ var='B' value=95.2 ]",
      "startsAt": "2026-06-16T10:00:00Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "abc123def456",     // ← 去重用
      "panelURL": "https://grafana.../d/...",
      "dashboardURL": "https://grafana.../d/..."
    }
  ],
  "commonLabels": { "severity": "critical" },
  "title": "[FIRING:1] High CPU Usage"
}
```

### 9.2 核心型別(來源中立 — 這是契約)
```typescript
interface ParsedAlert {
  status: 'firing' | 'resolved';
  source: string;        // 'grafana'(標記來源,但欄位本身不含來源特定結構)
  name: string;          // 告警名稱
  severity: string;      // 嚴重度,缺省 'unknown'
  instance?: string;     // 受影響對象
  summary?: string;      // 摘要
  value?: number;        // 實際數值
  startsAt: string;
  fingerprint: string;   // 去重 key
  panelURL?: string;     // 可選:回連來源
}
```

### 9.3 送給 AIRI 的內容
- 一段純文字字串(由 `core/format.ts` 產生)
- 是否附帶結構化 metadata,取決於 server-sdk 的能力(見第 10 節)

---

## 10. ⚠️ 調查項目 (Investigation Items — 動手前先解決)

這幾項無法事先確定,請先讀原始碼/文件確認,**不要用猜的**:

1. **server-sdk 的「送訊息讓角色講話」確切 API。**
   - 讀 `@proj-airi/server-sdk` 的型別定義或原始碼,找出 `Client` 連上後,要送哪種事件 / 呼叫哪個方法,才能讓桌面角色把一段文字念出來。
   - **決定模式(二擇一或都支援):**
     - (a) **當成輸入丟給 LLM brain** → 角色用自己的語氣轉述。較自然,適合「研判 + 轉述」。
     - (b) **直接送 TTS 念固定文字** → 內容精確、不經 LLM。較可靠,適合精確告警。
   - 建議預設走 (b) 求穩,(a) 當可選增強。

2. **AIRI 桌面版的 server channel 連線位址與埠號。**
   - 從 AIRI 桌面版設定或原始碼確認 `AIRI_WS_URL` 該填什麼,以及啟動時是否需手動開啟該 channel。

3. **Grafana webhook 的實際 schema。**
   - 各版本略有差異。在 Grafana contact point 用 **Test** 送一包,印出實際 body,以它為準調整 `sources/grafana.ts`。

---

## 11. 安全考量 (Security) — SOC 場景特別重要

- **AIRI 不是 source of truth。** 它會當、會關。真正的 sev1 告警鏈務必留在既有管線(值班 / PagerDuty 等)。AIRI 只是最上層的「語音播報 + 初步研判」,不是唯一通報管道。
- **用本地模型(Ollama),不要把 log 丟雲端 LLM。** 告警內容可能含敏感資訊,本地模型同時解決成本與外洩。
- **Webhook 端點驗 secret**,且綁 `127.0.0.1` / 內網,不對公網開放。
- **(Phase 3)Grafana API token 走唯讀、最小權限。**

---

## 12. Roadmap

### Phase 0 — 環境準備(設定,非寫程式)
- [ ] Grafana:建一條 alert rule(設好閾值與評估間隔)
- [ ] Grafana:建 webhook 類型 contact point,URL 指向 bridge 的 `/grafana/webhook`,加 `Authorization` header(填 secret)
- [ ] Grafana:notification policy 把該告警路由到此 contact point
- [ ] AIRI:桌面版接好本地 Ollama 模型,TTS 設好能發聲,確認 server channel 可連
- [ ] **(給人做)把 AIRI 手動設定記成一份 runbook** —— 模型、語音、模組、server channel、角色設定。這份就是後期自動化 provisioning 的規格。
- **DoD:** Grafana 按 Test 能看到請求打到臨時 endpoint;AIRI 能手動觸發講一句測試語音

### Phase 1 — MVP 主幹(source → core → AIRI sink)
- [ ] 專案初始化(pnpm + TS + Hono),建立第 7 節結構
- [ ] `core/types.ts`:定義 `ParsedAlert`
- [ ] `sources/grafana.ts`:Grafana webhook → `ParsedAlert[]`
- [ ] `server.ts`:webhook 端點 + secret 驗證 + 串接
- [ ] `core/format.ts`:組訊息字串
- [ ] `airi.ts`:`speakAlert()`(解決第 10 節調查項目 1、2)
- [ ] `index.ts`:串起來
- **DoD:** 一條真實 Grafana 告警 firing 時,桌面角色在數秒內把合理的語音摘要念出來

### Phase 2 — 強化(可靠度)
- [ ] severity 過濾:只播 `>= MIN_SEVERITY`
- [ ] `core/dedup.ts`:同 `fingerprint` 在 `DEDUP_WINDOW_SEC` 內只播一次(防洪)
- [ ] resolved 通知:告警恢復時播一句簡短「已恢復」
- [ ] 端點對沒帶/帶錯 secret 的請求回 401
- **DoD:** 低於門檻不播;短時間重複不洗版;恢復有通知;未授權被擋

### Phase 3 — 對話式即時查詢(進階,獨立線,不在本專案程式)
- [ ] 在 AIRI 把 MCP 模組接上 Grafana 官方 MCP server(唯讀 token)
- [ ] 驗證可用自然語言問現值(例:「prod-db-01 現在 CPU 多少」)
- **DoD:** 告警響後,可開口追問該指標現值,角色即時撈值回答

### Phase 4 —(後期)擴充來源
- 加 Splunk / Kibana = 在 `sources/` 新增 adapter + 在 `server.ts` 掛接收路由,`core/` 與 `airi.ts` 不動。
- **不要現在做**,等內部驗證完、確定要產品化再說。

---

## 13. 測試 (Testing)

- **本機單元測試:** 用 `curl` 把第 9.1 範例 payload POST 到 `/grafana/webhook`,驗證解析與推送。先放一份 fixture 在 `test/fixtures/firing.json`。
  ```bash
  curl -X POST http://127.0.0.1:8787/grafana/webhook \
    -H "Authorization: $WEBHOOK_SECRET" \
    -H "Content-Type: application/json" \
    -d @test/fixtures/firing.json
  ```
- **整合測試:** Grafana contact point 的 **Test** 按鈕送真實格式告警,確認角色發聲。
- **手動驗收:** 故意把閾值設很低觸發一次真告警,觀察端到端延遲與語音內容。

---

## 14. 參考 (References)

- AIRI server-sdk(npm):`@proj-airi/server-sdk` — Client 連線與事件,確切 API 以此為準
- AIRI 文件:https://airi.moeru.ai/docs/en/
- AIRI 原始碼:https://github.com/moeru-ai/airi(server-sdk 在 monorepo packages 內)
- Grafana Alerting — webhook contact point 設定與 payload 格式(Grafana 官方文件)
- Grafana MCP server:https://grafana.com/docs/grafana/latest/developer-resources/mcp/(Phase 3 用)

---

## 附:給 Claude Code 的最後提醒

整個專案的輪廓:**最小可行版本就是「Grafana webhook → 核心正規化 → 角色語音」這一條線**。先把它跑通(Phase 1),其餘都是加料。

三件最容易出錯、務必守住的事:
1. **現在只做 Grafana 一個 adapter**,別蓋通用框架(第 3 節)。
2. **動手前先解決第 10 節三個調查項目**,別猜 server-sdk 的 API。
3. **不要改 AIRI 原始碼**,只用 server-sdk + MCP 公開介面。
