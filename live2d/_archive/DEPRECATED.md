# ⚠️ DEPRECATED — Live2D(2D)路線已封存

**2026-06-23 起,Augur 角色改走 VRM(3D),廢除 Live2D。** 現行路線見 [`../../avatar/VRM-RUNBOOK.md`](../../avatar/VRM-RUNBOOK.md)。

## 為什麼廢除

Live2D 要 Cubism 綁定(GUI 手工、無法自動化、學習曲線陡或外包 USD 50–150)才能產出 `.moc3`,是全流程最貴、我(agent)做不到的一步;換皮又有 UV/mesh 對齊與授權限制。
VRM(VRoid Studio)= 現成 rig 換裝:對嘴/眨眼/idle/look-at/物理全內建、免 Cubism、免授權地雷、AIRI 同等支援 → 淨賺。代價僅「2D 手繪感 → 3D」。

## 這裡留存什麼(參考用,不再維護)

- `live2d-template-spec-v1.md` — Live2D 模板規格(錨點/部件/參數/4 表情/prompt/打包),曾錨定 Augur 銀藍占卜師 A1。
- `RUNBOOK.md` — Live2D 製作/外包/拆層工具研究(See-through、KomikoAI、外包行情等,仍有參考價值)。
- `README.md`、`nami/`(namei 匯出的娜美風全身組裝)、`layerwork/`(A1 的拆層 prompt)、`scripts/`(去背/驗收)。

## 仍在使用的東西

- `.claude/skills/image-layer-split/` — **保留**。它是通用「圖 → 分層圖庫」工具(生 Nano Banana prompt + 組裝驗收 + compose_cropped),不限 Live2D,日後仍可用。
