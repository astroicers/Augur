<!-- ADR-002 | Status: Accepted -->
# ADR-002：表情導播 + lip-sync + `AvatarController` 可換 avatar 介面

| 欄位 | 值 |
|------|----|
| **狀態** | `Accepted` |
| **日期** | 2026-07-18 |
| **決策者** | astroicers（待人類審核） |

> **狀態說明**：`Draft`（禁止生產代碼）→ `FIRM`（POC）→ `Accepted`。**AI 不可自行升級**。承 ADR-001,聚焦「AIRI 免費給的 TTS/lip-sync/表情/idle,現在由誰、如何擁有」。

> ⬆️ **由 `Draft` 升 `Accepted`（2026-07-18）**：使用者顯式授權 Accept。升級依據 = **POC gate 全綠**:G-ADR002-1 `AvatarController` 可換性 PASS(同一 pipeline 僅換 `?avatar`,VRM↔Live2D 皆講話+換表情,`SWAP_PROVEN=true`)、G-ADR002-2 Edge TTS→振幅 lip-sync PASS(見 Verification Evidence)。**人類顯式授權,非 AI 自行升級**。剩餘:viseme v1、正式版把 `AvatarController` 移入 Augur 生產前端。

## 痛點 / 需求

ADR-001 決定用瀏覽器原生 avatar,但 **AIRI 過去免費提供的 TTS、lip-sync、眨眼、idle、表情全都不見了**——這些現在必須由播報系統自己擁有。且使用者選 **C（VRM 起步 + avatar 模組化可換）**,故驅動層必須 **avatar-agnostic**:同一套「導播訊號」要能驅動 VRM(現在)與 Live2D(未來),不得綁死格式。

## 決策

### 1. 事件契約 `BroadcastPlan`（借 echobot「Stage Event Broker」模式,MIT 可借碼）

導播(Augur `src/core/format` 升級)輸出:

```ts
interface BroadcastPlan {
  text: string;                 // 要講的句子（TTS 輸入）
  severity: "critical" | "warning" | "info" | "resolved";
  emotion: Emotion;             // 由 severity 經 emotion-map 決定，可被 LLM/規則覆寫
  emphasis?: number;            // 0..1，影響語速/音量/表情強度
}
type Emotion = "neutral" | "angry" | "surprised" | "happy" | "sad";
```

**emotion-map**(可編輯設定,承 Augur `live2d/…spec §6` 早 spec 未接線的 severity→表情):
`critical→angry`、`warning→surprised`、`resolved→happy`、`info→neutral`。

### 2. `AvatarController` 介面（avatar-agnostic —— 這就是「模組化可換」的落點）

```ts
interface AvatarController {
  load(canvas: HTMLCanvasElement): Promise<void>;
  setMouth(open: number): void;      // 0..1，lip-sync 每幀
  setEmotion(e: Emotion): void;      // 格式內部自行映射
  tickIdle(t: number): void;         // 眨眼 + 呼吸/微擺
  dispose(): void;
}
```

- **VRM 實作(首發,spike A 已證)**:`setMouth`→`expressionManager 'aa'`;`setEmotion`→preset `angry/surprised/happy/neutral`;`tickIdle`→head sway + 週期 blink。
- **Live2D 實作(未來皮,spike B 已證雛形)**:`setMouth`→`ParamMouthOpenY`(或 `model.speak`);`setEmotion`→`ParamBrowLY/Angle`+`ParamMouthForm`+`ParamEyeSmile`;`tickIdle`→motion/auto-blink。

### 3. lip-sync 兩階

- **v0 = 振幅**(spike 已證、無 TTS 相依):`<audio>` + Web Audio `AnalyserNode` → RMS → `setMouth`。
- **v1 = viseme**:若 TTS 提供 phoneme 時戳(Azure/Edge),母音→更精準嘴型(VRM `aa/ih/ou/ee/oh`、Live2D 對應)。

### 4. TTS 抽象 `TTSProvider`

介面化 `speak(text): {audio, visemes?}`。引擎選型見待定;**v0 傾向 Edge TTS(免費、zh、no-key)**——先給 v0 振幅 lip-sync 用的音訊來源,不引入 Python。

## Verification Evidence

| 項目 | 結論 | 來源 |
|------|------|------|
| `setMouth`(振幅 lip-sync)在 VRM 與 Live2D 兩實作皆可 | ✅ 兩 spike mouth 峰值皆 1.0 | spike A/B（2026-07-18） |
| `setEmotion`(severity→表情)在兩實作皆可 | ✅ VRM preset / Live2D 參數級,critical→angry 目視正確 | spike A/B 截圖 |
| 介面中立性(同訊號驅動兩格式) | ✅ 兩 spike 的 `Severity`/emotion 切換邏輯結構相同,可抽為共同介面 | spike 原始碼對照 |
| **`BroadcastPlan` + TTS + lip-sync + emotion 端到端(G-ADR002-2)** | ✅ **PASS**——導播 emit `{text,severity,emotion}` + Edge TTS(`msedge-tts` zh-TW)→ base64 mp3 → `<audio>`+AnalyserNode → mouth 峰值 1.0;critical→angry、resolved→happy 目視正確 | `broadcaster-spikes/spike-c-e2e/`（2026-07-18 e2e） |
| **`AvatarController` 可換性(G-ADR002-1)** | ✅ **PASS**——實作 `AvatarController` 介面 + `VrmController` + `Live2DController`;**同一 App/WS/audio pipeline**,僅 `?avatar=vrm｜live2d` 不同 → 兩格式皆 `ready`/`spoke=true`/`mouth_max=1.0`、critical→angry、resolved→happy(Live2D 笑眼+張嘴);`SWAP_PROVEN=true` | `broadcaster-spikes/spike-d-swap/`（2026-07-18,playwright 雙模式 e2e） |

## Follow-up / POC gate（升 FIRM 前必過）

- **G-ADR002-1（`AvatarController` 可換性）✅ PASS（2026-07-18）**:`AvatarController` 介面 + `VrmController` + `Live2DController` 實作完成;同一 App/WS/audio pipeline 僅換 `?avatar` 參數 → VRM 與 Live2D 皆講話 + severity 換表情,`SWAP_PROVEN=true`(見 Verification Evidence)。**C「模組化可換」承諾已實證。** 剩:正式版把 `AvatarController` 移入 Augur 生產前端。
- **G-ADR002-2（Edge TTS → v0 振幅 lip-sync 端到端）✅ PASS（2026-07-18）**:見 Verification Evidence。

## 待驗風險

1. **viseme 時戳依賴 TTS**:v1 若走本地 TTS 可能引入 Python;Edge/Azure 雲則零 Python 但有網路相依。v0 先不擋。
2. **表達力落差**:VRM preset 表情數固定;Live2D 需 rig 時就決定表情通道。emotion-map 要能對映兩者的最小共集。
3. **idle 自然度**:眨眼/呼吸/微擺參數需調,否則「張嘴呆坐」(THA 的 `mouth_aaa default=1.0` 同類問題,VRM/Live2D 靜止需歸零 mouth)。
