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

### ✅ 已處理（2026-09-16 review 後）

| 項目 | 處置 |
|---|---|
| `live2d/_archive/nami/` 的 34 張「娜美風」角色美術（2.0MB，零出處，公開 Apache-2.0 repo） | **已從 branch 歷史移除**（分支當時尚未推送，只需改寫本地 commit；已 gc，舊物件不可達）。保留 `layout.json` / `manifest.json` 兩個純座標檔。原檔在本機備份。新增 `docs/asset-provenance.md` 與 `.gitignore` 防線 |
| `tools/asp-test.sh` 會為「完全沒執行的測試」蓋章放行 | 已修：跑前 `rm -f .jest-result.json`、判定納入 `JEST_EXIT`。並把 typecheck / lint / check-js-suffix 一併納入閘門 |
| README 的 `npm run server` 誤導 | 已補 `.env` 前置步驟與「P3 之前 Add panel 不會出現 Mascot」的但書 |
| `docs/ARCHITECTURE.md` / `monitoring/README.md` 仍描述已刪架構 | 已加失效警告與日期更新；**整份重寫仍在 P6 / P3** |

### 🟡 Review 指出但仍需你裁定

| 項目 | 狀況 |
|---|---|
| `.claude/settings.json` 進了公開 repo | 內含 `Bash(*)` 全域放行與三條 `/home/ubuntu/.claude/asp/hooks/` 絕對路徑，是本機狀態。零憑證（不觸鐵則二），但 `git rm --cached` 一行即可清掉。與 nami 是同一個「什麼該公開」的問題 |
| ADR-004 檔頭升級來歷寫「6 項查不到」，同檔〈查不到〉只列 5 項 | 第 6 項（rules 端點穩定性）只存在於未納管的 `.asp-fact-check.md`。**改 ADR 需你授權**，故未動 |
| `.asp-fact-check.md` 被 gitignore | 24 列中約 10–15 列只活在版控外。這是全機 15+ repo 的 ASP 慣例，**不宜單一 repo 破例**，故未動。ADR-004 的 Verification Evidence 表（已版控、每列自帶一級來源）承擔了主要舉證責任 |
| `monitoring/windows/*.ps1` 的供應鏈 | 兩支腳本要求管理員權限、抓 GitHub `releases/latest`（**版本不 pin**）、靜默安裝成 Windows 服務，**零 checksum、零簽章驗證**。公開 repo 上陌生人可能照著跑 |
| `npm run e2e` 會登入一台無關的 Grafana | `baseURL` 預設 `localhost:3000`（本機被別的 stack 佔著），`tests/` 未落地故只跑 `@grafana/plugin-e2e` 內建的 auth.setup。需固定 `GRAFANA_URL` 或在 P4 補 `tests/` |

### 🔵 覆蓋缺口（review 補查，非缺陷）

- **依賴供應鏈**：`npm audit` 有 8 個漏洞（5 high），全在 `@grafana/*` 的 transitive。
  但 webpack 將 `@grafana/*` 設為 externals、`dist/module.js` 僅 2,729 bytes，
  **有漏洞的套件不會隨 plugin 出貨** —— 乾淨是靠架構不是靠運氣。
- **缺失的整合測試**：計畫要求補一條等價於 `server.test.ts` 的「過濾 → 去重 → 播報」整合測試，
  P2 未補。**但現在不建議補** —— production 端對 `src/core/` 目前零 import
  （串接碼只存在於已刪的 `main:src/server.ts`），此刻在 `__tests__/` 自己接線自己斷言，
  P4 把次序寫反時照樣會綠。應在 P4 有真實串接碼之後才補。
- **`.config/AGENTS/`** 這批會直接指揮下一個 agent 的指令檔，review 未實質審過內容。

### 🟢 小決定

| 事項 | P2 的處置 | 待決 |
|---|---|---|
| `.env.example`（20 行 AIRI 設定）與 `docs/sample-grafana-firing.json` | **兩個都沒動** | 不在 ADR-004 廢除清單內，但 ADR-004 正文點名 `.env.example` 是「dormant 污染設定面」的反例。刪或留？ |
| plugin 版本號 | 暫取 `0.1.0` | 腳手架預設 `1.0.0`。它會注入 `dist/plugin.json`，對外可見。5 個 POC gate 全未跑，1.0.0 名實不符 |
| `src/img/logo.svg` | 維持腳手架預設 | 要不要換成 `assets/a1-augur-calm-cutout.png` 衍生圖（路徑必須落在 `src/` 底下） |

---

## 三點五、POC 實測結果（2026-09-17）與它推翻的兩件事

在**使用者實際看 dashboard 的機器**（Windows 11 / Chrome 152 / zh-TW）上跑過 Web Speech 探針，
五項先前標「查不到」的問題全部有答案。完整記錄見 `.asp-fact-check.md`。

| 問題 | 實測 |
|---|---|
| zh-TW 聲線 | **4 個**，其中 `Microsoft Hanhan`（預設）/ `Yating` / `Zhiwei` 三個是**本機**引擎 |
| `getVoices()` 首呼 | **空的**；單次 `voiceschanged` 於 +17ms 後給滿 25 個 |
| user gesture | **不需要** —— 零點擊即發聲且實際聽得到（還是在沙箱 iframe 內） |
| 中文 `onboundary` | **會觸發，詞級**：77 字 21 次，`charLength` 1–14，頻率 1.53 次/秒 |
| 15 秒截斷 | **未重現** —— 連續發聲 90 秒未中斷 |

### ⚠️ 這推翻 ADR-004 決策 4 的一個前提（需你授權修訂 ADR）

ADR-004 決策 4 寫「嘴型改用 `onboundary` 做 word-level 開合，**或** speaking 期間循環播固定幾格」，
而 review 進一步主張 **MVP 砍掉 boundary 模式**，理由是「boundary 模式下 speaking 每秒翻轉 5 次以上，
兩個圖層 visibility 每秒對調 5 次以上」。

**那個頻率是假設的，不是量的。實測是 1.53 次/秒**，相鄰事件平均間隔約 600ms（範圍 200–1950ms）。
在這個節奏下，boundary 驅動嘴型不但可行，還比定速循環好 ——
`charLength` 直接給出這一組的字數（1–14），可以讓長組多擺幾下、短組只擺一下；
`charIndex` 另可驅動播報 feed 的逐詞高亮。

**建議的 P4 做法**（取代 review 的「砍掉 boundary」）：以 boundary 事件為**同步點**，
在兩個事件之間跑一個嘴型循環，循環次數由 `charLength` 決定。
`setSpeaking(boolean)` 仍保留作為 fallback（給不觸發 boundary 的語言或引擎），
`setMouthOpen?(open)` 這個可選成員仍然值得留 —— 它現在有了第二個用途。

### ⚠️ 這也讓「切段 ≤10 秒」失去實證依據

review 要求 `chunkText` 依時長 ≤10s 切。實測 90 秒連續發聲未截斷，該要求目前**沒有證據支撐**。
但**不建議就此取消**：本次用的是本機 Hanhan，而該 bug 歷史上與**遠端**聲線相關，
有風險的那一組沒測到。建議改為「使用本機聲線時不切段；偵測到 `localService === false` 時才切段」。

### 給 P4 的實測基準

- **語速 5.6 字/秒**（Hanhan 預設 rate）。一則典型告警句約 77 字 ≈ **14 秒**。
  這個數字直接決定播報佇列的積壓速度：三則 critical 同時進來就是 42 秒的隊列。
- **啟用鈕仍保留但不應阻擋首次播報** —— 實測不需手勢，但 Chrome 的自動播放政策對
  同一 origin 有黏性，不能排除先前互動的影響。
- 首次 boundary 恆為 `name: "sentence"` 且 `charLength: 0`，是句首標記而非詞 —— 不要當成嘴型觸發。

## 三點六、P5 素材：已裁定與待你回報（2026-09-18）

規格在 `docs/sprite/sprite-sheet-spec.md`（1169 行，21 處跨設計矛盾的裁決全文保留）。

### ✅ 已裁定

| 事項 | 決定 |
|---|---|
| `AvatarController` 新增 `setReaction?('click'\|'pending'\|null)` | **放行**（已實作）。同時回覆 ADR-004〈待驗風險 4〉—— 該條原文寫「`emotion.ts` 只有 4 個 emotion，**需擴充**」，實際走相反的路：**不擴 `Emotion`**，因為 click/pending 不是 severity 的函數，擴了會逼 `severityToEmotion` 這個純函式處理與 severity 無關的輸入，污染 `core/` 的語意 |
| 產製路徑 | **先跑可讀性實測再決定**。委外行情 USD 50–150（`live2d/_archive/DEPRECATED.md` 記載），委外須一併取得書面著作權讓與 |
| 角色設定（capelet 太暗、瀏海蓋住眉窗） | 建議一併改 —— 不論誰畫都要重畫，現在改免費，畫完再改就是重畫 |

### 🔴 硬 blocker：等你回報

`assets/a1-augur-calm.png` **是 AI 生成的**，而 `docs/asset-provenance.md` 的出處與授權兩欄至今空白。
那張圖**已經在公開的 Apache-2.0 repo 裡**（`7539cfb` 就進去了）。

**你要做的**：實際讀該生成式服務的官方條款對「輸出歸屬」的規定，把**結論、一級來源 URL、
查證日期**逐字寫進 `docs/asset-provenance.md`。

⚠️ **不能只寫「見 `.asp-fact-check.md`」** —— 那個檔被根 `.gitignore` 排除，
公開 repo 的讀者取不到。這是 ASP 鐵則四的範疇，也是 AI 不該代答的事。

**在你回報之前**：sprite 素材即使畫好也**不得進版控**（依 `asset-provenance.md`
自己訂的「出處不明一律不進版控」）。規格與程式可以繼續做，交付不行。

### ⏳ 進行中：可讀性實測

規格裡**唯一凍結後改不動**的是虹膜直徑與瞳孔位移 —— 改它們等於 18 格全部重畫。
盲測頁已發佈，36 題、三組參數 × 三個尺寸隨機交錯，結果自動回傳。
判讀重點是 **128px 那三列**（規格訂的最小顯示尺寸），該列過不了的參數組不能用。

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
