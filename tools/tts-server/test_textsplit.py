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
    UPSTREAM_MAX_RATIO,
    cap_ratio,
    clause_max_tokens,
    clauses,
    spoken_units,
    upstream_max_len,
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
def 上限與上游的_float32_算法一致():
    # 第三輪複審 P1：上游以 int32 tensor × float 算 max_len（float32），用 float64 回推會差 1，
    # 失控跑滿上限也不會被判定。cap_ratio 加 0.5 之後，上游算出來必須剛好是 max_tokens。
    bad = []
    for t in range(1, 200):
        for m in range(50, 2000, 7):
            r = cap_ratio(m, t)
            if r < UPSTREAM_MAX_RATIO and upstream_max_len(t, r) != m:
                bad.append((t, m))
    assert not bad, bad[:5]


@test
def 已知會出錯的那組():
    # 不加 0.5 時 T=47、M=1010 上游得 1009（torch 實測）；加了之後必須是 1010。
    assert upstream_max_len(47, 1010 / 47) == 1009
    assert upstream_max_len(47, cap_ratio(1010, 47)) == 1010


@test
def 倍數不超過上游原本的_30_倍():
    assert cap_ratio(10_000, 10) == UPSTREAM_MAX_RATIO


@test
def 秒數上限():
    # 每單位 0.8 秒＋1 秒，50 token/秒：24 單位 → 20.2 秒 → 1010 token（自我介紹那句）。
    assert clause_max_tokens(24, 0.8) == 1010


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
