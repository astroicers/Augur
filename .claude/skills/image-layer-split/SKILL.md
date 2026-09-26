---
name: image-layer-split
description: Split one character illustration into a Live2D-ready layer library (per-part transparent PNGs + manifest) by generating Nano Banana 2 / Gemini image-edit prompts for the user to run by hand, then aligning, keying and validating the returned layers. No API key, no GPU. Use when the user wants to 拆層 / split an image into layers, prepare art for Live2D rigging, build a layered image library from a single illustration, or mentions 拆層, layer split, layer library, 圖層, Live2D 素材, Nano Banana, image-to-layers.
---

# image-layer-split

把**一張角色立繪**拆成**分層圖庫**(每部件一張全畫布透明 PNG + manifest),供 Live2D 綁定前的素材。
引擎是 **Nano Banana 2(Gemini 影像模型)**,做語意部件抽取 + 補遮擋;**零 API、零 GPU** —— skill 只負責「生 prompt」與「回填組裝驗收」,生圖那步由使用者手動在 Gemini App 跑。

## Quick start

```bash
S=path/to/this/skill/scripts
# 階段一:產去背圖 + 逐部件 prompt 清單
python3 $S/gen_prompts.py character.png            # 預設 preset = live2d-character
# → 產生 <character>_layerwork/{_cutout.png, PROMPTS.md, layers/, _preset.json}

# 使用者手動:照 PROMPTS.md 逐筆 → Gemini App(附上 _cutout.png)→ 存成 layers/part_<id>.png

# 階段二:對齊 + 去背鍵控 + 組裝 + 驗收
python3 $S/assemble.py <character>_layerwork --src character.png
# → library/part_*.png(全畫布透明) + manifest.json + _preview.png + 破洞驗收
```

## Workflow

1. **生 prompt**:`gen_prompts.py <image> [--preset NAME] [--out DIR]`。去背(四角 flood-fill)、依 preset 逐部件產 Nano Banana prompt(語意抽取 / 遮擋補完),寫進 `PROMPTS.md`。
2. **手動生圖**(使用者):每筆 prompt 在 Gemini App 跑,**務必附上 `_cutout.png`**,結果存到 `layers/part_<id>.png`。
3. **組裝驗收**:`assemble.py <workdir> --src <image>`。對齊原畫布、補上透明、依 z-order 疊 `_preview.png`、出 `manifest.json`,並跑覆蓋率/破洞檢查(`_holes.png` 粉紅=缺件或沒補的遮擋)。
4. 看 `_preview.png` 與 `_holes.png` → 對破洞/飄移的層,回 Gemini 重生或手動微修,重跑 assemble。

## Presets

- 預設 `parts/live2d-character.json`(對應 Live2D 拆層部件 + z-order;desc 為通用 anime 描述,可重用任何正面立繪)。
- 換 preset:`--preset <name>`,自訂就在 `parts/` 加一個同格式 JSON(見 [REFERENCE.md](REFERENCE.md))。

## 輸入已經是「裁切好的部位」（無位置）?

有些工具（如 **namei**）匯出的是 bbox 裁切、**無座標**的部位圖 → 用 `compose_cropped.py` 依 layout 放回全畫布,得到定位分層圖庫 + 組合預覽:

```bash
python3 $S/compose_cropped.py <partsdir> --layout parts/namei-layout.json --out <dir>
```

預設 layout `parts/namei-layout.json`(全身 taxonomy 的解剖佈局,px 中心點)。**位置不對就改 layout 的 `cx`/`cy` 重跑**。詳見 [REFERENCE.md](REFERENCE.md)。

## 誠實限制（務必先讓使用者知道）

- **不是像素級保證**:影像模型每次生成可能飄移位置/重畫/改色 → assemble 盡力對齊(resize 到原畫布 + 鍵控),**仍常需手動微調**。
- **每部件 = 一次手動生成**(零計費,但要逐筆貼;預設 16 件)。眼睛細件、共用 overlay 不在 preset,建議拆後手工細分。
- **產出是素材,不是綁好的模型**:不替代 Cubism 綁定,不保證 100% 乾淨。
- 背景需接近純色(立繪常見);複雜背景的去背會不準。

詳細 prompt 模板、preset 結構、對齊/驗收細節與疑難排解見 [REFERENCE.md](REFERENCE.md)。
