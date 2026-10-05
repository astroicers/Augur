# 吉祥物生成 brief（生成式繪圖工具版）

> 2026-10-05。造型依專案主人提供的參考圖（見〈造型參考〉）；本檔是交給生成工具的操作版。
> 規格 SP-0.9 的文字與色票，等母圖定稿後依實圖改寫。
> 實際用過的 prompt 要**逐字**另存 `SOURCE-PROMPTS.md`（SP-9.3），這裡是建議稿，不是紀錄。

## 先做最小模式：母圖＋3 張

專案主人 2026-10-05 裁定**先簡單些：只動嘴＋眨眼**（規格 SP-0.10）。要生的只有：

| 檔名 | 內容 |
|---|---|
| `master.png` | 母圖：正面、平視、表情平靜、眼睛張開、嘴巴閉著 |
| `react-4.png` | 說話（小開口） |
| `react-5.png` | 說話（大開口） |
| `react-6.png` | 閉眼（眨眼） |
| `react-7.png` | 半閉眼（**可省**；省了眨眼就是單幀） |

`align.json` 寫 `"features": { "gaze": false, "expressions": false }`。
之後要加視線或表情，補下面表格對應的圖、拿掉 `features` 就好，不用重做母圖。

## 母圖為什麼要「睜眼、閉嘴」（2026-10-05 實測）

l2d-factory 的 **THA3**（talking-head-anime-3）能從單張圖直接算出閉眼、半垂眼（疲憊）、
眼珠上下左右轉 —— 前提是輸入圖**睜眼、閉嘴**。實測：
- 參考圖本身（半閉眼、張嘴）：THA3 幾乎不動（最多 119 px 改變），沒辦法用。
- 睜眼閉嘴的圖：閉眼、半垂眼、四個方向的眼珠轉動都有效；但 **ω 這種很小的嘴張不開**，
  而且 THA3 只以 112px 高的臉來算，貼回精靈圖要放大約 1.5 倍，眼睛會稍微變軟。
所以母圖睜眼、嘴是一條簡單的線，眨眼（甚至視線）就有機會交給 THA3，嘴型再看 THA3 張不張得開，
張不開才用 Gemini 改圖。疲憊感靠黑眼圈與眉毛表現，平時的半垂眼可由 THA3 的 `eye_relaxed` 補。

## 為什麼是「1 張母圖 + 局部變體」

精靈圖必須**頭完全不動**（SP-3.6；反應格只能畫在各自的視窗與臉上）。
生成工具每次出圖都會飄（線條、髮絲、衣褶都會變），所以不要叫它畫好幾張獨立的圖。

做法是：先生一張**母圖**，其餘都**拿母圖當輸入**，只請它改眼睛或嘴巴（用「編輯／局部重繪」功能）。
飄掉一點沒關係 —— 組裝工具 `tools/sprite-gen/assemble.mjs` 只取「跟母圖不一樣、且落在該格允許範圍內」的像素，
其餘一律用母圖，所以頭不動、邊界不出界由工具保證。你要顧的只有：**改的地方看起來對**。

## 完整模式的檔案（之後擴充用；放 `assets/sprite-src/`，不進版控，見 SP-9.11）

| 檔名 | 內容 |
|---|---|
| `master.png` | 母圖 |
| `gaze-0.png` … `gaze-8.png` | 視線 9 格（`gaze-4` 可省略 = 母圖）。只改眼睛 |
| `react-0.png` … `react-8.png` | 反應 9 格。只改眉、眼、嘴與小記號 |

尺寸不限（建議 1024 以上的正方形），背景用**純色**（純白或純綠 `#00FF00`），工具會去背。

## 造型參考

專案主人 2026-10-05 提供的生成圖（坐在房間裡、雙手捧臉的藍鯨男孩）是造型依據。
原圖背景有第三方作品的海報與周邊，**不得**當生成輸入；只用去背後的
`assets/sprite-src/ref-boy.png`（男孩以外塗白，不進版控）。造型要點：

- **黑色**亂翹短髮，從頭套裡露出；瀏海在眉毛上方。
- 半閉、下垂的**棕色**疲憊眼，深色黑眼圈，臉頰泛紅帶斜線紅暈，嘴巴微張（母圖改成閉嘴）。
- 藍色**鯨魚連身衣**：頭套是鯨魚頭，正面兩顆黑色鯨魚眼、頭套側面一對小鰭、頭套內襯粉色、
  頭頂一道噴水帶水滴；頭套上有白色虛線縫線。
- 連身衣**白色前襟**、一排藍色鈕扣；袖子上有白線縫的鯨魚徽章；藍色連指手套。
- 尾巴從身後伸出來。

## 母圖 prompt（附上 `ref-boy.png` 當造型參考）

```
Use the attached image only as the character design reference (same boy, same whale onesie,
same face and hair). Draw a NEW image of him in this exact composition:

Anime chibi illustration, cute moe style, clean crisp lineart, soft cel shading.
Square 1:1 image, bust shot (head and upper chest only), character perfectly centred,
symmetric FRONT view, head straight (not tilted), looking straight at the viewer,
EYES OPEN normally (not half-closed) with brown irises clearly visible, tired look shown by
dark circles under the eyes and slightly drooping eyebrows, MOUTH CLOSED as a simple short line,
arms down — hands NOT touching the face.

Keep from the reference: messy short black hair with bangs ending above the eyebrows
(eyebrows fully visible), blue whale-head hood with two black whale eyes on the front,
small fins on the sides of the hood, pink hood lining, a water spout with droplets on top,
dashed white stitching, white front panel with blue buttons, whale emblem on the sleeve.
The whale tail curls up behind his back on the right side of the image.

Composition: big head, small body (chibi proportions). Top of the water spout close to the top
edge (about 4% margin), chin at about 60% of the image height, eyes at about 38% of the image
height, shoulders cut off by the bottom edge. Nothing touches the left/right edges.
Plain solid pure white background, no shadow, no gradient, no floor, no room, no props,
no text, no watermark.
```

**一定要守的四件事**（組裝與驗收靠它們）：
1. **正面、對稱、置中，手不碰臉**。歪頭、側臉、手捧臉都會讓九格視線與表情修補對不齊（參考圖是手捧臉，母圖要改掉）。
2. **眉毛露出來**（瀏海在眉毛上方，SP-2.10）—— 眉毛是上下視線與情緒的主要線索。
3. **眼睛不要被頭髮或手擋到**。
4. **純色背景、沒有陰影**（SP-6.8：素材不得烘進背景）。

## 變體 prompt（每張都附上 `master.png` 當輸入）

共通前綴：

```
Edit this image. Keep EVERYTHING identical — same character, pose, framing, linework, colours,
hood, hair, body, and the plain white background. Change ONLY the following:
```

視線 9 格（方向以**畫面**為準：left = 畫面左邊）。只改眼睛，頭與臉完全不動：

| 檔名 | 接在前綴後面 |
|---|---|
| `gaze-0.png` | `his eyes look toward the upper-left of the image (irises moved up and left inside the eyes). Head does not move.` |
| `gaze-1.png` | `his eyes look straight up (irises moved up inside the eyes, upper eyelids slightly raised). Head does not move.` |
| `gaze-2.png` | `his eyes look toward the upper-right of the image. Head does not move.` |
| `gaze-3.png` | `his eyes look toward the left of the image. Head does not move.` |
| `gaze-4.png` | （省略，等於母圖） |
| `gaze-5.png` | `his eyes look toward the right of the image. Head does not move.` |
| `gaze-6.png` | `his eyes look toward the lower-left of the image (upper eyelids lowered a little). Head does not move.` |
| `gaze-7.png` | `his eyes look straight down (upper eyelids lowered a little). Head does not move.` |
| `gaze-8.png` | `his eyes look toward the lower-right of the image (upper eyelids lowered a little). Head does not move.` |

反應 9 格。只改眉、眼、嘴與小記號，記號要畫在**臉上**（不可畫到頭套、頭髮或背景上）：

| 檔名 | 用途 | 接在前綴後面 |
|---|---|---|
| `react-0.png` | 被點擊 | `startled awake: eyes wide open with sparkly star highlights, eyebrows raised high, small round "o" mouth.` |
| `react-1.png` | warning | `worried: inner ends of the eyebrows raised, a light-blue sweat drop on his right cheek (left side of the image), wavy nervous mouth.` |
| `react-2.png` | critical | `angry: eyebrows pulled down into a sharp V, a small red cross-shaped anger mark on his forehead between the eyebrows, open shouting mouth with one tiny fang.` |
| `react-3.png` | resolved | `relieved and happy: relaxed raised eyebrows, open happy smile, stronger pink blush.` |
| `react-4.png` | 說話（小開口） | `mouth slightly open as if talking (small rounded opening, a bit of tongue). Eyes and eyebrows unchanged.` |
| `react-5.png` | 說話（大開口） | `mouth wide open as if yawning or talking loudly (big rounded opening with tongue). Eyes and eyebrows unchanged.` |
| `react-6.png` | 閉眼（眨眼） | `eyes fully closed, drawn as gentle downward-curved lines with lashes (sleepy). Eyebrows and mouth unchanged.` |
| `react-7.png` | 半閉眼（眨眼） | `eyes half closed: heavy upper eyelids covering the upper half of the irises. Eyebrows and mouth unchanged.` |
| `react-8.png` | pending | `puzzled: one eyebrow raised higher than the other, small sideways pursed mouth.` |

## 交付前自己先看一眼

- 17 張變體疊在母圖上，**除了該改的地方，其他都沒變**（尤其頭套輪廓、瀏海、臉型）。
  飄得太多的那張重生一次；組裝工具會報哪一張的差異跑出允許範圍。
- 視線格的方向對（`gaze-0` 是看畫面左上）。
- **做不出來可以減格**（專案主人 2026-10-05 同意）：半閉眼 `react-7` 可留空（manifest 宣告
  `intentionally_empty`，眨眼退化為單幀，SP-4.8 唯一允許留空的格）。其餘格在規格上是必要的；
  真的生不出來時，先告訴我是哪幾格，我用母圖做程式修補或另議。
- 閉眼格的眼睛**整個**閉上，看不到虹膜。

## 出處（SP-9.2 / 9.5 / 9.7，交付前必填）

**生成工具：Google Gemini**（專案主人 2026-10-05 告知）。條款查證（2026-10-05）：
- 歸屬：Google 服務條款（https://policies.google.com/terms ，生效日 2026-07-30）逐字：
  「Some of our services allow you to generate original content. Google won't claim ownership over that content.」
- 限制：Generative AI Prohibited Use Policy（https://policies.google.com/terms/generative-ai/use-policy ，最後修改 2024-12-17）
  禁止「Violates the rights of others, including privacy and intellectual property rights」與
  「Misrepresenting the provenance of generated content by claiming it was created solely by a human, in order to deceive.」
  —— 所以參考圖要先去掉第三方作品（已做：`ref-boy.png`），出處欄要明寫 AI 生成。
- 舊的 Generative AI Additional Terms（2023-08-09）頁面自述 2024-05-22 起不再適用，不引用。
- 條款沒有逐字寫「可商用」；本專案的主張照 SP-9.5(b)：「專案自有，以專案實際持有之權利為限，隨 repo Apache-2.0 釋出」。
- 交付時還要記：Gemini 的版本（App 若不顯示就寫「App 未公開版本」，不得臆造）、生成日期、操作者。


生成工具確定後，要記：產品名稱與可讀到的版本、生成日期、操作者、逐字 prompt（`SOURCE-PROMPTS.md`）、
輸入參考圖（只有母圖本身）、後製（`assemble.mjs`）。以及服務條款對輸出歸屬的結論，附一級來源 URL 與查證日期，
**逐字**寫進 `docs/asset-provenance.md`（不能只寫「見 .asp-fact-check.md」）。
否定聲明照抄：「未以任何第三方角色 IP、指名畫師風格、或未授權的參考圖作為生成輸入」——
所以 prompt 裡**不要**寫既有角色名或畫師名（例如不要寫「像小埋」）。
