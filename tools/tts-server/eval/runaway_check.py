"""
驗證失控上限的機制（ADR-005）：把上限壓到每單位 0.05 秒，正常句子一定會碰到 → 應拋 Runaway、HTTP 502、不寫進快取。
真正的失控無法穩定重現（取樣是隨機的），所以驗的是「碰到上限時的處理」，不是「哪些句子會失控」。

    conda activate qwen3tts && export PYTHONNOUSERSITE=1
    python tools/tts-server/eval/runaway_check.py
"""

import os
import sys
import time

os.environ["AUGUR_TTS_MAX_SEC_PER_UNIT"] = "0.05"
sys.path.insert(0, os.path.dirname(__file__))
from _server import load_server  # noqa: E402

srv = load_server()
from fastapi import HTTPException  # noqa: E402

text = "嗨，我是藍鯨小弟，我會幫你盯著儀表板，有告警就念給你聽。"
t0 = time.time()
try:
    srv.speech(srv.SpeechRequest(input=text))
    print("FAIL：沒有被截斷")
    sys.exit(1)
except HTTPException as e:
    took = time.time() - t0
    cached = srv.cache_get(text) is not None
    print(f"HTTP {e.status_code}：{e.detail}；花 {took:.1f} 秒；寫進快取：{cached}")
    sys.exit(0 if e.status_code == 502 and not cached else 1)
