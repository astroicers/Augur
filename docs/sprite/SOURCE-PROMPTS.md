# 素材的生成 prompt 與後製紀錄（SP-9.3）

> 對應 `src/img/sprite/` 的 2026-10-05 定稿。出處總表見 [`../asset-provenance.md`](../asset-provenance.md)。

## 生成

| 項目 | 內容 |
|---|---|
| 產品 | Google Gemini（App，版本未公開） |
| 操作者 | 專案主人 |
| 日期 | 不晚於 2026-10-05（確切日期未保留） |
| 輸入參考圖 | 無 |

**prompt（逐字，專案主人提供）**：

```
看起來很疲憊、有黑眼圈、穿著（藍鯨）鯨魚布偶裝的男孩，動漫的風格，可愛、萌，有點像小埋的感覺
```

> ⚠️ 這句 prompt 點名了第三方角色（小埋）作為風格參考，所以 SP-9.7 的否定聲明不能照抄，
> 出處欄已依實改寫（見規格 SP-9.7 的 2026-10-05 註）。產出的角色是原創造型：黑色短髮、
> 藍鯨連身衣，不含小埋的造型元素（金色長髮、倉鼠斗篷）。

生成圖是一張 1024×559 的房間場景：男孩坐在地上雙手捧臉。背景有 Gemini 自行加入的
第三方作品海報與周邊（原神、SPY×FAMILY、疑似小埋），**不在 prompt 裡，已於後製全數去除**。

## 後製（操作者：Claude，2026-10-05）

1. **去背**：l2d-factory 的 `l2df matte`（ComfyUI ＋ `BiRefNetRMBG` 節點、BiRefNet-matting 模型，MIT）。
   BiRefNet 把頭頂噴水當成背景切掉 → 噴水那一塊改用 OpenCV GrabCut 的結果補回；
   白色前襟被判成半透明 → 輪廓內縮 3px 的範圍補成不透明。海報碎片另行清除。
2. **嘴與眼**：[`tools/sprite-gen/face-edits.py`](../../tools/sprite-gen/face-edits.py)，全部從原圖像素修改：
   - 說話小開 = 原圖本身；
   - 說話大開 = 原圖的嘴垂直拉高 1.7 倍；
   - 平常（閉嘴）= 舊嘴以 Telea 修補抹成膚色，再用原圖嘴線色畫一條短弧線；
   - 眨眼 = 在「平常」上把兩眼塗成臉頰膚色，畫閉眼弧線與外眼角睫毛，黑眼圈保留。
3. **未採用**：ComfyUI 局部重繪（Illustrious-XL v1.0 ＋ Fooocus 補丁／ControlNet Union／IPAdapter，
   經 comfy-mcp 執行）。這張圖的嘴與眼只有約 40px，結果出現黃色發光、色偏與條紋破圖，全部捨棄。
4. **組裝**：`tools/sprite-gen/assemble.mjs`，`fit` 模式（整個角色塞進格子，錨點由五官實量）、
   最小模式（`features: { gaze: false, expressions: false }`，半閉眼留空）、`faceMask: "hull"`、
   描邊暖灰 `#827C76`、亮度豁免黑髮與膚色（理由見 manifest 的 `_note_exempt`）。

原圖、遮罩、四張來源圖與 `align.json` 不進版控（SP-9.11），存於專案主人本機 `assets/sprite-src/`。
