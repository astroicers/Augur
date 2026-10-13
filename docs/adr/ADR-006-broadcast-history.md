<!-- ADR-006 | Status: FIRM -->
# ADR-006：播報紀錄 —— 以 Grafana 告警狀態歷史當吉祥物的持久紀錄（唯讀、零後端）

| 欄位 | 值 |
|------|----|
| **狀態** | `FIRM` |
| **日期** | 2026-10-13（提出 2026-10-13）|
| **決策者** | astroicers |

> **狀態說明**：`Draft`（**禁止實作生產代碼**）→ `FIRM`（POC 驗證）→ `Accepted`（人類審核放行）。**AI 不可自行升級狀態**（ASP 鐵則）。
> 本 ADR **修訂 ADR-004 決策 2**（告警來源：新增第三條唯讀來源）與 panel 內播報 feed 的語意，不 supersede ADR-004 其餘部分。

> ⬆️ **由 `Draft` 升 `FIRM`（2026-10-13）**：astroicers 授權（`/asp:approve-adr` 流程，於對話中回覆）。
> 看過的摘要項目：決策 7 條（紀錄來源、事件紀錄的語意、同一套組句與樣板填值、介面、歷史只顯示不播報、保存期、可見降級）；
> 限制 3 項（是「發生過」不是「念過」的紀錄、摘要用規則現在的樣板、讀不到時退回本分頁模式）；
> Verification Evidence 在（本機 12.4.12 實測 V-1～V-6）；**6 個 POC gate（G-ADR006-1～6）全數未跑**；
> 無 `roadmap-ref`（repo 既有慣例）；本 repo 無 `docs/adr/README.md` 索引，ADR 清單在根 README。
> 回覆逐字：**「升 FIRM，開始實作」**。
> 升 FIRM 而非 Accepted：同 ADR-004／005 —— FIRM 解除「Draft 禁止實作」，POC gate 要等程式寫出來才跑得動，
> 「POC 未跑」誠實留在檔上。**人類顯式授權，非 AI 自行升級**（ASP 鐵則）。

## 痛點 / 需求

2026-10-13 吉祥物在 EKS 的 Grafana 12.4.12 上線（eks-infra #1110、#1168）。使用者實看後提出：

> 「我要他說的內容可以及時查詢，也可以翻看記錄。」

現況做不到。panel 的播報 feed 只活在**當下那個瀏覽器分頁的記憶體**裡：

- 重新整理就沒了。
- 每個觀看者看到的不一樣，因為各自從打開頁面那一刻開始累積。
- 頁面沒開著的時候發生的事，沒有任何紀錄。

吉祥物念的每一則，本質上都是一條 **Grafana-managed 規則的狀態變化**：進入 Alerting 念一次「偵測到」，離開 Alerting 念一次「恢復」。而 Grafana 本來就會把這些變化存成**告警狀態歷史**。

## 決策

### 1. 仍零後端：紀錄來源是 Grafana 已經在存的告警狀態歷史，唯讀

panel 以 `getBackendSrv()` 讀取：

```
GET /api/annotations?type=alert&dashboardUID=<本 dashboard>&panelId=<本 panel>&from=<ms>&to=<ms>&limit=<N>
```

- Grafana 12.x 的 `[unified_alerting.state_history]` **預設啟用**，`backend` 預設為 `annotations`，也就是存進 Grafana 自己的資料庫。規則帶有 `__dashboardUid__`／`__panelId__`，所以每筆紀錄都帶著 `dashboardUID` 與 `panelId`，可以只取綁在本 panel 上的紀錄。
- **不自建儲存、不寫入任何東西**，不需要額外權限。Viewer 讀得到（見 Verification Evidence V-1），所以 kiosk、值班這類唯讀帳號也能用。
- `/api/annotations` 是 Grafana **有公開文件的 HTTP API**，穩定度比 ADR-004 決策 2(b) 的 rules 端點高。

### 2. 這是「事件紀錄」，不是「某個瀏覽器確實念過」的紀錄

紀錄列的是 Grafana 判定發生過的狀態變化。那一刻有沒有任何瀏覽器開著、有沒有真的發出聲音，紀錄不知道，panel 上也不得這樣暗示。

- 列入的變化有兩種：任何狀態 → `Alerting`，對應「偵測到告警」；`Alerting` → `Normal*`，對應「告警已恢復」。
- 不列 `Pending`，也不列 `NoData` ↔ `Normal`。這兩者吉祥物本來就不念。
- 套用 panel 的「最低播報嚴重度」選項，和播報同一套篩選。

### 3. 紀錄的句子和播報同一套組句，摘要用規則樣板在前端填

每一條紀錄要顯示成和吉祥物念的一樣的中文句子，例如「偵測到告警：MerakContainerMemoryHigh，嚴重度 warning，目前數值 0.93，merak-prod api-7f…/app 記憶體 > 90% limit」。

- **規則名、嚴重度**：紀錄本身有規則名（`alertName`）。嚴重度從規則端點的 rule-level `labels.severity` 取。
- **數值**：取紀錄 `data.values` 的 `A`（規則的查詢結果。ADR-004 實作的條件 B＝`$A`，兩者相同）。
- **摘要**：紀錄**沒有**存渲染後的 annotation。改用規則端點回傳的 rule-level `annotations.summary` **樣板**，把紀錄 `text` 欄位裡的 instance labels 填進去。
  - 只支援 `{{ $labels.<名稱> }}` 與 `{{ $value }}`，其中 `$value` 取 A 的值。
  - 遇到其他 Go template 語法，或 labels 解析失敗，**那一條就不帶摘要**。不猜，也不實作完整的 Go template。
- 組句函式用 `src/core/` 現有的播報組句。紀錄與播報**不得各寫一套**，否則兩邊的措辭遲早會分岔。

### 4. 介面：feed 變成「紀錄」，跟著 dashboard 的時間範圍走，可以篩選

- **翻看舊紀錄**：載入時依 **dashboard 時間挑選器的範圍**讀取歷史，可以捲動，最多 200 條，並顯示「範圍內共 N 條，已顯示前 200 條」。要看更早的紀錄就調整時間範圍，這是 Grafana 使用者本來就熟悉的操作，不另做分頁 UI。
- **即時查詢**：feed 上方加一個關鍵字篩選框，比對規則名、句子與 labels，只篩選、不重新查詢。
- **即時更新**：每次 panel data refresh（dashboard 的 refresh 間隔）就重新讀一次歷史，新事件出現在最上面。

### 5. 歷史只顯示，不播報

載入或重新讀到的歷史紀錄**一律不念**。只有在本分頁觸發的新變化才走原本的播報管線，包括 `dedup.ts`、重播間隔、語音佇列。

否則每次重新整理，吉祥物都會把範圍內的舊告警全部重念一遍。

### 6. 保存期限由部署端決定

Grafana 預設**永久保存**（`[unified_alerting.state_history.annotations] max_age` 與 `max_annotations_to_keep` 預設為 0，實測確認）。panel 不管保存期限，部署端如果要限制，就設定這兩個值。README 會寫明這一點。

### 7. 讀不到歷史就降級回現行行為，而且要看得見

以下情況都會讓 panel 讀不到歷史：權限不足、端點錯誤、部署端把 state history 的 `backend` 改成 `loki`（`/api/annotations` 會變成空的）、`enabled=false`。

發生時，feed 退回目前的「只顯示本分頁的播報」，並在 panel 上標明「讀不到告警歷史：<原因>」。不靜默退回。

## 接受的代價

- **labels 要從字串解析。** 紀錄的 `text` 是 Grafana 組出來的字串，格式為 `<規則名> {k=v, k=v, …} - A=…, B=…`，**沒有文件保證**。`/api/v1/rules/history` 在 annotations 後端下回傳的也是同一個字串（V-3）。
  - label 的值裡如果含有 `, ` 或 `}`，就會解析錯。
  - Grafana 改了格式，摘要就會消失。
  - 兩種情況都只會讓摘要消失，規則名、嚴重度、數值、時間照樣正確，這就是決策 3 的退路。
- **嚴重度取的是規則「現在」的設定。** 規則事後被改過嚴重度的話，舊紀錄會顯示新的值。摘要樣板也一樣，用的是現在的樣板。
- **規則刪除後，它的舊紀錄只剩規則名、數值、時間**：規則端點已經查不到它，嚴重度與摘要會缺。
- **每個觀看者、每次 refresh，都會多一次 `/api/annotations` 查詢。** 查詢以 dashboard＋panel＋時間範圍過濾，量很小。

## 不採用的選項

| 選項 | 為什麼不 |
|---|---|
| Grafana 內建的「Annotations list」panel | 它**不列告警產生的紀錄**（12.4.12 實測：No annotations found） |
| 只用 Grafana 的 Alerting → History 頁 | annotations 後端下沒有跨規則的總表（實測：`ruleUID is required to query annotations`）；單條規則的 History 分頁可用，但要一條一條點，也沒有中文句子 |
| state history 改存 Loki，加一個 logs panel | 要改部署端的 Grafana 設定並重啟、要動 Loki；紀錄是英文的規則格式。使用者 2026-10-13 選了本 ADR 的方案 |
| panel 自己把念過的內容寫成 annotation | 每個開著的瀏覽器都會寫一份，造成重複；Viewer 沒有寫入權限；也違背零後端 |
| `localStorage` | 只存在單一瀏覽器，換台電腦或換個人就看不到，解決不了「每個人看到的不一樣」 |

## Verification Evidence

### 本機實測（2026-10-13，隔離 compose，Grafana 12.4.12，非推理）

| # | 事實點 | 結果 |
|---|---|---|
| V-1 | Viewer 帳號能否讀取告警歷史 | ✅ 新建的 Viewer（`role=Viewer`）呼叫 `GET /api/annotations?type=alert&dashboardUID=augur-mascot-trial&panelId=1` 回 200，有資料；同條件不帶 `type` 也一樣 |
| V-2 | 紀錄欄位 | ✅ `id, alertId, alertName, dashboardId, dashboardUID, panelId, newState, prevState, created, updated, time, timeEnd, text, tags, data`；`data.values` 是 `{"A":…, "B":…}`；`text` 例：`FlapTest {alertname=FlapTest, augur_mascot=true, grafana_folder=Augur Mascot, severity=warning} - A=1.000000, B=1.000000` |
| V-3 | `/api/v1/rules/history` 能否提供結構化 labels | ❌ Viewer 可讀（200），但在 annotations 後端下必須帶 `ruleUID`，回傳的 `text` 與 V-2 相同，沒有結構化 labels |
| V-4 | Viewer 能否讀取摘要樣板與嚴重度 | ✅ `GET /api/prometheus/grafana/api/v1/rules?dashboard_uid=…&panel_id=…` 回 200；rule-level `annotations.summary` 是原始樣板（`merak-prod {{ $labels.pod }}/{{ $labels.container }} 記憶體 > 90% limit（10m）`），`labels.severity` 是 `warning` |
| V-5 | 保存期限預設值 | ✅ 12.4.12 `defaults.ini`：`[unified_alerting.state_history] enabled = true`、`backend =`（＝annotations）；`[unified_alerting.state_history.annotations] max_age =`、`max_annotations_to_keep =`（0＝永久） |
| V-6 | 現成替代方案 | ❌ Annotations list panel：No annotations found；全域 Alerting → History：500 `ruleUID is required`；✅ 單條規則的 History 分頁可用 |

## Follow-up / POC gate（升 Accepted 前必過）

- **G-ADR006-1**：Viewer 帳號在真 Grafana（12.4.12）打開 panel 能看到歷史紀錄。（V-1 已在 API 層驗過，還要在 UI 層驗）
- **G-ADR006-2**：**同一個事件，播報出來的句子與紀錄裡的句子逐字相同**，包括摘要。要比對 MerakContainerMemoryHigh 這類多 instance 的規則。
- **G-ADR006-3**：重新整理後紀錄還在；兩個不同的瀏覽器看到的紀錄相同；**載入歷史時吉祥物不出聲**（決策 5）。
- **G-ADR006-4**：調整 dashboard 時間範圍可以翻到更早的紀錄；篩選框可以即時縮小列表；超過 200 條時有提示。
- **G-ADR006-5**：降級看得見：把 state history 的 backend 設成 `loki`、或用無權限的帳號時，feed 退回本分頁模式，並顯示原因。
- **G-ADR006-6**：EKS（eks-infra）的試用 dashboard 上實機確認。依使用者規則，叢集上的確認以 eks-infra issue 交辦。

## 待驗風險

1. `text` 欄位的格式在 13.x 是否改變：升 13 時要重驗 V-2。
2. 告警量大的 dashboard（數千筆紀錄）在 200 條上限下的查詢延遲。試用 dashboard 的量很小，目前驗不到。
3. Frontend Sandbox 開啟時，`getBackendSrv()` 呼叫 `/api/annotations` 是否照常可用。ADR-005 V-2 驗過 sandbox 下的 fetch，但沒有驗過這個端點。
