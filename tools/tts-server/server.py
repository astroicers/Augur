"""
Augur 外部語音服務的參考實作（ADR-005 決策 6）：BreezyVoice + 參考音特徵快取 + CORS。

對外是 OpenAI 相容的 `POST /v1/audio/speech`，面板的「外部語音服務網址」填這台的位址即可。

和上游 BreezyVoice `api.py` 的差別：
  1. 參考音的特徵（speech token、mel、聲紋）啟動時算一次。上游每則請求都重算，
     實測佔每句約 20 秒裡的 13–14 秒（RTX 4070，2026-10-05）。
  2. 加 CORS —— 面板是從 Grafana 頁面直接 fetch 過來的。
  3. 推論加鎖：單一 GPU，同時兩則只會兩則都慢。
  4. 在逗號也分段、每段修頭尾靜音（見 SENTENCE_SPLIT、trim_silence）。
  5. 片段快取（見 synthesize_wav）。

不改上游任何檔案：BreezyVoice 原封不動放在 BREEZYVOICE_DIR，這裡 import 它。

環境變數：
  BREEZYVOICE_DIR          上游 repo 的位置（預設 ~/engines/BreezyVoice）
  AUGUR_TTS_REFERENCE      參考音 wav（預設 ./voices/boy.wav，由 make_reference.py 產生）
  AUGUR_TTS_REFERENCE_TEXT 參考音的逐字稿檔（預設與 wav 同名的 .txt）
  AUGUR_TTS_ALLOW_ORIGINS  允許的 Grafana origin，逗號分隔（預設 localhost／127.0.0.1 的 3000 與 3002）
  AUGUR_TTS_CACHE          片段快取筆數（預設 512；0 = 不快取）

`speed` 欄位收下但不套用：BreezyVoice 沒有語速參數，事後變速（相位聲碼器）會有金屬聲。
所以面板的「語速」滑桿對這個服務沒有作用；語速由參考音決定（make_reference.py 的 --rate）。
"""

from __future__ import annotations

import io
import os
import re
import sys
import threading
from collections import OrderedDict
from pathlib import Path

HERE = Path(__file__).resolve().parent
BREEZY = Path(os.environ.get("BREEZYVOICE_DIR", Path.home() / "engines" / "BreezyVoice")).resolve()
REF_WAV = Path(os.environ.get("AUGUR_TTS_REFERENCE", HERE / "voices" / "boy.wav")).resolve()
REF_TXT = Path(os.environ.get("AUGUR_TTS_REFERENCE_TEXT", REF_WAV.with_suffix(".txt"))).resolve()
# 每筆約 50–300 KB（16-bit、22.05 kHz、1–7 秒），512 筆上限約 150 MB。
CACHE_SIZE = int(os.environ.get("AUGUR_TTS_CACHE", "512"))
# 預設涵蓋 Grafana 的預設埠 3000 與本 repo 開發環境的 3002（monitoring/，見 playwright.config.ts）。
# 瀏覽器送的 Origin 是網址列上的寫法，localhost 與 127.0.0.1 是兩個不同的 origin，兩種都列。
DEFAULT_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002"
ORIGINS = [o.strip() for o in os.environ.get("AUGUR_TTS_ALLOW_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()]

# 上游以 repo 根為工作目錄寫相對 import 與相對路徑。
sys.path.insert(0, str(BREEZY))
os.chdir(BREEZY)

import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from g2pw import G2PWConverter  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from cosyvoice.utils.file_utils import load_wav  # noqa: E402
from single_inference import CustomCosyVoice, get_bopomofo_rare  # noqa: E402

SAMPLE_RATE = 22050
# 分段：上游只在句號切（`inference_zero_shot_no_normalize`），但告警句整句只有逗號 ——
# 「偵測到告警：X，嚴重度 Y，受影響對象 Z，目前數值 N，<summary>。」一句 100 多字變成一條長序列。
# 2026-10-05 實測（RTX 4070 12GB）：這種句子單則 41–111 秒、還有逾時 120 秒的，顯存被撐到 11.9GB。
# 改在逗號、冒號、分號也切，每段單獨合成再接起來。
# 半形 `, : ; . ? !` 後面接數字或 `/` 時不切：`91.35`、`192.168.1.20:9182`、`12:30`、`http://`。
SENTENCE_SPLIT = re.compile(r"(?<=[，：；？！。])\s*|(?<=[,:;.?!])(?![\d/])\s*")

if not REF_WAV.exists():
    sys.exit(f"找不到參考音 {REF_WAV}。先跑 make_reference.py（見 README）。")
if not REF_TXT.exists():
    sys.exit(f"找不到參考音逐字稿 {REF_TXT}。")

print(f"[augur-tts] 載入模型（BreezyVoice @ {BREEZY}）…", flush=True)
cosy = CustomCosyVoice("MediaTek-Research/BreezyVoice")
g2p = G2PWConverter()


def bopomofo(text: str) -> str:
    return get_bopomofo_rare(cosy.frontend.text_normalize_new(text, split=False), g2p)


print(f"[augur-tts] 計算參考音特徵（{REF_WAV.name}）…", flush=True)
_prompt_text = bopomofo(REF_TXT.read_text(encoding="utf-8").strip())
# 參考音這一側的欄位每則都一樣，只有 text／text_len 會換。
BASE_INPUT = cosy.frontend.frontend_zero_shot(_prompt_text, _prompt_text, load_wav(str(REF_WAV), 16000))
LOCK = threading.Lock()
print(f"[augur-tts] 就緒。允許的 origin：{ORIGINS}", flush=True)


def synthesize(text: str) -> torch.Tensor:
    pieces = []
    for sentence in SENTENCE_SPLIT.split(bopomofo(text)):
        if not sentence.strip():
            continue
        tok, tok_len = cosy.frontend._extract_text_token(sentence)
        model_input = dict(BASE_INPUT, text=tok, text_len=tok_len)
        # 每段都修頭尾：段數一多，每段句尾的空白會累加成整句裡的長停頓。
        pieces.append(trim_silence(cosy.model.inference(**model_input)["tts_speech"], pad_sec=0.12))
    if not pieces:
        raise HTTPException(status_code=400, detail="input 沒有可念的內容")
    return torch.concat(pieces, dim=1)


def trim_silence(wav: torch.Tensor, pad_sec: float = 0.1) -> torch.Tensor:
    """
    修掉頭尾靜音。模型偶爾在句尾留幾秒空白（實測「好消息，CPU 使用率已經恢復正常囉。」
    10.6 秒裡只有 6.1 秒有聲音）—— 面板逐則播，句尾空白就是下一則告警白等的時間。
    門檻取這一段自己最大音框 RMS 的 5%，不用絕對值：不同輸出的音量差到 3 倍。
    """
    hop = 512
    x = wav.squeeze(0)
    n = x.numel() // hop
    if n == 0:
        return wav
    rms = x[: n * hop].reshape(n, hop).pow(2).mean(dim=1).sqrt()
    voiced = (rms > rms.max() * 0.05).nonzero()
    if voiced.numel() == 0:
        return wav
    pad = int(pad_sec * SAMPLE_RATE)
    start = max(0, int(voiced[0]) * hop - pad)
    end = min(x.numel(), (int(voiced[-1]) + 1) * hop + pad)
    return wav[:, start:end]


class SpeechRequest(BaseModel):
    input: str
    model: str = "tts-1"
    voice: str = "default"
    speed: float = 1.0
    response_format: str = "wav"


app = FastAPI(title="augur-tts")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "reference": REF_WAV.name}


@app.get("/v1/models")
def models() -> dict:
    return {"object": "list", "data": [{"id": "tts-1", "object": "model", "owned_by": "augur"}]}


CACHE: "OrderedDict[str, bytes]" = OrderedDict()
CACHE_LOCK = threading.Lock()


def cache_get(text: str) -> bytes | None:
    with CACHE_LOCK:
        wav = CACHE.get(text)
        if wav is not None:
            CACHE.move_to_end(text)
        return wav


def cache_put(text: str, wav: bytes) -> None:
    if CACHE_SIZE <= 0:
        return
    with CACHE_LOCK:
        CACHE[text] = wav
        CACHE.move_to_end(text)
        while len(CACHE) > CACHE_SIZE:
            CACHE.popitem(last=False)


def synthesize_wav(text: str) -> bytes:
    """
    以片段文字為鍵快取成品。面板逐句來要（見 `src/speech/remoteSpeaker.ts` 的 `splitClauses`），
    而告警句的片段大多會重複：「偵測到告警：<規則名>，」「嚴重度 warning，」與規則摘要，
    同一條告警每次觸發都一字不差，變的只有數值那一段。
    服務產語音約等於即時速度（RTX 4070 實測），沒有快取時開口要等第一句的 3–8 秒；
    命中快取的那幾句是立即回應，只剩數值那句要現產，而它是在前幾句播放的同時產的。

    兩道查詢：
      - 鎖外先查一次 —— 命中就不必排在別人的推論後面。
      - 拿到推論鎖之後再查一次 —— 同一句同時來 N 個請求（同一個 dashboard 有 N 個人在看）時，
        只有第一個真的推論，其餘排到鎖時就命中。不用 functools.lru_cache 正是為了這個：
        它不合併進行中的重複呼叫，N 個請求會各算一次（2026-10-05 複審 F3）。
    """
    wav = cache_get(text)
    if wav is not None:
        return wav
    with LOCK:
        wav = cache_get(text)
        if wav is not None:
            return wav
        audio = synthesize(text)
        buf = io.BytesIO()
        sf.write(buf, audio.squeeze(0).cpu().numpy(), SAMPLE_RATE, format="WAV", subtype="PCM_16")
        wav = buf.getvalue()
        # ⚠️ 寫入快取必須在鎖**裡面**：寫在外面的話，放開鎖到寫入之間，排在後面的同一句會拿到鎖、
        # 查不到、再算一次（2026-10-05 實測：同時 3 個同句請求產出兩種不同音訊）。
        cache_put(text, wav)
    return wav


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest) -> Response:
    text = req.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="input 是空的")
    if len(text) > 500:
        # 一則典型告警約 77 字；500 字是防誤用的上限，不是語意限制。
        raise HTTPException(status_code=413, detail="input 超過 500 字")
    return Response(content=synthesize_wav(text), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("AUGUR_TTS_HOST", "0.0.0.0"), port=int(os.environ.get("AUGUR_TTS_PORT", "8090")))
