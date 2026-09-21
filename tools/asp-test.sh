#!/usr/bin/env bash
# 產生 ASP ship-gate 讀的 .asp-test-result.json。
#
# 為什麼不是「跑完 jest 看退出碼」這麼簡單：
#  1. hook 只讀 .asp-test-result.json 的 .passed，讀不到本腳本的退出碼 ——
#     所以判定必須完整編碼在寫出的 JSON 裡。
#  2. --passWithNoTests 在零命中時 exit 0 並印 'No tests found'。
#  3. numTotalTests 把 skipped 算進去（test.skip x18 會騙過 >=18）。
#  4. suite 跑不起來時（.js 後綴的失敗模式）numFailedTests 是 0，
#     只有 numFailedTestSuites / numRuntimeErrorTestSuites 會反應。
#  5. **jest 根本沒起來時**（設定壞掉 / crash / npx 失敗）它不會寫出 --outputFile，
#     於是上一輪留在磁碟上的綠色結果會被當成本輪的。這是最危險的一種，
#     因為它會讓一次「完全沒執行的測試」蓋章放行一次 commit。
#     擋法有二：跑之前先刪掉結果檔，且把 jest 的退出碼一起納入判定。
#
# 本腳本的【最後一個動作】必須是寫 .asp-test-result.json —— hook 的判定是
# [ ! "$IDX" -nt "$TR" ]，而 git status / git diff 會刷新 .git/index 的 mtime。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

command -v jq >/dev/null 2>&1 || { echo 'asp-test: jq 不存在，無法產生測試痕跡'; exit 1; }

# 閘門不能只看 jest —— jest 覆蓋不到 module.ts 與 panelOptions.ts
# （`SimplePanel.tsx` 是腳手架的檔，早就不存在了，原註解寫錯）。
# MascotPanel 自 2026-09-21 起有三條接線測試，但 PanelPlugin 的註冊本身仍然只有
# typecheck 與 lint 在擋 —— 一個壞掉的 setPanelOptions 不會讓任何測試紅。
# 逐項各自記錄，不共用一個旗標 —— .asp-test-result.json 的 summary 是 ASP hook
# 唯一會讀的痕跡，把 sprite 的失敗寫成「typecheck 未過」比不寫更糟。
GATE_OK=true
FAILED=''
echo '--- typecheck ---'
npm run --silent typecheck || { GATE_OK=false; FAILED="$FAILED typecheck"; }
echo '--- lint ---'
npm run --silent lint || { GATE_OK=false; FAILED="$FAILED lint"; }
echo '--- .js 副檔名守門 ---'
bash tools/check-js-suffix.sh || { GATE_OK=false; FAILED="$FAILED js-suffix"; }

# sprite 素材驗收（SP-7.13）。素材未交付時這一步印 sentinel 並回 0，成本近乎零。
echo '--- sprite 素材 ---'
SPRITE_OUT=$(node tools/check-sprite-sheets.mjs 2>&1) || { GATE_OK=false; FAILED="$FAILED sprites"; }
echo "$SPRITE_OUT" | tail -3
# 四種結局各自有字，不要用「已驗」概括 —— 「manifest 壞掉」與「素材通過」
# 寫成同一句，等於把 SP-7.11 特地分出來的退出碼分級在痕跡裡抹掉。
case "$SPRITE_OUT" in
  *'SPRITE-CHECK: NOT-DELIVERED'*) SPRITE_SUM='sprites: 未交付' ;;
  *'SPRITE-CHECK: PASS'*)          SPRITE_SUM='sprites: 通過' ;;
  *'SPRITE-CHECK: TOOL-ERROR'*)    SPRITE_SUM='sprites: 工具或格式錯誤' ;;
  *)                               SPRITE_SUM='sprites: 素材違規' ;;
esac

# sprite 工具自身的回歸測試。它驗的交付物還不存在，在素材進來之前，
# 這是唯一在維持那十幾條檢查誠實的東西（合成基準全綠 + 逐條變異體紅在該紅的地方）。
# 約 16 秒；若日後覺得太貴，搬去 CI 是可接受的取捨，但不要靜默拿掉。
# Grafana 版本變更觸發器。跨 panel DOM 是本專案唯一 unsupported 的部分，
# 而「每次 minor 升版重跑 G-ADR004-4」這條規則原本只活在 ARCHITECTURE.md 的散文裡 ——
# 升版的人不會去讀那一行。這道檢查把它變成機械的。
echo '--- Grafana 版本 ---'
COMPOSE_TAG=$(grep -oE 'grafana/grafana:[0-9.]+' monitoring/docker-compose.yml | head -1 | cut -d: -f2)
VERIFIED_TAG=$(head -1 monitoring/VERIFIED-GRAFANA.txt 2>/dev/null | tr -d '[:space:]')
if [ -z "$COMPOSE_TAG" ] || [ -z "$VERIFIED_TAG" ]; then
  echo "grafana-version: 讀不到 tag（compose='$COMPOSE_TAG' verified='$VERIFIED_TAG'）"
  GATE_OK=false; FAILED="$FAILED grafana-version"
  GRAFANA_SUM='grafana: 版本讀不到'
elif [ "$COMPOSE_TAG" != "$VERIFIED_TAG" ]; then
  echo "grafana-version: compose 是 $COMPOSE_TAG，最後通過 G-ADR004-4 的是 $VERIFIED_TAG"
  echo "  → Grafana 版本已變更，需重跑 **G-ADR004-4**（漸進降級）並把新 tag 寫進 monitoring/VERIFIED-GRAFANA.txt"
  GATE_OK=false; FAILED="$FAILED grafana-version"
  GRAFANA_SUM="grafana: $COMPOSE_TAG 未驗（上次 $VERIFIED_TAG），需重跑 G-ADR004-4"
else
  echo "grafana-version: $COMPOSE_TAG（與 G-ADR004-4 通過時相同）"
  GRAFANA_SUM="grafana: $COMPOSE_TAG 已驗"
fi

# ASP 鐵則四的「逾 180 天提醒複查」在本 repo 沒有任何機械承接（無 .asp/）。
# 這一段只提醒、不擋 —— 外部事實過期是風險不是錯誤。
FACT_CHECK_DATE='2026-09-16'
FACT_AGE_DAYS=$(( ( $(date -u +%s) - $(date -u -d "$FACT_CHECK_DATE" +%s) ) / 86400 ))
if [ "$FACT_AGE_DAYS" -gt 180 ]; then
  echo "fact-check: ADR-004 的外部事實查證距今 $FACT_AGE_DAYS 天（> 180），建議複查"
  GRAFANA_SUM="$GRAFANA_SUM；外部事實查證逾 $FACT_AGE_DAYS 天"
fi

echo '--- sprite 工具自測 ---'
node tools/check-sprite-sheets.selftest.mjs | tail -2 || { GATE_OK=false; FAILED="$FAILED sprite-selftest"; }

echo '--- jest ---'
# 先刪：jest 沒起來時不會寫這個檔，殘留的舊檔會被誤當成本輪結果。
rm -f .jest-result.json
npx jest --ci --maxWorkers=4 --json --outputFile=.jest-result.json
JEST_EXIT=$?

# MIN_TESTS = 所有測試檔之和（core 四支 18 + sources/panelAlerts 13 + avatar/gaze 5 + avatar/flap 7 + avatar/spriteSheet 6 + components/MascotPanel 6）。
# 增刪測試時必須同步更新這個數字，否則閘門會對「測試被刪掉」無感。
MIN_TESTS=55

if [ "$JEST_EXIT" = 0 ] && [ -f .jest-result.json ] && jq -e \
  ".success == true and .numFailedTests == 0 and .numFailedTestSuites == 0 \
   and .numRuntimeErrorTestSuites == 0 and .numPendingTests == 0 \
   and ((.numTodoTests // 0) == 0) and .numPassedTests >= $MIN_TESTS" \
  .jest-result.json >/dev/null 2>&1; then
  JEST_OK=true
  SUM=$(jq -r '"\(.numPassedTests) pass / \(.numFailedTests) fail / \(.numTotalTestSuites) suites"' .jest-result.json)
else
  JEST_OK=false
  SUM="jest 未通過或未產生結果（exit=$JEST_EXIT）"
fi

if [ "$GATE_OK" = true ] && [ "$JEST_OK" = true ]; then
  PASSED=true
else
  PASSED=false
  [ "$GATE_OK" = true ] || SUM="未過：${FAILED# }；$SUM"
fi
SUM="$SUM；$SPRITE_SUM；$GRAFANA_SUM"

jq -n --argjson p "$PASSED" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg cmd 'tools/asp-test.sh（typecheck + lint + check-js-suffix + check-sprite-sheets + sprite-selftest + grafana-version + jest）' --arg s "$SUM" \
  '{passed:$p,timestamp:$ts,test_command:$cmd,summary:$s}' > .asp-test-result.json
cat .asp-test-result.json
[ "$PASSED" = true ] || exit 1
