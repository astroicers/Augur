# image-layer-split — REFERENCE

## 1. Prompt 模板（gen_prompts.py 內建）

**extract（一般部件）** —— 抽出單一部件、補自身被遮處：
```
Using the attached character illustration as reference, output ONLY {desc} as a PNG with a
fully transparent background. Keep the EXACT same art style, colors, line work, position, scale
and canvas framing as the original — do not move, resize, recolor, or redraw the character.
Reconstruct (inpaint) any part of {desc} that is hidden behind other elements in the original, so
this layer is complete on its own. The output must be the same {W}x{H} canvas with {desc} in its
original position and everything else fully transparent.
```

**complete（遮擋補完件，如 face_base / body）** —— 把被某物遮住的整塊補完：
```
Using the attached character illustration as reference, output {desc} as a PNG with a fully
transparent background, as if {occluder} were removed — fully reconstruct (inpaint) the parts
hidden behind {occluder}. Keep the EXACT same art style, colors, line work, position, scale and
{W}x{H} canvas framing as the original. Everything that is not {desc} must be fully transparent.
```

`{desc}`/`{occluder}` 來自 preset；`{W}x{H}` 來自輸入圖尺寸。

### 提高成功率的提醒（寫進 PROMPTS.md 也可口頭叮嚀使用者）
- **每筆都附上 `_cutout.png`**（去背圖比原圖乾淨，模型較不會把背景一起畫進去）。
- 若模型回的是**裁切過/位移**的部件 → 重生一次、或在 prompt 末尾加一句 “Return the full uncropped {W}x{H} canvas.”。
- 同一角色多筆之間若**風格飄移** → 在每筆附同一張 `_cutout.png` 當參考可降低飄移。

## 2. Preset 結構（parts/*.json）

```jsonc
{
  "name": "live2d-character",
  "parts": [
    { "id": "hair_back", "z": 10, "type": "extract",
      "desc": "the long back hair behind the head and shoulders" },
    { "id": "face_base", "z": 40, "type": "complete",
      "occluder": "the hair and bangs",
      "desc": "the full face and head skin (forehead, cheeks, chin, nose, ears, neck)" }
  ]
}
```
- `id`：檔名 `part_<id>.png` 與 manifest key。
- `z`：z-order，**越小越後（先畫）**；assemble 依此疊 `_preview.png`、manifest 排序。
- `type`：`extract`（預設）或 `complete`（需 `occluder`）。
- `desc`：填進 prompt 的 `{desc}`，寫**通用** anime 描述以利重用。

自訂 preset：在 `parts/` 放一個同格式 JSON，`gen_prompts.py --preset <檔名不含.json>`。

## 3. 對齊 / 鍵控（assemble.py 行為）

- **對齊**：層尺寸 ≠ 原畫布 → `resize` 到原 `W×H`（LANCZOS）。長寬比差 > 0.02 會印警告（代表模型可能裁切/變形，需手動對位）。
- **鍵控**：層的透明面積 ≤ 5%（模型沒給透明、是實心背景）→ 用 `_common.foreground_mask` 四角 flood-fill 去背成透明；否則沿用模型給的 alpha。
- **manifest.json**：`{canvas:[W,H], layers:[{id,z,file,opaque_px,bbox}], missing:[...]}`。
- **_preview.png**：依 z-order alpha_composite 疊在白底 → 看分層能否重組回角色。
- **驗收**：`check_layers.check(library, src)` → 覆蓋率、破洞%、溢出%、`_holes.png`（粉紅=剪影內無任何層覆蓋＝缺件或沒補的遮擋）。

## 4. 疑難排解

| 症狀 | 處置 |
|---|---|
| 破洞圖一大片粉紅 | 對應部件缺回填、或該層被裁切/位移 → 重生該 part、確認存檔名 `part_<id>.png` |
| 某層整片不透明、蓋住別層 | 模型沒去背 → assemble 會自動鍵控；若背景非純色鍵不乾淨，先在 Gemini 要 “transparent background” 重生 |
| 層長寬比警告、位置歪 | 模型裁切了 → prompt 末尾加 “Return the full uncropped {W}x{H} canvas.”，或手動貼回原位 |
| 角色多層風格不一致 | 每筆都附同一張 `_cutout.png`；必要時把已定版的鄰近層也附上當參考 |
| 背景複雜去背不準 | 本 skill 的去背假設近純色背景；複雜背景請先用其他工具去背成透明再餵 |

## 4b. 輸入已是「裁切部位」→ compose_cropped.py

某些工具（namei 等）匯出 **bbox 裁切、無座標** 的部位圖（每檔尺寸不一、位置遺失）。這種**不能**走 gen/assemble（assemble 假設全畫布層）→ 改用 `compose_cropped.py` 依 layout 放回全畫布:

```bash
python3 scripts/compose_cropped.py <partsdir> --layout <layout.json> --out <dir>
```

- `layout.json`：`{ "canvas":[W,H], "parts":{ "<name>":{"cx":,"cy":,"z":} } }`，`cx/cy` 是部位**中心**要放的畫布座標(px);partsdir 內檔名須為 `<name>.png`。
- 預設模板 `parts/namei-layout.json`（namei 全身 taxonomy：hair_back/front、face、ears、eyewhite/irides/eyelash/eyebrow、nose、mouth、neck、topwear/bottomwear/legwear/footwear/handwear 的解剖佈局）。
- 產出 `library/part_*.png`（全畫布定位層）+ `manifest.json` + `_preview.png`(組合圖)/`_composed.png`(透明)。
- **調位置**：看 `_preview.png`，改 layout 的 `cx/cy`（或換 `canvas`)重跑,直到組合正確。
- 注意：此模式的解析度受限於來源裁切圖(通常偏小);要高解析模型需來源本身就高解析。

## 5. 與 Live2D 流程的銜接

本 skill 產的是**分層圖庫（素材）**,對應 SOP 的 **A3 拆層**。之後仍要:
- 眼睛細件(white/iris/highlight/lid/lash)、共用 overlay(汗滴/怒紋…)→ 手工細分/手繪。
- **A5 Cubism 綁定** → 進 Cubism 手做或外包（本 skill 不涵蓋,見 `Augur/live2d/RUNBOOK.md`）。
