# Augur — 架構總覽

> **Augur ＝ 一個 Grafana panel plugin，讓吉祥物住在 dashboard 裡把告警念出來。**
> 本檔是**導覽**；每個決策的「為什麼」以 `docs/adr/` 為權威。**維護規則見文末。**
> 最後更新：2026-09-18（ADR-004 升 Accepted 後整份重寫）。

## 一句話

panel 讀自己的 `props.data` → 判斷有沒有在燒 → 打 Alerting rules 端點補細節 →
severity 過濾 → dedup 防洪 → 產 `BroadcastPlan` → 瀏覽器 Web Speech 念出來 +
avatar 換表情、動嘴、追滑鼠。**零後端、零常駐服務。**

## 資料流

```
Grafana（panel plugin 與 dashboard 同一個 document，不是 iframe）
  │
  ├─ props.data.alertState ──────┐  觸發訊號：只有 {state,id,panelId,dashboardUID} 四欄
  │  （alerting / pending / ok）  │  ⚠️ 黏著，永不回 undefined
  │                              ▼
  │                      src/sources/panelAlerts.ts
  │                        ├ alerting → 打 rules 端點補細節，建立／沿用 episode
  │                        ├ pending  → 不產生事件（見 ADR-004 決策 2）
  │                        └ ok       → 由記住的 episode 複製出 resolved
  │                              │
  └─ /api/prometheus/grafana/api/v1/rules?dashboard_uid&panel_id
       （src/sources/rulesFetcher.ts；內容來源，與 ParsedAlert 一對一）
                                 │
                                 ▼  ParsedAlert[]
                      src/components/MascotPanel.tsx（導播）
                        ├ core/severity.ts   meetsMin 過濾（resolved 不受門檻影響）
                        ├ core/dedup.ts      shouldSpeak 防洪 + resolved 綁狀態
                        └ core/format.ts     buildBroadcastPlan → {text, emotion, …}
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
   src/speech/speaker.ts                  src/avatar/AvatarController
     佇列、逐則播、不疊音                    setEmotion / setSpeaking
     onboundary → 嘴型同步點                setGaze / setMouthOpen?
     watchdog（先 cancel 再 finish）         現行實作：DiagnosticAvatar
                                            未來：SpriteController（P5）
                                                  ▲
                                     src/dom/dashboardPanels.ts
                                       跨 panel 能力偵測 + 漸進降級
                                       （看得到別的 panel → 追全頁滑鼠；
                                         看不到 → 只管自己的容器）
```

## 檔案

| 路徑 | 職責 |
|---|---|
| `src/module.ts` | `PanelPlugin` 註冊。**缺 `.setDataSupport({alertStates:true})` 的話 `alertState` 恆為空** |
| `src/panelOptions.ts` | panel 設定。承自舊架構 `config.ts` 的環境變數清單 |
| `src/components/MascotPanel.tsx` | 導播 + 呈現。是舊 `server.ts:68-77` 處理迴圈的搬家 |
| `src/sources/panelAlerts.ts` | 來源層。**唯一產生 `ParsedAlert` 的地方** |
| `src/sources/rulesFetcher.ts` | Alerting rules 端點的正式實作。獨立成一支，好讓來源層能用假 fetcher 做單元測試 |
| `src/core/` | 來源中立的核心（273 行）。**從舊 push 架構整包繼承，零修改** |
| `src/speech/speaker.ts` | Web Speech 封裝。常數全部來自實測 |
| `src/avatar/AvatarController.ts` | avatar-agnostic 契約（繼承 ADR-002 §2） |
| `src/avatar/gaze.ts` | 視線格計算。兩層防抖：dead zone + 角度遲滯 |
| `src/avatar/DiagnosticAvatar.ts` | 契約的第一個實作。**刻意不是吉祥物**，把四個輸入畫成儀表 |
| `src/dom/dashboardPanels.ts` | 跨 panel DOM 能力偵測。本專案**唯一** unsupported 的部分 |
| `monitoring/` | docker-compose 開發環境 + alert rules + provisioned dashboard |
| `tools/` | `check-js-suffix.sh`（守門）、`asp-test.sh`（ASP commit 閘） |

## 關鍵設計

**唯一的抽象邊界是 `ParsedAlert`**（`src/core/types.ts`）。來源層把任何來源轉成它，
`core/` 只認得它。這條線在 push → pull 的方向反轉中**完好無損** ——
`src/core/` 那 273 行一行沒改就承接了新架構。

**來源層的三個不變量**（`panelAlerts.ts` 檔頭有完整說明）：episode 用複製而非重算、
`startsAt` 釘死、每次評估都無條件 emit 而把抑制交給 dedup。
第三條讓 `dedup.ts` 既有語意零修改就是對的。

**avatar 可換**：上層只依賴 `AvatarController` 介面。換實作不動導播、不動語音、不動 DOM 層。

**漸進降級**（ADR-004 決策 6）：跨 panel 互動是 unsupported 的，
所以降級的全部實作就是「監聽 `document` 還是只監聽自己的容器」一行分支 ——
其餘邏輯完全相同。壞掉時是少一個功能，不是整個 plugin 炸掉。

## 設定

Panel options（`src/panelOptions.ts`）：`minSeverity`、`repeatFiringMin`、
`fallbackSeverity`、`alertLang`、`enableTTS`、`ttsVoice`。

**Threshold 不在這裡** —— ADR-004 決策 2 要求走 standard field config
（`fieldConfig.defaults.thresholds`），自訂 option 會失去 overrides 與原生編輯 UI。

開發環境設定在 `monitoring/.env`（由 `.env.example` 複製）。埠與啟動方式見 `README.md`。

## ADR 索引（決策權威，`docs/adr/`）

| ADR | 主題 | 狀態 |
|---|---|---|
| **ADR-004** | **改為 Grafana Panel Plugin**（2D 精靈圖 + Web Speech，零後端） | **Accepted**（2026-09-18） |
| ADR-001 | SOC 播報架構（Node 導播 + WS + VRM avatar） | Superseded |
| ADR-002 | 表情導播 + lip-sync + `AvatarController` 介面 | Superseded（**§1／§2 被 ADR-004 決策 5 明文繼承**） |
| ADR-003 | 前端 visual-web-stack | Superseded |

ADR-004 的 5 個 POC gate 全數 PASS，機械證據回填在該檔的 Verification Evidence。
ADR-001／002 引用的 `broadcaster-spikes/` 在 repo 中已不存在，那兩份的 POC 證據無法複驗。

## 技術棧

`@grafana/create-plugin` 7.11.0 腳手架（**webpack**，非 Vite）·
執行期 Grafana **13.2.x**、編譯期 pin `@grafana/*` **13.1.0**（externals，不進 bundle）·
React 18 · Emotion（`@grafana/ui` 的 `useStyles2`）· Jest + @swc/jest（60 測試 / 9 suites；另有 116 條 sprite 工具自測，不走 jest）· npm。

**`.config/` 由 create-plugin 託管，禁止手改** —— 手改的後果不是被覆寫而是**靜默失效**
（migration 全是 `if (!AST match) return` 的早退）。要擴充就改根層的 wrapper。

## 已知缺口

- **精靈圖 avatar 未做**（P5）。素材規格與美術定案是前置。
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
  兩份受眾不同，不要互相複製。
- **實測優於推理。** 這個專案已經有五次「靜態推理得出的結論實測不成立」
  （見 `.asp-fact-check.md`）。寫進本檔的行為描述應該是跑過的，不是推出來的。
