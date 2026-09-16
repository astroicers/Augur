#!/usr/bin/env python3
"""
A3 圖層驗收：把 AI 拆層工具產出的各層 PNG 對照 A1 剪影檢查。
用法：
  python3 live2d/scripts/check_layers.py <圖層資料夾> [參考剪影 png]
報告：
  - 每層：不透明像素、bbox、佔畫布比例
  - 全部層疊起來 vs A1 剪影 → 標出「破洞」(角色內、沒被任何層覆蓋的區域 = 缺件/未補遮擋)
  - 空層 / 極小層警告
與 §4a 部件清單對照(語意命名)由我讀圖人工判斷;本腳本給客觀覆蓋數據。
"""
import sys, os, glob
import numpy as np
from PIL import Image

folder = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/Augur/assets/layers_ai"
ref = sys.argv[2] if len(sys.argv) > 2 else "/home/ubuntu/Augur/assets/a1-augur-calm-cutout.png"

if not os.path.isdir(folder):
    print(f"找不到資料夾 {folder} — 請把 AI 拆層產出的各層 PNG 放這裡再跑。")
    sys.exit(1)

refimg = np.array(Image.open(ref).convert("RGBA"))
Hc, Wc = refimg.shape[:2]
silhouette = refimg[..., 3] > 16
total = Hc * Wc

paths = sorted(glob.glob(os.path.join(folder, "*.png")))
if not paths:
    print(f"{folder} 內沒有 PNG。")
    sys.exit(1)

union = np.zeros((Hc, Wc), bool)
print(f"參考剪影: {ref}  ({Wc}x{Hc}, 角色佔 {100*silhouette.mean():.1f}%)")
print(f"圖層數: {len(paths)}\n")
print(f"{'層檔名':32s}{'不透明px':>10s}{'%畫布':>7s}  bbox(x0,y0,x1,y1)")
for p in paths:
    im = np.array(Image.open(p).convert("RGBA"))
    if im.shape[:2] != (Hc, Wc):
        print(f"{os.path.basename(p):32s}  ⚠️ 尺寸 {im.shape[1]}x{im.shape[0]} 不等於畫布 {Wc}x{Hc}（需對齊!）")
        continue
    a = im[..., 3] > 16
    union |= a
    n = int(a.sum())
    if n == 0:
        print(f"{os.path.basename(p):32s}{0:>10d}{0:>7.1f}  (空層)")
        continue
    ys, xs = np.where(a)
    bbox = (xs.min(), ys.min(), xs.max(), ys.max())
    flag = "  ⚠️ 極小" if n < total * 0.002 else ""
    print(f"{os.path.basename(p):32s}{n:>10d}{100*n/total:>7.1f}  {bbox}{flag}")

# 破洞：在剪影內、但沒有任何層覆蓋
hole = silhouette & ~union
hole_pct = 100 * hole.sum() / max(silhouette.sum(), 1)
extra = union & ~silhouette  # 超出剪影(層畫到角色外)
print(f"\n疊合覆蓋:層union 蓋住剪影的 {100*(silhouette&union).sum()/max(silhouette.sum(),1):.1f}%")
print(f"破洞(剪影內未被覆蓋): {hole_pct:.1f}%  ← 高代表缺件或遮擋沒補")
print(f"溢出(層畫到角色外): {100*extra.sum()/max(total,1):.2f}%")

# 輸出破洞視覺圖供目視
vis = np.array(Image.open(ref).convert("RGB"))
vis[hole] = (255, 0, 200)
Image.fromarray(vis).save(os.path.join(folder, "_holes.png"))
print(f"破洞標示圖: {os.path.join(folder, '_holes.png')}")
