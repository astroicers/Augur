# P2 交接：待人類裁定事項

> 產出日期 2026-09-16 ｜ 對應 commit `fbd81f4` ｜ ADR-004 當時狀態 `FIRM`
> **本檔不改任何程式碼，也不自行修訂 ADR-004。** ADR 狀態與內容變更需人類授權。
>
> ## ⚠️ 2026-09-21 逐條校對：**這份文件的大部分內容已經有答案了**
>
> ADR-004 已於 **2026-09-18 升 Accepted**（5 個 POC gate 全 PASS）。
> 下面每一節都補了狀態標記。**照著未標記狀態的舊文字做，會把已經對的東西改壞** ——
> 例如把 `flap.ts` 拆掉重寫、白砍一次 Grafana volume、或重開一個已經走完的架構三選一。
>
> 仍然有效、仍需人類處理的原有兩件（2026-10-02 起只剩第 1 件）：
> 1. **`WEBHOOK_SECRET` 輪換**（§三的 🔴，AI 不代處理，至今未做）。
>    追蹤於 `docs/ROADMAP.md`〈未完成項目〉〈卡在人〉的 **B3-3**；2026-10-02 刪掉 contactpoints 後
>    它已無任何消費者，**作廢即可**（不必真的換一個新值）。
> 2. ~~**contactpoints / policies 的去留**~~ ✅ **2026-10-02 已裁定（經 PR 送審，merge 即為授權）**：兩檔刪除，
>    ADR-004 決策 7 補訂正；裁定紀錄在 `docs/ROADMAP.md`〈已裁定的衝突〉，其餘追蹤見 `docs/ROADMAP.md`〈未完成項目〉。
>
> ## 📌 2026-10-15 逐節補狀態（A0-7：選「逐條補狀態」，**不**整份退役）
>
> **這份文件不退役。** 它仍被 `src/avatar/flap.ts` 檔頭、`docs/sprite/sprite-sheet-spec.md`（9 處）、
> `monitoring/README.md`、`docs/handoff/remaining-plan.md`、`docs/dependency-audit.md`
> 與 `docs/ROADMAP.md` 的 B4-3 引用，而 §一的四個硬前提、
> §三點五的 Web Speech 實測數字（語速 5.6 字/秒、boundary 1.53 次/秒）在版控裡沒有第二個出處 ——
> 退役會讓那些引用全部指向一份作廢檔。
>
> 改法是：**每一節都帶狀態標記；仍開著的項目一律改指向 `docs/ROADMAP.md`〈未完成項目〉的編號。**
> 那裡是現行的單一追蹤處；本檔自 2026-10-15 起只負責保留歷史原文與當時的理由。
> **本檔與 ROADMAP 不一致時，以 ROADMAP 為準。**

P2（腳手架併入 + `src/core/` 遷入 + 舊管線刪除）已完成並驗證。
以下是 P2 刻意**沒有**做、需要你裁定的事。分三份。

---

## 一、ADR-004 修訂提案（三處）✅ **已併入**

~~P2 期間的實查推翻了 ADR-004 的三處內容。**提案而非逕改**。~~
✅ **三處皆已於 2026-09-17 併入 ADR-004 正文**（該 ADR 現為 Accepted）。
下面保留為提案的原文與理由，**不要再提一次**。
（下面 1 / 2 / 3 三個小節都由這一條 ✅ 涵蓋；還需要另一次授權才能改的 ADR 條目
是另一批，列在 `docs/ROADMAP.md`〈未完成項目〉的 **B4-1、B4-3 ~ B4-7**。）

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

> ~~附帶：`.asp-fact-check.md` 記 `AlertState` enum 有 7 個值（含 `unknown`），~~
> ~~ADR-004 只列 6 個。兩份文件本身也不一致，一併修。~~
> ✅ **這條附帶已不適用（2026-10-15）**：ADR-004 正文現在**不再列舉 enum 的值**，
> 改成寫「只有 `alerting` / `pending` / `ok` **三種可達**」（見該 ADR 的 (a) 小節）。
> enum 本身有 6 個還是 7 個值，對這條路徑不再有任何後果，所以沒有「兩份不一致」要修。

---

## 二、`.asp-fact-check.md` 待新增列

⏳ **狀態（2026-10-15）：四列至今未補進 `.asp-fact-check.md`。**
該檔被根 `.gitignore` 排除、只活在本機，AI 這一側無從確認它現在有哪些列。
補列的工作追蹤於 `docs/ROADMAP.md`〈未完成項目〉〈不卡人〉的 **散落-3**
（該條明文「另補 P2-handoff §二〈待新增列〉的四列」，並要求五欄格式：
事實點／聲稱值／驗證來源／驗證結果／日期）。
下表四列的**內容本身仍然有效**，是待搬運的原文，不是待查證的問題。

| 事實點 | 查證結果 |
|---|---|
| 13.2.2 的 `AlertStateInfo` 欄位 | 只有 `{id, dashboardUID, panelId, state}`。**無 `ruleUID`**（那是 main 分支才有）、**無 alertname / severity label / summary** |
| `@grafana/tsconfig@2.2.0` base.json | 已含 `lib: ["dom","dom.iterable","es2022"]`（補 lib 是多餘的）；但**沒有** `noUncheckedIndexedAccess`，另開了 `noUnusedLocals` 與 `noImplicitReturns` |
| Compose `extends` 對 ports 的行為 | 是**串接**不是覆寫（v2.35.1 實測） |
| create-plugin migration 適用範圍 | `satisfies(version, '7.11.0 - CURRENT')` 過濾，最新一支 migration 是 7.10.1 → **從 7.11.0 起一支都不會跑** |

---

## 三、需要你決定的事

⏳ **狀態（2026-10-15）：本節七個小節逐一標了狀態。真正還需要你的只剩四件** ——
`WEBHOOK_SECRET`（B3-3）、`.claude/settings.json`（B7-1）、ADR-004〈查不到〉第 6 項（B4-4）、
根 `.env.example` 的去留（B3-4），另加兩件已實質備好只等一句裁定的
`.config/AGENTS/` 去留（B7-4）與 logo（`logo` 條）。其餘都已走完或被實測推翻。

### ~~🔴 會反向決定 `src/core/` 存廢的架構分叉（最重要）~~ ✅ **已走 (b)，P4 已完成**

`alertState` 只給 `{id, dashboardUID, panelId, state}`，**不含 alertname、severity、summary**。
也就是說 `src/core/severity.ts` 與 `format.ts` 在這條路徑上**沒有輸入**。三選一：

| 選項 | 做法 | 對 core/ 的後果 |
|---|---|---|
| (a) | 只播「有幾條在燒」的泛用句 | core/ 大幅簡化，`severity.ts` 幾乎無用武之地 |
| (b) | 另呼叫 `getBackendSrv().get('api/prometheus/grafana/api/v1/rules')` 取細節 | core/ 全部留用，但該端點已被 `.asp-fact-check.md` 標為**中高風險**（無官方文件保證） |
| (c) | 完全退回 `fieldConfig.thresholds` 自算 | core/ 留用，但放棄真 alert 語意（`for` duration 等） |

~~這題不決定，P4 就沒辦法動工。~~

✅ **已選 (b) 並實作完成**：`src/sources/rulesFetcher.ts`（打端點）+ `panelAlerts.ts`（雙軌：
`alertState` 當觸發、rules 端點當內容）。`src/core/` **全部留用**。
~~273 行零修改存活。~~ ⚠️ **「零修改」自 2026-10 起不再成立**（同 `docs/ROADMAP.md`〈未完成項目〉的
**散落-2**）：`dedup.ts` 後來因兩個真實 bug 加了 `forget()` 與 `setWindow()`
（commit「fix(sources): 泛用 episode 被取代後，降級路徑會永久靜音」與
「fix(panel): 會讓面板永久靜音的三條路徑…」）。**留用**這個結論沒變，變的是「零修改」。
行數刻意不再寫死 —— 寫死過一次就過期過一次。
端點的「中高風險」標記仍然成立，但降級路徑已實作**並於 2026-09-21 實測四種失敗形狀**
（見 `docs/measurements.md` M-1）。**這題不要再開一次。**

### ~~🟡 破壞性操作，需你授權（P3）~~ ❌ **這條是錯的，不要照做**

~~`monitoring/` 的 Grafana 11.4.0 → 13.2.2 需要 `docker volume rm augur-monitoring_grafana-data`。~~

❌ **實測推翻（ADR-004〈待驗風險〉的 volume 條目；行號已因 2026-10-02 訂正位移）：升版\*\*不需要\*\*砍 volume，11.4.0 → 13.2.2 乾淨遷移完成。**
原判定是靜態推理（「13.0 的 unified storage migration 不可降版」）而非實測，不成立。

照舊文字做的後果：白砍一次 volume、admin 密碼回到 `.env` 初始值、
現有的 provisioned dashboard 與告警歷史全部消失 —— **而且完全沒有必要**。

### 🔴 敏感資訊，AI 不代處理

`WEBHOOK_SECRET` 已經進過 Grafana 容器環境與 provisioning 檔
（`monitoring/.env` 實含該變數，compose 有 `env_file: ./.env`）。
ADR-004 廢除整條 webhook 管線後，這個 secret 應該**輪換**，而不只是從 compose 拿掉一行。

同時 `monitoring/grafana/provisioning/alerting/{contactpoints,policies}.yml` 要不要清，
**ADR-004 決策 7 寫的是「monitoring/ 全套保留」，與計畫 P3 的刪除指示互相矛盾** —— 需裁定。

~~⏳ **仍未裁定（2026-09-21）。**~~ ✅ **2026-10-02 已裁定（經 PR 送審，merge 即為授權）：刪除兩檔**，
ADR-004 決策 7 補訂正。兩造原文與裁定並列在 `docs/ROADMAP.md`〈已裁定的衝突〉；
既有 volume 的一次性清除見 `monitoring/README.md`〈告警通知〉；其餘追蹤見 `docs/ROADMAP.md`〈未完成項目〉。
`WEBHOOK_SECRET` 的輪換**也仍未做**，且那件事不需要等上面的裁定。
⏳ **狀態（2026-10-15）：仍開著，追蹤於 `docs/ROADMAP.md`〈未完成項目〉〈卡在人〉的 B3-3。**
該條補了一個 2026-10-02 的新事實：contactpoints 刪除後這個 secret 已無任何消費者，
所以**作廢即可**，不必真的輪換出一個新值。仍是人的事，AI 不代處理也不編輯 `.env`。

### ✅ 已處理（2026-09-16 review 後）

| 項目 | 處置 |
|---|---|
| `live2d/_archive/nami/` 的 34 張「娜美風」角色美術（2.0MB，零出處，公開 Apache-2.0 repo） | **已從 branch 歷史移除**（分支當時尚未推送，只需改寫本地 commit；已 gc，舊物件不可達）。保留 `layout.json` / `manifest.json` 兩個純座標檔。原檔在本機備份。新增 `docs/asset-provenance.md` 與 `.gitignore` 防線 |
| `tools/asp-test.sh` 會為「完全沒執行的測試」蓋章放行 | 已修：跑前 `rm -f .jest-result.json`、判定納入 `JEST_EXIT`。並把 typecheck / lint / check-js-suffix 一併納入閘門 |
| README 的 `npm run server` 誤導 | 已補 `.env` 前置步驟與「P3 之前 Add panel 不會出現 Mascot」的但書 |
| `docs/ARCHITECTURE.md` / `monitoring/README.md` 仍描述已刪架構 | 已加失效警告與日期更新；**整份重寫仍在 P6 / P3** |

### 🟡 Review 指出但仍需你裁定

⏳ **狀態（2026-10-15）：五列裡兩列已修、三列仍開著。**「仍需你裁定」這個節名只對後三列成立。

| 項目 | 狀況（2026-09-16 原文） | 現況（2026-10-15） |
|---|---|---|
| `.claude/settings.json` 進了公開 repo | 內含 `Bash(*)` 全域放行與三條 `/home/ubuntu/.claude/asp/hooks/` 絕對路徑，是本機狀態。零憑證（不觸鐵則二），但 `git rm --cached` 一行即可清掉。與 nami 是同一個「什麼該公開」的問題 | ⏳ **仍開著 → `docs/ROADMAP.md` B7-1。** 三條 v4 hook 絕對路徑已於 asp-ng 接入時移除（2026-10-10），現在是 deny 10 條 / ask 10 條（2026-10-15 實查 `.claude/settings.json`；`docs/ROADMAP.md` B7-1 仍記 12 / 12，待該條自己的票更正）；但「`git rm --cached` 一行即可」**已不成立** —— 移出前要先替 deny 規則與 ship-gate 找著落（`pretooluse-ship-gate.sh` 不能直接搬到全域），`.claude/skills/` 下的 11 個專案資產也不要一起移 |
| ADR-004 檔頭升級來歷寫「6 項查不到」，同檔〈查不到〉只列 5 項 | 第 6 項（rules 端點穩定性）只存在於未納管的 `.asp-fact-check.md`。**改 ADR 需你授權**，故未動 | ⏳ **仍開著 → `docs/ROADMAP.md` B4-4**（屬「ADR-004 的下一次修訂」那一批，仍需人類授權）。補列時要引用 `docs/measurements.md` M-1 的實測，並留意 **A2-3** 的更正：M-1 量的是 `fetch + .json()`，不是 `getBackendSrv().get()` 本身 |
| `.asp-fact-check.md` 被 gitignore | 24 列中約 10–15 列只活在版控外。這是全機 15+ repo 的 ASP 慣例，**不宜單一 repo 破例**，故未動。ADR-004 的 Verification Evidence 表（已版控、每列自帶一級來源）承擔了主要舉證責任 | ⏳ **維持原判（不破例）**，但補列的缺口追蹤於 `docs/ROADMAP.md` **散落-3**；SP-9.6 另立了一條配套規則：公開 repo 要看得到的結論必須**逐字內嵌進版控文件**，不可只寫「見 `.asp-fact-check.md`」 |
| `monitoring/windows/*.ps1` 的供應鏈 | 兩支腳本要求管理員權限、抓 GitHub `releases/latest`（**版本不 pin**）、靜默安裝成 Windows 服務，**零 checksum、零簽章驗證**。公開 repo 上陌生人可能照著跑 | ✅ **已修。** 兩支腳本現在都釘住版本並驗 SHA256（`windows_exporter-install.ps1` 釘 `0.31.8` + `Get-FileHash -Algorithm SHA256` 比對 release 的 `sha256sums.txt`；`alloy-install.ps1` 同樣做法）。管理員權限與靜默安裝是安裝 Windows 服務的必然，檔頭已寫明 |
| `npm run e2e` 會登入一台無關的 Grafana | `baseURL` 預設 `localhost:3000`（本機被別的 stack 佔著），`tests/` 未落地故只跑 `@grafana/plugin-e2e` 內建的 auth.setup。需固定 `GRAFANA_URL` 或在 P4 補 `tests/` | ✅ **已修（兩半都做了）。** 根 `playwright.config.ts` 把 `baseURL` 覆寫成 `process.env.GRAFANA_URL ?? 'http://127.0.0.1:3002'`，註解逐字寫明「不覆寫的後果不是連不上，是去登入 3000 上那台無關的 Grafana」；`tests/` 也已落地（`plugin-loads.spec.ts`、`panel-speaks.spec.ts`）。⚠️ 另一個相關坑仍開著：`.config/AGENTS/e2e-testing.md` 教的 `GRAFANA_VERSION` 在本 repo 無效 → **B7-4-附** |

### 🔵 覆蓋缺口（review 補查，非缺陷）

⏳ **狀態（2026-10-15）：三條都已有後續處置，列在各條末尾。**

- **依賴供應鏈**：`npm audit` 有 8 個漏洞（5 high），全在 `@grafana/*` 的 transitive。
  但 webpack 將 `@grafana/*` 設為 externals、`dist/module.js` 僅 2,729 bytes，
  **有漏洞的套件不會隨 plugin 出貨** —— 乾淨是靠架構不是靠運氣。
  ✅ **已結案並升格成一份獨立裁決**：`docs/dependency-audit.md`（2026-09-21）
  —— 結論相同（**不修、不跑 `npm audit fix --force`**），但更正了本條兩處：
  「全在 transitive」是錯的（三個 `@grafana/*` 是 `dependencies` 裡的 direct），
  且不只一條鏈（至少 `dompurify`、`js-cookie → react-use`、`react-router` 三條）。
  **「8 個漏洞（5 high）」與另一處記的「3 moderate / 5 high」其實一致**（3+5=8），不是矛盾。
  ⚠️ `dist/module.js` 的 2,729 bytes 不要再引用 —— 寫下來幾天就過期，而且沒有東西依賴它。
- **缺失的整合測試**：計畫要求補一條等價於 `server.test.ts` 的「過濾 → 去重 → 播報」整合測試，
  P2 未補。**但現在不建議補** —— production 端對 `src/core/` 目前零 import
  （串接碼只存在於已刪的 `main:src/server.ts`），此刻在 `__tests__/` 自己接線自己斷言，
  P4 把次序寫反時照樣會綠。應在 P4 有真實串接碼之後才補。
  ✅ **前提已消失，該補的也補了。** P4 之後 `src/core/` 有真實串接碼
  （`src/sources/panelAlerts.ts`、`src/director/BroadcastDirector.ts`、`src/components/MascotPanel.tsx`），
  「過濾 → 去重 → 播報」這條管線由 `src/director/__tests__/BroadcastDirector.test.ts`
  對真實串接碼斷言，`tests/panel-speaks.spec.ts` 另在真 Grafana 上跑端到端。
  **不要再照「現在不建議補」那一行做** —— 它的理由（零 import）已經不成立。
- **`.config/AGENTS/`** 這批會直接指揮下一個 agent 的指令檔，review 未實質審過內容。
  ⏳ **已實質審過，裁定仍開著 → `docs/ROADMAP.md` B7-4。** A4-7 讀完四個檔
  （`instructions.md`、`e2e-testing.md`、`skills/build-plugin.md`、`skills/validate-plugin.md`）：
  沒有本機絕對路徑、沒有憑證，建議四個都留在公開版控 —— 但「什麼該公開」要專案主人一句裁定。

### 🟢 小決定

⏳ **狀態（2026-10-15）：三列都有處置，見末欄。**

| 事項 | P2 的處置 | 待決 | 現況（2026-10-15） |
|---|---|---|---|
| `.env.example`（20 行 AIRI 設定）與 `docs/sample-grafana-firing.json` | **兩個都沒動** | 不在 ADR-004 廢除清單內，但 ADR-004 正文點名 `.env.example` 是「dormant 污染設定面」的反例。刪或留？ | ⏳ **仍開著 → `docs/ROADMAP.md` B3-4。** 另記一件已做的：`monitoring/.env.example` 的 `WEBHOOK_SECRET` 三行已於 2026-10-02 隨 contactpoints 刪除拿掉；還在的是**根目錄**那一支 |
| plugin 版本號 | 暫取 `0.1.0` | 腳手架預設 `1.0.0`。它會注入 `dist/plugin.json`，對外可見。5 個 POC gate 全未跑，1.0.0 名實不符 | ✅ **已結案。** 5 個 POC gate 於 2026-09-18 全 PASS，之後實際發過 v0.1.0 / v0.2.0 / v0.2.1，`package.json` 現為 `0.2.1`（`src/plugin.json` 寫 `%VERSION%`，建置時注入）。1.0.0 的時機屬 P11〈1.0 準備〉 |
| `src/img/logo.svg` | 維持腳手架預設 | ~~換成 A1 衍生圖~~ —— A1 已於 2026-09-21 退出版控。改為：等 sprite 交付後由 master frame 裁一張，路徑須落在 `src/` 底下 | ⏳ **仍開著 → `docs/ROADMAP.md`〈未完成項目〉的 `logo` 那一條**（素材已於 2026-10-05 定稿，所以「等交付」的前置已解除；卡在 B2-4 的機械驗收）。改 `plugin.json` 後要重啟 Grafana |

---

## 三點五、POC 實測結果（2026-09-17）與它推翻的兩件事

✅ **狀態（2026-10-15）：本節的數字仍然有效，且是版控裡唯一的出處** ——
`src/avatar/flap.ts`、`src/speech/speaker.ts` 與 `docs/sprite/sprite-sheet-spec.md`
都在引用它。**不要刪，也不要照它推翻的那兩件舊主張做。**

在**使用者實際看 dashboard 的機器**（Windows 11 / Chrome 152 / zh-TW）上跑過 Web Speech 探針，
五項先前標「查不到」的問題全部有答案。完整記錄見 `.asp-fact-check.md`。

| 問題 | 實測 |
|---|---|
| zh-TW 聲線 | **4 個**，其中 `Microsoft Hanhan`（預設）/ `Yating` / `Zhiwei` 三個是**本機**引擎 |
| `getVoices()` 首呼 | **空的**；單次 `voiceschanged` 於 +17ms 後給滿 25 個 |
| user gesture | **不需要** —— 零點擊即發聲且實際聽得到（還是在沙箱 iframe 內） |
| 中文 `onboundary` | **會觸發，詞級**：77 字 21 次，`charLength` 1–14，頻率 1.53 次/秒 |
| 15 秒截斷 | **未重現** —— 連續發聲 90 秒未中斷 |

### ~~⚠️ 這推翻 ADR-004 決策 4 的一個前提（需你授權修訂 ADR）~~ ✅ **已併入 ADR-004 並實作**

ADR-004 決策 4 寫「嘴型改用 `onboundary` 做 word-level 開合，**或** speaking 期間循環播固定幾格」，
而 review 進一步主張 **MVP 砍掉 boundary 模式**，理由是「boundary 模式下 speaking 每秒翻轉 5 次以上，
兩個圖層 visibility 每秒對調 5 次以上」。

**那個頻率是假設的，不是量的。實測是 1.53 次/秒**，相鄰事件平均間隔約 600ms（範圍 200–1950ms）。
在這個節奏下，boundary 驅動嘴型不但可行，還比定速循環好 ——
`charLength` 直接給出這一組的字數（1–14），可以讓長組多擺幾下、短組只擺一下；
`charIndex` 另可驅動播報 feed 的逐詞高亮。

✅ **P4 採用了這個建議並已實作**（`src/avatar/flap.ts`，`charLength` 決定**擺動次數**）。
**不要照 §四「MVP 砍掉 boundary 模式」那一行做** —— 那一行是被本節推翻的舊主張。

**建議的 P4 做法**（取代 review 的「砍掉 boundary」）：以 boundary 事件為**同步點**，
在兩個事件之間跑一個嘴型循環，循環次數由 `charLength` 決定。
`setSpeaking(boolean)` 仍保留作為 fallback（給不觸發 boundary 的語言或引擎），
`setMouthOpen?(open)` 這個可選成員仍然值得留 —— 它現在有了第二個用途。

### ~~⚠️ 這也讓「切段 ≤10 秒」失去實證依據~~ ✅ **2026-10-06 已依本節的建議實作（B7-2）**

review 要求 `chunkText` 依時長 ≤10s 切。實測 90 秒連續發聲未截斷，該要求目前**沒有證據支撐**。
但**不建議就此取消**：本次用的是本機 Hanhan，而該 bug 歷史上與**遠端**聲線相關，
有風險的那一組沒測到。建議改為「使用本機聲線時不切段；偵測到 `localService === false` 時才切段」。

✅ **這個建議被採納並實作完成**（`src/speech/speaker.ts` 的 `splitForRemoteVoice`）：
`localService === false` 的聲線依 `CHARS_PER_SEC` 切成每段 ≤10 秒（語速加快時上限跟著放大），
本機聲線與 null 聲線不切；不切在小數點、IP、IPv6、時間與 Windows 路徑中間。
15 條測試、11 個對應變異全數轉紅。**遠端那一半仍只有單元測試** —— 手上沒有遠端聲線可實跑。
追蹤條目 `docs/ROADMAP.md` 的 **B7-2 已結案**。

### 給 P4 的實測基準

✅ **狀態（2026-10-15）：三條都仍然有效，且都已落實在程式裡**（下方逐條不再重複標記）。

- **語速 5.6 字/秒**（Hanhan 預設 rate）。一則典型告警句約 77 字 ≈ **14 秒**。
  這個數字直接決定播報佇列的積壓速度：三則 critical 同時進來就是 42 秒的隊列。
- **啟用鈕仍保留但不應阻擋首次播報** —— 實測不需手勢，但 Chrome 的自動播放政策對
  同一 origin 有黏性，不能排除先前互動的影響。
- 首次 boundary 恆為 `name: "sentence"` 且 `charLength: 0`，是句首標記而非詞 —— 不要當成嘴型觸發。

## 三點六、P5 素材：已裁定與待你回報（2026-09-18）

⚠️ **狀態（2026-10-15）：本節有三處把已廢除的 SP-2.6 / SP-3.3 / SP-5.3 寫成現行指示，已逐處標記（A0-1）。**
P5 素材本身已於 **2026-10-05 定稿**（專案主人的 Gemini 原圖改格，`SPRITE-CHECK: PASS`，
視線不做 → `features.gaze = false`），角色定義見規格 **SP-0.9**；收尾項目追蹤於
`docs/ROADMAP.md`〈未完成項目〉（B2-1 凍結、B2-4 機械驗收、B2-6 門檻回填、logo）。

規格在 `docs/sprite/sprite-sheet-spec.md`（21 處跨設計矛盾的裁決全文保留）。
~~（1169 行）~~ ⚠️ **行數已拿掉**：寫死就會過期，而且沒有任何東西依賴它的確切值。

### ✅ 已裁定

| 事項 | 決定 |
|---|---|
| `AvatarController` 新增 `setReaction?('click'\|'pending'\|null)` | **放行**（已實作）。同時回覆 ADR-004〈待驗風險 4〉—— 該條原文寫「`emotion.ts` 只有 4 個 emotion，**需擴充**」，實際走相反的路：**不擴 `Emotion`**，因為 click/pending 不是 severity 的函數，擴了會逼 `severityToEmotion` 這個純函式處理與 severity 無關的輸入，污染 `core/` 的語意 |
| 產製路徑 | ~~**先跑可讀性實測再決定**~~ ⚠️ **「先跑可讀性實測」這半句已於 2026-09-20 廢除**，見 `sprite-sheet-spec.md`〈可讀性實測：三輪，與它們證偽的東西〉（SP-5.3 連同 SP-2.6 / SP-3.3 一起廢除，取代它的是 SP-V.1 的交付驗收）。**不要再去跑它。**「委外行情 USD 50–150（`live2d/_archive/DEPRECATED.md` 記載），委外須一併取得書面著作權讓與」那半句仍然有效，但也已不適用：素材於 2026-10-05 由專案主人自行以 Gemini 生成並定稿，不再發包（`docs/ROADMAP.md` 的 B2-2 已作廢） |
| 角色設定（capelet 太暗、瀏海蓋住眉窗） | 建議一併改 —— 不論誰畫都要重畫，現在改免費，畫完再改就是重畫 |

### ✅ ~~硬 blocker：A1 出處~~ —— 已於 2026-09-21 解決

專案主人確認想不起來當初用的生成式服務。依 `docs/asset-provenance.md` 自己的規則
（出處不明一律不進版控），A1 與其衍生分層共 11 檔（約 7.6 MB）退出版控。

**角色不變** —— 它的定義是 `live2d-template-spec-v1.md` §7 的文字描述加上
規格 **SP-6.0 的色票表**（刪檔前從各分層量出來的 16 個 hex 值與相對亮度），
兩者都是本專案自己的產物。

### ~~⏳ 進行中：可讀性實測~~ ❌ **2026-09-20 廢除，整節不要照做**

**見 `docs/sprite/sprite-sheet-spec.md`〈可讀性實測：三輪，與它們證偽的東西〉。**
實測真的跑了（三輪共 98 題），結論是**證偽了整個參數化前提** ——
SP-2.6（虹膜直徑）、SP-3.3（瞳孔位移）、SP-5.3（可讀性實測本身）**三條條文一併廢除**，
取代它們的是 SP-V.1 的交付驗收。下面是當時的原文，保留為歷史：

> ~~規格裡**唯一凍結後改不動**的是虹膜直徑與瞳孔位移 —— 改它們等於 18 格全部重畫。~~
> ~~盲測頁已發佈，36 題、三組參數 × 三個尺寸隨機交錯，結果自動回傳。~~
> ~~判讀重點是 **128px 那三列**（規格訂的最小顯示尺寸），該列過不了的參數組不能用。~~

⚠️ 連帶作廢的還有「36 題」這個數字（實際三輪共 98 題）與「唯一凍結後改不動」這個說法 ——
定稿素材**不做視線**（`features.gaze = false`），虹膜直徑與瞳孔位移已不是凍結清單的樞紐。

## 四、P3/P4 契約備忘（給下一階段執行者）

✅ **狀態（2026-10-15）：P3 與 P4 都已完成，本節整體降為歷史契約。**
每一塊下面都帶了狀態。**只有帶 ❌ 的那兩行是「不要照做」**，其餘是已落實的設計理由，
拆掉會把對的東西改壞。仍開著的部分一律指向 `docs/ROADMAP.md`〈未完成項目〉。

**types 層**：D1（複製 episode 而非重算）、D5（levelIndex）、D6（repeatFiringMin）、
D9（startsAt 凍結）、D10（useRef + LoadingState 守門）**採用**；
D2（六態映射）、D4（ruleUID fingerprint）、D8（no_data option）**依第一節改寫**。
fingerprint 改用 `alert:panel:${panelId}:${kind}`，不提 ruleUID。

**avatar 層**：
- ~~**MVP 砍掉 boundary 模式**~~ ❌ **已作廢，不要照做。**
  本檔 §三點五 的實測推翻了它所依據的假設（假設每秒翻轉 5 次以上，**實測 1.53 次/秒**）。
  程式走的是 boundary 驅動（`src/avatar/flap.ts`，檔頭寫明理由）。照這一行做會把 `flap.ts` 拆掉重寫。
- 介面補**可選**成員 `setMouthOpen?(open: number): void` 承接幀級嘴型 ——
  這樣未來若有拿得到 audio buffer 的 TTS，振幅 lip-sync 只要實作這個成員就能回來，
  不必再動一次契約
- watchdog 觸發路徑必須**先 `synth.cancel()` 再 finish**，否則只是把「卡住且看得出來」
  變成「卡住且看不出來」
- `chunkText` 依時長 ≤10s 切
  ✅ **2026-10-06 已實作（B7-2 結案）** —— 本行先前標的「⏳ 未實作」已過期。
  `src/speech/speaker.ts` 的 `splitForRemoteVoice` 只對 `localService === false` 的聲線切段
  （依 `CHARS_PER_SEC`，語速加快時上限跟著放大），本機與 null 聲線不切，
  正是 §三點五 建議的那個形狀。15 條測試、11 個對應變異全數轉紅。
  **仍知的限制**：遠端那一半只有單元測試，手上沒有遠端聲線可實跑。

**dedup**：需新增 `forget(fingerprint)`，不要靠副作用達成。
✅ **已因真實 bug 實作**（2026-10 訂正本條；原本在 2026-09-21 標成「已作廢」）。

當時作廢的理由是：`shouldSpeak` 對 `resolved` 的處理**本來就是** `lastFiring.delete(key)` 後回 true
（`src/core/dedup.ts`）—— 那不是「副作用」，那是 resolved 綁狀態的實作本體；
另開一支 `forget()` 會讓同一件事有兩個入口，而其中一個沒有人呼叫。

**那個推論在當時的程式上是對的，但後來出現了第二個呼叫者。** `dedup.ts` 現在有 `forget()`
（commit「fix(sources): 泛用 episode 被取代後，降級路徑會永久靜音」）與 `setWindow()`
（commit「fix(panel): 會讓面板永久靜音的三條路徑…」）—— 兩支都是修真實的永久靜音 bug 時加的，
不是為了「不靠副作用」這個美感理由。所以本行的結論反轉：**`forget()` 存在、有人呼叫、不要移除。**
追蹤條目見 `docs/ROADMAP.md`〈未完成項目〉的 **散落-2**。

**P4 必須 POC 實測、不可推論的四項** —— ✅ **四項都已有答案（2026-10-15 補狀態）**：

| 原項目 | 現況 |
|---|---|
| `recovering` 的語意（`keep_firing_for` 期間 vs 已恢復觀察期，兩種語意下 flap 行為完全相反） | **不適用，不必再測。** `promAlertStateToAlertState()` 是 firing→Alerting、pending→Pending、**其餘一律 OK**，所以 `recovering` 透過這條路徑永遠到不了 panel（2026-09-17 實測確認，見 `src/sources/panelAlerts.ts` 的註解與 ADR-004）。兩種語意都不影響 flap，因為那個值不會出現 |
| boundary event 對中文 voice 是否觸發及粒度 | ✅ **已測，見 §三點五**：**會觸發，詞級**（77 字 21 次、`charLength` 1–14、1.53 次/秒）。`src/avatar/flap.ts` 以 `charLength` 決定擺動次數 |
| Chrome「約 15 秒無聲截斷」的確切條件 | ⚠️ **未重現，條件仍未知**：本機 Hanhan 連續發聲 90 秒未中斷（§三點五）。歷史上該 bug 與**遠端**聲線相關，而手上沒有遠端聲線，所以「確切條件」這一題**沒有結論**。防線改走實作：遠端聲線一律切 ≤10 秒段（B7-2，已完成），外加 watchdog |
| `unlockSpeech` 的靜音熱身是否必要且足夠 | ✅ **已答：不必要。** 實測 `speak()` 零點擊即發聲、且是在沙箱 iframe 內（§三點五）。介面上的 `unlock()` 保留為保險（Chrome 自動播放政策對同一 origin 有黏性，不能排除先前互動的影響），但**不應擋住首次播報** —— 理由逐字寫在 `src/speech/speaker.ts` 的 `Speaker.unlock` 註解。⚠️ 仍未驗的是另一件事：**Frontend Sandbox 開啟時語音能否發聲**（headless 無聲線）→ `docs/ROADMAP.md` 的 B5-1 |

**P5 素材** —— ✅ **已落實**（比例錨點的要求見下方原註；素材已於 2026-10-05 定稿）：
9 格反應圖與 9 格方向圖的比例錨點必須**在畫之前**校正並凍結
（兩張對不齊時切換圖層會「跳一下」，肉眼很明顯）。
注意 `live2d-template-spec` §3 的「臉中軸 X≈384 / 眼線 Y≈285」是 768×1376 全身基準圖的
**絕對像素**，丟給畫 512 方格的人沒有意義，必須改成以格寬為單位的比例，
並先決定裁切構圖（胸上 vs 全身）。
另更正一處事實：`assets/layers/` 實際是 **6 張** `part_*.png` + 1 張 `_preview_segmentation.png`（預覽圖），
不是先前文件寫的「7 張分層」。
⚠️ **該目錄已於 2026-09-21 整個退出版控**（出處不可考，見 `docs/asset-provenance.md`）。
比例錨點的要求仍然成立且已落實在 `docs/sprite/sprite-sheet-spec.md` §2，
風格依據改為 `live2d-template-spec-v1.md` §7 的文字 + SP-6.0 的色票表。

---

## 五、已知的 blocker

⏳ **狀態（2026-10-15）：仍然成立，追蹤於 `docs/ROADMAP.md`〈未完成項目〉〈卡在人〉的 B5-2**
（需主機持有者以管理員身分安裝 `windows_exporter`，AI 不代處理）。
本節描述的硬前置（`__dashboardUid__` / `__panelId__` 註解）已補完，所以「裝好就能驗」仍是真的。

**G-ADR004-2b（真 Windows 端到端）目前無法執行。** Windows 側實查：
9182（windows_exporter）、6121（AIRI）、3001（bridge）**皆無 listener**。
（6121 / 3001 已不相干 —— AIRI 與 bridge 都隨 ADR-004 廢除了。剩下的只有 9182。）

⚠️ **2026-09-21 補：在裝 exporter 之前還有一個硬前置已經做完，但要知道它存在** ——
`rules-perf.yml` / `rules-security.yml` 那 8 條真規則先前**沒有** `__dashboardUid__` /
`__panelId__` 註解，`alertState` 到不了任何 panel。A5-4 已補上並在 POC dashboard
加了 panel 4 / 5 綁它們。所以現在「裝好 exporter 就能驗」才是真的。
在裝好 `windows_exporter` 之前跑不了 —— 這也是把 always-firing 的 `vector(1)` 規則
升為 G-ADR004-2 骨幹的正確性佐證。
