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
if grep -rnE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]\.{1,2}/[^'\"]*\.js['\"]" src --include='*.ts' --include='*.tsx'; then
  echo 'check-js-suffix: relative .js import suffix found (see above)'
  exit 1
fi
echo 'check-js-suffix: OK'
