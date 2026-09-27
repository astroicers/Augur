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

## 未解決：`measureStrokeWidths` 的重寫，卡在「沒有有效的測試台」

**現況**：`tools/lib/spriteChecks.mjs` 的 `measureStrokeWidths` 仍是「描邊帶面積 ÷ 剪影周長」。
2026-09-22 的對抗性複審對它提出三條實質指控（都附了量測）：

| 指控 | 複審量到的數字 |
|---|---|
| 內／外描邊兩種畫法在同一剪影上差 **2.31 px**，比整個容差窗 2.048 px 還寬 | 內 7.479 / 外 9.792 |
| 四條普通髮束（SP-2.3 合法）把真值 8.192 稀釋成 9.505 | 超出容差 |
| 1px 填色滲出（手繪 lineart-over-fill 的常態）讓環狀 flood 找不到種子 → **NaN 硬紅** | 舊實作 8.505 clean |

同日跑了一輪五設計 × 五評審的重設計工作流。結論是採用「沿剪影局部法線的逐邊界像素游程
＋直方圖眾數（不做周長正規化）」，實作簡報完整、每個常數都有出處。

**但它沒有落地，理由是我無法驗證它。** 實作完之後對照量測：

| 案例 | 新（法線游程） | 舊（面積÷周長） |
|---|---|---|
| 抗鋸齒基準（SP-2.14 下限 2px） | 7.864 通過 | 8.525 通過 |
| 相鄰 `#777777` 同亮度衣物 | 7.864 通過 | **8.525 通過** |
| 填色滲出 1px | 8.867 通過 | **8.680 通過** |
| 填色滲出 2px | 9.856 **紅** | 9.009 通過 |
| 四種一次上 | 9.856 **紅** | 9.009 通過 |

**在我建得出來的 fixture 上，新的比舊的差**（滲出 2px 與四合一都是回歸）。
更關鍵的是最後兩欄：舊實作在「同亮度衣物」讀 8.525 而不是複審說的 17.132，
在「滲出 1px」讀 8.680 而不是複審說的 NaN ——
**我的測試台一個原始失效案例都沒重現出來**，所以我沒有立場判斷改寫是不是改善。
按「量不到改善就不上」的原則退回，改寫的程式碼沒有保留。

**真正的 blocker 因此不是演算法，是 fixture。** `tools/lib/syntheticSheet.mjs` 畫的是
硬邊、平塗、1-bit alpha 的幾何人偶（1-bit 本身就違反 SP-2.14）。要評估任何描邊估計器，
測試台必須先能重現那三條指控，也就是至少要支援：
`strokeInside`、`fillBleedPx`、`inBandGarment`（讓帶內色**真的貼著**描邊，
複審的版本貼了 45% 周長）、`strands`、`alphaRampPx`（以真實邊界為中心的對稱斜坡 ——
單向往外加半透明像素會把剪影放大、每條游程系統性長 1.5px，我第一版就是這樣錯的）、
`matte`、`strokeColour`、`strokeGapY`、`perCellStrokePx`。

**【2026-09-26 更新：fixture 做好了，四條指控重現了兩條】**

`syntheticSheet.mjs` 的 `buildSheets(opts)` 現在支援 `strokeInside` / `fillBleedPx` /
`strands` / `alphaRampPx` / `matte` / `strokeColour` / `strokeGapY` /
`perCellStrokePx` / `inBandGarment`（預設值一律維持舊行為）。
alpha 漸層是**以真實邊界為中心**的對稱斜坡 —— 單向往外加會把剪影放大、
每條游程系統性變長，我第一次寫就是這樣錯的。

對現行 area÷perimeter 估計器實測（真值 8.192，容差 ±1.024）：

| 案例 | 量到 | 判定 |
|---|---|---|
| 基準 / 抗鋸齒 2px | 8.525 | 通過 |
| 內描邊 | 8.297 | 通過 —— 兩種畫法只差 **0.23px**，不是複審說的 2.31 |
| 填色滲出 1px / 3px | 8.598 / 8.854 | 通過 —— **不是 NaN** |
| **同亮度衣物 `#7c7c7c`** | **17.132** | **紅** ← 重現，與複審數字完全相同 |
| **四根漸細髮束** | **9.708** | **紅** ← 重現 |
| 真的畫錯 4px / 12px | 4.120 / 12.567 | 紅 ✓（鑑別力還在） |

**同亮度衣物那條已修**：SP-6.4 把 `#6E7681` 只列為參考色、規範的是亮度帶，
於是檢查沒有東西可以分辨「描邊」與「剛好同亮度的合法衣物」。
改成讓描邊色成為 manifest 的宣告值（`stroke.colour` + `stroke.colourToleranceRgb`，
預設取 SP-6.4 的參考色），亮度帶保留為第一道篩、顏色是第二道。
17.132 → 8.525，與乾淨基準完全相同。參考色由**完全不透明**的像素取，
不從最外圈取 —— 抗鋸齒讓最外圈是混色。

**四根髮束那條沒修。** 機制與複審描述的**相反**：我的 fixture 上它讓估計值偏**高**
（9.708 > 8.192），因為細髮束兩側的描邊會合併、描邊面積相對周長偏大；
複審描述的是偏低。我試過用形態學開運算排除細長特徵的周長，結果讓基準從
8.525 惡化到 9.070（吃掉 86% 容差預算）而髮束變成 11.068 —— 方向就是反的，已退回。
要修它需要的是工作流設計的**逐法線游程**而不是 area÷perimeter，
而那個 380 行改寫我仍然無法在現有證據下證明是改善。

**【2026-09-27 更新：換掉了。共用電池 15/20 → 20/20】**

`tools/stroke-battery.mjs`（20 列、兩個方向都要對）現在是共用的計分板 ——
上一輪失敗的唯一原因就是沒有它。舊的 area÷perimeter 實作：**15 / 20**，
錯的是 F/G（髮束 9.708）、L/M（matte → NaN）、S（窗內邊緣 9.0px → 9.426）。

新實作（法線游程 + 眾數統計 + sRGB→線性查表）：**20 / 20**，
selftest 126 / 126 零回歸，完整閘門全綠，9 格 172 ms，**沒有動任何 severity 或門檻**。
五列誤紅全部修掉。

**這份程式碼的來歷必須誠實記下來。** 重跑的設計比較工作流在驗證階段前失敗
（7 個 agent 有 5 個停滯），但其中一個 agent **把實作留在追蹤檔裡當殘留**、
而它的報告從未回來。我先自己照另一個設計的演算法重寫了一遍，只拿到 18/20；
發現工作樹有 423 行不是我改的東西之後才回頭查 —— 那份殘留在電池上跑 20/20。
我已經把它 `git checkout` 掉了，靠 `git fsck --lost-found` 從 dangling blob
（`83d8135`，95,867 bytes）救回來的。

**所以：這 390 行是我用量測驗證的，不是逐行讀過的。** 我驗了：
電池 20/20、selftest 126/126、閘門全綠、172ms、沒改任何 severity/門檻、
而且真實寬度 3→16px 的掃描顯示它確實在追蹤（不是回一個接近宣告值的數字）。
**但它需要一次 read-through。**

**已量到的系統性偏差**：在宣告值 8.192 上讀 7.553，**−0.639 px（吃掉 62% 的容差預算）**；
3–16px 全域都是 −0.3 到 −0.8 的負偏差。舊實作是 +0.333（33%）。
兩個都不是無偏的。**刻意不校正** —— 對著合成 fixture 減掉一個 offset
正好是「調到 fixture 上」那個陷阱，而合成 fixture 不是真實畫稿。
第一批真素材到貨時要重量這個偏差，再決定是校正還是放寬容差。

**仍然沒有的：`tools/` 裡完全不存在 SP-2.14 的檢查**（禁 1-bit 硬邊）。
整個電池的基準列都是 1-bit，也就是「閘門對著一張規格自己會退的圖校準」
這件事的最後一塊。補上它之後，1-bit 的那幾列該改成「應該紅」。

## ⚠️ 引用 commit SHA 這件事已經出過一次錯

2026-09-22 的複審發現：本 repo 的四份文件共五處引用 **`d428af1`**，而**那個 commit 不存在**。
`git cat-file -t d428af1` → `fatal: Not a valid object name`。
真正刪掉舊管線的是 **`fbd81f4`**（已全部更正）。

**來歷**：`d428af1` 是 nami 美術那次 `filter-branch` **之前**的 SHA。
改寫歷史讓分支上每個 commit 的 SHA 都變了，而文件裡的引用沒人回去更新 ——
**而且過了好幾天都沒有人發現**，因為沒有任何機械檢查會去驗一個 SHA 解不解得開。

**這直接關係到還沒做的另一次歷史改寫**：把 `assets/` 的 A1 衍生素材從分支的
24 個 commit 的 tree 裡移除（現況是「不再提供」而不是「拿掉」）。
同一件事會再發生一次 —— 分支上每個 commit 的 SHA 都會變。要做的話，改寫**之後**
必須逐一重映文件裡的 SHA，或者乾脆改成引用 commit 標題而不是 SHA。

> ⚠️ **這一段原本寫「`remaining-plan.md` 的 D1／B6 前置」。那個引用解不開** ——
> `remaining-plan.md` 裡沒有 D1，而 `A1` 在該檔解析到的是一個**已完成**的
> 「讓 panel 可被觀測」，跟歷史改寫無關。比純粹的斷鏈更糟：它會**默默解析到錯的東西**。
> 該次改寫的決策追蹤在 session 的待裁定清單裡，那份不在版控中 ——
> 所以這裡改成內文描述，不依賴任何跨檔錨點。

## 相關文件

| 文件 | 內容 |
|---|---|
| `docs/adr/ADR-004-...md` | 決策權威。與本檔衝突時**以 ADR 為準**。 |
| `docs/handoff/remaining-plan.md` | 未完成項目的逐條執行計畫（A0–A5 / B1–B7） |
| `docs/sprite/sprite-sheet-spec.md` | 精靈圖規格。發包給畫師時給這份 + `production-sop.md` + `sprite-manifest.example.json`。 |
| `docs/asset-provenance.md` | 美術資產的出處與授權；含 A1 退出版控的完整記錄 |
| `docs/dependency-audit.md` | `npm audit` 的 8 筆命中為什麼不修 |
