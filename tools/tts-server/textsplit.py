"""
分段、念出來的單位、失控上限的算術（ADR-005）。只用標準函式庫：不載模型就能測（見 test_textsplit.py）。
server.py 從這裡 import。
"""

from __future__ import annotations

import math
import re

# 在標點後切，與面板 `src/speech/remoteSpeaker.ts` 的 `splitClauses` 同一組標點：
#   全形 `，：；。！？` 一律切；半形 `, : ; ? !` 後面接數字或 `/` 時不切（`192.168.1.20:9182`、`12:30`、`http://`）。
#   半形 `.` 不切（client 也不切；`91.35`、`grafana.local`）。
# 另外兩條是伺服器才有的：
#   - 不在注音標註 `字[:ㄉㄧㄢ3]` 的 `[:` 裡切（2026-10-06 第三輪複審 P2）。注音標註是前一個模型 BreezyVoice 的
#     前處理產物；換成 Qwen3-TTS 後輸入裡不再有它，這條保留無害。
#   - 不吃掉標點後的空白：吃掉的話併段時英文字會黏在一起（`firing:WindowsHighCPU,severity`）。
SENTENCE_SPLIT = re.compile(r"(?<=[，：；。！？])|(?<=[,:;?!])(?<!\[:)(?![\d/])")
BOPOMOFO_TAG = re.compile(r"\[:[^\]]*\]")

# 段落至少幾個字，與 client 的 minChars 同值。太短的段落上下文不夠，數字最容易念錯
# （2026-10-05：「目前數值 91.35。」單獨成段 4 次錯 3 次，整句 3 次全對）。
# client 算繁體原文，這裡算轉成簡體後的文字。OpenCC 以詞為單位轉換，字數幾乎不變，兩邊切出來的段落
# 通常一致；偶有不同時只是多切一刀、多一個停頓，不影響正確性。
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


# ---- 失控上限 ----
# 以「念出來的單位」算這一段最多可以念幾秒：每單位 sec_per_unit 秒＋1 秒。超過就當作失控。
# 不用「文字 token 的倍數」：英文單字、數字 token 少卻念得久（前一個模型實測以 12 倍試跑，12 次誤判 7 次）。
#
# 每單位秒數依 Qwen3-TTS 實測校準（2026-10-06，第四輪複審 F1）：正常語速每單位約 0.21–0.25 秒
# （`eval/quality.py`：24 單位的自我介紹 5.0–5.4 秒、約 28 單位的帳號鎖定 5.9–6.2 秒）。預設 0.45 ——
# 約正常的 1.8 倍，加上 1 秒給短句的頭尾；整段念兩遍（約 0.5）就會被擋。原本沿用前一個模型 BreezyVoice
# 的 0.8（它念得慢、正常最高 0.59），在 Qwen 上寬了約 3.5 倍：念兩三遍都擋不住。
DEFAULT_SEC_PER_UNIT = 0.45

# Qwen3-TTS-12Hz 的語音以 frame 為單位：tokenizer 每個 frame 上採樣 1920 點、輸出 24 kHz → 每 frame 0.08 秒
# （qwen_tts 的 configuration_qwen3_tts_tokenizer_v2：decode_upsample_rate=1920、output_sample_rate=24000）。
# generate 的第一步（prefill）不產 frame，所以 max_new_tokens=n 最多產 n−1 個 frame
# （實測 36 → 2.80 秒 = 35 × 0.08）。第四輪複審 F4：先前寫成「每步 0.078 秒」，是 35 個 frame 攤到 36 步的結果。
FRAME_SEC = 1920 / 24000


def clause_limit_sec(units: float, sec_per_unit: float = DEFAULT_SEC_PER_UNIT) -> float:
    return sec_per_unit * units + 1.0


def qwen_max_new_tokens(limit_sec: float) -> int:
    """交給 generate 的 max_new_tokens：最多 n−1 個 frame，剛好能念到 limit_sec。"""
    return math.ceil(limit_sec / FRAME_SEC) + 1


def is_runaway(audio_sec: float, limit_sec: float) -> bool:
    """
    產出的語音長度碰到上限就算失控：模型是被 max_new_tokens 截斷的，不是自己停下來。
    被截斷時恰好是 n−1 個 frame；差半個 frame 的容忍給解碼頭尾的取樣差。
    """
    frames = qwen_max_new_tokens(limit_sec) - 1
    return audio_sec >= (frames - 0.5) * FRAME_SEC
