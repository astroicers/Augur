# 執行期行為實測

> 這裡放的是**對 live Grafana 量出來的行為**，不是推論。
> ADR-004 的〈待驗風險〉與〈查不到〉回填需要人類授權（`remaining-plan.md` 的 B4），
> 在那之前結論住這裡。每一則都記環境、日期、與怎麼複驗。
>
> 環境（除非另註）：Grafana **13.2.2**（`monitoring/docker-compose.yml`）、
> plugin 由 `../dist` 掛載、headless chromium（playwright）、dashboard `augur-poc`。

---

## M-1 rules 端點降級：四種失敗形狀（A2-3，2026-09-21）

`/api/prometheus/grafana/api/v1/rules` **無官方穩定性保證**，失敗是預期內的一種結果。
量的是：四種失敗形狀下 panel 是否仍播泛用句、有沒有未捕捉例外。

### 先講一個量測上的坑

第一次攔截用的是 `**/api/prometheus/grafana/api/v1/rules*`，**結果整組作廢** ——
**Grafana 自己也打這個端點**（它靠它決定 `hasAlertRules`）。全攔之後連 `alertState`
都斷了，chip 四種情況全是 `—`，而 console 裡那兩個
`TypeError: Cannot read properties of undefined (reading 'groups') at transformResponse`
來自 **Grafana 自己的程式**，不是我們的。

分辨方式：**只有 `fetchPanelRules` 會帶 `panel_id`**。收窄成
`url.searchParams.has('panel_id')` 之後量測才成立。

> 這個坑會重複出現在任何「攔 Grafana API 測降級」的實驗裡，值得記住。

### 結果（收窄攔截後）

| 形狀 | chip | feed 有播報 | 含規則細節 | 未捕捉例外 |
|---|---|---|---|---|
| `404` + JSON | `alerting` | ✅ | ❌（泛用句） | 無（只有瀏覽器的 `Failed to load resource` 網路日誌） |
| `401` + JSON | `alerting` | ✅ | ❌（泛用句） | 同上 |
| `200` + 空 body | `alerting` | ✅ | ❌（泛用句） | **零** |
| `200` + HTML 登入頁 | `alerting` | ✅ | ❌（泛用句） | **零** |

**四種都正確降級**：panel 照常播報，只是少了 severity / summary / value 的細節。

### `getBackendSrv().get()` 是 reject 還是 resolve？

計畫要求特別記錄這一題，因為「reject 走 catch」與「resolve 一個怪物件讓
`parseRulesResponse` 回空陣列」在**可見行為上完全相同**，但成因不同。

從 panel 的行為**分辨不出來**，所以改量底下那個原語（`fetch` + `.json()`，
也就是 `getBackendSrv().get()` 實際會做的兩步）：

| 形狀 | 結果 | 在哪一步 |
|---|---|---|
| `404` / `401` | **reject** | HTTP 非 2xx |
| `200` + 空 body | **reject** | `.json()` → `SyntaxError: Unexpected end of JSON input` |
| `200` + HTML 登入頁 | **reject** | `.json()` → `SyntaxError: Unexpected token '<'` |
| `200` + 合法 JSON 但形狀不對（`{"foo":1}`） | **resolve** | `.json()` 成功，回一個 `parseRulesResponse` 看不懂的物件 |

**⚠️ 這更正了計畫的前提。** 計畫擔心的是「HTML 登入頁會 resolve 一個怪物件」——
**不會，它跟 404 一樣 reject**。真正會走 resolve 那條路的是
**合法 JSON 但形狀不對**，而那正是「端點改版」會長的樣子。

**實務意涵**：
1. 四種失敗形狀有三種走 `panelAlerts.ts` 的 `catch`，一種（改版）走
   `parseRulesResponse` 回空陣列。兩條路的結果相同**是設計而非巧合**，
   但它們是兩條路 —— 若日後讓 `parseRulesResponse` 對非預期形狀丟例外，
   改版那條會變成未捕捉例外。
2. 瀏覽器對 404/401 一定會印一行 `Failed to load resource`。
   那是網路層日誌不是未捕捉例外，**不要把它當成 bug 去修**。

### 怎麼複驗

```bash
docker compose -f monitoring/docker-compose.yml up -d
npm run build
node .sprite-check/a2-3-degrade.mjs     # 四種形狀的 panel 行為
node .sprite-check/a2-3-primitive.mjs   # reject vs resolve 的原語量測
```

（兩支 harness 放在 gitignore 的 `.sprite-check/` 下 —— 它們是一次性的量測工具，
不是要維護的產品碼。要重跑的話本節的描述足以重建。）

---

## M-2 跨格滲色：Firefox 會滲，但 SP-2.1 的透明帶擋得住（A2-4，2026-09-21）

SP-1.18 的零滲色結論只在 chromium 上量過，§11 第 2 條把 Firefox / WebKit 列為未驗。
這次補量。條件照 SP-1.18：dpr ∈ {1,2} × 元素邊長 ∈ {480, 240, 148.73, 97.31, 61.4, 40} ×
座標 {整數 100px, 非整數 100.37px} = **24 組**，外加 `background-size: 299%` 對照組。

**測試圖**：3×3，中央格全透明、其餘八格飽和紅。顯示中央格，畫面上任何紅色像素都只可能
來自隔壁格。引擎版本**實跑當下**：chromium `153.0.8010.12`、firefox `155.0`。

⚠️ **「紅色像素」的判定是 `R > 8 且 R > G+8 且 R > B+8`，這個門檻必須寫出來**，
否則複驗的人會得到不同的數字而無法判斷是引擎變了還是量測變了。
取 8 的理由：底色是黑，抗鋸齒產生的極暗殘留（R ≤ 8）在任何主題上都看不見，
把它算成污染會讓對照組與實驗組都失去分辨力。**下面所有「歸零」都是在 R > 8 的判定下**；
若改用 R > 0，`b = 2` 那一列會有少量 R ≤ 4 的殘留。

### 先講兩個讓第一版作廢的坑

1. **`file://` 載不進 `setContent` 的頁面。** 那個頁面的 origin 是 `about:blank`，
   載 `file://` 會被擋，而且**是靜默的** —— 圖沒進來，元素全透明，
   實驗組與對照組**都**量到 0 污染，看起來像「三個引擎都沒問題」。改用 data URI。
2. **對照組是唯一抓得到第 1 點的東西。** 規格要求「299% 必須產生污染，否則量測作廢」——
   第一版的對照組是 0，依規則整組丟掉重做。沒有這條規則，那份假的全綠會被寫進規格。

修正後的健全性檢查：顯示全紅的格 0 → 兩個引擎都量到 **57600/57600 px 全紅**。

### 結果

| 引擎 | 對照組 299%（必須有污染） | 實驗組 300%（規格宣稱 0） |
|---|---|---|
| chromium 153.0.8010.12 | 24/24 組有污染，合計 37,014 px | **24 組全部為 0** |
| firefox 155.0 | 24/24 組有污染，合計 44,154 px | **18/24 組有污染**，合計 8,073 px，最強 R=227 |
| webkit | **未量到** —— 見下 |

Firefox 乾淨的 6 組是大尺寸（480px 在兩個 dpr、240px 在 dpr 2）；
會滲的是**縮得比較小**的那些。這與「Chromium 把取樣核箝制在來源矩形內、Firefox 不箝制」
的解釋一致 —— 縮放比越小，取樣核伸得越遠。

### ⚠️ 所以 SP-2.1 的 `0.020·S` 透明帶夠不夠？**夠，而且多了 5 倍。**

上面的測試圖**沒有**透明帶（紅色一路畫到格邊）。真實素材每格外緣有
`0.020·S`（S=512 時 10.24 px）alpha 嚴格為 0 的帶。所以直接掃它：
同一張圖、每格外緣 `b` 個來源像素設為 alpha=0，跑 Firefox 滲色最嚴重的四組條件。

| 透明帶 `b`（來源像素） | dpr1/40 | dpr1/240 | dpr2/97.31 | dpr2/148.73 |
|---|---|---|---|---|
| 0 | 156 px (R33) | 956 px (R27) | 776 px (R227) | 1184 px (R40) |
| **2** | **0** | **0** | **0** | **0** |
| 4 / 6 / 8 / 10 / 12 / 16 | 0 | 0 | 0 | 0 |

**2 個來源像素就歸零。** SP-2.1 訂的 10.24 px 是它的 5 倍。

**結論**：Firefox 的取樣核確實會跨格，但伸出的距離小於 2 個來源像素，
而 SP-2.1 的透明帶本來就是為這件事設的保險 —— 它從「假設有效」變成「量過有效」。
**不需要改規格的任何數值。**

### WebKit 仍未量到（誠實記）

`npx playwright install firefox webkit` 已裝好 `webkit-2359` 的執行檔，
但啟動時缺一整批**系統層**函式庫：`libgtk-4.so.1`、`libgraphene-1.0.so.0`、
`libxslt.so.1`、`libevent-2.1.so.7`、`libopus.so.0`、一整組 `libgst*`、`libflite*` 等。
補齊需要 `sudo npx playwright install-deps webkit`（會動系統套件），**未執行**。

Firefox 的結果讓這件事的急迫性降低：既然 2 px 透明帶就能擋住一個**不箝制取樣核**的引擎，
WebKit 需要超過 10.24 px 才會出事的機率很低。但**這是推論不是量測**，別寫成已驗。

### 怎麼複驗

⚠️ **這兩支腳本不在版控裡，下面的指令現在會 `MODULE_NOT_FOUND`。**
它們當初寫在 `.sprite-check/`，而那個目錄是 gitignore 的，從未 commit。
要複驗得先照下面的描述重建 harness（我就是這樣做的，花了一輪 playwright + PIL）。

```bash
# 以下是**當初的**指令，保留作為 harness 應該做什麼的描述，不是可以直接跑的東西：
node .sprite-check/a2-4-bleed.mjs     # 24 組 × 2 引擎 × 實驗/對照 + 健全性檢查
node .sprite-check/a2-4-margin.mjs    # 透明帶寬度掃描
# 兩者都用 PIL 數紅色像素（一次性外部裁判，不是 repo 依賴）
```

**重建要點**（兩個坑我都踩過）：
- 用 `page.setContent()` 的頁面**載不進 `file://` 圖片**，會靜默失敗。要走 HTTP。
  當初是對照組讀到 299% 才發現的。
- 不要攔截 Grafana 自己的 rules 請求去做假資料，那會讓所有 chip 變成 `—`。

---

## M-3 pending 轉換逐秒觀察（A2-2，2026-09-21）

對 `PocFlapping`（`minute() % 2`、`for: 20s`，完整週期 **2 分鐘**）逐秒記錄
A1-2 的 `alertState` chip 與 emotion。兩輪：**420 秒（3.5 個週期）** 與 **280 秒（2.3 個週期）**。

觀測到的週期是穩定的：`ok`（約 60s）→ `pending`（20–30s）→ `alerting`（30–40s）→ `ok`。

### (a) pending 是否真以 `'pending'` 抵達 panel？**是。**

420 秒那輪：`ok` 223 次、`alerting` 127 次、**`pending` 70 次**。
`alertState` 的黏著性**沒有**把 pending 蓋成殘留的 `alerting` ——
它是真的以 `'pending'` 抵達，`REACHABLE_STATES` 的三態實測全部可達。

### (b) 回落時是否殘留舊值？**沒有，但那個轉換沒被跑到。**

逐秒序列裡每一次狀態變動都是乾淨的，沒有任何一秒停在舊值。
**但 `alerting → pending` 這個轉換在這條規則的生命週期裡不存在** ——
它走的是 `ok → pending → alerting → ok`。原問題設想的情境沒有被這次量測覆蓋，
要驗它需要一條會從 firing 直接回落到 pending 的規則。**不要把這條寫成已驗。**

### (c) resolved 是否準時播且只播一次？**沒有乾淨量到。**

每次 `alerting → ok` 的同一秒 emotion 就變成 `resolved`，兩輪各兩次、沒有重複，
與「一次轉換一則」一致。**但這不是直接證據**：

- headless chromium **沒有安裝任何語音**，`speechSynthesis` 的 `onEnd` 不會觸發，
  所以佇列計數從 `0→1` 之後就停在 1，量不出「播完了幾則」。
- 抽 feed 行的選擇器兩版都抓到 panel 整塊文字而非單行播報，計數不可信。

要乾淨回答這題，得在**有語音的環境**（Windows/Chrome）跑，或改用 `enableTTS: false`
＋直接計 feed 的 DOM 節點數。列為未完成。

### 🔴 順帶浮出一個設計問題：情緒衰減比告警週期長

280 秒那輪裡，**emotion 只有最初 66 秒是 `calm`**，之後再也沒回去過。原因是兩個計時器沒對上：

| 計時器 | 值 | 出處 |
|---|---|---|
| 情緒衰減回 calm | **3 分鐘** | `MascotPanel.tsx` 的 `EMOTION_DECAY_MS` |
| PocFlapping 的完整週期 | **2 分鐘** | `rules-poc.yml` |

而 pending 反應的顯示條件是 **`emotion === 'calm'` 且未播報**
（`AvatarController.setReaction` 的契約、SP-4.9）。兩者相乘的結果是：

> **在會翻轉的告警上，pending 表情只會在第一個週期出現，之後永遠被 `resolved` 壓著。**

逐秒證據：`ok → pending` 發生在 t=46（emotion `calm` → **會顯示**）、
t=156 與 t=276（emotion 皆為 `resolved` → **不會顯示**）。

**這不是程式錯誤** —— 程式完全照契約做。是兩個各自合理的數字放在一起才產生的後果，
而先前沒有人把它們放在一起看過。三條可能的處置：

1. **接受**。理由：真實告警不會每兩分鐘翻轉一次；`PocFlapping` 是刻意造出來的病態情境。
2. **縮短情緒衰減**（例如 90 秒）。代價是一則 critical 播完後臉回 calm 得更快。
3. **放寬 pending 的顯示條件**，改成「非 critical 時也可顯示」。
   代價是 SP-4.9 原本要避免的「pending 跟 critical 搶臉」會部分回來。

**建議 1（接受）並把這段記著**，理由是這個情境需要 <3 分鐘的告警翻轉週期才會出現，
而那種規則本身就該被修。但這是判斷不是裁定 —— 若日後 B2 的素材做好、
pending 那一格畫了卻幾乎看不到，回來看這一節。

### 怎麼複驗

⚠️ **同上，這支也不在版控裡**（`.sprite-check/` 是 gitignore 的），現在跑會 `MODULE_NOT_FOUND`。
保留作為 harness 應該產出什麼的描述。

```bash
node .sprite-check/a2-2-observe.mjs 420 .sprite-check/a2-2-trace.tsv
# 逐秒 TSV：t / wallclock / chip / emotion / feed / panel1_chip
```
