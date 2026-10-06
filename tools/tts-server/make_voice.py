"""
產生 Augur 年輕男聲的參考音（ADR-005 決策 7）。產物不進 repo。

聲音由 Qwen3-TTS **VoiceDesign** 依文字描述直接生成：**不變聲、不使用任何真人錄音**。
server.py 再用 Qwen3-TTS Base 照這段聲音念，聲線才會每一句都一樣（官方建議的「先設計、再複製」流程）。

使用者 2026-10-06 試聽後選定的是「年輕男生、簡體輸入」那一段（下面的 DESCRIPTION 與 TEXT）。
取樣是隨機的，重跑不保證得到同一段聲音 —— 要沿用選定的那一段，用 --from 指定它的檔案：

    conda activate qwen3tts && export PYTHONNOUSERSITE=1
    python tools/tts-server/make_voice.py                      # 重新生成（聲音可能與選定的略有不同，請試聽）
    python tools/tts-server/make_voice.py --from <選定的.wav>  # 沿用選定的那一段

寫入 voices/young_male.wav 與逐字稿 voices/young_male.txt（繁體；server 讀取時才轉簡體）。
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent

# 2026-10-06 使用者選定那一段的描述。寫「台灣口音」時模型念成廣東話，所以改寫「標準普通話」。
DESCRIPTION = "一个二十出头的年轻男生，声音温和明亮。说标准普通话，字正腔圆，不带任何方言口音。说话自然亲切。"
# 參考音念的內容（也是逐字稿）。
TEXT = "嗨，我是藍鯨小弟，我會幫你盯著儀表板，有告警就念給你聽。"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="src", type=Path, help="沿用既有的 wav（逐字稿必須是 TEXT）")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=HERE / "voices" / "young_male.wav")
    args = ap.parse_args()
    out = args.out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    if args.src:
        shutil.copyfile(args.src, out)
    else:
        import soundfile as sf
        import torch
        from opencc import OpenCC
        from qwen_tts import Qwen3TTSModel

        model = Qwen3TTSModel.from_pretrained(
            "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cuda:0", dtype=torch.bfloat16
        )
        torch.manual_seed(args.seed)
        # 模型入口一律轉簡體（繁體輸入時模型常念成廣東話）。
        wavs, sr = model.generate_voice_design(
            text=OpenCC("t2s").convert(TEXT), instruct=DESCRIPTION, language="Chinese"
        )
        sf.write(out, wavs[0], sr, subtype="PCM_16")
    out.with_suffix(".txt").write_text(TEXT + "\n", encoding="utf-8")
    print(f"寫入 {out} 與逐字稿 {out.with_suffix('.txt').name}")


if __name__ == "__main__":
    main()
