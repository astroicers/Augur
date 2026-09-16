# Augur — Live2D 角色

讓 Augur 的告警由一個 Live2D 角色用語音念出(會眨眼、對嘴)。本資料夾放**規格與素材**,不含 bridge 程式。

## 兩份文件的關係

| 文件 | 角色 | 位置 |
|---|---|---|
| **SOP**(怎麼做) | 操作順序:Phase A 建母模型(一次)→ Phase B 換皮(每隻) | `/mnt/c/Users/USER/Downloads/live2d-production-sop.md` |
| **spec v1**(查表) | 規格是什麼:錨點/部件/參數/表情/prompt/打包 | [`live2d-template-spec-v1.md`](live2d-template-spec-v1.md) |

做的時候照 SOP 走,需要細節翻 spec 對應 § 章節。

## 流程兩階段（摘要）

- **Phase A(只做一次)**:產基準角色 → 量錨點(spec §3)→ 拆層(§4a)→ 畫共用 overlay(§4b)→ Cubism 綁母模型(§5/§6)→ 匯出 `master.moc3`。
- **Phase B(每隻角色)**:產美術(§7 prompt)→ 正規化對齊錨點 → 拆層 → 換貼圖到母模型 → 打包(§8)→ 匯入 AIRI 接角色卡。

## v1 範圍

只綁**對嘴 + 眨眼 + idle**;4 個情緒表情的部件/參數先在 spec 定齊(避免重綁),但 `.exp3.json` 與「按嚴重度切表情」**延後**到 AIRI server-sdk 的表情切換路徑通(見 spec §9)。語音播報與角色模型兩條平行、不互卡。

## 資料夾

- `live2d-template-spec-v1.md` — 規格本體(凍結 §3/§4a 後不可改,改即升版)。
- `../assets/` — 放 A1 基準圖、分層 PSD、Cubism 專案、匯出包。

## 待補（需使用者提供）

- **A1 calm 基準角色圖** → 放 `../assets/`。提供後填實 spec **§3 比例錨點**(量測)與 **§7 `[CHARACTER_APPEARANCE]`**(外觀反推),即可凍結並開始 Phase A 的 A3 拆層。
