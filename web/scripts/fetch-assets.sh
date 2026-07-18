#!/usr/bin/env bash
# 下載 Augur/web 前端所需的第三方 avatar 資產（刻意不進 git）。
set -euo pipefail
cd "$(dirname "$0")/../public"

echo "[fetch] VRM sample avatar（three-vrm sample, MIT）…"
curl -fsSL "https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm" -o avatar.vrm

echo "[fetch] Cubism Core（Live2D 專有 runtime；?avatar=live2d 才需要）…"
curl -fsSL "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js" -o live2dcubismcore.min.js

echo "[fetch] Hiyori Live2D sample（Live2D Free Material License；?avatar=live2d 才需要）…"
mkdir -p models
curl -fsSL "https://github.com/Live2D/CubismWebSamples/archive/refs/heads/develop.tar.gz" \
  | tar xz -C models --wildcards '*/Samples/Resources/Hiyori/*' --strip-components=4

echo "[fetch] 完成。"
ls -la
