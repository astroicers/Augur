"""
產生 Augur 男童聲的參考音（ADR-005 決策 7）。產物不進 repo，換機器時重跑這支就好。

不用任何真人兒童的錄音。步驟：
  1. BreezyVoice 內建聲紋「中文男」念一段固定的話 —— 成人男聲、台灣華語（F0 約 85 Hz）。
  2. Praat 的 Change gender 把共振峰與音高一起往上推成小男孩。
     只推音高聽起來是「吸了氦氣的大人」；童聲的關鍵是共振峰（聲道短）。
  3. 存成 voices/boy.wav 與逐字稿 voices/boy.txt，server.py 拿它做 zero-shot。

強度預設是使用者 2026-10-05 試聽後選的「輕」檔：共振峰 ×1.25、F0 中位數 220 Hz。
另兩檔（×1.30／250 Hz、×1.35／280 Hz）可用 --formant / --pitch 重現。
語速（--rate）與種子（--seed）見各自的說明；同一張顯卡、同一個種子會產出同一段參考音。

Parselmouth 是 GPL-3.0，只在這支本機工具裡用，不進 plugin、不散布。
"""

from __future__ import annotations

import argparse
import re
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BREEZY = Path(os.environ.get("BREEZYVOICE_DIR", Path.home() / "engines" / "BreezyVoice")).resolve()

# 參考音念的內容。改了它，boy.txt 會跟著寫，兩者必須一致（zero-shot 要逐字稿對得上）。
REFERENCE_TEXT = "今天天氣很好，我們一起去公園散步吧。如果你有任何問題，可以隨時問我，我會盡量回答你。"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--formant", type=float, default=1.25, help="共振峰倍率（預設 1.25）")
    ap.add_argument("--pitch", type=float, default=220.0, help="目標 F0 中位數 Hz（預設 220）")
    # 語速會被 zero-shot 學走（輸出約為參考音的 1.1–1.3 倍），而服務產語音的時間與語音長度成正比 ——
    # 念得慢就是產得慢。2026-10-05 實測：參考音 4.0 字/秒 → 輸出 4.4 字/秒；5.0 → 6.4、生成時間少 32%。
    # 用「目標字/秒」而不是固定時長倍率：成人男聲那一步每次取樣的快慢不同，固定倍率會跟著漂。
    ap.add_argument("--rate", type=float, default=4.6, help="參考音的目標語速，字/秒（預設 4.6，輸出約 5–6 字/秒）")
    # 種子 1：2026-10-05 掃 0–7，「中文男」念這段的速度 2.8–4.0 字/秒，種子 1 最接近口語（4.0），
    # 只需壓 0.87 倍；其他種子要壓到 0.61–0.77，PSOLA 壓太多會不自然。
    ap.add_argument("--seed", type=int, default=1, help="成人男聲那一步的取樣種子；固定才重現得出同一段參考音（預設 1）")
    ap.add_argument("--out", type=Path, default=HERE / "voices" / "boy.wav")
    args = ap.parse_args()
    out = args.out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(BREEZY))
    os.chdir(BREEZY)
    import parselmouth
    import torchaudio
    from g2pw import G2PWConverter
    from parselmouth.praat import call
    from single_inference import CustomCosyVoice, get_bopomofo_rare

    import torch

    cosy = CustomCosyVoice("MediaTek-Research/BreezyVoice")
    g2p = G2PWConverter()
    torch.manual_seed(args.seed)
    text = get_bopomofo_rare(cosy.frontend.text_normalize_new(REFERENCE_TEXT, split=False), g2p)
    adult = cosy.model.inference(**cosy.frontend.frontend_sft(text, "中文男"))["tts_speech"]

    adult_path = out.with_name(out.stem + ".adult.wav")
    torchaudio.save(str(adult_path), adult, 22050)
    snd = parselmouth.Sound(str(adult_path))
    # 參數：最低／最高音高 60／400 Hz、共振峰倍率、新 F0 中位數、音高範圍倍率 1.2、時長倍率。
    chars = len(re.sub(r"[，。！？、\s]", "", REFERENCE_TEXT))
    duration_factor = (chars / args.rate) / snd.duration
    boy = call(snd, "Change gender", 60, 400, args.formant, args.pitch, 1.2, duration_factor)
    boy.scale_peak(0.95)  # 推音高後偶有削峰
    boy.save(str(out), "WAV")
    out.with_suffix(".txt").write_text(REFERENCE_TEXT + "\n", encoding="utf-8")
    adult_path.unlink()

    f0 = call(boy.to_pitch(), "Get quantile", 0, 0, 0.5, "Hertz")
    print(
        f"寫入 {out}（{boy.duration:.1f} 秒、{chars / boy.duration:.1f} 字/秒、時長倍率 {duration_factor:.2f}、"
        f"F0 中位數 {f0:.0f} Hz）與逐字稿 {out.with_suffix('.txt').name}"
    )


if __name__ == "__main__":
    main()
