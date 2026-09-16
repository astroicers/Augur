# Live2D 角色模板規格 v1（`live2d-template-spec-v1.md`）

> 這份是「**查表**」(規格是什麼);操作順序看 `live2d-production-sop.md`(怎麼做)。
> 兩份搭配使用:做的時候照 SOP 走,需要細節時翻這份對應 § 章節。

---

## §1 目的與用法

- **目標**:定義一套可重複使用的 Live2D **母模型**規格,讓 Phase A(建工廠,一次)綁好後,Phase B(換皮,每隻角色)只需換貼圖即可量產。
- **凍結原則(重要)**:**§3 比例錨點** 與 **§4a 部件清單** 一旦凍結就**不可改**——改了等於要重綁母模型(SOP 常見卡點)。要改就升版(v2),別動 v1。
- **v1 範圍**:只綁「對嘴 + 眨眼 + 呼吸/身體擺動」讓角色先會動;4 個情緒表情(§6)的**部件/參數先在此定義齊全(避免日後重綁)**,但 `.exp3.json` 表情檔與「按嚴重度切換表情」**延後**——因為 Augur 的 server-sdk(v0.10.2)目前**沒有觸發表情的路徑**,bridge 切不動。詳見 §9。

---

## §2 命名與資料夾

**ArtMesh / 部件命名**:`part_<區域>_<側>_<細節>`,全小寫底線。例:`part_hair_front`、`part_eye_l_iris`、`part_brow_r`、`part_mouth`、`part_ov_sweat`(overlay)。

**參數命名**:沿用 Cubism 標準 `ParamXxx`(見 §5);本模板自訂的 overlay 參數用 `ParamOv<Name>`。

**貼圖分圖集(atlas)**:
- `texture_00` — **角色美術**(每隻角色不同,Phase B 換它)。
- `texture_01` — **共用 overlay**(全角色共用,只畫一次,見 §4b)。

**資料夾/打包結構**:見 §8。

---

## §3 比例錨點（基準 = `assets/a1-augur-calm.png` · 估值待校正）

所有角色(Phase B)都會被正規化對齊到這組錨點(SOP 的 B2);因此**先用核准的 A1 calm 基準圖量一次、凍結**。

下表為**我從 A1 目測估值**(畫布 768×1376)。`≈` 標記者請在影像軟體用尺規/座標工具讀游標像素**校正後再凍結**(校正前足以開始 A3 拆層;Phase B 正規化前務必校正精確)。

| 錨點 | 值 (px) | 說明 |
|---|---|---|
| 畫布尺寸 W×H | **768 × 1376** | 基準畫布(已定) |
| 臉中軸 X | ≈ 384 | 置中(鼻樑/對稱中線) |
| 眼線 Y | ≈ 285 | 左右瞳孔中心連線高度 |
| 瞳距 | ≈ 100 | 左右瞳孔中心水平距 |
| 嘴中心 Y | ≈ 380 | 閉口時嘴的垂直位置 |
| 頭頂 Y / 下巴 Y | ≈ 90 / ≈ 425 | → 頭高 ≈ 335 |
| 肩線 Y | ≈ 585 | 兩肩連線高度(斗篷下) |

> 校正後 §7 prompt 產的新角色與分層 PSD 都要縮放/平移對齊上表(否則套不上母模型)。

---

## §4a 部件清單（凍結 · 放 `texture_00`）

拆層的完整清單。**設計成可同時支援「對嘴 + 眨眼 + 4 表情 + overlay」而不必重拆**。遮擋處(被頭髮/瀏海/下巴蓋住的部分)拆層時要**補畫完整**。

| 區域 | 部件(ArtMesh) | 備註 / 遮擋補畫 |
|---|---|---|
| 頭髮 | `part_hair_front`、`part_hair_side_l/r`、`part_hair_back` | back 在最底層;front 會蓋到額頭 |
| 臉 | `part_face_base`、`part_ear_l/r`、`part_nose` | face_base 要補到被瀏海蓋住的額頭 |
| 眉 | `part_brow_l`、`part_brow_r` | 獨立左右,供表情上下/變形 |
| 眼(左,右同) | `part_eye_l_white`(眼白)、`part_eye_l_iris`(虹膜/瞳孔)、`part_eye_l_highlight`(高光)、`part_eye_l_lid_upper`(上眼皮,眨眼用)、`part_eye_l_lid_lower`、`part_eye_l_lash` | 眼白要完整(眨眼時上眼皮蓋下來) |
| 嘴 | `part_mouth` | 單一可變形嘴(對嘴用 ParamMouthOpenY 變形 + ParamMouthForm 笑/苦) |
| 腮紅 | `part_cheek_l/r` | 可開關(ParamCheek);平時淡或關 |
| 身體 | `part_neck`、`part_torso`、`part_shoulder_l/r`、`part_arm_l/r` | 供呼吸/身體擺動;手臂可選 |
| 配件 | `part_acc_*` | 視角色(髮飾/領結等) |

---

## §4b 共用 overlay（凍結 · 放 `texture_01` · 全角色共用）

情緒記號,只畫一次,對齊 §3 錨點。各自一個部件 + 一個顯示參數(§5)。

| 部件 | 用途 | 預設顯示參數 |
|---|---|---|
| `part_ov_sweat` | 汗滴(緊張/警告) | `ParamOvSweat` |
| `part_ov_anger` | 怒紋/青筋(危急) | `ParamOvAnger` |
| `part_ov_gloom` | 額前陰影直線(低落/警告) | `ParamOvGloom` |
| `part_ov_sparkle` | 火花/放鬆光(恢復) | `ParamOvSparkle` |

---

## §5 Cubism 參數集

**標準動作參數**(母模型必備;v1 就要綁這些):

| 參數 | 範圍 | 用途 |
|---|---|---|
| `ParamAngleX/Y/Z` | -30~30 | 頭部轉動 |
| `ParamEyeLOpen` / `ParamEyeROpen` | 0~1 | **眨眼(v1)** |
| `ParamEyeBallX/Y` | -1~1 | 眼球視線 |
| `ParamBrowLY` / `ParamBrowRY` | -1~1 | 眉上下(表情用) |
| `ParamMouthOpenY` | 0~1 | **對嘴(v1;AIRI 依 TTS 音量驅動)** |
| `ParamMouthForm` | -1~1 | 嘴型 苦↔笑(表情用) |
| `ParamCheek` | 0~1 | 腮紅濃度 |
| `ParamBreath` | 0~1 | **呼吸(v1;idle 動態)** |
| `ParamBodyAngleX/Y/Z` | -10~10 | 身體擺動 |

**自訂 overlay 顯示參數**(0~1,控制 §4b 顯示):
`ParamOvSweat`、`ParamOvAnger`、`ParamOvGloom`、`ParamOvSparkle`。

> v1 真正會被 AIRI 自動驅動的是 `ParamMouthOpenY`(對嘴)+ `ParamEyeLOpen/ROpen`(眨眼,或用內建 auto-blink)+ `ParamBreath`/`ParamBodyAngle*`(idle)。其餘參數先綁好待表情用。

---

## §6 四表情 `.exp3.json`（部件/參數此版定義齊全;檔案與切換延後）

對應 Augur 的 `ParsedAlert`:`severity`(critical/warning/info)與 `status`(resolved)。

| 表情 | 對應 | 參數設定(Overwrite) |
|---|---|---|
| `calm` | info / idle | `ParamMouthForm`=+0.2、眉中性、所有 `ParamOv*`=0 |
| `warning` | warning | 眉略下、`ParamOvSweat`=1、`ParamOvGloom`=0.5、`ParamMouthForm`=-0.2 |
| `critical` | critical | 眉下壓、`ParamOvAnger`=1、`ParamMouthForm`=-0.6、眼略放大 |
| `resolved` | resolved(已恢復) | `ParamMouthForm`=+0.6、`ParamOvSparkle`=1、`ParamCheek`=0.5 |

`.exp3.json` 格式範本(warning 為例):
```json
{
  "Type": "Live2D Expression",
  "Parameters": [
    { "Id": "ParamBrowLY", "Value": -0.5, "Blend": "Overwrite" },
    { "Id": "ParamBrowRY", "Value": -0.5, "Blend": "Overwrite" },
    { "Id": "ParamMouthForm", "Value": -0.2, "Blend": "Overwrite" },
    { "Id": "ParamOvSweat", "Value": 1, "Blend": "Overwrite" },
    { "Id": "ParamOvGloom", "Value": 0.5, "Blend": "Overwrite" }
  ]
}
```

> **v1 不接切換**:bridge 目前只能送 `input:text`、無觸發表情路徑。這 4 個檔在「server-sdk 表情切換調查」通了之後再產製與接線(見 §9)。先把參數/部件定義齊,日後只補 `.exp3.json`、**不必重綁**。

---

## §7 Gemini（Nano Banana）prompt 模板（`[角色外觀]` 待用 A1 反推填實）

**calm 基準角色 prompt**(英文;產 A1 與 Phase B 每隻角色用,只換 `[CHARACTER_APPEARANCE]`):

```
A single anime character, [CHARACTER_APPEARANCE], front-facing, looking at the
viewer, neutral calm expression, mouth closed, eyes open. Upper body (waist up),
symmetric pose, arms relaxed at sides. Flat anime cel-shading, clean line art,
soft even lighting, no harsh shadows. Each part clearly separated and fully
visible (hair not heavily covering the face, no occluded limbs), suitable for
Live2D rigging. Plain solid background / transparent. High resolution, vertical.
```

**綁定友善約束(務必保留)**:正面、對稱、平塗、無強陰影、部件可分離、無遮擋、純背景、閉口中性。

**表情變體 prompt(參考用)**:在 calm prompt 後改最後的表情描述 ——
- warning:`worried expression, slight frown, one sweat drop`
- critical:`alarmed/serious expression, furrowed brows`
- resolved:`relieved gentle smile, soft blush`

> `[CHARACTER_APPEARANCE]` 由核准的 A1 圖反推(髮型/髮色/眼睛/服裝/配件等),填實後凍結,確保 Phase B 產出同一角色族系。

### 已凍結角色外觀（v1 · A1 = `assets/a1-augur-calm.png`）

把下面這段填入上方 prompt 的 `[CHARACTER_APPEARANCE]`(已核准):

```
named "Augur", a calm young female oracle mascot: medium-length silver-blue
hair with straight blunt bangs and long side locks, a small pale-blue
star/snowflake hairclip on her right bangs, soft violet eyes, wearing a dark
navy hooded capelet with a subtle white starry-speckle pattern over a
charcoal-grey high-neck long-sleeve top
```

色票(供 Cubism/拆層對齊):髮 銀藍 silver-blue、眼 violet、斗篷 navy + 白點星紋、上衣 charcoal-grey。

---

## §8 打包與匯入 AIRI

**資料夾 / zip 結構**:
```
<character>/
  <character>.model3.json        # 入口:引用 moc3/貼圖/physics/expressions
  <character>.moc3               # Phase A 匯出的母模型(換皮時不動)
  <character>.physics3.json
  <character>.cdi3.json          # 可選(參數顯示名)
  expressions/
    calm.exp3.json               # §6(v1 可先省略,留空資料夾)
    warning.exp3.json
    critical.exp3.json
    resolved.exp3.json
  <character>.2048/
    texture_00.png               # 角色美術(Phase B 換)
    texture_01.png               # 共用 overlay(不換)
```

**匯入 AIRI**:Settings → **Character Model → add** 選上面打包的 zip。

**CCV3 角色卡**綁定(指向匯入的模型):
```json
{
  "spec": "chara_card_v3",
  "data": {
    "name": "<character>",
    "extensions": {
      "airi": { "modules": { "live2d": { "file": "<匯入後的模型路徑/檔名>" } } }
    }
  }
}
```

---

## §9 v1 範圍與後續

- **v1(現在做)**:綁 idle(呼吸/身體)+ 眨眼(`ParamEyeLOpen/ROpen`)+ 對嘴(`ParamMouthOpenY`,AIRI 依 TTS 驅動)。匯出 `master.moc3` + `texture_00/01` + physics。**§4a 部件、§5 參數、§4b overlay 全綁齊**,只是不接表情切換。
- **v2(表情)**:產製 §6 的 4 個 `.exp3.json`。等 **server-sdk 表情切換調查**(Augur 的 Blocker)通了,bridge 再把 `severity/status` 對應到表情。因 v1 已把部件/參數定齊,**v2 只補表情檔、不重綁**。
- **與語音線的關係**:語音播報(Augur 主功能)與本角色模型**兩條平行、不互相卡**。第一版角色出現在 AIRI、會眨眼+對嘴(對著語音)即達標。

> **已查證(2026-06,影響本節)**:AIRI 的**對嘴(lip-sync,2026-01 起原生)、眨眼、idle、look-at 全是 runtime 內建驅動** → v1 連這些行為的「驅動」都不用寫,模型只要把標準參數(`ParamMouthOpenY`/`ParamEyeLOpen`/`ParamEyeROpen`/`ParamAngleX/Y/Z`/`ParamBodyAngleX`)綁出來即可。**server-sdk 確認無表情切換事件**(`ProtocolEvents` 僅 `input:text`/`input:text:voice`/`input:voice`),表情靠 LLM 回覆塞 `<|ACT:emotion|>` 標籤、不走 server-sdk → 外部告警切表情無官方 API(AIRI v0.8 Issue #312 開發中),故 §6 延後正確。**完整製作路徑、拆層工具、外包綁定、VRM 替代路線見 [`RUNBOOK.md`](RUNBOOK.md)。**
