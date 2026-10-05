#!/usr/bin/env python3
"""
藍鯨男孩（2026-10-05 定稿）的嘴與眼修改：從專案主人提供的 Gemini 原圖做出
「平常（閉嘴）」「說話大開」「眨眼（閉眼）」三張。說話小開 = 原圖本身。

`python3 tools/sprite-gen/face-edits.py <原圖 1024×559 PNG> <輸出目錄>`

全部是**從原圖像素改**，不經生成模型：ComfyUI 局部重繪（Illustrious-XL ＋ Fooocus 補丁／ControlNet）
實測在這張圖 40px 大的嘴與眼上出現發光與色偏，沒有採用（見 docs/sprite/SOURCE-PROMPTS.md）。
座標是這張原圖的實量值，換圖要重量。依賴：numpy、opencv-python-headless、Pillow。
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
orig = np.array(Image.open(src).convert('RGB'))
k = np.ones((3, 3), np.uint8)

# ---- 嘴：x 505–540、y 257–277 ----
x0, x1, y0, y1 = 505, 540, 257, 277
hole = np.zeros(orig.shape[:2], np.uint8)
hole[y0:y1, x0:x1] = 1
skin = np.median(orig[y0 - 6:y0 - 2, x0:x1].reshape(-1, 3).astype(np.float32), 0)
d = np.abs(orig.astype(np.float32) - skin).max(-1)
mouth = cv2.dilate(((d > 40) & (hole > 0)).astype(np.uint8), k, iterations=2)
skinbase = cv2.cvtColor(cv2.inpaint(cv2.cvtColor(orig, cv2.COLOR_RGB2BGR), mouth * 255, 5, cv2.INPAINT_TELEA), cv2.COLOR_BGR2RGB)

# 說話大開：原圖的嘴垂直拉高 1.7 倍貼回去
patch = orig[y0:y1, x0:x1].astype(np.float32)
pa = np.clip((np.abs(patch - skin).max(-1) - 25) / 40, 0, 1)
h, w = patch.shape[:2]
nw, nh = round(w * 1.05), round(h * 1.7)
p = cv2.resize(patch, (nw, nh), interpolation=cv2.INTER_CUBIC)
a = cv2.resize(pa, (nw, nh), interpolation=cv2.INTER_CUBIC)[..., None]
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2 + 2
X0, Y0 = round(cx - nw / 2), round(cy - nh / 2)
wide = skinbase.astype(np.float32).copy()
wide[Y0:Y0 + nh, X0:X0 + nw] = wide[Y0:Y0 + nh, X0:X0 + nw] * (1 - a) + p * a
Image.fromarray(np.clip(wide, 0, 255).astype(np.uint8)).save(out / 'p_wide.png')

# 平常：舊嘴抹成膚色，畫一條短弧線（顏色取原圖嘴線最暗的 12 個像素）
sub = d[y0:y1, x0:x1].ravel()
idx = np.argsort(sub)[-12:]
line = orig[y0:y1, x0:x1][idx // (x1 - x0), idx % (x1 - x0)].mean(0)
S = 4
big = cv2.resize(skinbase, None, fx=S, fy=S, interpolation=cv2.INTER_CUBIC)
pts = np.array([[512 * S, 266 * S], [517 * S, 268 * S], [522 * S, 268.6 * S], [527 * S, 268 * S], [532 * S, 266 * S]], np.int32)
cv2.polylines(big, [pts], False, tuple(int(c) for c in line), thickness=7, lineType=cv2.LINE_AA)
idle = cv2.resize(big, (orig.shape[1], orig.shape[0]), interpolation=cv2.INTER_AREA)
Image.fromarray(idle).save(out / 'p_idle.png')

# 眨眼：在「平常」上把兩眼（含上睫毛，不含眉毛與黑眼圈）塗成臉頰膚色，再畫閉眼弧線
idle = idle.astype(np.float32)
skin_ref = np.array([249, 214, 183], np.float32)
eyes = np.zeros(idle.shape[:2], np.uint8)
for (ex0, ex1, ey0, ey1) in [(466, 506, 208, 233), (532, 584, 209, 233)]:
    eyes[ey0:ey1, ex0:ex1] = (np.abs(idle[ey0:ey1, ex0:ex1] - skin_ref).max(-1) > 38).astype(np.uint8)
eyes[:211, :] = 0
eyes = cv2.dilate(eyes, k, iterations=1)
wgt = cv2.GaussianBlur(eyes.astype(np.float32), (0, 0), 1.0)[..., None]
lid = np.median(idle[236:246, 512:530].reshape(-1, 3), 0)
base = idle * (1 - wgt) + lid * wgt
big = cv2.resize(np.clip(base, 0, 255).astype(np.uint8), None, fx=S, fy=S, interpolation=cv2.INTER_CUBIC)
lash = (40, 14, 12)


def arc(points, th):
    cv2.polylines(big, [(np.array(points) * S).astype(np.int32)], False, lash, thickness=th, lineType=cv2.LINE_AA)


arc([(468, 223), (476, 226.5), (486, 228), (496, 226.5), (504, 223.5)], 10)
arc([(468, 223), (464.5, 221)], 7)
arc([(534, 223.5), (544, 226.5), (556, 228), (568, 226.5), (580, 223)], 10)
arc([(580, 223), (583.5, 221)], 7)
blink = cv2.resize(big, (orig.shape[1], orig.shape[0]), interpolation=cv2.INTER_AREA)
Image.fromarray(blink).save(out / 'p_blink.png')
print('ok')
