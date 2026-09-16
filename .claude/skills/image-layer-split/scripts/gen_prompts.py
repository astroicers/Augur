#!/usr/bin/env python3
"""階段一：一張角色圖 → 去背 + 逐部件的 Nano Banana 2 prompt 清單（給使用者手動在 Gemini App 跑）。
用法：python3 gen_prompts.py <image> [--preset live2d-character] [--out <workdir>]"""
import sys, os, json, argparse, shutil
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import load_rgb, cutout_rgba

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXTRACT_TMPL = (
    "Using the attached character illustration as reference, output ONLY {desc} as a PNG with a "
    "fully transparent background. Keep the EXACT same art style, colors, line work, position, scale "
    "and canvas framing as the original — do not move, resize, recolor, or redraw the character. "
    "Reconstruct (inpaint) any part of {desc} that is hidden behind other elements in the original, so "
    "this layer is complete on its own. The output must be the same {W}x{H} canvas with {desc} in its "
    "original position and everything else fully transparent."
)
COMPLETE_TMPL = (
    "Using the attached character illustration as reference, output {desc} as a PNG with a fully "
    "transparent background, as if {occluder} were removed — fully reconstruct (inpaint) the parts "
    "hidden behind {occluder}. Keep the EXACT same art style, colors, line work, position, scale and "
    "{W}x{H} canvas framing as the original. Everything that is not {desc} must be fully transparent."
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--preset", default="live2d-character")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    preset_path = os.path.join(SKILL_DIR, "parts", a.preset + ".json")
    if not os.path.exists(preset_path):
        sys.exit(f"找不到 preset：{preset_path}")
    preset = json.load(open(preset_path, encoding="utf-8"))

    stem = os.path.splitext(os.path.basename(a.image))[0]
    work = a.out or os.path.join(os.path.dirname(os.path.abspath(a.image)), stem + "_layerwork")
    os.makedirs(os.path.join(work, "layers"), exist_ok=True)

    rgb = load_rgb(a.image)
    H, W = rgb.shape[:2]
    rgba, _ = cutout_rgba(rgb)
    Image.fromarray(rgba, "RGBA").save(os.path.join(work, "_cutout.png"))
    shutil.copy(a.image, os.path.join(work, "_source" + os.path.splitext(a.image)[1]))
    json.dump(preset, open(os.path.join(work, "_preset.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    lines = [
        f"# Nano Banana 2 拆層 prompt — {stem}  ({W}x{H}, preset: {a.preset})",
        "",
        "**每一筆**：在 Gemini App 開新對話 → **附上 `_cutout.png`**（或 `_source` 原圖）→ 貼下面的 prompt →",
        "把產出的圖**存成 `layers/<檔名>.png`**（檔名見每節標題）。全部跑完後執行 assemble.py 組裝驗收。",
        "",
        "> 提醒：模型可能飄移位置/重畫 → 盡量挑「全畫布、位置一致」的結果；assemble 會幫你對齊+驗收，仍可能要手動微調。",
        "",
    ]
    parts = sorted(preset["parts"], key=lambda p: p.get("z", 999))
    for p in parts:
        fn = f"part_{p['id']}.png"
        if p.get("type") == "complete":
            prompt = COMPLETE_TMPL.format(desc=p["desc"], occluder=p.get("occluder", "the covering parts"), W=W, H=H)
        else:
            prompt = EXTRACT_TMPL.format(desc=p["desc"], W=W, H=H)
        lines += [f"## {p['id']}  → 存成 `layers/{fn}`", "", "```", prompt, "```", ""]

    open(os.path.join(work, "PROMPTS.md"), "w", encoding="utf-8").write("\n".join(lines))

    print(f"✅ 工作夾：{work}")
    print(f"   _cutout.png（附給 Gemini）、_source、PROMPTS.md（{len(parts)} 筆 prompt）、layers/（回填到這）")
    print(f"   下一步：照 PROMPTS.md 逐筆在 Gemini 跑、存到 layers/，再跑：")
    print(f"   python3 {os.path.join(os.path.dirname(os.path.abspath(__file__)),'assemble.py')} {work} --src {a.image}")


if __name__ == "__main__":
    main()
