"""
Augur 外部語音服務的參考實作（ADR-005 決策 6）：Qwen3-TTS 年輕男聲 + 片段快取 + CORS。

對外是 OpenAI 相容的 `POST /v1/audio/speech`，面板的「外部語音服務網址」填這台的位址即可。

聲音怎麼來的（ADR-005 決策 7）：先用 Qwen3-TTS **VoiceDesign** 依文字描述生成一段年輕男聲（make_voice.py），
使用者試聽選定；服務用 Qwen3-TTS **Base** 照這段聲音念（官方建議的「先設計、再複製」流程），
聲線才會每一句都一樣。**不變聲、不使用任何真人錄音。**

要點：
  1. 聲音特徵（voice clone prompt）啟動時建一次，之後每句重用。
  2. 送進模型前把文字轉成簡體（OpenCC t2s）。繁體輸入時模型常念成廣東話（2026-10-06 使用者試聽）；
     轉換只發生在模型入口，面板顯示、告警內容一律維持繁體。
  3. 加 CORS —— 面板是從 Grafana 頁面直接 fetch 過來的。
  4. 推論加鎖：單一 GPU，同時兩則只會兩則都慢。
  5. 在逗號也分段、每段修頭尾靜音、片段快取（見 textsplit.clauses、trim_silence、synthesize_wav）。
  6. 失控上限（見 textsplit.clause_limit_sec／qwen_max_new_tokens）。

環境變數：
  AUGUR_TTS_MODEL          模型（預設 Qwen/Qwen3-TTS-12Hz-1.7B-Base）
  AUGUR_TTS_REFERENCE      參考音 wav（預設 ./voices/young_male.wav，見 make_voice.py）
  AUGUR_TTS_REFERENCE_TEXT 參考音的逐字稿檔（預設與 wav 同名的 .txt）
  AUGUR_TTS_ALLOW_ORIGINS  允許的 Grafana origin，逗號分隔（預設 localhost／127.0.0.1 的 3000 與 3002）
  AUGUR_TTS_CACHE          片段快取筆數（預設 512；0 = 不快取）
  AUGUR_TTS_MAX_SEC_PER_UNIT 失控上限，每單位幾秒（預設 0.8）

`speed` 欄位收下但不套用：模型沒有語速參數，事後變速會有金屬聲。面板的「語速」滑桿對這個服務沒有作用。
"""

from __future__ import annotations

import io
import os
import sys
import threading
from collections import OrderedDict
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = os.environ.get("AUGUR_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
REF_WAV = Path(os.environ.get("AUGUR_TTS_REFERENCE", HERE / "voices" / "young_male.wav")).resolve()
REF_TXT = Path(os.environ.get("AUGUR_TTS_REFERENCE_TEXT", REF_WAV.with_suffix(".txt"))).resolve()
# 每筆約 50–400 KB（16-bit、24 kHz、1–8 秒），512 筆上限約 200 MB。
CACHE_SIZE = int(os.environ.get("AUGUR_TTS_CACHE", "512"))
# 預設涵蓋 Grafana 的預設埠 3000 與本 repo 開發環境的 3002（monitoring/，見 playwright.config.ts）。
# 瀏覽器送的 Origin 是網址列上的寫法，localhost 與 127.0.0.1 是兩個不同的 origin，兩種都列。
DEFAULT_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002"
ORIGINS = [o.strip() for o in os.environ.get("AUGUR_TTS_ALLOW_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()]
MAX_SEC_PER_UNIT = float(os.environ.get("AUGUR_TTS_MAX_SEC_PER_UNIT", "0.8"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from opencc import OpenCC  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from qwen_tts import Qwen3TTSModel  # noqa: E402

sys.path.insert(0, str(HERE))
from textsplit import clause_limit_sec, clauses, is_runaway, qwen_max_new_tokens, spoken_units  # noqa: E402

if not REF_WAV.exists():
    sys.exit(f"找不到參考音 {REF_WAV}。先跑 make_voice.py（見 README）。")
if not REF_TXT.exists():
    sys.exit(f"找不到參考音逐字稿 {REF_TXT}。")

T2S = OpenCC("t2s")


def to_model_text(text: str) -> str:
    """模型入口的文字：轉簡體。繁體輸入時模型常念成廣東話（見檔頭第 2 點）。"""
    return T2S.convert(text)


print(f"[augur-tts] 載入模型 {MODEL}…", flush=True)
model = Qwen3TTSModel.from_pretrained(MODEL, device_map="cuda:0", dtype=torch.bfloat16)
print(f"[augur-tts] 建立聲音特徵（{REF_WAV.name}）…", flush=True)
VOICE = model.create_voice_clone_prompt(
    ref_audio=str(REF_WAV), ref_text=to_model_text(REF_TXT.read_text(encoding="utf-8").strip())
)
LOCK = threading.Lock()
# 暖機：第一次生成要多花二、三十秒（CUDA kernel 初始化等），實測服務啟動後第一則告警開口等了 31.5 秒。
# 啟動時先念一句丟掉，第一則真的告警就不用付這筆。不寫進快取。
print("[augur-tts] 暖機…", flush=True)
model.generate_voice_clone(text="你好。", language="Chinese", voice_clone_prompt=VOICE, max_new_tokens=40)
print(f"[augur-tts] 就緒。允許的 origin：{ORIGINS}", flush=True)


class Runaway(Exception):
    """模型一路念到這段的長度上限 —— 幾乎一定是失控（見 textsplit.is_runaway）。"""


def synthesize(text: str) -> tuple[np.ndarray, int]:
    pieces: list[np.ndarray] = []
    sr = 24000
    for clause in clauses(to_model_text(text)):
        limit = clause_limit_sec(spoken_units(clause), MAX_SEC_PER_UNIT)
        wavs, sr = model.generate_voice_clone(
            text=clause,
            language="Chinese",
            voice_clone_prompt=VOICE,
            max_new_tokens=qwen_max_new_tokens(limit),
        )
        wav = np.asarray(wavs[0], dtype=np.float32)
        if is_runaway(len(wav) / sr, limit):
            raise Runaway(f"語音 {len(wav) / sr:.1f} 秒碰到這段的上限 {limit:.1f} 秒")
        # 每段都修頭尾：段數一多，每段句尾的空白會累加成整句裡的長停頓。
        pieces.append(trim_silence(wav, sr, pad_sec=0.12))
    if not pieces:
        raise HTTPException(status_code=400, detail="input 沒有可念的內容")
    return np.concatenate(pieces), sr


def trim_silence(wav: np.ndarray, sr: int, pad_sec: float = 0.1) -> np.ndarray:
    """
    修掉頭尾靜音。模型偶爾在句尾留幾秒空白 —— 面板逐則播，句尾空白就是下一則告警白等的時間。
    門檻取這一段自己最大音框 RMS 的 5%，不用絕對值：不同輸出的音量差到 3 倍。
    """
    hop = 512
    n = len(wav) // hop
    if n == 0:
        return wav
    rms = np.sqrt((wav[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    voiced = np.nonzero(rms > rms.max() * 0.05)[0]
    if voiced.size == 0:
        return wav
    pad = int(pad_sec * sr)
    return wav[max(0, int(voiced[0]) * hop - pad) : min(len(wav), (int(voiced[-1]) + 1) * hop + pad)]


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
    return {"ok": True, "model": MODEL, "reference": REF_WAV.name}


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
    同一條告警每次觸發都一字不差，變的只有數值那一段。命中快取的句子立即回應。

    兩道查詢：
      - 鎖外先查一次 —— 命中就不必排在別人的推論後面。
      - 拿到推論鎖之後再查一次 —— 同一句同時來 N 個請求（同一個 dashboard 有 N 個人在看）時，
        只有第一個真的推論，其餘排到鎖時就命中（2026-10-05 複審 F3）。
    """
    wav = cache_get(text)
    if wav is not None:
        return wav
    with LOCK:
        wav = cache_get(text)
        if wav is not None:
            return wav
        audio, sr = synthesize(text)
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
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
    try:
        wav = synthesize_wav(text)
    except Runaway as e:
        # 不寫進快取（例外在 cache_put 之前就拋出），回 502 讓面板把這則剩下的部分交給 Web Speech —— 失控的音訊不放出去。
        print(f"[augur-tts] 失控截斷：{e}；input={text[:40]!r}", flush=True)
        raise HTTPException(status_code=502, detail="語音模型失控，已截斷") from e
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    # 選填 TLS：Grafana 走 https 時，http 的語音服務會被瀏覽器當成混合內容擋下（ADR-005 待驗風險 2），
    # 語音服務也要走 https。兩個都給才啟用。
    cert = os.environ.get("AUGUR_TTS_SSL_CERTFILE")
    key = os.environ.get("AUGUR_TTS_SSL_KEYFILE")
    uvicorn.run(
        app,
        host=os.environ.get("AUGUR_TTS_HOST", "0.0.0.0"),
        port=int(os.environ.get("AUGUR_TTS_PORT", "8765")),
        **({"ssl_certfile": cert, "ssl_keyfile": key} if cert and key else {}),
    )
