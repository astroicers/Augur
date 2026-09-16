# Nano Banana 2 拆層 prompt — a1-augur-calm  (768x1376, preset: live2d-character)

**每一筆**：在 Gemini App 開新對話 → **附上 `_cutout.png`**（或 `_source` 原圖）→ 貼下面的 prompt →
把產出的圖**存成 `layers/<檔名>.png`**（檔名見每節標題）。全部跑完後執行 assemble.py 組裝驗收。

> 提醒：模型可能飄移位置/重畫 → 盡量挑「全畫布、位置一致」的結果；assemble 會幫你對齊+驗收，仍可能要手動微調。

## hair_back  → 存成 `layers/part_hair_back.png`

```
Using the attached character illustration as reference, output ONLY the long back hair behind the head and shoulders as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the long back hair behind the head and shoulders that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the long back hair behind the head and shoulders in its original position and everything else fully transparent.
```

## body  → 存成 `layers/part_body.png`

```
Using the attached character illustration as reference, output the torso and neck (the inner top/clothing the character wears) as a PNG with a fully transparent background, as if the cape/outer garment and any hair were removed — fully reconstruct (inpaint) the parts hidden behind the cape/outer garment and any hair. Keep the EXACT same art style, colors, line work, position, scale and 768x1376 canvas framing as the original. Everything that is not the torso and neck (the inner top/clothing the character wears) must be fully transparent.
```

## arm_l  → 存成 `layers/part_arm_l.png`

```
Using the attached character illustration as reference, output ONLY the character's left arm and sleeve as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the character's left arm and sleeve that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the character's left arm and sleeve in its original position and everything else fully transparent.
```

## arm_r  → 存成 `layers/part_arm_r.png`

```
Using the attached character illustration as reference, output ONLY the character's right arm and sleeve as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the character's right arm and sleeve that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the character's right arm and sleeve in its original position and everything else fully transparent.
```

## capelet  → 存成 `layers/part_capelet.png`

```
Using the attached character illustration as reference, output ONLY the outer garment / cape / capelet worn over the shoulders as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the outer garment / cape / capelet worn over the shoulders that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the outer garment / cape / capelet worn over the shoulders in its original position and everything else fully transparent.
```

## face_base  → 存成 `layers/part_face_base.png`

```
Using the attached character illustration as reference, output the full face and head skin (forehead, cheeks, chin, nose, ears, neck) as a PNG with a fully transparent background, as if the hair and bangs were removed — fully reconstruct (inpaint) the parts hidden behind the hair and bangs. Keep the EXACT same art style, colors, line work, position, scale and 768x1376 canvas framing as the original. Everything that is not the full face and head skin (forehead, cheeks, chin, nose, ears, neck) must be fully transparent.
```

## cheek  → 存成 `layers/part_cheek.png`

```
Using the attached character illustration as reference, output ONLY the blush marks on the cheeks (if any) as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the blush marks on the cheeks (if any) that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the blush marks on the cheeks (if any) in its original position and everything else fully transparent.
```

## eye_l  → 存成 `layers/part_eye_l.png`

```
Using the attached character illustration as reference, output ONLY the character's left eye (iris, eye white, eyelid and lashes together) as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the character's left eye (iris, eye white, eyelid and lashes together) that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the character's left eye (iris, eye white, eyelid and lashes together) in its original position and everything else fully transparent.
```

## eye_r  → 存成 `layers/part_eye_r.png`

```
Using the attached character illustration as reference, output ONLY the character's right eye (iris, eye white, eyelid and lashes together) as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the character's right eye (iris, eye white, eyelid and lashes together) that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the character's right eye (iris, eye white, eyelid and lashes together) in its original position and everything else fully transparent.
```

## brow_l  → 存成 `layers/part_brow_l.png`

```
Using the attached character illustration as reference, output ONLY the character's left eyebrow as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the character's left eyebrow that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the character's left eyebrow in its original position and everything else fully transparent.
```

## brow_r  → 存成 `layers/part_brow_r.png`

```
Using the attached character illustration as reference, output ONLY the character's right eyebrow as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the character's right eyebrow that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the character's right eyebrow in its original position and everything else fully transparent.
```

## mouth  → 存成 `layers/part_mouth.png`

```
Using the attached character illustration as reference, output ONLY the mouth as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the mouth that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the mouth in its original position and everything else fully transparent.
```

## hair_side_l  → 存成 `layers/part_hair_side_l.png`

```
Using the attached character illustration as reference, output ONLY the left side lock of hair framing the face as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the left side lock of hair framing the face that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the left side lock of hair framing the face in its original position and everything else fully transparent.
```

## hair_side_r  → 存成 `layers/part_hair_side_r.png`

```
Using the attached character illustration as reference, output ONLY the right side lock of hair framing the face as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the right side lock of hair framing the face that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the right side lock of hair framing the face in its original position and everything else fully transparent.
```

## hair_front  → 存成 `layers/part_hair_front.png`

```
Using the attached character illustration as reference, output ONLY the front hair / bangs over the forehead as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the front hair / bangs over the forehead that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the front hair / bangs over the forehead in its original position and everything else fully transparent.
```

## acc_clip  → 存成 `layers/part_acc_clip.png`

```
Using the attached character illustration as reference, output ONLY the hair clip / hair accessory (if any) as a PNG with a fully transparent background. Keep the EXACT same art style, colors, line work, position, scale and canvas framing as the original — do not move, resize, recolor, or redraw the character. Reconstruct (inpaint) any part of the hair clip / hair accessory (if any) that is hidden behind other elements in the original, so this layer is complete on its own. The output must be the same 768x1376 canvas with the hair clip / hair accessory (if any) in its original position and everything else fully transparent.
```
