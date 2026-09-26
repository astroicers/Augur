# Augur 角色 — VRM Runbook（VRoid → AIRI）

> **現行角色路線(2026-06-23 起)。** Live2D(2D)已廢除封存(見 `../live2d/_archive/DEPRECATED.md`)。
> 目標 v1:一個 3D 角色出現在 AIRI,會**對嘴 + 眨眼 + idle + 髮擺**,唸出 Augur 的告警。

## 0. 為什麼走這條

VRM = 「**現成 rig,你只換裝**」。骨架、對嘴(viseme)、眨眼、idle、look-at、髮/裙物理(spring bones)都是 **VRM 標準 + VRoid 自動生成 + AIRI runtime 內建** → **你幾乎不用「綁」任何東西**。免 Cubism、免 `.moc3`、免 UV/mesh 對齊、免授權地雷。代價:風格是 3D(VRoid 風),不是 2D 手繪。**一個下午、零費用**。

## 路線 0 — 最省力（建議,若不堅持「我這隻角色」）

**不捏、不生、不賭 —— 直接抓一個別人已經綁好的免費 VRM 丟進 AIRI。** 對嘴/眨眼/spring bone 都是現成的,5 分鐘、瀏覽器直接跑。這是「全自動(對你零工)+ 會動 + 瀏覽器」的真正解,代價是角色不是你獨有的(但你仍可從目錄挑一個喜歡的,如銀藍/占卜風)。

**哪裡抓(選可下載 + 授權允許的)**:
- **VRoid Hub** [hub.vroid.com](https://hub.vroid.com/en) —— 專為 VRM 而生,每個模型頁**右下角**標示可否下載/商用/修改/再散布。找「Free to use」角色(例:[Fred 免費角色](https://hub.vroid.com/en/characters/7404759744605846862/models/7304684792940112239)、[Pastel 免費 VTuber](https://hub.vroid.com/en/characters/6933068319521707258/models/5421768628497152084))。
- **BOOTH** [booth.pm](https://booth.pm/en/search/free%20vtuber%20model) —— 搜「free vtuber model / free vroid model」,大量免費 VRM 包(例:[MillyDusa 免費 VRM 包](https://booth.pm/en/items/4939358))。
- 彙整清單:[Live3D 100+ VRoid 模型](https://live3d.io/vroid_model)。

**授權**:個人桌面私用(你的 Augur companion)風險低;但**若之後要直播/公開/商用**,務必讀該模型的使用條款(VRoid Hub 頁面右下角那組旗標)。優先用 VRoid Hub / BOOTH 官方作者頁,別用轉載站。

**步驟**:下載 `.vrm` → AIRI **Settings → Models → add** → 選它 → 開 TTS 講話,對嘴/眨眼/髮擺全自動。**結束。**

> 想要「你那張臉」才走下面 §2 的 VRoid 自捏(或外包)。純想「快、會動、瀏覽器」→ 路線 0 就夠。

## 1. 關鍵前提（已查證）

- **AIRI 吃 VRM**:Settings → **Models** → **add** 直接匯入 `.vrm`;VRM 與 Live2D 同等支援。([AIRI 手冊](https://airi.moeru.ai/docs/en/docs/manual/tamagotchi/setup-and-use/))
- **全自動**:對嘴走 **A/I/U/E/O viseme**(跟 TTS 音訊);眨眼/idle/look-at 是 runtime 行為;髮/裙擺動靠 VRoid 自動生成的 **spring bones**。**基本 AIRI 用途不需要 Unity round-trip**(那只有 VRChat/進階微調才要)。([VRoid FAQ](https://vroid.pixiv.help/hc/en-us/articles/38726063278233-How-do-I-export-a-model-as-VRM))
- **⚠️ 最大雷**:**VRoid Studio 不能把成品 `.vrm` 再匯入編輯** → **一定要存好 `.vroid` 專案檔**,日後要改只能改它再重匯出。

## 2. 步驟

### Step 1 — 裝 VRoid Studio（免費）
- 下載:[vroid.com](https://vroid.com/en/studio) 或 Steam。Windows/macOS 皆可。

### Step 2 — 捏角色
- 用**預設角色**當底,拉滑桿改:臉、髮型(Hair Editor)、眼、體型、服裝、顏色/材質。
- **配色參考**:想延續專案名「Augur(占卜者)」→ 參考封存的銀藍占卜師 A1（⚠️ 該圖已於 2026-09-21 退出版控，本機仍在；色票見 `docs/sprite/sprite-sheet-spec.md` SP-6.0）;或走 namei 那個橘髮風。**你的立繪只當配色/風格參考,VRoid 是重捏一個 3D 的。**
- 不用追求完美,先能出一個像樣的角色即可(v1)。

### Step 3 —（選）表情
- VRoid 內建 AIUEO(對嘴)+ 眨眼 + 喜怒哀樂驚,**基本 v1 不用動**。
- 要自訂再進 **Expression Editor**。

### Step 4 — 匯出 VRM
- 右上匯出鈕 → **Export VRM** → 匯出設定頁:可 **optimize**(減多邊形/材質/骨數)讓檔案更輕;**別 optimize 過頭**(會破圖/掉髮擺)。
- **VRM 版本**:VRoid 可選 **VRM 0.0 或 1.0**。先匯 **0.0**(相容性最廣);若 AIRI 載不進去,改匯 **1.0** 再試。
- 匯出 `.vrm`。**同時把 `.vroid` 專案檔存好**(見 §1 雷)。

### Step 5 — 匯入 AIRI
- AIRI → **Settings → Models → add** → 選你的 `.vrm`。
- 角色卡(CCV3)指向此模型(`extensions.airi.modules` 下的 VRM 模組;用 Models 面板匯入後通常自動綁定)。

### Step 6 — 驗證(怎麼算成功)
1. **對嘴**:開 TTS 講一句(或讓 Augur 送一條告警)→ 嘴跟著音節開合。
2. **眨眼/idle/look-at**:AIRI 設定/參數面板確認 Auto Blink、Idle、Look-at 開著(通常預設開)。
3. **物理**:轉頭/移動 → 頭髮、裙擺會晃(spring bones)。
4. 三項都動 = **v1 達標**:Augur 告警 → `input:text` → AIRI → TTS → **3D 角色開口念出、嘴同步**。

## 3. 工量 / 成本

| 項 | 工量 |
|---|---|
| VRoid 捏角色 | 一下午(拉滑桿,無技術門檻) |
| 匯出 VRM | 幾分鐘 |
| AIRI 匯入 + 驗證 | 幾分鐘(拖檔) |
| 綁定 / 費用 / 授權 | **零**(全內建;自捏模型是你的) |

## 4. 常見雷

- **沒存 `.vroid` 專案檔** → 成品 VRM 無法回頭編輯,只能重捏。**務必存。**
- **VRM 版本對不上** → AIRI 載不進去就換 0.0 ↔ 1.0 另一個試。
- **optimize 過頭** → 破圖 / 髮擺消失 → 匯出時保守一點。
- **VRoid Hub 下載的現成 VRM** → 有各自授權(自捏的才完全是你的);要用別人的先看授權。
- **對嘴不明顯** → 確認 TTS 有實際出聲(對嘴靠音訊);必要時調 viseme 強度。

## 5. 表情(依 severity)— 仍延後

與 Live2D 同結論:**server-sdk 沒有外部觸發表情的 API**(只有 `input:text` 系列)。所以「按告警嚴重度變表情」目前無官方路徑。未來兩條可能:
1. 等 AIRI v0.8(roadmap Issue #312 的 server event / 模組化)。
2. 用 system prompt/告警文字**誘導 LLM 在回覆塞 `<|ACT:emotion|>` 標籤** → AIRI 依標籤切 VRM 表情(推測待驗)。
v1 先只做對嘴+眨眼+idle。

## 6. 與語音線的銜接

Augur bridge(語音線)**完全不變**:Grafana 告警 → `input:text` → AIRI 本地 LLM → TTS → 現在由這個 VRM 角色開口 + 對嘴。角色與語音兩條平行,VRM 只是把「發聲的那張臉」換成 3D。

## 7. 來源

- AIRI 手冊(模型設定):https://airi.moeru.ai/docs/en/docs/manual/tamagotchi/setup-and-use/
- AIRI Models 設定頁:https://airi.moeru.ai/settings/models
- VRoid Studio:https://vroid.com/en/studio
- VRoid「如何匯出 VRM」:https://vroid.pixiv.help/hc/en-us/articles/38726063278233-How-do-I-export-a-model-as-VRM
- VRoid VRM 匯出說明:https://vroid.pixiv.help/hc/en-us/articles/15760756822297
