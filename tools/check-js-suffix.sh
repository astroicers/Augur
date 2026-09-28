#!/usr/bin/env bash
# 禁止 src/ 內出現帶 .js 副檔名的相對 import。
# webpack 的 resolve.extensions 無 extensionAlias、jest 的 moduleNameMapper 只映 css 與
# react-inlinesvg，兩者都解不到；但 tsc 在任何 moduleResolution 下都會把 .js 自動對映回 .ts，
# 所以 `npm run typecheck` 永遠綠 —— 這是個會騙人的坑，必須用獨立守門釘住。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ ! -d src ]; then echo 'check-js-suffix: src/ missing'; exit 1; fi
# 四種寫法都要抓：from './x.js'、import './x.js'（side-effect）、
# import('./x.js')（動態）、require('./x.js')。原版只抓 from 與 import(。
#
# ⚠️ **不要寫成 `if grep …; then`。** grep 的退出碼有三種語意：
# 0 = 有命中、1 = 沒命中、>=2 = grep 自己出錯（目錄不可讀、參數壞掉…）。
# `if` 只分真假，於是 >=2 會被當成「沒命中」而**靜默放行** ——
# 實測：`chmod 000 src/locked` 之後，裡面帶 `.js` 後綴的檔案完全沒被掃到，
# 閘門仍印 OK 並回 0。掃不到不等於乾淨，必須分成三路。
PATTERN="(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]\.{1,2}/[^'\"]*\.js['\"]"
# .mts / .cts 也要掃：它們同樣被 tsc 接受，而原本的 --include 只有 .ts/.tsx。
HITS=$(grep -rnE "$PATTERN" src \
  --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' 2>&1)
RC=$?
case "$RC" in
  0)
    printf '%s\n' "$HITS"
    echo 'check-js-suffix: relative .js import suffix found (see above)'
    exit 1
    ;;
  1)
    echo 'check-js-suffix: OK'
    ;;
  *)
    printf '%s\n' "$HITS"
    echo "check-js-suffix: TOOL-ERROR grep 退出碼 $RC —— 有檔案沒掃到，不能當成通過"
    exit 1
    ;;
esac
