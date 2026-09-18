<!-- ADR-001 | Status: Superseded -->
# ADR-001：SOC 播報架構 —— Augur 由 AIRI 文字橋升級為瀏覽器原生 avatar 播報 runtime

| 欄位 | 值 |
|------|----|
| **狀態** | `Superseded`（被 ADR-004 取代） |
| **日期** | 2026-07-18 |
| **決策者** | astroicers（待人類審核） |

> **狀態說明**：`Draft`（禁止實作生產代碼）→ `FIRM`（POC 驗證）→ `Accepted`（人類審核放行）。**AI 不可自行升級狀態**（ASP 鐵則）。本 ADR 由 2 個最小 spike（`broadcaster-spikes/`，2026-07-18）與 `.asp-fact-check.md` 外部授權查證支撐。

> ⬆️ **由 `Draft` 升 `Accepted`（2026-07-18）**：使用者於對話明確表示「三支 ADR 都同意」並授權 Accept。升級依據 = **POC gate G-ADR001-1 端到端骨架 PASS**(mock 告警→TS 導播→WS→React VRM 講話+表情,見 Verification Evidence)。**人類顯式授權,非 AI 自行升級**(符合 ASP ADR 狀態變更鐵則)。剩餘生產增量(真 Grafana webhook、Grafana 嵌入、延遲量測)於生產階段補。

> 🔻 **由 `Accepted` 轉 `Superseded`（2026-09-18）**：被 **ADR-004** 取代。
> 本 ADR 的三根柱子——Node/TS 導播、WebSocket 推播、3D VRM avatar——全數拔除，
> 相關程式碼已於 commit `fbd81f4` 刪除（`git log` 可取回）。
> **仍然有效的部分**：它記錄的「為何否決 AIRI」「為何否決常駐 THA 即時神經渲染」
> 兩項評估，以及 §待驗風險 1 對 Web Speech 的否決理由——
> ADR-004 決策 4 正是明文推翻後者，讀那一節時應對照本檔。
> ⚠️ 本檔 Verification Evidence 引用的 `broadcaster-spikes/` 在 repo 中**已不存在**，證據無法複驗。

## 痛點 / 需求

Augur 目前是 `airi-ops-bridge`：Grafana webhook → `src/sources/grafana.ts`（`ParsedAlert`）→ severity 過濾 → dedup → `format`（事實句）→ `src/airi.ts`（WS `input:text`）推給 **AIRI**，由 AIRI 的 LLM+TTS 講出。**AIRI 已廢棄**——實測 AIRI 無 Spine TTS lip-sync（`l2d-factory/.asp-fact-check.md` 2026-07-18），且 AIRI 只吃 `input:text`、表情/lip-sync/idle 全綁在 AIRI 內、外部無法驅動。

需求:一個**會講話、有表情的動漫 avatar**，即時讀出 SOC 資安警報(像 VTuber 主播)，**在網頁前端呈現**，**live 迴路盡量零 Python**，未來可加更多表情讓播報生動。

先前替代路皆死或不穩:Live2D moc3 auto-rig(l2d-factory ADR-006 Rejected)、AIRI+Spine(無 lip-sync)、常駐 THA 即時神經渲染(l2d-factory ADR-008 **Superseded**——對永遠在線的 SOC 監控太脆弱、bespoke GPU 串流)。

## 決策

**Augur 升級為完整「SOC 播報 runtime」**,採**瀏覽器原生 VTuber runtime + TS 導播 + React 前端**;**avatar 只需一支、做一次**,故不需自動 rig 也不需即時神經渲染。

**元件分工**:
1. **Augur 導播(Node/TS,保留現有骨幹)**:續用 `src/sources/grafana.ts`、`src/core/{types,severity,dedup,format}`、`src/server.ts`、`src/config.ts` 與 `monitoring/` 全套。**替換 `src/airi.ts`**:AIRI WS sink → 輸出**「播報計畫」**(`{text, emotion, severity, …}`)並經 **WS/SSE 推給前端**。`format` 由「事實句」升級為「播報計畫產生器」。
2. **React 前端(visual-web-stack:Vite+TS+Tailwind+Zustand)**:消費播報計畫,承載 **可換的瀏覽器 avatar 模組**,做 lip-sync + severity 表情 + idle,並**嵌入 Grafana 面板**。
3. **avatar-renderer = 可換模組**(`AvatarController` 介面,細節見 ADR-002)。**首發實作 = VRM（three-vrm/R3F）**;Live2D 為未來可換皮。

**為何 VRM 起步(承 spike 實測 + 使用者 2026-07-18 選 C)**:兩個 spike 都證明瀏覽器 avatar 可 lip-sync + 換表情、零 Python;VRM 勝在**商用授權乾淨(`@pixiv/three-vrm` MIT + VRoid 商用)**、**VRoid 免手動 rig**、**18 表情 preset 開箱**、迭代快。Live2D 雖 2D 貼 l2d 藝術且 mobile 輕,但要 **Cubism 商用 Expandable-App 個案簽約 + 每支 avatar 手動 rig + 專有 Core**;故**先 VRM 把整條播報跑通(最低風險),avatar 介面保留 Live2D 未來選項**。

**live 迴路語言**:導播 = TS(Augur)、前端 + avatar = TS/瀏覽器 → **「廢棄 Python」在 live 迴路達成**。唯一可能的 Python 是選用本地 TTS(ADR-002 待定;可用瀏覽器/雲 TTS 完全避開)。

## 專案拓撲(收斂 cross-project 整合問題)

- **l2d-factory(Python)**:維持獨立——2D 圖→PSD 素材產線 + **THA 離線 preview(ADR-005,gif)**。**在 VRM 路線下不進播報關鍵路徑**(VRM avatar 由 VRoid 製作,不走 l2d PSD)。
- **Augur**:播報的 **home**(導播 + 前端 + avatar)。所有播報 ADR 落此 repo。
- **未來 Live2D 皮 = 唯一回接 l2d 的橋**:若日後 2D 成硬需求,`AvatarController` 的 Live2D 實作可消費 l2d-factory 產出的 PSD 手動 rig 而成的 Live2D 模型。
- **結論**:兩 repo **分離、鬆耦合**;不合併。

## Verification Evidence

| 項目 | 結論 | 來源 |
|------|------|------|
| 瀏覽器 VRM avatar 可渲染 + lip-sync + severity 表情、零 Python | ✅ PASS——振幅→`aa` 峰值 1.0、18 表情 preset、critical→angry 目視正確 | spike A `broadcaster-spikes/spike-a-vrm/`（2026-07-18） |
| 瀏覽器 Live2D 同樣可行(未來皮的可行性) | ✅ PASS——`model.speak()`→`ParamMouthOpenY` 峰值 1.0、參數級表情、60fps | spike B `broadcaster-spikes/spike-b-live2d/` |
| VRM 商用授權乾淨 vs Live2D Expandable-App 簽約 | ✅ three-vrm MIT + VRoid 商用;⚠️ Live2D avatar 系統需個案簽約 | `l2d-factory/.asp-fact-check.md` 2026-07-18 |
| Augur 導播骨幹可重用、僅換 sink | ✅ `src/core` + `src/sources` + `src/server` 與 AIRI 無耦合;只有 `src/airi.ts` 需換 | Augur 原始碼盤點 |
| **端到端 POC 骨架(G-ADR001-1)** | ✅ **PASS**——mock 告警(trigger)→ TS 導播產 `BroadcastPlan` → WS → React VRM **用 Edge TTS(zh-TW)語音講出 + 依 severity 換表情 + feed 更新**;實測 `ws_open=true`、`spoke=true`、`mouth_max=1.0`、critical→angry、resolved→happy | `broadcaster-spikes/spike-c-e2e/`（2026-07-18,playwright headless e2e） |

## Follow-up / POC gate（升 FIRM 前必過）

- **G-ADR001-1（端到端骨架）✅ PASS（2026-07-18）**:mock 告警 → TS 導播產 `BroadcastPlan` → WS → React VRM **用 Edge TTS 講出 + severity 換表情 + feed**,e2e 實測通過(見 Verification Evidence)。**剩餘增量**(升 Accepted / 進生產前補):真 Grafana webhook 接入(目前 mock)、Grafana 面板嵌入(ADR-003)、`AvatarController` 介面 + Live2D-swap 證明(ADR-002)、端到端延遲量測。
- 子 ADR:**ADR-002**（表情導播 + lip-sync + `AvatarController` 介面）、**ADR-003**（前端 visual-web-stack + Grafana 嵌入）。

## 待驗風險

1. **TTS 選型未定**（ADR-002）:瀏覽器 Web Speech(零後端但音質/一致性差、難取振幅)vs Edge TTS/Azure(雲、有 viseme)vs 本地(引入 Python)。影響「零 Python」純度與 lip-sync 品質。
2. **WS/SSE 串流 + 多告警排隊**:同時多筆 critical 時的播報佇列/插播策略未定。
3. **Grafana 面板嵌入**:iframe/panel CSP 與同源限制待驗。
4. **avatar 抽象邊界**:`AvatarController` 介面要夠中立,才能讓 VRM↔Live2D 真的可換(ADR-002 負責)。
