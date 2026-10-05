# 要交的圖（最小模式：動嘴＋眨眼）

> **2026-10-05 定稿採用專案主人的原圖（不轉正面、只動嘴＋眨眼），本檔是之前的產圖規劃，保留供日後補視線或表情時參考。** 現況見 `SOURCE-PROMPTS.md`。

> 2026-10-05。由專案主人用 Gemini 或自建 ComfyUI 產生；組裝與驗收由 `tools/sprite-gen/assemble.mjs`
> 與 `tools/check-sprite-sheets.mjs` 處理。構圖參考：[`layout-guide.png`](layout-guide.png)。
> 造型依據：專案主人提供的參考圖（黑髮、棕色疲憊眼、黑眼圈、白前襟藍鯨連身衣、頭頂噴水、尾巴）。

## 四張圖

| 檔名 | 內容 | 跟母圖比，**只**改哪裡 |
|---|---|---|
| `master.png` | 母圖：正面、睜眼看鏡頭、嘴巴閉成一條線、雙手放下 | — |
| `react-4.png` | 說話：嘴巴**小開** | 嘴 |
| `react-5.png` | 說話：嘴巴**大開** | 嘴 |
| `react-6.png` | 眨眼：**雙眼完全閉上** | 兩眼 |
| `react-7.png`（可省） | 眨眼：**半閉眼** | 兩眼 |

放在 `assets/sprite-src/`（不進版控）。

## 四張都要守的

1. **正方形、同一尺寸**（建議 1024×1024），**角色在四張圖裡位置完全一樣**。
   變體請用母圖去改（Gemini：附上母圖說「其他都不變，只改 X」；ComfyUI：inpaint，遮罩只蓋嘴或眼睛）。
2. **背景**：透明 PNG 最好；不行就純白，不要陰影、地板、漸層、任何物件或文字。
3. **正面、左右對稱、頭不歪**；兩眼在同一水平線上。
4. **眉毛露出來**（瀏海在眉毛上面）；**眼睛、嘴巴不能被手、頭髮擋住**。
5. **上、左、右各留 6% 空白**（什麼都不能碰到，含噴水和尾巴）；身體被**下緣**切掉沒關係。
6. 不用畫外框灰線、不用做下襬漸隱、不用縮小 —— 組裝工具會做。

## 構圖（照 `layout-guide.png`，誤差 ±2% 都可以）

以畫布寬高的百分比：

| 部位 | 位置 |
|---|---|
| 噴水頂端 | 離上緣 ≥ 6.5% |
| 頭套頂 | 20% |
| 頭套寬 | 56%（左右置中，約 22%–78%） |
| 眼線（兩眼瞳孔高度） | 50% |
| 兩個瞳孔 | 左右 43.75% / 56.25% |
| 嘴中心 | 57.5% |
| 下巴 | 62% |
| 身體 | 下巴以下到畫布底，被下緣切掉 |

比例是照參考圖量的（頭套寬 ≈ 頭高 × 1.32、眼睛在頭高 70%、兩眼距 ≈ 頭套寬 22%），
所以跟原本那張圖的臉一樣就對了。最後的錨點以你交的母圖實量為準，寫進 manifest。

## Gemini prompt（母圖）

附上 `assets/sprite-src/ref-boy.png` 與 `docs/sprite/layout-guide.png`：

```
Use the first image only as the character design reference (same boy, same whale onesie,
same face and hair). Draw a NEW image of him following the layout of the second image
(the guide): square 1:1, bust shot, front view, perfectly centred and symmetric,
head straight, eyes on the red line at the two red circles, chin on the green line,
hood top at the top of the blue ellipse, water spout inside the small blue box.
Keep the top/left/right 6% margin completely empty.

Expression: tired but awake — EYES OPEN looking at the viewer, dark circles under the eyes,
slightly drooping eyebrows, MOUTH CLOSED as a simple short line. Arms down, hands NOT touching the face.
Eyebrows visible (bangs above the eyebrows).

Anime chibi style, clean lineart, soft cel shading.
Plain flat pure white background, no shadow, no floor, no props, no text, no watermark.
Do not draw any of the guide's lines or labels.
```

變體（附上剛生的 `master.png`）：

```
Edit this image. Keep EVERYTHING identical — same character, pose, position, size, linework,
colours and background. Change ONLY:
```
- `react-4`：`his mouth, now slightly open as if talking (small rounded opening).`
- `react-5`：`his mouth, now wide open as if talking loudly (big rounded opening, a bit of tongue).`
- `react-6`：`his eyes, now fully closed (gentle curved lines with lashes, as in a blink).`
- `react-7`：`his eyes, now half closed (upper eyelids covering the upper half of the irises).`

## ComfyUI 的話

- 母圖：用 `ref-boy.png` 當 IPAdapter／reference，`layout-guide.png` 當構圖（例如 ControlNet 或先畫底稿再 img2img）。
- 變體：對母圖做 **inpaint**，遮罩只蓋嘴（react-4/5）或兩眼（react-6/7），denoise 0.5–0.7。
  遮罩外的像素保持不動，組裝最穩。
- 輸出 PNG；有 RMBG／BiRefNet 節點就直接輸出透明背景。

## 交圖後

告訴我放好了。我跑組裝 → 驗收 → 預覽給你看，再補出處（Gemini 的話：生成日期、操作者、可看到的版本；
ComfyUI 的話：用到的模型名稱與授權）與 `SOURCE-PROMPTS.md`。
