# 路線圖與計畫原文

> **這份文件存在的理由**：`docs/` 底下多份 handoff 與規格在引用「計畫 P3」「P5」「P6」，
> 而那份計畫只存在於本機 `~/.claude/plans/` 下一個未版控的檔案 ——
> **repo 的讀者拿不到被引用的原文**。凡是進版控的文件所引用的東西，都得在版控裡。
>
> 更要緊的是：那份計畫裡有一條與已 Accepted 的 ADR-004 **正面衝突**，
> 而衝突的兩造先前不在同一個地方，誰都看不出有矛盾。下面〈未解決的衝突〉把兩造並列。

## 階段與現況（2026-09-21）

| 階段 | 內容 | 現況 |
|---|---|---|
| P0 | 保護既有未版控資產 | ✅ `14a481d` |
| P1 | 寫 ADR-004 supersede ADR-001/002/003 | ✅ Accepted 2026-09-18，5 個 POC gate 全過 |
| P2 | 腳手架併入、`src/core/` 遷入、舊管線刪除 | ✅ |
| P3 | 開發環境（Grafana 升版、plugin 掛載、provisioned dashboard） | ✅ 除下方衝突項外 |
| P4 | plugin 實作（來源層、語音層、跨 panel 互動、`AvatarController`） | ✅ |
| P5 | sprite 素材 | **工具側 ✅、素材側未開工** —— 規格、SOP、SP-7 機械驗收、SP-V.1 盲測頁都就位；缺的是畫 |
| P6 | 文件 | ✅ 根 README / `src/README.md` / CHANGELOG 已對齊現況（2026-09-21） |

未完成項目的逐條執行計畫在 **`docs/handoff/remaining-plan.md`**，
分「現在就能做（A0–A5）」與「卡在人（B1–B7）」兩部分。

## 計畫原文（被引用的段落，逐字）

### P3 — 開發環境

> 改 `monitoring/docker-compose.yml`：
> - Grafana **11.4.0 → 13.2.x**。
> - 新增 volume 把 `dist/` 掛到 `/var/lib/grafana/plugins/augur-mascot-panel`。
> - 新增 `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=augur-mascot-panel`。
> - **補一個 provisioned dashboard**（`provisioning/dashboards/`，目前零個）——
>   沒有 dashboard 就無從測「點擊偵測」。
> - **丟** `alerting/contactpoints.yml` 與 `policies.yml`（指向已不存在的 :3001 bridge）。
> - **留** `rules-perf.yml`（CPU 85% / Mem 10% / Disk 10%）與 `rules-security.yml`（5 條 Loki 規則）
>   —— 它們正是 `alertState` 的來源，也是現成的 threshold 參考。

前四條已完成。**第五條未執行，且與 ADR-004 衝突 —— 見下。**

### P5 — sprite 素材

> - **內容大綱已經有人寫好**：`live2d/_archive/live2d-template-spec-v1.md:103-113` §6 定義了
>   calm/warning/critical/resolved 四個表情的視覺語意（汗滴、陰影、怒氣符號、閃光）。
>   直接當 9 格反應圖的大綱（4 格表情 + idle/眨眼/講話/追視左右）。
> - 現有 `emotion.ts` 只有 4 個 emotion，吃不滿 9 格 → 需擴充，它是骨架不是成品。
> - 風格參考：`assets/layers/` 的 7 張 full-canvas 同錨點分層（Augur 銀藍占卜師）。

⚠️ **這三條都已被後續裁定取代或作廢**：

1. 「9 格 = 4 格表情 + idle/眨眼/講話/追視左右」被四層疊合架構取代 ——
   現在是 **18 格**（directions 9 + reactions 9），語意見規格 §3 / §4。
2. 「`emotion.ts` 需擴充」被 2026-09-18 的人類裁定**否決** ——
   改用 `AvatarController.setReaction?()` 承接 click / pending，
   理由是它們不是 severity 的函數，擴充會污染 `severityToEmotion` 的純函式語意。
3. 「風格參考 `assets/layers/`」**該目錄已於 2026-09-21 退出版控**（出處不可考）。
   替代品是 `live2d-template-spec-v1.md` §7 的文字描述 + 規格 SP-6.0 的色票表。

### P6 — 文件

> 重寫根 `README.md`（**現在還在講 AIRI 與 `pnpm smoke`，已過期一輪，這次不要再欠**）
> 與 `docs/ARCHITECTURE.md`（資料流圖整份作廢）。修正安裝說明為 `dist/` 掛載。

已完成，並於 2026-09-21 再對齊一次現況。

## 未解決的衝突：`monitoring/` 的 contactpoints / policies

**兩造逐字並列**：

| 來源 | 原文 | 效力 |
|---|---|---|
| **ADR-004 決策 7**（`docs/adr/ADR-004-...md:162-163`） | 「**保留**：`src/core/*`… 與其 4 支測試；**`monitoring/` 全套**（升 Grafana 13.2.x、加 plugin 掛載、補 provisioned dashboard）。」 | **Accepted**（2026-09-18，經人類授權） |
| **計畫 P3** | 「**丟** `alerting/contactpoints.yml` 與 `policies.yml`（指向已不存在的 :3001 bridge）。」 | 計畫，未經 ADR 程序 |

**現況**：兩個檔**都還在**，而 `contactpoints.yml:11` 逐字是
`url: http://host.docker.internal:3001/grafana/webhook` —— 那個 bridge 已於 `fbd81f4` 刪除。
所以它現在是一個**指向不存在服務的 webhook 設定**。

**為什麼不自行裁定**：ADR 的效力高於計畫。「全套保留」是 Accepted 的文字，
要改它需要走 ADR 修訂（`remaining-plan.md` 的 B4），而那需要人類顯式授權。
在那之前自行刪除等於讓計畫覆寫 ADR，那會讓 ADR 的狀態值失去意義。

**三條可能的解**（待裁定，追蹤於 `remaining-plan.md` 的 B3）：

1. **刪掉兩個檔**，並在 ADR-004 補一行說明「全套保留」不含已失效的 bridge 設定。
2. **留著但改成無害**：把 webhook URL 換成一個明確的佔位（例如 `http://localhost:1/disabled`）
   並在檔頭標明它是歷史遺留、目前不通往任何地方。
3. **留著不動**，接受 `monitoring/` 裡有一份指向死服務的設定。

另外還有一件**與裁定無關、但不該一起拖著**的事：`WEBHOOK_SECRET`
曾出現在容器環境變數與 provisioning 檔裡。**那應該由人輪換**，不論上面選哪一條。
AI 不編輯 `.env`。

## ⚠️ 引用 commit SHA 這件事已經出過一次錯

2026-09-22 的複審發現：本 repo 的四份文件共五處引用 **`d428af1`**，而**那個 commit 不存在**。
`git cat-file -t d428af1` → `fatal: Not a valid object name`。
真正刪掉舊管線的是 **`fbd81f4`**（已全部更正）。

**來歷**：`d428af1` 是 nami 美術那次 `filter-branch` **之前**的 SHA。
改寫歷史讓分支上每個 commit 的 SHA 都變了，而文件裡的引用沒人回去更新 ——
**而且過了好幾天都沒有人發現**，因為沒有任何機械檢查會去驗一個 SHA 解不解得開。

**這直接關係到還沒做的 A1 歷史改寫（`remaining-plan.md` 的 D1／B6 前置）**：
同一件事會再發生一次。要做的話，改寫**之後**必須逐一重映文件裡的 SHA，
或者乾脆改成引用 commit 標題而不是 SHA。

## 相關文件

| 文件 | 內容 |
|---|---|
| `docs/adr/ADR-004-...md` | 決策權威。與本檔衝突時**以 ADR 為準**。 |
| `docs/handoff/remaining-plan.md` | 未完成項目的逐條執行計畫（A0–A5 / B1–B7） |
| `docs/sprite/sprite-sheet-spec.md` | 精靈圖規格。發包給畫師時給這份 + `production-sop.md` + `sprite-manifest.example.json`。 |
| `docs/asset-provenance.md` | 美術資產的出處與授權；含 A1 退出版控的完整記錄 |
| `docs/dependency-audit.md` | `npm audit` 的 8 筆命中為什麼不修 |
