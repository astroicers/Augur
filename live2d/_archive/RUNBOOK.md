# Augur 角色製作 Runbook — 把「Augur」弄進 AIRI（v1：對嘴 + 眨眼 + idle）

> 搭配 [`live2d-template-spec-v1.md`](live2d-template-spec-v1.md)（查表）與 `/mnt/c/Users/USER/Downloads/live2d-production-sop.md`（流程）。
> 本檔 = **最終建議與決策**：用最省力的路徑達成 v1，並串起已產出的所有素材。

## 0. TL;DR

**先記住一件會改變整個決策的事實:AIRI 把「對嘴、眨眼、idle、看向」全做成 runtime 內建** —— lip-sync 自 2026-01 起原生（跟 TTS 音量自動驅動），眨眼/idle 是設定面板開關。**所以 v1 你幾乎不用「綁」這些行為,只要模型把標準 Cubism 參數綁出來、AIRI 就會自己驅動。** v1 的綁定需求遠小於完整 VTuber rig。

**兩條主線,依「要不要保留 A1 那張 2D 臉」二選一:**

| 路線 | 適合 | 做法 | 成本/工 |
|---|---|---|---|
| **A. 2D Live2D(保留 A1)** | 你想要就是這張占卜師臉 | See-through 拆層 → **外包綁定** → 匯入 AIRI | USD 50–150 + 數天 |
| **B. 3D VRM(放棄 A1 改 3D)** | 只在乎「角色會動能上線」 | VRoid Studio 捏一個 → 匯出 `.vrm` → 匯入 AIRI | 幾乎零費、一個下午 |

> **我的建議**:若這張臉是重點 → **走 A,且綁定外包**(自學 Cubism 綁定是全流程最貴最費工、CP 值最低的一步)。若臉可換 → **B 最省力**(對嘴+眨眼+idle 是 VRM 內建,近乎零綁定)。

---

## 1. 關鍵前提（已查證,影響每個決定）

- **匯入硬門檻**:模型必須含 `.moc3`(Cubism 3+,舊版 `.moc` 不收),整包資料夾壓成 `.zip`,從 **AIRI → Settings → Models → Character Model → add** 匯入。
- **對嘴 = 原生**:vowel-based,跟 TTS 自動驅動。社群 PR #583 想加此功能,2026-01-15 被維護者關閉註明「Now natively supported」。**你不用接線、不靠角色卡設定。**
- **眨眼/idle/look-at = runtime 開關**:parameters 面板可調 Auto Blink、Idle Animation、Mouse tracking。v1 不用你綁。
- **務必用標準參數命名**(讓內建驅動生效):`ParamMouthOpenY`、`ParamMouthForm`、`ParamEyeLOpen`/`ParamEyeROpen`、`ParamAngleX/Y/Z`、`ParamBodyAngleX`。(官方未逐字列必綁清單,此為合理推斷)
- **角色卡 CCV3** 的 `extensions.airi.modules.live2d` 只有 `source`/`file`/`url` 三欄 —— 只負責「指向哪個模型」,**沒有 motion/expression 欄位**。
- **❗server-sdk 無表情切換 API(已證實)**:直接讀 `@proj-airi/plugin-protocol` 的 `ProtocolEvents`,客戶端輸入事件只有 `input:text` / `input:text:voice` / `input:voice`,**無任何 live2d/motion/expression/emotion 事件**。AIRI 的表情是靠 LLM 在回覆文字塞 `<|ACT:{"emotion":"happy"}|>` 標籤觸發,**不走 server-sdk**。→ 對 Augur(表情要由 Grafana 告警驅動、非對話)目前**無官方外部 API**(v0.8 roadmap Issue #312 開發中)。**故 4 表情延後、v1 只做對嘴+眨眼+idle,是與 AIRI 現況最契合的決定。**

---

## 2. 決策樹

- 保留 A1 立繪(臉不可放棄)→ **路線 A**:See-through 拆層 + Fiverr 外包綁定。最確定保留外觀。
- 只要會動、不執著 2D 臉 → **路線 B**:VRoid 捏 VRM。一下午、零綁定、零外包費、零授權煩惱。
- 預算零 + 願學 → **A 的 DIY 變體**:自己 See-through + 自學 Cubism 綁定。最省錢最費時。
- 不想架 ComfyUI 但要 2D → 拆層改雲端 **imagetolayers/Komiko**,綁定仍外包。
- ❌ **不要**:免費 rigged 模板換皮(授權多禁散布修改版 + 換皮要對齊 mesh/UV,不省工)、auto-rig to moc3(CartoonAlive 未釋出 code,別賭 v1)。

---

## 3. 推薦主線(路線 A)逐步

### A3 — 拆層 + 補遮擋
- **首選工具:See-through**（`github.com/jtydhr88/ComfyUI-See-through`,本地 ComfyUI、MIT、免費）。唯一同時做到**真語意分層**(19–24 層,自動拆前後髮/左右眼/眼白)+ **真 inpaint 補遮擋**(每層含被帽兜/瀏海遮住的隱藏像素)+ 直出**分層 PSD**。對 Augur 的連帽斗篷遮擋是決定性能力。
  - **輸入**:原為 `assets/a1-augur-calm-cutout.png`，**該檔已於 2026-09-21 退出版控**（本機仍在）。
  - **VRAM 雷**:預設吃 12GB+,768×1376 在 4070 12GB 邊界內、解析度拉高會吃緊(**請實測**)。**跑拆層前先停掉 `llama-server`**,否則與它搶同一張 GPU、重演 WebGPU 餓死(見 runbook 已知雷)。
- **退路(不想架 ComfyUI)**:雲端 `imagetolayers.com`(no-code、有補遮擋、出 PSD,匯出吃 credits)或 `komiko.app`(出散 PNG 需自拼)。
- **我已產的對照**:色彩分區 prepass [`assets/layers/`](../assets/layers/) 與 [`live2d/scripts/a3_prepass.py`](scripts/a3_prepass.py)(色塊級,僅供對照,非語意層)。
- **驗收**:把工具輸出的各層 PNG 丟 `assets/layers_ai/`,跑 `python3 live2d/scripts/check_layers.py assets/layers_ai` → 看覆蓋率與**破洞圖**(`_holes.png`,粉紅=缺件/沒補的遮擋)。
- **手補退路**(若某些遮擋補不乾淨):用我給的 Gemini prompt 生「完整臉底(去髮)」「脫斗篷上半身」當 `face_base`/`torso` 來源(見對話紀錄或下方附錄)。

### A5 — 綁定(外包,推薦)
**交付給 rigger 的輸入**(你已幾乎備齊,所以報價能壓低):
- 分層 PSD(A3 產出)+ [`live2d-template-spec-v1.md`](live2d-template-spec-v1.md) 的 **§4a 部件、§5 參數、§4b overlay、§6 表情定義**。
- **動作清單(v1 最小)**:嘴 `ParamMouthOpenY`+`ParamMouthForm`、雙眼 `ParamEyeLOpen`/`ParamEyeROpen`、頭 `ParamAngleX/Y/Z`、`ParamBodyAngleX`、**極簡 physics**(髮/斗篷輕擺即可)。

**必須白紙黑字要回的交付物**:`.moc3` + textures + `model3.json`,**外加 `.cmo3` 原始檔**(日後加 4 表情要用;很多 gig 預設不含或另收費)。

**平台/行情**:Fiverr「Live2D rigging」簡單 rig **USD 50–150**、約 5 天起。你只買 rigging 勞務(美術自帶)→ 落最低區間。

### A6 — 匯出 + 打包
- 從 **Cubism 標準匯出**成 [§8](live2d-template-spec-v1.md) 的資料夾結構 → 壓 `.zip`。
- **剔除多餘檔**(別用 VTube Studio 那種含額外檔的 zip,AIRI loader 會讀不了);`physics` 可極簡或缺(loader 容錯),但 **textures 路徑/檔名要與 `model3.json` 完全一致**,否則載入失敗。

### 匯入 AIRI + 驗證
1. AIRI → **Settings → Models → Character Model → add** 拖入 zip。
2. 角色卡(CCV3)`extensions.airi.modules.live2d`:`source:"file"`、`file:"<模型檔>"`。
3. **驗對嘴**:開 TTS 講一句,看嘴自動開合。**驗眨眼/idle**:parameters 面板確認 Auto Blink、Idle 開著。
4. 串回 Augur:告警 → `input:text` → 角色用語音念出、嘴同步動 = **v1 達標**。

---

## 4. 路線 B(VRM)速記

VRoid Studio(免費)捏一個銀藍髮/紫眸占卜師 → 匯出 `.vrm` → AIRI 匯入。對嘴(viseme)+ 眨眼 + idle 是 VRM blendshape + runtime 內建,**幾乎零綁定、零外包**。代價:A1 立繪只能當配色參考,風格 2D→3D。**若你對「那張臉」沒執念,這是最省力的路。**

---

## 5. 表情（v2,延後 —— 為何 & 未來怎麼接）

- **為何延後**:server-sdk 無表情切換事件(§1 已證實),Augur 的表情要由「外部告警」驅動,目前無官方 API。
- **未來兩條可能路徑**:
  1. **等 AIRI v0.8**:roadmap Issue #312「plugin-izing Live2D motion / Server Event to configure child modules」落地後,bridge 或許能經 server event 切表情。
  2. **借 LLM 的 `<|ACT:emotion|>` 標籤(推測,待驗)**:Augur 送的 `input:text` 會經 AIRI 的 LLM 產生回覆;若用 system prompt/告警文字**誘導 LLM 依 severity 在回覆塞對應 emotion 標籤**,AIRI 就會切表情 —— 這條**不需 server-sdk**,但需先用 `.cmo3` 把 4 表情做好,且行為較不可控。標為待驗證假設。
- 兩條都需要 §6 的 4 個 `.exp3.json`(或 `.cmo3` 內表情)。**因 spec §4a/§5 已把表情所需部件/參數定齊,日後只補表情、不必重綁。**

---

## 6. 工量 / 成本 / 可外包性

| 步驟 | 工量 | 怎麼處理 |
|---|---|---|
| A3 拆層 + 補遮擋 | 半天 | **工具外包**(See-through / imagetolayers);事後 layer editor 微修 |
| A5 Cubism 綁定 | **最高、學習曲線陡** | **外包 Fiverr USD 50–150**(最該外包的一步) |
| A6 匯出 + zip | 低 | 自己照 Cubism 標準匯出,注意檔名一致 |
| 匯入 AIRI + 驗證 | 近乎零 | 拖 zip → 開 TTS,driver 全內建 |
| 4 表情 | 延後 | 需 `.cmo3` + 等 AIRI v0.8 / 或 LLM ACT 標籤 |

---

## 7. 常見雷

- **See-through 與 llama-server 搶 GPU** → 拆層時先停 LLM。
- **VTube Studio 匯出的 zip 不能直接餵 AIRI**（含多餘檔）→ 自己從 Cubism 標準匯出,或剔除多餘檔再壓。
- **外包前確認交付含 `.cmo3`**(日後加表情要用),否則只拿到 `.moc3` 改不了。
- **免費 rigged 模板換皮的雙重牆**:授權禁散布修改版 + 對齊 mesh/UV 不省工 → 個人自用尚可,要打包進可下載 repo 就踩線。
- **任何拆層工具都跳不過綁定**:給的是分層 PSD,不是 `.moc3`;匯入 Cubism 後仍要檢查嘴內/眼白畫足、合併線稿與填色。
- **textures 路徑錯 = 載入失敗**;physics 缺可容錯。
- 拆層自動補的遮擋偶有層重疊小瑕疵(See-through 作者也承認)→ Cubism 內微修,別預期 100% 乾淨。

---

## 8. 這個 repo 已產出的素材

| 檔 | 用途 |
|---|---|
| [`live2d-template-spec-v1.md`](live2d-template-spec-v1.md) | 規格(部件/參數/4 表情/prompt/打包);§3 錨點/§7 外觀已錨定 A1 |
| ~~`assets/a1-augur-calm.png`~~ | A1 calm 立繪(768×1376)。**已於 2026-09-21 退出版控**，色票見 `docs/sprite/sprite-sheet-spec.md` SP-6.0 |
| ~~`assets/a1-augur-calm-cutout.png`~~ | 去背透明圖。**同上，已退出版控** |
| ~~`assets/layers/`~~ | 色彩分區 prepass。**同上，已退出版控** |
| [`scripts/a3_prepass.py`](scripts/a3_prepass.py) | 去背 + 色彩分區 |
| [`scripts/check_layers.py`](scripts/check_layers.py) | 圖層覆蓋率/破洞驗收 |

---

## 9. 來源

- See-through(拆層+補遮擋,首選):https://github.com/jtydhr88/ComfyUI-See-through
- imagetolayers(雲端拆層,有補遮擋):https://www.imagetolayers.com/solutions/character-into-layers
- Komiko Layer Splitter:https://komiko.app/layer_splitter
- LayerDivider(低 CP,不補遮擋):https://github.com/mattyamonaca/layerdivider
- CartoonAlive(auto-rig 研究,未釋出 code):https://arxiv.org/abs/2507.17327
- AIRI repo（VRM/Live2D 同支援、auto blink/idle）:https://github.com/moeru-ai/airi
- AIRI lip-sync 原生(PR #583):https://github.com/moeru-ai/airi/pull/583
- AIRI 表情/server event roadmap(Issue #312):https://github.com/moeru-ai/airi/issues/312
- Live2D 官方 sample 授權:https://www.live2d.com/eula/live2d-sample-model-terms_en.html
- Fiverr Live2D rigging 行情:https://www.fiverr.com/gigs/live2d-rigging
- Live2D 官方拆圖/補遮擋規範:https://docs.live2d.com/en/cubism-editor-tutorials/psd/
