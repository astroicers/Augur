"""
textsplit.py 的測試（ADR-005）。只用標準函式庫，不載模型、不需要 GPU：

    python3 tools/tts-server/test_textsplit.py

由 tools/asp-test.sh 的 tts-server 那一道執行。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from textsplit import (  # noqa: E402
    FRAME_SEC,
    clause_limit_sec,
    clauses,
    is_runaway,
    qwen_max_new_tokens,
    spoken_units,
)

TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


@test
def 數值那段不單獨成段():
    assert clauses("偵測到告警：WindowsHighCPU，嚴重度 warning，目前數值九十一點三五。") == [
        "偵測到告警：WindowsHighCPU，",
        "嚴重度 warning，目前數值九十一點三五。",
    ]


@test
def 不在注音標註裡切():
    # 上游會把破音字標成 `点[:ㄉㄧㄢ3]`；`[:` 後面是注音不是數字，原本會被當成冒號切開（第三輪複審 P2）。
    text = "受影響對象是主機甲乙丙丁戊己庚辛点[:ㄉㄧㄢ3]三五壬癸子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己。"
    for c in clauses(text):
        assert c.count("[") == c.count("]"), c


@test
def 不吃掉標點後的空白():
    out = clauses("Alert firing: WindowsHighCPU, severity warning, current value 91.35.", min_chars=8)
    joined = " ".join(out)
    assert "firing:WindowsHighCPU" not in joined and "WindowsHighCPU,severity" not in joined, out


@test
def 數字與網址裡的半形標點不切():
    out = clauses("受影響對象 192.168.1.20:9182，時間 12:30:05，網址 http://grafana.local/d/x。", min_chars=4)
    assert "受影響對象 192.168.1.20:9182，" in out, out
    assert any("12:30:05" in c for c in out), out
    assert any("http://grafana.local/d/x" in c for c in out), out


@test
def 結尾太短併回最後一段():
    assert clauses("主機 CPU 使用率過高，請檢查。") == ["主機 CPU 使用率過高，請檢查。"]


@test
def 空輸入():
    assert clauses("") == []
    assert clauses("   ") == []


@test
def 念出來的單位():
    assert spoken_units("嚴重度") == 3
    assert spoken_units("91") == 2
    assert spoken_units("warning") == 7 / 3
    assert spoken_units("A") == 1  # 一個英文字至少 1 單位
    assert spoken_units("点[:ㄉㄧㄢ3]") == 1  # 注音標註不算
    assert spoken_units("カタカナ한글") == 6  # 假名、韓文也算（第三輪複審：原本只認基本區漢字）


@test
def 秒數上限():
    # 每單位 0.45 秒＋1 秒（Qwen 實測正常約 0.21–0.25）：24 單位 → 11.8 秒。
    assert abs(clause_limit_sec(24) - 11.8) < 1e-9
    assert abs(clause_limit_sec(24, 0.8) - 20.2) < 1e-9


@test
def 正常語速不會碰到上限_念兩遍會():
    # quality.py 實測：24 單位的自我介紹念 5.0–5.4 秒、約 28 單位的帳號鎖定 5.9–6.2 秒。
    for units, normal_sec in ((24, 5.4), (28, 6.2)):
        assert not is_runaway(normal_sec, clause_limit_sec(units))
    # 整段念兩遍＋停頓：24 單位約 11 秒以上、上限 11.8 秒 → 被截在上限，判為失控。
    limit = clause_limit_sec(24)
    truncated = (qwen_max_new_tokens(limit) - 1) * FRAME_SEC
    assert is_runaway(truncated, limit)


@test
def max_new_tokens_剛好念得到上限():
    for limit in (1.0, 3.7, 11.8, 45.0):
        n = qwen_max_new_tokens(limit)
        assert (n - 1) * FRAME_SEC >= limit, (limit, n)  # n−1 個 frame 念得到上限
        assert (n - 2) * FRAME_SEC < limit, (limit, n)  # 不多給


@test
def frame_長度對得上實測():
    # 2026-10-06 實測：max_new_tokens=36 產出 2.80 秒＝35 個 frame（第一步 prefill 不產 frame）。
    assert abs((36 - 1) * FRAME_SEC - 2.80) < 1e-9


@test
def 碰到上限才算失控():
    limit = 11.8
    frames = qwen_max_new_tokens(limit) - 1  # 被截斷時恰好這麼多 frame
    assert is_runaway(frames * FRAME_SEC, limit)
    assert not is_runaway((frames - 1) * FRAME_SEC, limit)  # 少一個 frame＝自己停下來的正常句
    assert not is_runaway(5.4, limit)


@test
def 簡體也算單位():
    # 模型入口轉成簡體後才算單位；簡體字（含常用的「侦、测、库」）都在基本區。
    assert spoken_units("侦测到告警，数据库") == 8


if __name__ == "__main__":
    failed = 0
    for fn in TESTS:
        try:
            fn()
            print(f"ok    {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"{len(TESTS) - failed} pass / {failed} fail")
    sys.exit(1 if failed else 0)
