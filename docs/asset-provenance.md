# 素材出處與授權

> 本 repo 是**公開的 Apache-2.0**。任何進版控的美術資產都必須在此表有一列。
> 建立於 2026-09-16，起因是 review 發現 `live2d/_archive/nami/` 有 2.0MB 角色美術
> 零出處地進了版控 —— 而同一個 repo 對 three-vrm、Cubism Core、Hiyori、page-mascot
> 都已經逐項標過授權。三次做對、一次漏掉，所以改成用一張表釘住。

## 進版控的資產

| 路徑 | 內容 | 出處 | 授權 | 備註 |
|---|---|---|---|---|

| `live2d/_archive/nami/layout.json`<br>`live2d/_archive/nami/manifest.json` | 純座標與 z-order，**無美術資料** | 自產（拆層工具輸出） | 隨 repo Apache-2.0 | 對應的 34 張圖已移除，見下 |
| `src/img/logo.svg` | plugin 圖示 | `@grafana/create-plugin` 7.11.0 腳手架 | Apache-2.0（隨腳手架） | 尚未替換成自有圖示 |

## A1 已退出版控（2026-09-21）

專案主人確認**想不起來當初用的是哪個生成式服務**，依本文件自己的規則
（出處不明一律不進版控）裁定把 A1 與其衍生分層退出版控。

**退出的 11 個檔案**（約 7.6 MB）：`assets/a1-augur-calm.png`、
`assets/a1-augur-calm-cutout.png`、`assets/layers/` 的 6 張 `part_*.png` 與
`_preview_segmentation.png`、`live2d/_archive/layerwork/_source.png`（與 A1 位元組相同）、
`live2d/_archive/layerwork/_cutout.png`。原檔仍在本機，只是不進版控。

**角色沒有消失。** 它的定義是兩份本專案自己的產物：
`live2d/_archive/live2d-template-spec-v1.md` §7 的文字描述，
以及 `docs/sprite/sprite-sheet-spec.md` **SP-6.0 的色票表**
（刪檔前從各分層量測出來的 16 個 hex 值與相對亮度）。
畫師拿的本來就是文字與色票，不是拿 A1 去描。

**為什麼不是「留著並接受風險」**：這個 repo 是公開的 Apache-2.0。
「大概沒問題」不是可以寫進出處欄的東西，而出處欄寫不出來的資產不該在裡面 ——
那條規則是這份文件自己訂的，`live2d/_archive/nami/` 那 36 檔就是沒守它的代價。

### 做到哪裡（2026-09-21，誠實記）

**已做**：一次普通的 `git rm --cached` commit 把 11 個檔移出索引，並在 `.gitignore`
釘住五條路徑防止再度加入。原檔留在本機磁碟（已 gitignore），另有一份離線備份。

**沒做**：歷史沒有改寫。這 11 個 blob 在 `14a481d` 起算的 24 個 commit 的 tree 裡仍然存在，
clone 下來的人用 `git log --all -- assets/` 挖得到，而 `feat/grafana-mascot-panel`
已經推上 GitHub。所以現況精確的說法是「**不再提供**」而不是「**拿掉**」。

**要做到「拿掉」需要什麼**：`git filter-branch --index-filter` 覆寫分支上全部 24 個 commit，
再 `--force-with-lease` 推蓋 `origin/feat/grafana-mascot-panel`。代價有三：

1. 24 個 commit 的 SHA 全變。本 repo 文件目前引用了其中 5 個
   (`fbd81f4` / `de98011` / `9911b00` / `596f9db` / `dabb3f3`，散在 ADR-001、
   `sprite-sheet-spec.md`、`remaining-plan.md`)，全數失效 —— 可機械重映，但要一起改。
2. 屬 CLAUDE.md 鐵則明文列名的毀滅性操作（`git push` / `rebase`），需人類逐次授權；
   本機 auto mode 分類器亦直接擋下 `filter-branch`。
3. GitHub 端 force-push **不保證真的刪掉** —— 被覆寫的 commit 仍可用 SHA 取回，
   要徹底清除得另外請 GitHub Support 處理。換句話說這一步買到的是
   「一般 clone 拿不到」，不是「世界上不存在」。

**建議（仍待裁定）**：值得做，而且**趁分支 land 進 `main` 之前做**。
理由是時間窗：現在清只影響一支未合併的 feature 分支；併進 `main` 之後再清，
對象就變成 `main`，成本量級不同。與 nami 那次是同一個邏輯。

**與 nami 那次的差別**在風險性質而非規則寬嚴：nami 是可辨識的**第三方角色**，
風險是著作權侵害，且當時分支尚未推送、改寫成本近乎零；A1 是本專案的**原創角色**，
風險僅在於「產生它的服務其條款如何規定輸出歸屬」—— 那是條款問題不是侵權問題。
兩者都該清，但急迫性不同。

## A1 出處調查（2026-09-20）

`assets/a1-augur-calm.png` 是整個角色設定的根，值得把查過什麼寫下來，
免得下一個人重查一遍。

**查了什麼**：PNG 文字區塊（無任何 `tEXt`/`iTXt`/`eXIf`，沒有嵌入產生器資訊）、
本 repo 與 `l2d-factory` 全部 Markdown 的關鍵字掃描、git 歷史、相關 runbook 與 spec。

**查到的**：

- `live2d/_archive/layerwork/PROMPTS.md` 的標題是「**Nano Banana 2** 拆層 prompt」——
  但那是**拆層**步驟，A1 是它的**輸入**而非產出。
- `live2d/_archive/live2d-template-spec-v1.md` §7 明寫
  「`[CHARACTER_APPEARANCE]` 由**核准的 A1 圖反推**」—— 那段生成 prompt 寫在 A1 之後，
  是給**未來**同族角色用的，不是用來產生 A1 的。
- `live2d/_archive/README.md` 的待辦欄寫「A1 calm 基準角色圖 → **需使用者提供**」。

**結論**：A1 來自本 repo 所記錄的管線**之外**，由專案主人提供。
**用什麼工具產生的，repo 裡沒有任何記錄，也無法從檔案本身還原。**

**為什麼沒有比照 `live2d/_archive/nami/` 直接移出版控**：兩者的風險性質不同。
nami 是可辨識的**第三方角色**，風險是著作權侵害；A1 是本專案的**原創角色**，
風險僅在於「產生它的服務其條款如何規定輸出歸屬」——那是條款問題不是侵權問題，
且只有專案主人知道用了哪個服務。在未知服務的情況下逕行改寫已推送的歷史，
與風險不成比例。

**待專案主人做的一件事**：回想並確認當初用的服務，實讀其條款對「輸出歸屬」與
「商業／再散布」的規定，把結論與一級來源 URL 逐字填進上表。
**若條款不允許**，remedy 是比照 nami 處理 —— A1 移出版控、角色重新設計，
屆時 `live2d-template-spec-v1.md` §7 的角色凍結與本 repo 所有沿用該設定的素材一併作廢。

**在確認之前**：A1 維持現狀（已在版控中），但**新的 sprite 素材必須在產生的當下就記錄出處**
（見 `docs/sprite/production-sop.md` 階段 5）。這條規則對新素材沒有例外。

## 刻意不進版控的資產

| 路徑 | 原因 |
|---|---|
| `live2d/_archive/nami/` 的 34 張 png | 「娜美風」角色美術，零出處、零授權記錄。2026-09-16 從 branch 歷史移除（分支當時尚未推送，故只需改寫本地 commit）。原檔留在本機備份 |
| `web/public/avatar.vrm`（11MB） | 體積 + 授權；原由 `web/scripts/fetch-assets.sh` 下載。`web/` 已於 `fbd81f4` 刪除 |
| `web/public/live2dcubismcore.min.js` | **Live2D Cubism Core 為專有軟體，不可再散布** |
| `web/public/models/Hiyori.*` | Live2D 官方範例模型，Free Material License，不隨本專案散布 |

## 規則

新增任何美術資產進版控之前，先在上表補一列。出處不明的一律不進版控。
第三方素材即使授權允許，也要標明出處與授權條款；「看起來可以用」不算。
