#!/usr/bin/env python3
"""
A3 拆層「起手 prepass」：去背 + 依色彩切主要區域遮罩。
這是 SCAFFOLD（粗略起手），不是最終 Live2D 部件：
  - 不做遮擋補畫（額頭/眼白/斗篷後肩）→ 需 Gemini/Photoshop。
  - 不細分同色部件（髮 front/side/back、虹膜/眼白/眼皮）→ 需人工。
輸出：cutout（透明去背）+ 各區域遮罩 PNG + 一張彩色 preview 供目視檢查分割品質。
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/Augur/assets/a1-augur-calm.png"
OUTDIR = "/home/ubuntu/Augur/assets/layers"
import os
os.makedirs(OUTDIR, exist_ok=True)

im = Image.open(SRC).convert("RGB")
rgb = np.asarray(im).astype(np.int16)
H, W, _ = rgb.shape

# ---- 1) 去背：四角取背景色，色距內且與邊界相連者 = 背景 ----
corners = np.vstack([rgb[:12, :12].reshape(-1, 3), rgb[:12, -12:].reshape(-1, 3),
                     rgb[-12:, :12].reshape(-1, 3), rgb[-12:, -12:].reshape(-1, 3)])
bgcol = corners.mean(0)
dist = np.sqrt(((rgb - bgcol) ** 2).sum(2))
bgcand = dist < 22.0                      # 接近背景色（髮銀藍色距≈23，故 <22 不會吃到髮）
border = np.zeros((H, W), bool)
border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
seeds = bgcand & border
bg = ndimage.binary_propagation(seeds, mask=bgcand)   # 只長出與邊界相連的背景
fg = ~bg
fg = ndimage.binary_fill_holes(fg)
fg = ndimage.binary_opening(fg, iterations=1)         # 去雜點
# 取最大連通區當主體
lbl, n = ndimage.label(fg)
if n > 1:
    sizes = ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1))
    fg = lbl == (np.argmax(sizes) + 1)

rgba = np.dstack([np.asarray(im), (fg * 255).astype(np.uint8)])
Image.fromarray(rgba, "RGBA").save(f"{OUTDIR}/../a1-augur-calm-cutout.png")

# ---- 2) 色彩分區（HSV，PIL 尺度 0..255）----
hsv = np.asarray(im.convert("HSV")).astype(np.int16)
Hh, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]

region = np.zeros((H, W), np.uint8)       # 0=未分類
# 順序有優先權：先暗（線稿/眼），再斗篷(藍且暗)，再髮(亮冷低彩)，再膚(暖)，再上衣(中性暗)
dark     = fg & (V < 70)
capelet  = fg & (~dark) & (S > 70) & (Hh > 140) & (Hh < 180) & (V < 165)   # navy 藍、彩度高、偏暗
hair     = fg & (~dark) & (~capelet) & (V > 150) & (S < 95) & (Hh > 120) & (Hh < 185)  # 銀藍、亮、低彩、冷
skin     = fg & (~dark) & (~capelet) & (~hair) & (V > 150) & ((Hh < 30) | (Hh > 235))  # 暖膚
top      = fg & (~dark) & (~capelet) & (~hair) & (~skin) & (S < 70)        # charcoal 中性
for val, m in [(1, dark), (2, capelet), (3, hair), (4, skin), (5, top)]:
    region[m] = val
region[fg & (region == 0)] = 6            # 其餘歸 leftover

names = {1: "dark_eyes_lineart", 2: "capelet", 3: "hair", 4: "skin", 5: "top", 6: "leftover"}
src_rgb = np.asarray(im)
counts = {}
for val, name in names.items():
    m = region == val
    counts[name] = int(m.sum())
    out = np.dstack([src_rgb, (m * 255).astype(np.uint8)])
    Image.fromarray(out, "RGBA").save(f"{OUTDIR}/part_{name}.png")

# ---- 3) 彩色 preview（目視分割品質）----
palette = {0: (220, 220, 220), 1: (30, 30, 30), 2: (40, 70, 160), 3: (150, 200, 230),
           4: (245, 215, 195), 5: (90, 90, 100), 6: (255, 0, 200)}
prev = np.zeros((H, W, 3), np.uint8)
for val, col in palette.items():
    prev[region == val] = col
Image.fromarray(prev, "RGB").save(f"{OUTDIR}/_preview_segmentation.png")

fgpix = int(fg.sum())
print("前景像素:", fgpix, f"({100*fgpix/(H*W):.1f}% of canvas)")
print("各區像素佔前景比例:")
for name, c in counts.items():
    print(f"  {name:18s} {100*c/max(fgpix,1):5.1f}%")
print("輸出:")
print("  assets/a1-augur-calm-cutout.png  (去背透明)")
print("  assets/layers/part_*.png         (各區起手遮罩)")
print("  assets/layers/_preview_segmentation.png")
