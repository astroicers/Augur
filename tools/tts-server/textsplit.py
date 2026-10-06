"""
分段、念出來的單位、失控上限的算術（ADR-005）。只用標準函式庫：不載模型就能測（見 test_textsplit.py）。
server.py 從這裡 import。
"""

from __future__ import annotations

import re
import struct

# 在標點後切，與面板 `src/speech/remoteSpeaker.ts` 的 `splitClauses` 同一組標點：
#   全形 `，：；。！？` 一律切；半形 `, : ; ? !` 後面接數字或 `/` 時不切（`192.168.1.20:9182`、`12:30`、`http://`）。
#   半形 `.` 不切（client 也不切；`91.35`、`grafana.local`）。
# 另外兩條是伺服器才有的：
#   - 不在注音標註 `字[:ㄉㄧㄢ3]` 的 `[:` 裡切（2026-10-06 第三輪複審 P2：冒號後接注音不是數字，原本會被切開）。
#   - 不吃掉標點後的空白：吃掉的話併段時英文字會黏在一起（`firing:WindowsHighCPU,severity`）。
SENTENCE_SPLIT = re.compile(r"(?<=[，：；。！？])|(?<=[,:;?!])(?<!\[:)(?![\d/])")
BOPOMOFO_TAG = re.compile(r"\[:[^\]]*\]")

# 段落至少幾個字，與 client 的 minChars 同值。太短的段落上下文不夠，數字最容易念錯
# （2026-10-05：「目前數值 91.35。」單獨成段 4 次錯 3 次，整句 3 次全對）。
# ⚠️ 兩邊算的不是同一份文字：client 算原文，這裡算上游正規化後的文字（數字已轉成國字、注音標註不算），
#    所以 client 的一段到這裡偶爾會再被切一刀（例如長數字轉國字後變長）。多一個停頓，不影響正確性。
MIN_CLAUSE_CHARS = 16


def visible_len(text: str) -> int:
    return len(re.sub(r"\s", "", BOPOMOFO_TAG.sub("", text)))


def clauses(text: str, min_chars: int = MIN_CLAUSE_CHARS) -> list[str]:
    out: list[str] = []
    buf = ""
    for piece in SENTENCE_SPLIT.split(text):
        if not piece.strip():
            buf += piece
            continue
        buf += piece
        if visible_len(buf) >= min_chars:
            out.append(buf)
            buf = ""
    if buf.strip():
        if out:
            out[-1] += buf
        else:
            out.append(buf)
    return [c.strip() for c in out]


# 中日韓文字（含擴充 A、相容字）、假名、韓文：各算 1 單位。
_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]")


def spoken_units(text: str) -> float:
    """念出來的長度：中日韓文字、數字各 1，英文每 3 個字母算 1（一個字至少 1）。注音標註不算。"""
    t = BOPOMOFO_TAG.sub("", text)
    cjk = len(_CJK.findall(t))
    digits = len(re.findall(r"\d", t))
    latin = sum(max(1.0, len(w) / 3) for w in re.findall(r"[A-Za-z]+", t))
    return cjk + digits + latin


TOKENS_PER_SEC = 50  # 語音 token 速率（CosyVoice-300M：50 token = 1 秒）
UPSTREAM_MAX_RATIO = 30.0  # 上游 CosyVoiceModel.inference 寫死的倍數


def clause_max_tokens(units: float, sec_per_unit: float) -> int:
    return int((sec_per_unit * units + 1.0) * TOKENS_PER_SEC)


def cap_ratio(max_tokens: int, text_tokens: int) -> float:
    """
    交給上游 `llm.inference(max_token_text_ratio=…)` 的倍數。上游算 `int(text_len * ratio)` 時，
    text_len 是 int32 tensor，所以是 **float32** 乘法；用 float64 算 `max_tokens / text_tokens` 回推會差 1
    （2026-10-06 第三輪複審 P1：T=47、M=1010 時上游得 1009；掃 T<200、M<2000 有 4622 組不一致）。
    加 0.5 讓 float32 的結果穩穩落在 max_tokens（同一掃描 0 組不符）。不超過上游原本的 30 倍。
    """
    return min(UPSTREAM_MAX_RATIO, (max_tokens + 0.5) / max(1, text_tokens))


def _f32(x: float) -> float:
    return struct.unpack("f", struct.pack("f", x))[0]


def upstream_max_len(text_tokens: int, ratio: float) -> int:
    """上游的 `int((text_len - prompt_text_len) * ratio)`，以 float32 重現（int32 tensor × Python float）。"""
    return int(_f32(_f32(ratio) * text_tokens))
