"""
品質抽查（ADR-005）：用伺服器真正的合成路徑（分段、失控上限、修靜音）念幾句典型告警，
每句換幾個種子，Whisper 轉回文字。Whisper 本身也會聽錯（「藍鯨」常聽成「藍金」），
所以結果是抽查線索，不是判決；最後要人耳聽。

    conda activate qwen3tts && export PYTHONNOUSERSITE=1
    python tools/tts-server/eval/quality.py [輸出目錄，預設 ~/.cache/augur-tts-eval/quality]
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from _server import load_server  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / ".cache/augur-tts-eval/quality")
OUT.mkdir(parents=True, exist_ok=True)
SENTENCES = [
    "嗨，我是藍鯨小弟，我會幫你盯著儀表板，有告警就念給你聽。",
    "偵測到告警：主機 CPU 使用率過高，嚴重度 warning，目前數值 91.35。",
    "告警已恢復：主機 CPU 使用率已經回到正常範圍囉。",
    "偵測到告警：WindowsAccountLockout，嚴重度 critical，A Windows user account was locked out。",
]
SEEDS = [1, 2, 3]

srv = load_server()
import librosa  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
import whisper  # noqa: E402

asr = whisper.load_model("small")
log = open(OUT / "results.txt", "a", encoding="utf-8")
for k, text in enumerate(SENTENCES):
    for seed in SEEDS:
        torch.manual_seed(seed)
        t0 = time.time()
        try:
            wav, sr = srv.synthesize(text)
        except srv.Runaway as e:
            line = f"#{k} seed {seed} | 失控截斷：{e}"
        else:
            took = time.time() - t0
            path = OUT / f"s{k}_seed{seed}.wav"
            sf.write(path, wav, sr, subtype="PCM_16")
            audio = librosa.resample(wav, orig_sr=sr, target_sr=16000).astype(np.float32)
            heard = asr.transcribe(audio, language="zh", initial_prompt="以下是繁體中文的句子。")["text"]
            line = f"#{k} seed {seed} | {len(wav) / sr:4.1f}s 語音、{took:4.1f}s 生成 | {heard}"
        print(line, flush=True)
        log.write(line + "\n")
        log.flush()
