<!-- ADR-005 | Status: FIRM -->
# ADR-005：選填的外部語音服務（OpenAI 相容 TTS），Web Speech 保留為預設與降級

| 欄位 | 值 |
|------|----|
| **狀態** | `FIRM` |
| **日期** | 2026-10-05 |
| **決策者** | astroicers |

> **狀態說明**：`Draft`（**禁止實作生產代碼**）→ `FIRM`（POC 驗證）→ `Accepted`（人類審核放行）。**AI 不可自行升級狀態**（ASP 鐵則）。
> 本 ADR **修訂 ADR-004 決策 4**（語音），不 supersede ADR-004 其餘部分。

> ⬆️ **由 `Draft` 升 `FIRM`（2026-10-05）**：astroicers 授權（`/asp:approve-adr` 流程，於對話中回覆）。
> 看過的摘要項目：決策條目 7、Verification Evidence 在（外部事實查證 6 列 + 本機實測 4 列）、
> **本次升級涉及的決策已回填 POC 機械證據 0 項**、無 `roadmap-ref`（repo 既有慣例）、
> diff 範圍為本檔首次提交；缺項清單：**5 個 POC gate（G-ADR005-1～5）全數未跑**、
> 本 repo 無 `.asp/gate.sh`，`adr-draft`／`adr-index` 機械驗證跑不了。
> 回覆逐字：**「升firm」**（同一則回覆另選男童聲「輕」檔，見決策 7）。
> 升 FIRM 而非 Accepted：理由同 ADR-004 —— FIRM 已解除「Draft 禁止實作」，POC gate 要等程式寫出來才跑得動，
> 「POC 未跑」誠實留在檔上。**人類顯式授權，非 AI 自行升級**（ASP 鐵則）。

## 痛點 / 需求

吉祥物是藍鯨男孩，使用者要的是**小男孩的聲音、台灣口音**。ADR-004 決策 4 選了 Web Speech，
聲線由作業系統提供。2026-10-05 實測走到了它的天花板：

- PR #16 加了音高／語速選項。使用者回報「聲音變高了，但我要小朋友的聲線」。
  Web Speech 只能調音高，聽起來是調高的大人，不是小孩：童聲的關鍵在**共振峰**（聲道短），
  `SpeechSynthesisUtterance` 沒有這個參數。
- Windows 內建台灣中文聲線只有三個：Zhiwei（男）、Yating、Hanhan（女），沒有童聲。
- 使用者另外要求「盡量不要有中國大陸的口音」，這排除了大多數開源中文 TTS（見 Verification Evidence）。

ADR-004 決策 4 寫明了 Web Speech 是「**形態決定選型，不是重新評估後認為 Web Speech 變好了**」，
並在介面上預留了 `setMouthOpen?`：「未來若有拿得到 audio buffer 的 TTS，振幅 lip-sync 只要實作這個成員就能回來」。
本 ADR 就是那個「未來」。

## 決策

**面板新增一個選填欄位「外部語音服務網址」。留空 = 現狀（Web Speech）；填了 = 對該網址發
OpenAI 相容的 `POST /v1/audio/speech`，播放回傳的音訊。任何一則失敗都降級回 Web Speech。
plugin 本身仍是零後端。**

### 1. plugin 仍零後端；語音服務是使用者自備的選填依賴
ADR-004「零後端」的意思是 **plugin 不帶後端元件**（沒有 Go backend、不要求 Grafana 端安裝東西）。
本 ADR 不改這點：瀏覽器直接呼叫使用者填的網址，plugin 不代理、不打包任何伺服器。
欄位預設空白，**沒填的人行為與今天完全相同**。

### 2. 介面契約：OpenAI 相容 `POST {base}/v1/audio/speech`
請求 `{"model": "tts-1", "input": <文字>, "voice": <選填>, "speed": <語速>}`，回應為音訊
（`AudioContext.decodeAudioData` 解得開的格式，wav/mp3 皆可）。選這個契約而非自訂，是因為它已是事實標準：
BreezyVoice 自帶的 `api.py` 就是這個介面，其他本地 TTS（GPT-SoVITS、Kokoro 等的社群包裝）多半也有。
**plugin 不綁特定模型**，換模型不動 plugin。

### 3. 失敗即降級，逐則判斷
- 連線失敗、非 2xx、逾時（預設 **15 秒**，可調）→ **該則**改用 Web Speech 念，佇列繼續。
- 不做「連續失敗 N 次就關閉」的熔斷：告警稀疏，熔斷的狀態反而會讓服務恢復後還在念機器人聲。
- 面板的聲線標籤（PR #16 的 `voice-chip`）要顯示實際用的是哪一條路，降級時看得出來。
- 逾時取 15 秒的依據：本機實測（RTX 4070）一般 3–8 秒，曾出現單句 32 秒的離群值。
  15 秒是「寧可降級也不要讓告警晚半分鐘」的取捨。

> 🔬 **2026-10-05 POC 實測修訂（G-ADR005-4）**：原文假設「一則一個請求」。用真實格式的告警句
> （`偵測到告警：<規則名>，嚴重度 …，受影響對象 …，目前數值 …，<英文摘要>。`，53–118 字）實測，
> 整則一個請求時 10 則裡有 4 則超過 40 秒、一則逾時 120 秒，顯存被撐到 11.9／12 GB。
> 服務產語音的時間約等於語音長度（語言模型 ~90 token/s、50 token = 1 秒），而一則告警念出來 10–25 秒 ——
> **整則要完才播，就是整則的時間都在空等**。因此改為：
> - **client 逐句要**（`remoteSpeaker.ts` 的 `splitClauses`：在 `，：；。！？` 後切、不足 8 字併入下一段），
>   第一句回來就播，播的同時預取下一句（同一則的下一句，或下一則的第一句；只預取一句，服務是單 GPU 且推論加鎖）。
> - **逾時改為逐句，且從輪到那一句時才起算**：預取的句子在服務端要先等前一句的推論鎖，那段排隊時間
>   不算（2026-10-05 複審 F2：原實作從送出請求就計時，冷啟動時「服務不慢、只是在排隊」的句子會被誤判逾時）。
>   某一句失敗時，**已念過的不重念**，從那一句起整則交給 Web Speech；下一則再試外部服務。
> - 伺服器端同樣在逗號分段、每段修頭尾靜音，並以片段文字為鍵快取成品（決策 6）。

### 4. 不收金鑰
panel 選項存在 dashboard JSON，**看得到 dashboard 的人就看得到選項**。panel plugin 沒有
`secureJsonData`（那是 data source／app plugin 才有的）。因此**不提供 API key 欄位**；
語音服務應放在可信網段、不需金鑰。需要金鑰的雲端 TTS 不在本 ADR 範圍。

### 5. 振幅 lip-sync 接回 `setMouthOpen?`
外部服務回傳的是音訊：`fetch` 取 ArrayBuffer → `AudioContext.decodeAudioData` → `AudioBufferSourceNode` 播放，
逐幀呼叫 `AvatarController.setMouthOpen(open)`。介面不改（ADR-004 決策 5 已預留）。

> 🔬 **2026-10-05 實作修訂**：原文寫 `AnalyserNode` 即時算 RMS。實作改為**解碼後從整段 AudioBuffer 算包絡**
> （`mouthEnvelope`），播放時以 `currentTime` 查表。理由：同一個服務的兩段輸出音量差到 3 倍
> （RMS p90 0.162 vs 0.048），固定門檻必有一段整句閉嘴或整句全開；整段在手上就能以**這一段自己的** p90
> 為基準（< 0.2 閉、< 0.7 半開、其餘全開），而且是純函式、單元測試測得到。每格至少停 80ms 防閃爍。
**播放一律走 Web Audio，不用 `<audio>` + blob 網址**：Grafana 的 CSP 模板含 `media-src 'none'`
（見待驗風險 1），走 `<audio>` 會在啟用 CSP 的站台被擋；Web Audio 只受 `connect-src` 管。
Web Speech 路徑維持 boundary 事件驅動的嘴型。

### 6. 參考伺服器：BreezyVoice + 參考音特徵快取，放 `tools/tts-server/`
- 模型：**BreezyVoice**（聯發科研究院，台灣華語，Apache-2.0）。
- 上游 `api.py` 每則請求都重算參考音特徵，實測佔每句 20 秒中的 13–14 秒；
  參考伺服器在啟動時算一次並快取，另加 CORS（允許 Grafana 的 origin）。
- （2026-10-05 POC 後補）在逗號也分段、每段修頭尾靜音（實測一句 10.6 秒裡只有 6.1 秒有聲音），
  並以**片段文字為鍵快取成品**（LRU 512 筆）。告警句的片段大多會重複 ——「偵測到告警：<規則名>，」
  「嚴重度 warning，」與規則摘要每次觸發都一字不差，變的只有數值那段。
- 預設允許的 origin 涵蓋 Grafana 預設埠 3000 與本 repo 開發環境的 3002（localhost 與 127.0.0.1 各一）。
- **repo 只放我們寫的包裝程式與說明**：不放模型權重、不放參考音檔。
  參考音由腳本重現（見決策 7）。

### 7. 童聲參考音一律合成，不使用真人兒童錄音
聲線由「參考錄音」決定。**不取用任何真實兒童的錄音**（未成年人的聲音複製有倫理與同意問題，
即使資料集授權寬鬆也一樣）。做法：
1. 以 BreezyVoice 內建聲紋「中文男」產一段成人男聲（台灣華語的 LLM，F0 約 85 Hz）。
2. 以 Praat 的 Change gender（共振峰 ×1.25–1.35、F0 中位數 220–280 Hz）推成男童。
3. 以此當參考音做 zero-shot。

**使用者選定的強度（2026-10-05 試聽後）**：「輕」檔 —— 共振峰 ×1.25、F0 中位數 220 Hz
（複製後實測輸出 F0 約 218 Hz）。另兩檔（×1.30／250 Hz、×1.35／280 Hz）未採用。

> 🔬 **2026-10-05 POC 後補：語速與種子。** zero-shot 會把參考音的語速學走，而產語音的時間與語音長度成正比 ——
> **念得慢就是產得慢**。試聽版的參考音約 4.0 字/秒，輸出只有 2.6–4.4 字/秒（一般口語約 5 字/秒）；
> 把參考音壓到 5.0 字/秒時輸出 6.4 字/秒、生成時間少 32%。`make_reference.py` 因此改以**目標語速**
> （`--rate`，預設 4.6 字/秒）推算時長倍率，並固定成人男聲那一步的種子（`--seed`，預設 1：掃 0–7 時
> 「中文男」念這段 2.8–4.0 字/秒，種子 1 最快、只需壓 0.87 倍，其他種子要壓到 0.61–0.77）。
> 音色參數（共振峰、F0）不變；**語速是使用者試聽之後才改的，需再試聽確認**。
產生腳本進 repo，產物不進 repo。Praat 的 Python 綁定 Parselmouth 是 GPL-3.0，
只在本機產參考音時使用，不進 plugin、不散布。

## 接受的代價

- **要一台有 GPU 的機器常駐語音服務**（實測 RTX 4070、逐句合成時約 3.6 GB 顯存）。沒有 GPU 時 BreezyVoice 可跑 CPU，但未實測速度。
- **延遲**（G-ADR005-4 實測）：某種告警**第一次**出現時，開口要等 p50 5.7 秒、最慢 8.9 秒，句間偶有卡頓
  （最長 11.8 秒），單一片段偶爾超過 15 秒 → 那則後半段改由 Web Speech 念。**同一種告警再次出現**時
  （數值不同）開口 0 秒、卡頓最長 1.7 秒。快取在伺服器記憶體，重啟後歸零。
- **瀏覽器端限制**（見待驗風險）：CORS、混合內容、Grafana CSP、autoplay。
- 自迴歸模型偶爾多念或多一個語氣詞（實測一則開頭多了「嗯？」）。

## 不採用的選項

| 選項 | 不採用的理由 |
|---|---|
| 只靠 Web Speech 調音高 | 已實測，使用者否決（調高的大人，不是小孩） |
| 瀏覽器內 WASM TTS（sherpa-onnx） | 授權 OK，但找不到台灣口音或童聲的中文模型；能保零後端是它唯一優勢 |
| Spark-TTS（可直接調性別、音高） | 權重改為 CC BY-NC-SA（非商用），且非台灣口音 |
| CosyVoice、Kokoro 中文聲線 | 中國大陸口音（使用者排除） |
| 火山引擎「少年梓辛」「灣灣小何」（小智 AI 用的聲線） | 雲端付費 API、無模型可下載、需金鑰（違反決策 4） |
| 預錄固定句子 | 告警內容是動態的（規則名、數值），只能涵蓋自我介紹之類的固定句 |
| Grafana data source proxy 轉發 | panel plugin 不能單獨用 proxy，要另做 data source plugin，與「零後端」衝突 |

## Verification Evidence

### 外部事實查證
完整查證列在 `.asp-fact-check.md` 的〈童聲／台灣口音開源 TTS 候選（2026-10-05）〉段，摘要：

| 事實 | 來源 | 結果 |
|---|---|---|
| BreezyVoice 授權、台灣華語、OpenAI 相容 API | `gh api repos/mtkresearch/BreezyVoice`、HF model card、arXiv 2501.17790 | Apache-2.0；`api.py` 提供 `/v1/audio/speech` |
| Spark-TTS 權重授權 | HF `SparkAudio/Spark-TTS-0.5B` | CC BY-NC-SA |
| GPT-SoVITS 授權 | GitHub、HF `lj1995/GPT-SoVITS` | MIT（程式與權重） |
| 小智 AI 聲線來源 | `xinnan-tech/xiaozhi-esp32-server` 的 `config.yaml` | 熱門聲線為火山引擎雲端 API |
| Parselmouth 授權 | `gh api repos/YannickJadoul/Parselmouth` | GPL-3.0 |
| Grafana CSP 預設與模板 | `docker exec augur-grafana` 讀 `conf/defaults.ini`（13.2.2） | 預設關閉；模板 `connect-src 'self' grafana.com *.cartocdn.com …`、`media-src 'none'` |

### 本機實測（2026-10-05，RTX 4070，非推理）
| 項目 | 結果 |
|---|---|
| 上游 `api.py` 熱機延遲 | 3 次請求 19.8／22.4／22.7 秒（短句） |
| 分段計時 | g2pw 1.5 秒、參考音特徵 13.4–13.9 秒、模型 5.2–6.8 秒 |
| 快取參考音特徵後 | 3.3–8.4 秒（產 4.3–10.3 秒語音）；一次離群 32 秒 |
| 男童聲 3 檔強度 Whisper 回寫 | 三檔都念對；中檔開頭多一聲「嗯？」 |
| 整則一個請求、真實格式告警句 10 則 | 9.1–111.3 秒，4 則 > 40 秒，1 則逾時 120 秒；顯存 11.9／12 GB |
| 伺服器在逗號分段後、整則一個請求 | p50 15.5、最慢 36.8 秒；顯存 3.6 GB |
| 分段計時（單一片段） | 語言模型 58–95 token/s、聲學模型 0.8–1.0 秒、聲碼器 0.1 秒；fp16 對語言模型無明顯幫助 |
| 參考音語速 4.0 vs 5.0 字/秒（同 6 片段 × 2 種子） | 輸出 4.4 vs 6.4 字/秒；生成 47.6 vs 32.2 秒 |
| 同一片段同時 3 個請求（複審 F3 修正後） | 3 個都 6.2 秒、音訊 md5 相同（只推論一次）；修正前產出兩種不同音訊 |

### POC gate 機械證據（2026-10-05 實跑，非推理）
真 Grafana 13.2.2（`http://127.0.0.1:3002`）＋真語音服務（`tools/tts-server`，`http://127.0.0.1:8090`）＋
無頭 Chromium（Playwright，**預設** autoplay 政策），暫時 dashboard 以 API 建立、跑完刪除。

| Gate | 結果 | 證據 |
|---|---|---|
| G-ADR005-1 跨來源 | ✅ PASS（http） | 從 Grafana 頁面 POST，回 200、`access-control-allow-origin: http://127.0.0.1:3002`（瀏覽器實測）；非允許 origin（`http://evil.example`）的預檢回 400（以 Python urllib 直接送預檢實測，非瀏覽器）。https 混合內容**未測**（本機無 https 的 Grafana），留在待驗風險 2 |
| G-ADR005-2 autoplay | ✅ PASS | 點「試聽」（使用者手勢，內含 `unlock()`）後播放成功、聲線標籤維持「外部語音」，沒有 `autoplay-blocked` |
| G-ADR005-3 降級 | ✅ 標籤與恢復 PASS；「念完、佇列不卡」為單元測試證據 | 瀏覽器（Playwright 攔截模擬）驗的是**聲線標籤**：回 500 →「外部語音失敗：HTTP 500，已降級」；連不上 →「Failed to fetch」；服務 6 秒才回、逾時 3 秒 →「timeout」；服務恢復後下一則回到「外部語音」（無熔斷）。無頭 Chromium 沒有聲線，Web Speech 是否真的念出來、佇列是否繼續，由 `remoteSpeaker.test.ts` 的降級測試釘住（假 fallback），未在真瀏覽器聽過 |
| G-ADR005-4 延遲分布 | ✅ 已記錄（見上方「接受的代價」） | 30 則（10 種真實格式告警 × 3 輪，數值每輪不同），模擬面板的逐句＋預取：冷 p50 5.7／p95 8.0／最慢 8.9 秒；熱 0.0 秒，句間卡頓最長 1.7 秒；單一片段 > 15 秒 1 次（冷） |
| G-ADR005-5 嘴型 | ✅ 機械 PASS，**目測待使用者** | 試聽期間取樣 286 次，嘴型層在 隱藏／半開／全開 三態間切換 21 次，首次 44ms、最後一次 2.09 秒（≈ 該句長度）。「與聲音同步」需人眼確認。複審修正後重跑 G1／G2／G3／G5 全數維持：切換 23 次、最後一次 2.77 秒（伺服器重啟、快取清空，該句重新合成，長度不同） |

## Follow-up / POC gate（升 Accepted 前必過；結果見上方「POC gate 機械證據」）

- **G-ADR005-1 跨來源呼叫**：從 Grafana 頁面（`http://localhost:3000`）呼叫 `http://<GPU 主機>:<port>`，
  確認 CORS 預檢通過、音訊可播。另記錄 Grafana 走 https 時的混合內容行為。
- **G-ADR005-2 autoplay**：沿用既有「啟用語音」鈕解鎖後，`<audio>`／`AudioContext` 播放不被擋。
- **G-ADR005-3 降級**：服務關掉、回 500、逾時三種情況，該則都改用 Web Speech 念完，佇列不卡。
- **G-ADR005-4 延遲分布**：同一聲線連續 30 則典型告警句，記 p50／p95／最大值。
- **G-ADR005-5 振幅嘴型**：音訊包絡驅動 `setMouthOpen`，嘴型與聲音同步（目測＋錄影）。

## 待驗風險

1. **Grafana CSP**：預設不啟用（`augur-grafana` 13.2.2 容器的 `conf/defaults.ini` 第 542 行
   `content_security_policy = false`，2026-10-05 實查）。啟用後預設模板的 `connect-src` 只有
   `'self' grafana.com *.cartocdn.com` 與 ws，**外部語音服務會被擋**；模板另有 `media-src 'none'`
   （決策 5 改走 Web Audio 的原因）。啟用 CSP 的站台需在模板的 `connect-src` 加上語音服務網址，
   或把語音服務放在同源反向代理後面。只能寫進 README，plugin 管不到。
2. **混合內容**：Grafana 走 https 時，http 的語音服務會被瀏覽器擋。語音服務需同樣走 https 或放同源反向代理。
3. **BreezyVoice 上游維護**：最後推送 2025-06-21，依賴版本舊（torch 2.3.1、ruamel.yaml 需 pin 0.17）。
   實測安裝時踩到三個相依問題，參考伺服器的說明要寫清楚。
4. **聲音由使用者裁定**：「像不像小男孩」沒有機械判準，選哪一檔強度由使用者試聽決定。
5. **中英夾雜**：規則名與摘要多為英文（`WindowsHighCPU`、`Windows host CPU usage is high …`），
   中文模式的播報句其實是中英夾雜。Whisper 回寫抽查念得出來，但「好不好聽」未經使用者確認；
   IP 位址會被逐位念出（`192.168.1.20:9182` 一段就 5 秒以上）。
6. **快取不持久**：片段快取在伺服器記憶體，重啟後每種告警第一次又要冷啟動。
7. **降級時已送出的預取不會讓伺服器停算**（複審 S3）：client 會 abort，但伺服器端已開始的推論停不下來、
   仍持有推論鎖，下一則的第一句可能排在它後面。冷啟動時會不會因此連鎖逾時，未量測。
8. **參考服務沒有驗證**：預設綁 `0.0.0.0`，CORS 只擋瀏覽器。README 已提醒放可信網段或只綁本機。

> **2026-10-05 獨立複審（`/asp:review-work`，唯讀 reality-checker）**：判定 NEEDS_WORK，九項發現全數在本 ADR 範圍內修正 ——
> 播報器重建時 speaking 卡住（F1）、逾時含排隊時間（F2，見決策 3 修訂）、伺服器不合併同時的重複請求（F3）、
> 中途降級時 onStart 發兩次（F4）、測試對世代與錯誤路徑釘不住（F5）、語速對參考服務無效未寫明（F6）、
> CHANGELOG 語意與實作不符（F7）、fallback 回呼與計時器未綁世代（S1、S2）。另修：半形冒號在 `192.168.1.20:9182`
> 這類數字裡會被切開。修正後以變異測試驗證：12 個防護拿掉 11 個會讓測試轉紅，存活的 1 個（finish 內的世代檢查）
> 是等價變異（所有呼叫點上游都已檢查），程式內有註明。
