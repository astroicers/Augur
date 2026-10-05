# tts-server：吉祥物的童聲

Augur 面板的「外部語音服務網址」要填一個語音服務。這個目錄是它的參考實作：
台灣口音的小男孩聲音，模型是聯發科研究院的 [BreezyVoice](https://github.com/mtkresearch/BreezyVoice)（Apache-2.0）。
設計理由見 [ADR-005](../../docs/adr/ADR-005-optional-external-tts.md)。

服務對外是 OpenAI 相容的 `POST /v1/audio/speech`。面板不綁這個實作，任何相容的服務都能填。

## 需要什麼

- 一台有 NVIDIA GPU 的 Linux 機器（或 WSL2）。實測 RTX 4070（12 GB），用掉約 3.6 GB 顯存。
  沒有 GPU 也能跑 CPU，但速度沒測過。
- conda（或任何能建 Python 3.10 環境的工具）。
- 約 11 GB 磁碟：Python 環境約 8 GB，模型約 3 GB（第一次執行時從 Hugging Face 下載）。

repo 裡只有我們寫的兩支程式。模型權重、上游程式和參考音都不進 repo。

## 安裝

上游的依賴版本很舊，照它的 `requirements.txt` 直接裝會踩到三個坑。
下面的順序是 2026-10-05 實際裝過的版本。

```bash
# 1. 上游程式放在 ~/engines/BreezyVoice（別的位置請設 BREEZYVOICE_DIR）
git clone https://github.com/mtkresearch/BreezyVoice.git ~/engines/BreezyVoice
cd ~/engines/BreezyVoice
git checkout d592c9d   # 2025-06-21，實測過的版本

# 2. Python 3.10 環境
conda create -y -n breezyvoice python=3.10
conda activate breezyvoice
export PYTHONNOUSERSITE=1   # 坑 1：~/.local 裡的套件會蓋過環境裡的版本

# 3. 依賴
pip install "setuptools<70" wheel
pip install --no-build-isolation openai-whisper==20231117   # 坑 2：它的建置腳本要 pkg_resources
pip install -r requirements.txt
pip install "ruamel.yaml==0.17.40"   # 坑 3：新版 ruamel.yaml 與 hyperpyyaml 1.2.2 不相容
pip install --force-reinstall --no-deps torch==2.3.1 torchaudio==2.3.1 \
    --index-url https://download.pytorch.org/whl/cu118   # 確保 torch 與 CUDA 函式庫同一套
pip install praat-parselmouth   # 只有 make_reference.py 用到

python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
# 應該印出 2.3.1+cu118 True
```

## 產生參考音

聲線由一段「參考錄音」決定。這裡**不使用任何真人兒童的錄音**，而是：
模型內建的成人男聲（台灣口音）念一段固定的話 → 用 Praat 把共振峰和音高一起推高成小男孩。

```bash
conda activate breezyvoice && export PYTHONNOUSERSITE=1
python tools/tts-server/make_reference.py
# 寫入 tools/tts-server/voices/boy.wav 與 boy.txt（voices/ 已列入 .gitignore）
```

預設參數是 2026-10-05 試聽後選的「輕」檔（共振峰 ×1.25、音高 220 Hz）。
同一張顯卡、同一個種子，產出的參考音會相同。可調的參數：

| 參數 | 預設 | 作用 |
|---|---|---|
| `--formant` | 1.25 | 共振峰倍率。越高越像小孩，太高會含糊（1.35 時 Whisper 回寫開始聽錯字） |
| `--pitch` | 220 | 音高中位數 Hz。另兩檔試聽版是 250、280 |
| `--rate` | 4.6 | 參考音的語速（字/秒）。輸出會學走它；念得慢就產得慢，生成時間與語音長度成正比 |
| `--seed` | 1 | 成人男聲那一步的取樣種子 |

## 啟動

```bash
conda activate breezyvoice && export PYTHONNOUSERSITE=1
python tools/tts-server/server.py
# [augur-tts] 就緒。允許的 origin：[...]
# Uvicorn running on http://0.0.0.0:8090
```

啟動約需 25 秒（實測：載模型 12 秒、算參考音特徵 7 秒）。之後在 panel 選項「外部語音服務網址」填
`http://<這台機器>:8090`，按「試聽」。面板上的聲線標籤會顯示「外部語音（主機:埠）」。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `AUGUR_TTS_ALLOW_ORIGINS` | localhost／127.0.0.1 的 3000 與 3002 | 允許的 Grafana 網址，逗號分隔。**要寫成瀏覽器網址列上的樣子**：`localhost` 與 `127.0.0.1` 是不同的 origin |
| `AUGUR_TTS_PORT` | 8090 | |
| `AUGUR_TTS_HOST` | 0.0.0.0 | |
| `AUGUR_TTS_CACHE` | 512 | 片段快取筆數，0 = 不快取 |
| `AUGUR_TTS_REFERENCE` | `voices/boy.wav` | 參考音；逐字稿預設是同名的 `.txt` |
| `BREEZYVOICE_DIR` | `~/engines/BreezyVoice` | 上游程式的位置 |

## 會遇到的延遲

模型產語音大約是即時速度：念 5 秒的話要算 3–5 秒。面板因此把一則告警切成短句、逐句來要，
第一句回來就開始播。伺服器會記住念過的片段，所以：

- **某種告警第一次出現**：開口前等大約 6 秒（實測 p50 5.7 秒、最慢 8.9 秒），句子之間偶爾會停頓。
- **同一種告警再出現**（只有數值不同）：幾乎立刻開口。只有數值那一段要現產，而它在前面幾句播放時就產好了。
- 任何一段超過 panel 選項「外部語音逾時」（預設 15 秒），那則剩下的部分改用瀏覽器聲線念完。

快取存在記憶體，重啟服務後歸零。

## 連不上的時候

面板的聲線標籤會寫明原因：「外部語音失敗：…，已降級」。

| 標籤上的原因 | 通常是 |
|---|---|
| `Failed to fetch` | 服務沒開、埠不對、**CORS 擋下**（`AUGUR_TTS_ALLOW_ORIGINS` 沒有你的 Grafana 網址），或 Grafana 走 https 而服務是 http（混合內容） |
| `HTTP 4xx／5xx` | 服務端錯誤，看伺服器的輸出 |
| `timeout` | 這一段超過逾時。第一次念某種告警時偶爾會發生 |
| `autoplay-blocked` | 瀏覽器擋自動播放。點一下 panel 上的「啟用語音」 |

Grafana 若啟用了 CSP（`content_security_policy = true`，預設關閉），要在模板的 `connect-src`
加上這個服務的網址，否則一律 `Failed to fetch`。
