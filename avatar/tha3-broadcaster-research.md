# THA3 用於 AI 播報員／主播：限制與優勢（研究備忘錄）

日期：2026-07-22 ｜ 角色焦點：播報員/主播（半身、講話、換表情）｜ 前提：本機有 Nvidia GPU
對照決策：[ADR-001](../docs/adr/ADR-001-soc-broadcaster-architecture.md)（否決常駐 THA）、[ADR-002](../docs/adr/ADR-002-expression-director-and-avatar-interface.md)（`AvatarController` 介面）

## 0. 結論先行（TL;DR）

- **就 Augur 現在的 SOC 播報而言，不建議切到 THA。** VRM 管線已跑通、瀏覽器原生、零 Python、24/7 穩、授權乾淨；而 ADR-001 的「只需一支 avatar、做一次」前提，**正好抵銷 THA 最大的賣點（免 rig、任意圖直出）**——你不需要「任意圖」，你只需要那一支，VRoid 已經免費幫你 rig 好。
- **THA 只有在一個條件成立時才划算**：你有一張**必須像素級忠實保留的 2D 角色圖**，其畫風是 VRM/VRoid 的 3D 重詮釋達不到的，且你**接受一個常駐 GPU Python 服務 + 自建幀串流**。若這條成立（例如做一個「2D 畫風即品牌」的對外 AI 主播產品），THA 是正當且強的選擇。
- **若要用，選 [THA4](https://pkhungurn.github.io/talking-head-anime-4/) 而非 THA3。** THA4 用蒸餾把每個角色壓成 <2MB 學生模型、在 GTX 1080 Ti 就 ≥30 FPS 即時，直接解掉 THA3「只有 Titan RTX 才跑得動」的頭號限制。你的角色卡是**固定小集合**（`?avatar` 切換），正好命中 THA4「avatar 外觀不常變」的設計甜蜜點。
- **角色適配**：播報員/主播 ✅ 甜蜜點；櫃檯小姐 ✅ 良好；介紹員/導覽 ❌ 不行（THA 動不了手臂、不能指向/走動）。

## 1. THA3 是什麼（技術本質）

一個神經網路：輸入**一張 512×512 動漫角色圖**（含 alpha、角色直立正面、頭在中上 ~128×128 框內、雙手遠離頭、背景 alpha=0）+ 一個 **45 維 pose 向量**，輸出同一角色的新姿態影格。可動的維度：**臉部表情、頭部旋轉、身體旋轉、呼吸（胸口起伏）**。

它與你在 [`image-to-vrm-experiment.md`](image-to-vrm-experiment.md) 苦惱的問題是**相反解法**：不是把圖 rig 成 3D 模型，而是**直接神經動畫化你的 2D 原圖**——沒有 rig、沒有 VRoid 重建、沒有手綁 viseme/spring bone。

官方 demo 兩支：`manual_poser`（GUI 拉桿）、`ifacialmocap_puppeteer`（iPhone TrueDepth 臉部追蹤，需 iOS App「iFacialMocap」980 日圓 + iPhone X 以上）。**注意：官方 demo 都不是「用 TTS 音訊驅動嘴型」的**；音訊驅動 lip-sync 是下游整合（見 §3）。

## 2. 優勢（針對播報員/主播）

| # | 優勢 | 說明 |
|---|------|------|
| A | **零 rig、畫風像素級忠實** | 動的就是你那張原圖，不是被 3D 重新詮釋。當「必須是這張畫」是硬需求時，這是對 VRM/Live2D 的殺手級優勢。 |
| B | **與 Augur 現有管線幾乎 1:1 對接** | Augur 已產 `BroadcastPlan{text,severity,emotion}` → Edge TTS → 音訊 RMS → `setMouth(0..1)` + `setEmotion()`（見 [`AvatarController.ts`](../web/src/avatar/AvatarController.ts)）。THA 的嘴型 morph 正是吃這種**振幅純量**；情緒是 JSON morph 模板。這正是參考整合（SillyTavern `talkinghead`）的做法。 |
| C | **授權友善** | 程式碼 MIT、模型權重 CC BY 4.0 → **可商用，散布時標註作者**。（附帶一個 Google IP 免責聲明，作者自述可能主張 IP；對正式產品是小小的法律灰帶。） |
| D | **VRAM 溫和** | `separable_half` 變體約 **520 MB**、~40–50 FPS（RTX 3070 Ti mobile 實測，來自 SillyTavern）。 |

## 3. 限制（deal-breakers）

| # | 限制 | 說明 |
|---|------|------|
| 1 | **GPU 強制、伺服器端、非瀏覽器原生** | 需 Nvidia CUDA。THA3 全模型在 Titan RTX 才 ~20 FPS；`separable_half` 在 3070 Ti mobile ~40–50 FPS；**CPU ~2 FPS = 不可用**。這打破 Augur「瀏覽器端 WebGL、live 迴路零 Python」的模型——你得起一個 Python 動畫服務、把 512×512 影格**串流**給瀏覽器（MJPEG/WebRTC）。 |
| 2 | **主體與動作受限** | 單一半身、直立正面。只有頭/身旋轉 + 呼吸——**沒有手臂手勢、沒有指向、不能走動**。介紹員/導覽出局；會講話的播報員/坐姿櫃檯是甜蜜點。 |
| 3 | **預設只有振幅 lip-sync** | 嘴開/合，非音素級（跟你的 v0 同級，不是 [ADR-002](../docs/adr/ADR-002-expression-director-and-avatar-interface.md) 的 v1 viseme 目標）。 |
| 4 | **輸出 512×512** | 放大到大型播報螢幕會糊（THA4 也是 512）。 |
| 5 | **idle「張嘴呆坐」調校負擔** | ADR-002 已點名 THA 的 `mouth_aaa default=1.0` 這類問題；靜止需歸零、眨眼/呼吸/微擺要調，否則像人偶。 |
| 6 | **參考整合正在變動** | 經典整合 [SillyTavern-Extras talkinghead](https://github.com/SillyTavern/SillyTavern-Extras/blob/main/talkinghead/README.md) 已標 **[OBSOLETE]**（talkinghead 移到 client-side）。好處是它暗示了瀏覽器端路徑（見 §6），壞處是你不能照抄一個穩定的伺服器參考。 |

## 4. 與 ADR-001 的和解（最關鍵的一節）

ADR-001（Accepted）否決常駐 THA 的**原話**是：「常駐 THA 即時神經渲染…對永遠在線的 SOC 監控太脆弱、bespoke GPU 串流」，且「avatar 只需一支、做一次,故不需…即時神經渲染」。逐條檢視今天是否仍成立：

| ADR-001 的反對理由 | 今天還成立嗎？ |
|---|---|
| 「只需一支 avatar、做一次」→ 不需神經渲染 | **仍成立，且這是關鍵。** THA 的頭號賣點是「任意圖免 rig 直出」；但你只要一支、VRoid 已免費 rig 好 → **THA 的優勢 A 在此情境被抵銷**。除非「必須是這張特定 2D 畫」是硬需求，否則 THA 不划算。 |
| 「永遠在線的 SOC 監控太脆弱」 | **部分鬆動。** SOC 播報其實是**突發式**（告警來才講一句、其餘 idle），不是逐幀 24/7 生成。但「一個必須常駐不掛的 GPU Python 服務」對監控系統仍是真實的 ops 脆弱點——這條**沒有消失，只是變小**。 |
| 「bespoke GPU 串流」 | **鬆動但未消除。** 你現在有 GPU；THA4 讓即時性不再需要頂級卡；ONNX Runtime Web + WebGPU（§6）指出一條瀏覽器端路徑。但「自建幀串流管線」這件工程今天仍要你自己做。 |

**和解結論**：ADR-001 對「當前 SOC 播報」的判斷**依然正確**——VRM 已經贏在「夠用、穩、零 Python、授權乾淨」。THA 不是來取代它的。THA 的正當使用場景是**另一個問題**：「當 2D 畫風本身就是不可妥協的品牌」時的對外 AI 主播——那時 THA/THA4 才上場，而且是**加在 `AvatarController` 後面的第三種 backend**，不是推翻 VRM。

## 5. THA3 vs THA4（若要用，選哪個）

| 面向 | THA3 | THA4 |
|---|---|---|
| 即時性 | Titan RTX ~20 FPS；`separable_half` 消費卡 ~40–50 FPS | **蒸餾學生模型 <2MB，GTX 1080 Ti 就 ≥30 FPS** |
| 每角色成本 | 直接吃圖，零預處理 | **需每角色離線蒸餾一次**（你的角色是固定小集合 → 可接受） |
| 臉部驅動 demo | iPhone iFacialMocap（980 日圓 + iPhone X+） | **MediaPipe（webcam）**——對 TTS 驅動的播報其實兩者都不重要 |
| 生態成熟度 | 有 SillyTavern 參考（但已 OBSOLETE） | 較新、參考整合少 |
| 建議 | 只作為理解/離線 preview | **要做 live 播報就用這個** |

## 6. 瀏覽器端 THA 的可能性（降低 §3-1 限制的伏筆，屬 R&D）

[ONNX Runtime Web + WebGPU](https://opensource.microsoft.com/blog/2024/02/29/onnx-runtime-web-unleashes-generative-ai-in-the-browser-using-webgpu/)（2024 起成熟，Chrome/Edge 113+）能在**使用者自己的 GPU** 上跑 PyTorch 匯出的模型——若把 THA 匯成 ONNX 跑在瀏覽器，就**同時消除「伺服器端 Python」與「bespoke GPU 串流」兩個限制**，讓 THA 回到 Augur 的瀏覽器原生模型內。

**誠實邊界**：我查證到「這條技術路徑成熟」與「SillyTavern 已把 talkinghead 移到 client-side」，但**沒有查到一個現成、可直接用的瀏覽器 THA build**。所以這是一條**有前景但需自己驗證/移植**的 R&D 路，不是今天能拿來 ship 的選項。

## 7. 若要整合（概念性，不寫碼）

好消息是 Augur 的接縫已經留好，THA 是**加法不是重寫**：

- 新增一個 `TalkingHeadController implements AvatarController`（`kind="tha"`），實作既有 4 method：`mount(canvas)` / `setMouth(0..1)` / `setEmotion(e)` / `dispose()`（見 [`AvatarController.ts`](../web/src/avatar/AvatarController.ts)）。唯一 swap 點是 `AvatarStage.tsx` 的 `?avatar=` 分支。
- 與 VRM/Live2D 不同：它不本地渲染，而是**開一條 WS/WebRTC 到 Python(THA4) GPU 服務**，把 `setMouth`/`setEmotion` 轉發過去、把回傳影格畫到 canvas。介面契約**不變**（「owns its own render loop」變成「owns its own frame-receive loop」）。
- **完全重用**現有的 `BroadcastPlan` → Edge TTS → 音訊 RMS → `setMouth` + `setEmotion` 管線。lip-sync 用你現成的振幅純量即可（THA 嘴型正是吃這個）。
- emotion 對映：把 Augur 的 `Emotion`（calm/warning/critical/resolved）對到一組 THA emotion 模板 JSON（照 SillyTavern `emotions/*.json` 的形狀）。

## 8. 角色適配矩陣（回應你最初問的三種角色）

| 角色 | THA 適配 | 原因 |
|---|---|---|
| **播報員 / 主播** | ✅ **甜蜜點** | 半身、講話、換表情、idle 呼吸眨眼——THA 正好做這個。（但在 Augur 現況，VRM 已做到，故 THA 只在「2D 畫風硬需求」時才上。） |
| **AI 櫃檯小姐** | ✅ 良好 | 半身、坐/站應答，不需走動。同上 caveat。 |
| **介紹員 / 導覽** | ❌ 不適合 | 需比手勢、指向畫面、可能走動——THA 動不了手臂、不能位移。**這類請用 VRM/3D。** |

## 9. 建議 / 決策規則

1. **維持 SOC 播報用 VRM。** 它贏在夠用、穩、零 Python、授權乾淨，且 ADR-001 前提（一支、做一次）讓 THA 沒有優勢。
2. **只有當「必須忠實保留某張特定 2D 畫」變成硬需求時**，才把 **THA4** 當 `AvatarController` 的第三種 backend 引入——並**先做一個離線 PoC**：拿你的銀藍占卜師圖（[`live2d/_archive/`](../live2d/_archive/)）跑 THA4，肉眼確認畫質與即時 FPS，再決定要不要接 live。
3. **介紹員/導覽別用 THA。**
4. 若哪天想「瀏覽器原生的 THA」，追 §6 的 ONNX Runtime Web + WebGPU，但當成 R&D，不壓主線。

## 10. 外部事實查證（sources + 查證日 2026-07-22）

- THA3 repo / README（輸入規格、45-DOF、demo、授權 MIT+CC BY 4.0、iFacialMocap 980 日圓）：<https://github.com/pkhungurn/talking-head-anime-3-demo> ／ <https://github.com/pkhungurn/talking-head-anime-3-demo/blob/main/README.md>
- THA3 速度/VRAM（Titan RTX ~20 FPS、3070 Ti mobile ~40–50 FPS、~520MB、CPU ~2 FPS）與 lip-sync（振幅／emotion JSON／`separable_half` auto／HF `OktayAlpk/talking-head-anime-3`）：[SillyTavern talkinghead docs](https://docs.sillytavern.app/extensions/talkinghead/) ／ [SillyTavern-Extras talkinghead README（OBSOLETE）](https://github.com/SillyTavern/SillyTavern-Extras/blob/main/talkinghead/README.md)
- THA4（<2MB 學生模型、≥30 FPS on 1080 Ti、MediaPipe、demo code released）：[專案頁](https://pkhungurn.github.io/talking-head-anime-4/) ／ [repo](https://github.com/pkhungurn/talking-head-anime-4) ／ [demo repo](https://github.com/pkhungurn/talking-head-anime-4-demo) ／ [WACV 2025 論文](https://openaccess.thecvf.com/content/WACV2025/papers/Khungurn_Talking_Head_Anime_4_Distillation_for_Real-Time_Performance_WACV_2025_paper.pdf)
- 瀏覽器端推論路徑（ONNX Runtime Web + WebGPU，2024 起成熟）：[Microsoft Open Source Blog](https://opensource.microsoft.com/blog/2024/02/29/onnx-runtime-web-unleashes-generative-ai-in-the-browser-using-webgpu/)
