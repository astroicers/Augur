#!/usr/bin/env python3
"""階段二：把回填的層 PNG → 對齊原畫布 + 去背鍵控 + 依 z-order 組裝 manifest/preview + 驗收。
用法：python3 assemble.py <workdir> --src <image>"""
import sys, os, json, argparse
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import load_rgb, foreground_mask
import check_layers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--src", required=True)
    ap.add_argument("--tol", type=float, default=22.0)
    a = ap.parse_args()

    rgb = load_rgb(a.src)
    H, W = rgb.shape[:2]
    preset = json.load(open(os.path.join(a.workdir, "_preset.json"), encoding="utf-8"))
    layers_dir = os.path.join(a.workdir, "layers")
    lib = os.path.join(a.workdir, "library")
    os.makedirs(lib, exist_ok=True)

    manifest, missing = [], []
    for p in sorted(preset["parts"], key=lambda x: x.get("z", 999)):
        src_png = os.path.join(layers_dir, f"part_{p['id']}.png")
        if not os.path.exists(src_png):
            missing.append(p["id"]); continue
        im = Image.open(src_png).convert("RGBA")
        # 對齊：尺寸不符就 resize 到原畫布（prompt 已要求 full-canvas；此為收尾）
        if im.size != (W, H):
            ar_src, ar_lay = W / H, im.width / im.height
            note = "（⚠️長寬比不同，可能需手動對位）" if abs(ar_src - ar_lay) > 0.02 else ""
            print(f"  {p['id']}: resize {im.width}x{im.height} → {W}x{H} {note}")
            im = im.resize((W, H), Image.LANCZOS)
        arr = np.array(im)
        # 鍵控：模型沒給透明（不透明面積>95%）就用四角 flood-fill 去背
        if (arr[..., 3] < 16).mean() <= 0.05:
            fg = foreground_mask(arr[..., :3], a.tol)
            arr[..., 3] = (fg * 255).astype(np.uint8)
        Image.fromarray(arr, "RGBA").save(os.path.join(lib, f"part_{p['id']}.png"))
        m = arr[..., 3] > 16
        n = int(m.sum())
        bbox = None
        if n:
            ys, xs = np.where(m)
            bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
        manifest.append({"id": p["id"], "z": p.get("z", 999), "file": f"part_{p['id']}.png",
                         "opaque_px": n, "bbox": bbox})

    json.dump({"canvas": [W, H], "layers": manifest, "missing": missing},
              open(os.path.join(a.workdir, "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)

    # 依 z-order 疊出 preview（看層能不能重組回角色）
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    for m in manifest:
        canvas.alpha_composite(Image.open(os.path.join(lib, m["file"])).convert("RGBA"))
    canvas.convert("RGB").save(os.path.join(a.workdir, "_preview.png"))

    print(f"\n✅ 組裝完成：{lib}/  manifest.json  _preview.png")
    if missing:
        print(f"⚠️ 缺少未回填的層：{', '.join(missing)}")
    print()
    check_layers.check(lib, a.src)


if __name__ == "__main__":
    main()
