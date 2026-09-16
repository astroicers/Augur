# P2 交接：待人類裁定事項

> 產出日期 2026-09-16 ｜ 對應 commit `d428af1` ｜ ADR-004 狀態 `FIRM`
> **本檔不改任何程式碼，也不自行修訂 ADR-004。** ADR 狀態與內容變更需人類授權。

P2（腳手架併入 + `src/core/` 遷入 + 舊管線刪除）已完成並驗證。
以下是 P2 刻意**沒有**做、需要你裁定的事。分三份。

---

## 一、ADR-004 修訂提案（三處）

P2 期間的實查推翻了 ADR-004 的三處內容。**提案而非逕改**。

### 1. §1 的 Grafana 版本寫法

- **現狀**：「`@grafana/data|ui|runtime` 13.2.x」
- **提案**：「**執行期** Grafana 13.2.2；**編譯期** pin `@grafana/*` 13.1.0」
- **理由**：腳手架 pin 的是 13.1.0，而 `@grafana/*` 在 webpack 設定裡是 **externals** ——
  不進 bundle，執行期由 Grafana 本體提供。編譯期版本與執行期版本本來就可以不同，
  原文把兩者混為一談。

### 2. 決策 2 的 alertState 六態 → 三態

- **現狀**：列出 `alerting|pending|ok|no_data|recovering|paused` 六態
- **提案**：改為**只有 `alerting` / `pending` / `ok` 三態可達**
- **理由**：`promAlertStateToAlertState()` 是 firing→Alerting、pending→Pending、
  **其餘一律 OK**。`no_data` / `recovering` / `paused` 透過這條路徑永遠到不了。

### 3. 新增兩段硬前提

**(a) `alertState` 是黏著的。** 實作是 `alertState != null ? alertState : 上一次的值`，
**永不回 `undefined`**。所以「偵測不到 alertState 就降級到 threshold」這個機制**不成立**，
降級只能靠顯式的 panel option 強制。

**(b) 四個硬前提，缺一則 alertState 恆為空**：

1. `module.ts` 必須寫 `.useFieldConfig().setDataSupport({ alertStates: true, annotations: false })`
2. panel 在 dashboard JSON 中必須**至少有一個 query target**，且 `plugin.json` 不可設 `skipDataQuery`
3. alert rule 必須帶 `__dashboardUid__` / `__panelId__`，且是**註解（annotation）形式**
4. dashboard 時間範圍結尾必須是 `now`

另有 `hasAlertRules` latch：若先載入 dashboard 再建規則，必須**整頁重新載入**才會生效。

> 附帶：`.asp-fact-check.md` 記 `AlertState` enum 有 7 個值（含 `unknown`），
> ADR-004 只列 6 個。兩份文件本身也不一致，一併修。

---

## 二、`.asp-fact-check.md` 待新增列

| 事實點 | 查證結果 |
|---|---|
| 13.2.2 的 `AlertStateInfo` 欄位 | 只有 `{id, dashboardUID, panelId, state}`。**無 `ruleUID`**（那是 main 分支才有）、**無 alertname / severity label / summary** |
| `@grafana/tsconfig@2.2.0` base.json | 已含 `lib: ["dom","dom.iterable","es2022"]`（補 lib 是多餘的）；但**沒有** `noUncheckedIndexedAccess`，另開了 `noUnusedLocals` 與 `noImplicitReturns` |
| Compose `extends` 對 ports 的行為 | 是**串接**不是覆寫（v2.35.1 實測） |
| create-plugin migration 適用範圍 | `satisfies(version, '7.11.0 - CURRENT')` 過濾，最新一支 migration 是 7.10.1 → **從 7.11.0 起一支都不會跑** |

---

## 三、需要你決定的事

### 🔴 會反向決定 `src/core/` 存廢的架構分叉（最重要）

`alertState` 只給 `{id, dashboardUID, panelId, state}`，**不含 alertname、severity、summary**。
也就是說 `src/core/severity.ts` 與 `format.ts` 在這條路徑上**沒有輸入**。三選一：

| 選項 | 做法 | 對 core/ 的後果 |
|---|---|---|
| (a) | 只播「有幾條在燒」的泛用句 | core/ 大幅簡化，`severity.ts` 幾乎無用武之地 |
| (b) | 另呼叫 `getBackendSrv().get('api/prometheus/grafana/api/v1/rules')` 取細節 | core/ 全部留用，但該端點已被 `.asp-fact-check.md` 標為**中高風險**（無官方文件保證） |
| (c) | 完全退回 `fieldConfig.thresholds` 自算 | core/ 留用，但放棄真 alert 語意（`for` duration 等） |

這題不決定，P4 就沒辦法動工。

### 🟡 破壞性操作，需你授權（P3）

`monitoring/` 的 Grafana 11.4.0 → 13.2.2 需要 `docker volume rm augur-monitoring_grafana-data`。
理由充分（零個手建 dashboard、13.0 的 unified storage migration 不可降版），
但這是破壞性操作，且 admin 密碼會回到 `.env` 初始值。**P2 沒有執行。**

### 🔴 敏感資訊，AI 不代處理

`WEBHOOK_SECRET` 已經進過 Grafana 容器環境與 provisioning 檔
（`monitoring/.env` 實含該變數，compose 有 `env_file: ./.env`）。
ADR-004 廢除整條 webhook 管線後，這個 secret 應該**輪換**，而不只是從 compose 拿掉一行。

同時 `monitoring/grafana/provisioning/alerting/{contactpoints,policies}.yml` 要不要清，
**ADR-004 決策 7 寫的是「monitoring/ 全套保留」，與計畫 P3 的刪除指示互相矛盾** —— 需裁定。

### 🟢 小決定

| 事項 | P2 的處置 | 待決 |
|---|---|---|
| `.env.example`（20 行 AIRI 設定）與 `docs/sample-grafana-firing.json` | **兩個都沒動** | 不在 ADR-004 廢除清單內，但 ADR-004 正文點名 `.env.example` 是「dormant 污染設定面」的反例。刪或留？ |
| plugin 版本號 | 暫取 `0.1.0` | 腳手架預設 `1.0.0`。它會注入 `dist/plugin.json`，對外可見。5 個 POC gate 全未跑，1.0.0 名實不符 |
| `src/img/logo.svg` | 維持腳手架預設 | 要不要換成 `assets/a1-augur-calm-cutout.png` 衍生圖（路徑必須落在 `src/` 底下） |

---

## 四、P3/P4 契約備忘（給下一階段執行者）

**types 層**：D1（複製 episode 而非重算）、D5（levelIndex）、D6（repeatFiringMin）、
D9（startsAt 凍結）、D10（useRef + LoadingState 守門）**採用**；
D2（六態映射）、D4（ruleUID fingerprint）、D8（no_data option）**依第一節改寫**。
fingerprint 改用 `alert:panel:${panelId}:${kind}`，不提 ruleUID。

**avatar 層**：
- **MVP 砍掉 boundary 模式**（ADR-004 決策 4 已明碼標價接受定速循環）
- 介面補**可選**成員 `setMouthOpen?(open: number): void` 承接幀級嘴型 ——
  這樣未來若有拿得到 audio buffer 的 TTS，振幅 lip-sync 只要實作這個成員就能回來，
  不必再動一次契約
- watchdog 觸發路徑必須**先 `synth.cancel()` 再 finish**，否則只是把「卡住且看得出來」
  變成「卡住且看不出來」
- `chunkText` 依時長 ≤10s 切

**dedup**：需新增 `forget(fingerprint)`，不要靠副作用達成。

**P4 必須 POC 實測、不可推論的四項**：
`recovering` 的語意（`keep_firing_for` 期間 vs 已恢復觀察期，兩種語意下 flap 行為完全相反）、
boundary event 對中文 voice 是否觸發及粒度、Chrome「約 15 秒無聲截斷」的確切條件、
`unlockSpeech` 的靜音熱身是否必要且足夠。

**P5 素材**：9 格反應圖與 9 格方向圖的比例錨點必須**在畫之前**校正並凍結
（兩張對不齊時切換圖層會「跳一下」，肉眼很明顯）。
注意 `live2d-template-spec` §3 的「臉中軸 X≈384 / 眼線 Y≈285」是 768×1376 全身基準圖的
**絕對像素**，丟給畫 512 方格的人沒有意義，必須改成以格寬為單位的比例，
並先決定裁切構圖（胸上 vs 全身）。
另更正一處事實：`assets/layers/` 實際是 **6 張** `part_*.png` + 1 張 `_preview_segmentation.png`（預覽圖），
不是先前文件寫的「7 張分層」。

---

## 五、已知的 blocker

**G-ADR004-2b（真 Windows 端到端）目前無法執行。** Windows 側實查：
9182（windows_exporter）、6121（AIRI）、3001（bridge）**皆無 listener**。
在裝好 `windows_exporter` 之前跑不了 —— 這也是把 always-firing 的 `vector(1)` 規則
升為 G-ADR004-2 骨幹的正確性佐證。
