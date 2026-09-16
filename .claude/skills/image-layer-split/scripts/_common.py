"""image-layer-split 共用工具：去背（四角 flood-fill）+ 載圖。純 Pillow+numpy+scipy，無 GPU/AI。"""
import numpy as np
from PIL import Image
from scipy import ndimage


def load_rgb(path):
    return np.asarray(Image.open(path).convert("RGB"))


def foreground_mask(rgb, tol=22.0):
    """四角取背景色，色距 < tol 且與邊界相連者 = 背景；回傳前景 bool 遮罩。
    適用純色/接近純色背景（立繪常見）。tol 預設 22：銀髮等亮色（色距≈23）不會被吃。"""
    rgb = np.asarray(rgb)[..., :3].astype(np.int16)
    H, W, _ = rgb.shape
    corners = np.vstack([
        rgb[:12, :12].reshape(-1, 3), rgb[:12, -12:].reshape(-1, 3),
        rgb[-12:, :12].reshape(-1, 3), rgb[-12:, -12:].reshape(-1, 3),
    ])
    bgcol = corners.mean(0)
    dist = np.sqrt(((rgb - bgcol) ** 2).sum(2))
    bgcand = dist < tol
    border = np.zeros((H, W), bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    bg = ndimage.binary_propagation(bgcand & border, mask=bgcand)
    fg = ndimage.binary_fill_holes(~bg)
    return fg


def cutout_rgba(rgb, tol=22.0):
    """回傳去背 RGBA（前景保留、背景透明）。"""
    rgb = np.asarray(rgb)[..., :3]
    fg = foreground_mask(rgb, tol)
    return np.dstack([rgb, (fg * 255).astype(np.uint8)]), fg
