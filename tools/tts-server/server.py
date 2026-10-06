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
# 切完再把太短的段併進下一段，與面板 `splitClauses` 的 minChars 一致（16）。不併的話面板合好的段落
# 到這裡又被逗號切開；而太短的段落上下文不夠，數字最容易念錯（2026-10-05：「目前數值 91.35。」
# 單獨成段 4 次錯 3 次，整句 3 次全對）。
MIN_CLAUSE_CHARS = 16
BOPOMOFO_TAG = re.compile(r"\[:[^\]]*\]")


def clauses(text: str) -> list[str]:
    out: list[str] = []
    buf = ""
    for piece in SENTENCE_SPLIT.split(text):
        if not piece.strip():
            continue
        buf += piece
        # 字數不算注音標註（`点[:ㄉㄧㄢ3]` 是一個字）與空白。
        if len(re.sub(r"\s", "", BOPOMOFO_TAG.sub("", buf))) >= MIN_CLAUSE_CHARS:
            out.append(buf)
            buf = ""
    if buf.strip():
        if out:
            out[-1] += buf
        else:
            out.append(buf)
    return out

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


class Runaway(Exception):
    """語言模型一路念到 token 上限 —— 幾乎一定是失控（見 _capped_llm_inference）。"""


# 失控上限：以「念出來的單位」算這一段最多可以念幾秒，超過就當作失控。
# 上游 `CosyVoiceModel.inference` 把語音 token 上限寫死成文字 token 的 30 倍（原版 CosyVoice 預設 20）。
# 2026-10-05 實測失控一次：模型把參考音的逐字稿接著念下去，24 單位的句子產出 21.7 秒、花了 809 秒，
# 期間推論鎖住整張 GPU。
# ⚠️ 不用「文字 token 的倍數」當上限：英文單字、數字是 1 個 token 卻念很久，短段落的比例天生偏高。
#    2026-10-06 以 12 倍試跑，12 次有 8 次誤判（例如 6.7 秒的正常句被截斷）；先前量到的「正常最高 7.7 倍」
#    也是錯的 —— 上游會就地把 text_len 加上逐字稿長度，量測腳本讀到的是加過的值。
# 每單位秒數（40 筆正常輸出）：最高 0.59；極端失控 0.9；輕微失控（多念一段）0.65。
# 取 0.8 秒/單位 + 1 秒：擋得住極端失控。**擋不住 0.65 那種輕微失控**，ADR-005 待驗風險有記。
MAX_SEC_PER_UNIT = float(os.environ.get("AUGUR_TTS_MAX_SEC_PER_UNIT", "0.8"))
TOKENS_PER_SEC = 50  # 語音 token 速率（CosyVoice-300M：50 token = 1 秒）
_clause_max_tokens: int | None = None  # synthesize 在呼叫模型前設定；推論有 LOCK，同一時間只有一段


def spoken_units(clause: str) -> float:
    """念出來的長度：中文字、數字各 1，英文每 3 個字母算 1（一個字至少 1）。注音標註不算。"""
    t = BOPOMOFO_TAG.sub("", clause)
    cjk = len(re.findall(r"[\u4e00-\u9fff]", t))
    digits = len(re.findall(r"\d", t))
    latin = sum(max(1.0, len(w) / 3) for w in re.findall(r"[A-Za-z]+", t))
    return cjk + digits + latin


_upstream_llm_inference = cosy.model.llm.inference


def _capped_llm_inference(*args, **kwargs):
    if _clause_max_tokens is None:
        return _upstream_llm_inference(*args, **kwargs)
    # ⚠️ 先讀 text_len 再呼叫：上游會就地改寫它（`text_len += prompt_text_len`）。
    text_tokens = max(1, int(kwargs["text_len"].reshape(-1)[0].item()))
    # 上游的上限是「文字 token × 倍數」，所以把秒數上限換算回倍數交給它。
    kwargs["max_token_text_ratio"] = _clause_max_tokens / text_tokens
    tokens = _upstream_llm_inference(*args, **kwargs)
    limit = int(text_tokens * kwargs["max_token_text_ratio"])
    if tokens.size(1) >= limit:
        raise Runaway(f"語音 {tokens.size(1) / TOKENS_PER_SEC:.1f} 秒碰到這段的上限 {limit / TOKENS_PER_SEC:.1f} 秒")
    return tokens


# 不改上游檔案：在執行期把這個物件的 inference 換成有上限的版本（上游以關鍵字參數呼叫它）。
cosy.model.llm.inference = _capped_llm_inference
print(f"[augur-tts] 就緒。允許的 origin：{ORIGINS}", flush=True)


def synthesize(text: str) -> torch.Tensor:
    global _clause_max_tokens
    pieces = []
    for sentence in clauses(bopomofo(text)):
        _clause_max_tokens = int((MAX_SEC_PER_UNIT * spoken_units(sentence) + 1.0) * TOKENS_PER_SEC)
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
    try:
        wav = synthesize_wav(text)
    except Runaway as e:
        # 不寫進快取（例外在 cache_put 之前就拋出），回 502 讓面板把這則剩下的部分交給 Web Speech —— 失控的音訊不放出去。
        print(f"[augur-tts] 失控截斷：{e}；input={text[:40]!r}", flush=True)
        raise HTTPException(status_code=502, detail="語音模型失控，已截斷") from e
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("AUGUR_TTS_HOST", "0.0.0.0"), port=int(os.environ.get("AUGUR_TTS_PORT", "8765")))
