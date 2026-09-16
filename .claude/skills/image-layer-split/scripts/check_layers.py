#!/usr/bin/env python3
"""驗收：把分層圖庫對照原圖剪影檢查覆蓋率與「破洞」（剪影內、無任何層覆蓋＝缺件/沒補的遮擋）。
用法：python3 check_layers.py <圖庫資料夾> <參考圖(原圖或 cutout)>"""
import sys, os, glob
import numpy as np
from PIL import Image

try:
    from _common import foreground_mask
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from _common import foreground_mask


def _silhouette(ref_path):
    im = Image.open(ref_path)
    a = np.array(im.convert("RGBA"))
    if a[..., 3].min() == 0 and (a[..., 3] > 16).mean() < 0.95:
        return a[..., 3] > 16, a.shape[1], a.shape[0]   # 已是去背圖，用 alpha
    rgb = np.array(im.convert("RGB"))
    return foreground_mask(rgb), rgb.shape[1], rgb.shape[0]


def check(folder, ref):
    sil, W, H = _silhouette(ref)
    total = H * W
    paths = sorted(glob.glob(os.path.join(folder, "*.png")))
    paths = [p for p in paths if not os.path.basename(p).startswith("_")]
    if not paths:
        print(f"[check] {folder} 內沒有層 PNG。")
        return
    union = np.zeros((H, W), bool)
    print(f"[check] 參考剪影 {W}x{H}（角色佔 {100*sil.mean():.1f}%）；層數 {len(paths)}")
    print(f"  {'層':30s}{'不透明px':>10s}{'%畫布':>7s}  bbox")
    for p in paths:
        im = np.array(Image.open(p).convert("RGBA"))
        if im.shape[:2] != (H, W):
            print(f"  {os.path.basename(p):30s}  ⚠️ 尺寸 {im.shape[1]}x{im.shape[0]} ≠ {W}x{H}")
            continue
        a = im[..., 3] > 16
        union |= a
        n = int(a.sum())
        if n == 0:
            print(f"  {os.path.basename(p):30s}{0:>10d}{0:>7.1f}  (空)")
            continue
        ys, xs = np.where(a)
        flag = "  ⚠️極小" if n < total * 0.002 else ""
        print(f"  {os.path.basename(p):30s}{n:>10d}{100*n/total:>7.1f}  ({xs.min()},{ys.min()},{xs.max()},{ys.max()}){flag}")
    hole = sil & ~union
    extra = union & ~sil
    cov = 100 * (sil & union).sum() / max(sil.sum(), 1)
    print(f"\n[check] 覆蓋剪影 {cov:.1f}%｜破洞(剪影內未覆蓋) {100*hole.sum()/max(sil.sum(),1):.1f}%｜溢出(畫到角色外) {100*extra.sum()/total:.2f}%")
    vis = np.array(Image.open(ref).convert("RGB"))
    if vis.shape[:2] == (H, W):
        vis[hole] = (255, 0, 200)
        out = os.path.join(folder, "_holes.png")
        Image.fromarray(vis).save(out)
        print(f"[check] 破洞標示圖：{out}（粉紅＝缺件/沒補的遮擋）")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法：python3 check_layers.py <圖庫資料夾> <參考圖>")
        sys.exit(1)
    check(sys.argv[1], sys.argv[2])