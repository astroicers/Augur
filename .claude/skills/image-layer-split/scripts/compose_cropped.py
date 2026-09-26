#!/usr/bin/env python3
"""把「bbox 裁切、無位置」的部位圖（如 namei 匯出）依 layout 放回全畫布 → 定位分層圖庫 + 組合預覽。
用法：python3 compose_cropped.py <partsdir> --layout layout.json [--out DIR]
layout.json: { "canvas":[W,H], "parts":{ "<name>":{"cx":..,"cy":..,"z":..} } }
partsdir 內檔名須為 <name>.png（對應 layout 的 key）。"""
import sys, os, json, glob, argparse
from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("partsdir")
    ap.add_argument("--layout", required=True)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    lay = json.load(open(a.layout, encoding="utf-8"))
    W, H = lay["canvas"]
    out = a.out or a.partsdir
    lib = os.path.join(out, "library")
    os.makedirs(lib, exist_ok=True)

    present = {os.path.splitext(os.path.basename(p))[0]: p for p in glob.glob(os.path.join(a.partsdir, "*.png"))}
    manifest, missing_layout, missing_file = [], [], []
    for name in present:
        if name not in lay["parts"]:
            missing_layout.append(name)

    comp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for name, pos in sorted(lay["parts"].items(), key=lambda kv: kv[1].get("z", 999)):
        if name not in present:
            missing_file.append(name); continue
        part = Image.open(present[name]).convert("RGBA")
        x, y = int(pos["cx"] - part.width / 2), int(pos["cy"] - part.height / 2)
        # 全畫布定位層（供綁定/匯入）
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(part, (x, y))
        canvas.save(os.path.join(lib, f"part_{name}.png"))
        comp.alpha_composite(canvas)
        manifest.append({"id": name, "z": pos.get("z", 999), "pos": [x, y],
                         "size": [part.width, part.height], "file": f"part_{name}.png"})

    json.dump({"canvas": [W, H], "layers": manifest, "missing_file": missing_file,
               "not_in_layout": missing_layout},
              open(os.path.join(out, "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    # 預覽（透明 + 淺灰底兩版）
    comp.save(os.path.join(out, "_composed.png"))
    bg = Image.new("RGBA", (W, H), (235, 235, 235, 255)); bg.alpha_composite(comp)
    bg.convert("RGB").save(os.path.join(out, "_preview.png"))

    print(f"✅ 定位圖庫：{lib}/（{len(manifest)} 層,全畫布 {W}x{H})")
    print(f"   組合預覽：{os.path.join(out,'_preview.png')}｜透明：_composed.png｜manifest.json")
    if missing_file:
        print(f"⚠️ layout 有列但 partsdir 缺檔：{', '.join(missing_file)}")
    if missing_layout:
        print(f"⚠️ partsdir 有檔但 layout 沒列(未放入)：{', '.join(missing_layout)}")
    print("   位置不對 → 改 layout.json 的 cx/cy 重跑即可。")


if __name__ == "__main__":
    main()
