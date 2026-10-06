"""
G-ADR005-4 延遲（ADR-005）：模擬面板的行為 —— 一則切成片段（與 remoteSpeaker.ts 的 splitClauses 同規則、16 字），
逐段要音訊、預取一段，第一段回來就「播」（以語音長度模擬）。量開口等待與段間卡頓。
第 1 輪是冷的（伺服器快取空），之後每輪換掉「目前數值」，模擬同一條告警再觸發。

    python3 tools/tts-server/eval/latency.py [伺服器網址，預設 http://127.0.0.1:8765] [輪數，預設 3]
（只用標準函式庫，不需要 conda 環境；伺服器要先跑起來，且最好是剛重啟、快取空的）
"""

import io
import json
import math
import re
import statistics
import sys
import time
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
OUT = Path.home() / ".cache/augur-tts-eval/latency.txt"
OUT.parent.mkdir(parents=True, exist_ok=True)

ALERTS = [
    "偵測到告警：WindowsHighCPU，嚴重度 warning，受影響對象 192.168.1.20:9182，目前數值 91.35，Windows host CPU usage is high (above 85 percent)。",
    "告警已恢復：WindowsHighCPU，受影響對象 192.168.1.20:9182，目前數值 42。",
    "偵測到告警：WindowsLowMemory，嚴重度 warning，目前數值 8.20，Windows host available memory is low (below 10 percent)。",
    "偵測到告警：WindowsLowDisk，嚴重度 warning，受影響對象 C:，目前數值 6.75。",
    "偵測到告警：WindowsFailedLogonBurst，嚴重度 warning，Multiple failed Windows logon attempts detected (possible brute force)。",
    "偵測到告警：WindowsAccountLockout，嚴重度 critical，A Windows user account was locked out。",
    "偵測到告警：WindowsSecurityLogCleared，嚴重度 critical，The Windows security audit log was cleared。",
    "偵測到告警：WindowsDefenderThreat，嚴重度 critical，Windows Defender detected a malware threat。",
    "告警已恢復：WindowsLowDisk，受影響對象 C:。",
    "偵測到告警：PocAlwaysFiring，嚴重度 critical，POC 用的恆定告警，用來確認 panel 收得到 alertState。",
]
SPLIT = re.compile(r"(?<=[，：；。！？])|(?<=[,:;?!])(?![\d/])")


def split_clauses(text, min_chars=16):
    out, buf = [], ""
    for piece in (p for p in SPLIT.split(text) if p.strip()):
        buf += piece
        if len(re.sub(r"\s", "", buf)) >= min_chars:
            out.append(buf)
            buf = ""
    if buf.strip():
        if out:
            out[-1] += buf
        else:
            out.append(buf)
    return out or [text]


def fetch(text):
    t0 = time.time()
    req = urllib.request.Request(
        f"{BASE}/v1/audio/speech", data=json.dumps({"input": text}).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read()
    except Exception as e:  # noqa: BLE001 —— 失敗也要記下來（面板會降級）
        return time.time() - t0, None, str(e)
    w = wave.open(io.BytesIO(body))
    return time.time() - t0, w.getnframes() / w.getframerate(), None


pool = ThreadPoolExecutor(2)
log = open(OUT, "a", encoding="utf-8")
log.write(f"# {time.strftime('%F %T')} {BASE} rounds={ROUNDS}\n")
results = []  # (round, 開口, 卡頓, 最久單段, 失敗段數)
for rnd in range(ROUNDS):
    for i, alert in enumerate(ALERTS):
        text = re.sub(r"目前數值 [\d.]+", f"目前數值 {40 + rnd * 13 + i * 3}.{(rnd * 7 + i) % 10}", alert)
        cl = split_clauses(text)
        t0 = time.time()
        futs = [None] * len(cl)
        futs[0] = pool.submit(fetch, cl[0])
        play_end = first = None
        stall = longest = 0.0
        fails = 0
        for k in range(len(cl)):
            if k + 1 < len(cl) and futs[k + 1] is None:
                futs[k + 1] = pool.submit(fetch, cl[k + 1])  # 預取一段
            took, dur, err = futs[k].result()
            longest = max(longest, took)
            if err:
                fails += 1
                break  # 面板會把剩下的交給 Web Speech
            now = time.time() - t0
            start = now if play_end is None else max(now, play_end)
            if play_end is not None:
                stall += max(0.0, now - play_end)
            first = start if first is None else first
            play_end = start + dur
        results.append((rnd, first, stall, longest, fails))
        line = f"r{rnd} #{i} 段數 {len(cl)} 開口 {first if first is not None else float('nan'):.1f}s 卡頓 {stall:.1f}s 最久單段 {longest:.1f}s 失敗 {fails}"
        print(line, flush=True)
        log.write(line + "\n")
        log.flush()


def summary(name, rows):
    opens = sorted(r[1] for r in rows if r[1] is not None)
    stalls = [r[2] for r in rows]
    if not opens:
        return f"{name}：全部失敗"
    # nearest-rank 百分位。N=10 時 p95 就是最大值，所以報 p90 與最大值（第三輪複審：原本標成 p95 的其實是 p90）。
    p90 = opens[max(0, math.ceil(len(opens) * 0.9) - 1)]
    return (
        f"{name} N={len(rows)} 開口 p50 {statistics.median(opens):.1f} p90 {p90:.1f} max {opens[-1]:.1f} | "
        f"卡頓 p50 {statistics.median(stalls):.1f} max {max(stalls):.1f} | 單段 >15s {sum(r[3] > 15 for r in rows)} | 失敗 {sum(r[4] for r in rows)}"
    )


for line in (summary("冷（第 1 輪）", [r for r in results if r[0] == 0]), summary("熱（之後各輪）", [r for r in results if r[0] > 0])):
    print(line)
    log.write(line + "\n")
