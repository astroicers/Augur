# 賭一鍵「圖 → VRM」實驗清單

> 搭配保底路線 [`VRM-RUNBOOK.md`](VRM-RUNBOOK.md)(VRoid,保證能用)。
> **目標**:拿你的角色圖去試「上傳一張圖 → 自動出綁好 VRM」的工具,看能不能一步到位。
> **誠實前提**:研究結論是**沒有一個經獨立驗證、能一鍵從圖出「含 viseme+眨眼+spring bone 的 anime VRM」的工具**。以下都是**彩票** —— 成了賺到、爛了就丟,VRoid 才是保底。別付大錢、別把主線壓在這。

## 用哪張圖去試

- 銀藍占卜師（⚠️ 該圖已於 2026-09-21 退出版控，本機仍在；色票見 `docs/sprite/sprite-sheet-spec.md` SP-6.0）
- 或娜美風:`../live2d/_archive/nami/_preview.png`(組合圖)
- **要求**:單一角色、正面、乾淨背景、最好全身 A-pose(半身也行,但腿/腳會被 AI 腦補)。

## 值得試的(依「符合你本意 × 可信度」排序)

| 工具 | 一句誠實評註 | 到 VRM | 費用 | 該不該試 |
|---|---|---|---|---|
| **Neural4D AnimeArt** ([neural4d.com/features/animeart](https://www.neural4d.com/features/animeart)) | **唯一宣稱**「anime 圖/文字 → 直出綁好 VRM **0.x**(55 骨/52 blendshape/spring)、~90 秒」。**查證(2026-07)**:公司 = DreamTech,底層 = **Direct3D-S2(NeurIPS 2025 論文)** → **技術真實、非騙局**;有 Capterra 登錄、Face Track 表情預覽。**但輸出品質/rig 實際能不能動,仍零第三方實測**(所有正面評價都是自家 blog + 付費新聞稿)。 | 宣稱 ✅(VRM 0.x) | 商業(**先找免費試用**再決定付費) | **先試這個**(可信度中上的彩票);用下方三點驗,別預付大錢 |
| **Hunyuan3D**(Tencent,官方開源 [github.com/Tencent/Hunyuan3D-2](https://github.com/Tencent/Hunyuan3D-2)) | 很強的圖→3D,生態內有身體 rig;但**無 viseme/無 VRM**,第三方「VRChat maker」包裝站未驗證。 | ⚠️ 要補 | 開源免費 / 第三方站另計 | 想要高品質 mesh 可試,但**到 VRM 仍要手工** |
| **Tripo3D** [tripo3d.ai](https://www.tripo3d.ai/) | 成熟、stylized/anime 表現佳、有**身體** auto-rig。但無臉部 viseme、不出 VRM。 | ⚠️ 身體骨,無臉/無 VRM | 免費額度 + 訂閱 | 想要「有身體骨的 mesh」可試,非一鍵到位 |

## 想「忠實還原角色」且願意補一點手工才選(開源、anime 專用)

| 工具 | 特點 | 缺 |
|---|---|---|
| **StdGEN / StdGEN++**(CVPR25,anime SOTA) | 單圖 → **語意拆件** mesh(身/衣/髮分離,正好對應 spring bone 鏈) | 無 rig,要自己綁 → 進 Blender/UniVRM |
| **CharacterGen**(SIGGRAPH24,[github](https://github.com/zjp-shadow/CharacterGen)) | 單圖 → A-pose 角色,最好接後續 rigging | 無 rig,要自己綁 |

## 直接跳過(方向不符)

- **VTubeMe**:寫實風、非 anime(官方自稱 unlike anime tools)→ 美術方向就錯。
- **Ready Player Me**:寫實/西式卡通、非 anime。
- **Meshy / Rodin**:無 anime 模式 / 無 rig 或下載付費 → 對「一鍵 anime VRM」不划算。

## 收到輸出後,怎麼判斷「彩票中幾成」（在 AIRI 驗三點）

1. **載入**:AIRI(瀏覽器或桌面)→ Settings → Models → **add** → 選 `.vrm` → **載得進去嗎?**(載不進 = 格式/版本問題,先換 VRM 0.x/1.0 或直接淘汰)
2. **對嘴**:開 TTS 講一句 → **嘴有沒有跟著動?**(有 = viseme 命名正確;沒有 = 缺/錯 viseme,對嘴失效)
3. **物理**:轉頭/移動 → **頭髮、衣服有沒有擺動?**(有 = spring bone 有掛;沒有 = 缺物理)

**三點全過** = 彩票中了,直接用。**只過 1(載入)** = 是個靜態 3D 臉,對嘴/物理還是得手工補 → 這時**回 VRoid 保底**比補它划算。

## 決策規則

- 試 1–2 個(從 Neural4D 開始),**照上面三點驗**。
- 中了 → 用它。沒中 / 吐壞模型 → **不糾結,回 [`VRM-RUNBOOK.md`](VRM-RUNBOOK.md) 的 VRoid**(30–90 分鐘保證有會動的角色)。
- **別為彩票付大錢、別停在這條**;VRoid 永遠是可交付的底。
