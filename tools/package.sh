#!/usr/bin/env bash
# 產出可散布的 plugin zip：`npm run package`。
#
# 為什麼需要它：Grafana 的安裝單位是「一個以 plugin id 命名、內含 plugin.json
# 的目錄」。repo 的 dist/ 內容正確但**目錄名不對**（叫 dist），而官方打包文件
# 的做法就是改名再 zip。這裡不動 dist/（dev 的掛載指著它），改在暫存目錄組。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f dist/plugin.json ]; then
  echo 'package: dist/plugin.json 不存在 —— 先跑 npm run build（npm run package 會自動做）'
  exit 1
fi

PLUGIN_ID=$(node -p "require('./dist/plugin.json').id")
VERSION=$(node -p "require('./dist/plugin.json').info.version")
OUT="${PLUGIN_ID}-${VERSION}.zip"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp -r dist "$TMP/$PLUGIN_ID"
rm -f "$OUT"
(cd "$TMP" && zip -qr - "$PLUGIN_ID") > "$OUT"

# 驗證產物自己：zip 裡必須有 <id>/plugin.json，且版本要對得上。
if ! unzip -l "$OUT" | grep -q "$PLUGIN_ID/plugin.json"; then
  echo "package: $OUT 裡找不到 $PLUGIN_ID/plugin.json —— 打包壞了"
  exit 1
fi
echo "package: $OUT（$(du -h "$OUT" | cut -f1)）"
echo "  安裝：解壓到 Grafana 的 plugins 目錄，並設定"
echo "  GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=$PLUGIN_ID 後重啟 Grafana"
