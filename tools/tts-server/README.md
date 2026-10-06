# tts-server：吉祥物的聲音

Augur 面板的「外部語音服務網址」要填一個語音服務。這個目錄是它的參考實作：
一個年輕男生的聲音，模型是阿里巴巴 Qwen 團隊的 [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)（Apache-2.0）。
設計理由見 [ADR-005](../../docs/adr/ADR-005-optional-external-tts.md)。

服務對外是 OpenAI 相容的 `POST /v1/audio/speech`。面板不綁這個實作，任何相容的服務都能填。

> 2026-10-06 之前這裡用的是 BreezyVoice 加變聲做出來的童聲；試聽時都被聽成女生，已撤換（ADR-005〈撤換紀錄〉）。

## 聲音怎麼來的

- 聲音由 Qwen3-TTS **VoiceDesign** 依一段文字描述直接生成（「二十出頭的年輕男生，聲音溫和明亮，說標準普通話」），
  **不變聲、不使用任何真人錄音**。
- 服務啟動時用 Qwen3-TTS **Base** 記住這段聲音，之後每一句都照它念，聲線才不會每句不一樣。
- 送進模型前，服務會把文字轉成簡體（OpenCC）：繁體輸入時模型常念成廣東話。**只在模型入口轉**，面板上看到的、告警內容都還是繁體。
- 口音是標準普通話，不是台灣腔。

## 需要什麼

- 一台有 NVIDIA GPU 的 Linux 機器（或 WSL2）。實測 RTX 4070（12 GB），服務用掉約 4.6 GB 顯存。
- conda（或任何能建 Python 3.12 環境的工具）。
- 約 11 GB 磁碟：Python 環境約 6.5 GB，模型約 4.3 GB（第一次啟動時從 Hugging Face 下載）。
  要重新生成聲音的話，另需 VoiceDesign 模型約 4 GB。

repo 裡只有我們寫的程式。模型權重和參考音都不進 repo。

## 安裝

```bash
conda create -y -n qwen3tts python=3.12
conda activate qwen3tts
export PYTHONNOUSERSITE=1   # 避免 ~/.local 裡的套件蓋過環境裡的版本
pip install qwen-tts==0.1.1 opencc-python-reimplemented fastapi "uvicorn[standard]" soundfile   # qwen-tts 釘版本：失控判定依賴它的內部行為，升版要重跑 eval/runaway_check.py
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"   # 最後要是 True
```

`qwen-tts` 會裝上新版的 torch，請用獨立的環境，不要和其他專案共用。啟動時出現「SoX could not be found」的警告可以忽略。

## 準備聲音

```bash
conda activate qwen3tts && export PYTHONNOUSERSITE=1
python tools/tts-server/make_voice.py --from <選定的那一段.wav>   # 沿用已經試聽選定的聲音
python tools/tts-server/make_voice.py                            # 或重新生成（每次生成的聲音會略有不同，請試聽）
# 寫入 tools/tts-server/voices/young_male.wav 與 young_male.txt（voices/ 已列入 .gitignore）
```

## 啟動

```bash
conda activate qwen3tts && export PYTHONNOUSERSITE=1
python tools/tts-server/server.py
# [augur-tts] 暖機…
# [augur-tts] 就緒。允許的 origin：[...]
# Uvicorn running on http://0.0.0.0:8765
```

啟動約需 1–1.5 分鐘（載入模型約 1 分鐘，再暖機一次 —— 不暖機的話，第一則告警要等 30 秒以上）。
之後在 panel 選項「外部語音服務網址」填 `http://<這台機器>:8765`，按「試聽」。面板上的聲線標籤會顯示「外部語音（主機:埠）」。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `AUGUR_TTS_ALLOW_ORIGINS` | localhost／127.0.0.1 的 3000 與 3002 | 允許的 Grafana 網址，逗號分隔。**要寫成瀏覽器網址列上的樣子**：`localhost` 與 `127.0.0.1` 是不同的 origin |
| `AUGUR_TTS_PORT` | 8765 | 8080–8099 常被 `kubectl port-forward` 等工具占用，所以避開 |
| `AUGUR_TTS_HOST` | 0.0.0.0 | |
| `AUGUR_TTS_CACHE` | 512 | 片段快取筆數，0 = 不快取 |
| `AUGUR_TTS_MAX_SEC_PER_UNIT` | 0.45 | 失控上限：每個字最多念幾秒（另加 1 秒；正常約 0.21–0.25），見下方〈念錯與失控〉 |
| `AUGUR_TTS_MODEL` | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 模型。只能換 12Hz 的 Base（失控上限的 frame 長度寫死在 12Hz）；換 0.6B 實測沒有比較快 |
| `AUGUR_TTS_REFERENCE` | `voices/young_male.wav` | 參考音；逐字稿預設是同名的 `.txt` |
| `AUGUR_TTS_SSL_CERTFILE`／`AUGUR_TTS_SSL_KEYFILE` | （空） | 兩個都給就走 https。Grafana 走 https 時語音服務也要 https，見下方〈Grafana 走 https〉 |

## 會遇到的延遲

這個模型**產語音比念出來慢**：念 1 秒要算約 1.5–2 秒（瓶頸在逐步生成的程式開銷，不在 GPU）。
面板把一則告警切成短句、逐句來要，第一句回來就開始播；伺服器會記住念過的片段。所以：

- **某種告警第一次出現**：開口前要等 5–10 秒（兩輪實測 p50 4.9、9.6 秒；最慢 17 秒，多半是逐位念 IP 的那段），
  而且**句子之間常會停頓**（一則加總最長約 11 秒），因為後面的句子還在產。
- **同一種告警再出現**（只有數值不同）：立刻開口。只有數值那一段要現產，一則的停頓加總最長約 12 秒。
- 輪到某一段時，若等超過 panel 選項「外部語音逾時」（預設 30 秒，從輪到這一段時起算），
  從這一段起改用瀏覽器聲線念完這則。下一則會再試外部服務。

快取存在記憶體，重啟服務後歸零。同一段同時有好幾個請求（例如好幾個人開著同一個 dashboard）時只算一次。

**面板的「語速」對這個服務沒有作用**：模型沒有語速參數，事後變速會有金屬聲。

**這個服務沒有驗證機制**，預設綁 `0.0.0.0`。CORS 只擋得住瀏覽器，擋不住其他程式直接呼叫。
請放在可信的網段，或用 `AUGUR_TTS_HOST=127.0.0.1` 只開給本機、前面再放反向代理。

## 念錯與失控

試聽前先知道：

- 抽查（4 句各 3 次，跑了兩次）：數字都念對（「91.35」3/3）、英文摘要都完整念出、「warning」3 次對 2 次。
- **失控**：這類模型偶爾會停不下來。服務以字數算每段最多能念多久（每字 0.45 秒＋1 秒，正常約 0.21–0.25），
  超過就截斷、回 502，面板把那則剩下的部分改用瀏覽器聲線念。失控的音訊不會被放出來。
  整段念兩遍會被擋；只多念一個詞、重複一小段這類輕微失控擋不住，會照樣播出，而且會被快取住，直到服務重啟。抽查 24 次沒有發生。
- 面板語言設成 English（整句英文）時沒有測過。

## 自己驗證

不需要 GPU 的那部分（分段、單位、失控上限的算術）有單元測試，提交閘與 CI 都會跑：`python3 tools/tts-server/test_textsplit.py`。
需要模型的部分是下面這幾支，手動執行。

`eval/` 裡的腳本會把結果寫到 `~/.cache/augur-tts-eval/`：

| 腳本 | 驗什麼 | 怎麼跑 |
|---|---|---|
| `runaway_check.py` | 失控上限：碰到上限會回 502、不寫進快取 | `qwen3tts` 環境裡 `python tools/tts-server/eval/runaway_check.py`（另需 `pip install openai-whisper librosa` 才能跑 `quality.py`） |
| `quality.py` | 念 4 句典型告警各 3 次，用 Whisper 轉回文字抽查（Whisper 本身也會聽錯，結果只是線索） | 同上 |
| `latency.py` | 模擬面板逐句要音訊，量冷／熱的開口等待與停頓 | 服務跑起來後 `python3 tools/tts-server/eval/latency.py http://127.0.0.1:8765` |
| `browser-poc.mjs` | 在真的 Grafana 上用無頭瀏覽器按「試聽」：跨來源、播放、嘴型、各種失敗時的降級 | `GRAFANA_URL=… TTS_URL=… node tools/tts-server/eval/browser-poc.mjs`（會建一個暫時 dashboard、跑完刪掉） |

## Grafana 走 https

瀏覽器不讓 https 頁面呼叫 http 服務（混合內容），所以 Grafana 走 https 時，語音服務也要走 https：

```bash
AUGUR_TTS_SSL_CERTFILE=/path/cert.pem AUGUR_TTS_SSL_KEYFILE=/path/key.pem python tools/tts-server/server.py
```

憑證要是瀏覽器信任的，並且 `AUGUR_TTS_ALLOW_ORIGINS` 要寫 `https://` 開頭的 Grafana 網址。
（2026-10-06 實測 Chromium：http 服務用主機名稱會被擋；用 `192.168.x.x` 這種區網 IP 只會警告、照樣能播，
但那是瀏覽器對區網位址的放寬，不保證每個瀏覽器、每個版本都這樣。）

## 連不上的時候

面板的聲線標籤會寫明原因：「外部語音失敗：…，已降級」。

| 標籤上的原因 | 通常是 |
|---|---|
| `Failed to fetch` | 服務沒開、埠不對、**CORS 擋下**（`AUGUR_TTS_ALLOW_ORIGINS` 沒有你的 Grafana 網址），或 Grafana 走 https 而服務是 http（混合內容） |
| `HTTP 502` | 模型失控、已截斷（見〈念錯與失控〉）。偶爾發生是正常的 |
| `HTTP 4xx／其他 5xx` | 服務端錯誤，看伺服器的輸出 |
| `timeout` | 這一段超過逾時。第一次念某種告警時偶爾會發生 |
| `autoplay-blocked` | 瀏覽器擋自動播放。點一下 panel 上的「啟用語音」 |

Grafana 若啟用了 CSP（`content_security_policy = true`，預設關閉），要在模板的 `connect-src`
加上這個服務的網址，否則一律 `Failed to fetch`。
