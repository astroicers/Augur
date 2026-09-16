# 素材出處與授權

> 本 repo 是**公開的 Apache-2.0**。任何進版控的美術資產都必須在此表有一列。
> 建立於 2026-09-16，起因是 review 發現 `live2d/_archive/nami/` 有 2.0MB 角色美術
> 零出處地進了版控 —— 而同一個 repo 對 three-vrm、Cubism Core、Hiyori、page-mascot
> 都已經逐項標過授權。三次做對、一次漏掉，所以改成用一張表釘住。

## 進版控的資產

| 路徑 | 內容 | 出處 | 授權 | 備註 |
|---|---|---|---|---|
| `assets/a1-augur-calm.png`<br>`assets/a1-augur-calm-cutout.png` | Augur 角色「銀藍占卜師」立繪，768×1376 | ⚠️ **待補** | ⚠️ **待補** | 專案自有角色。生成方式與工具需由專案主人填寫 |
| `assets/layers/part_*.png`（6 張） | 上述立繪經 l2d-factory 拆出的分層 | 由上一列衍生 | 同上 | `_preview_segmentation.png` 為拆層預覽 |
| `live2d/_archive/nami/layout.json`<br>`live2d/_archive/nami/manifest.json` | 純座標與 z-order，**無美術資料** | 自產（拆層工具輸出） | 隨 repo Apache-2.0 | 對應的 34 張圖已移除，見下 |
| `src/img/logo.svg` | plugin 圖示 | `@grafana/create-plugin` 7.11.0 腳手架 | Apache-2.0（隨腳手架） | 尚未替換成自有圖示 |

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
