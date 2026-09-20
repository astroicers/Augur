# 素材出處與授權

> 本 repo 是**公開的 Apache-2.0**。任何進版控的美術資產都必須在此表有一列。
> 建立於 2026-09-16，起因是 review 發現 `live2d/_archive/nami/` 有 2.0MB 角色美術
> 零出處地進了版控 —— 而同一個 repo 對 three-vrm、Cubism Core、Hiyori、page-mascot
> 都已經逐項標過授權。三次做對、一次漏掉，所以改成用一張表釘住。

## 進版控的資產

| 路徑 | 內容 | 出處 | 授權 | 備註 |
|---|---|---|---|---|
| `assets/a1-augur-calm.png`<br>`assets/a1-augur-calm-cutout.png` | Augur 角色「銀藍占卜師」立繪，768×1376 | ⚠️ **不可考**（見下方調查） | ⚠️ **待專案主人確認** | 專案自有的原創角色，非第三方既有角色 |
| `assets/layers/part_*.png`（6 張） | 上述立繪經 l2d-factory 拆出的分層 | 由上一列衍生 | 同上 | `_preview_segmentation.png` 為拆層預覽 |
| `live2d/_archive/nami/layout.json`<br>`live2d/_archive/nami/manifest.json` | 純座標與 z-order，**無美術資料** | 自產（拆層工具輸出） | 隨 repo Apache-2.0 | 對應的 34 張圖已移除，見下 |
| `src/img/logo.svg` | plugin 圖示 | `@grafana/create-plugin` 7.11.0 腳手架 | Apache-2.0（隨腳手架） | 尚未替換成自有圖示 |

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
| `web/public/avatar.vrm`（11MB） | 體積 + 授權；原由 `web/scripts/fetch-assets.sh` 下載。`web/` 已於 `d428af1` 刪除 |
| `web/public/live2dcubismcore.min.js` | **Live2D Cubism Core 為專有軟體，不可再散布** |
| `web/public/models/Hiyori.*` | Live2D 官方範例模型，Free Material License，不隨本專案散布 |

## 規則

新增任何美術資產進版控之前，先在上表補一列。出處不明的一律不進版控。
第三方素材即使授權允許，也要標明出處與授權條款；「看起來可以用」不算。
