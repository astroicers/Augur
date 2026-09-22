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

# ⚠️ **第一件事就是刪掉上一輪的結果檔。**
# 腳本檔頭第 11–14 行講的正是這個失敗模式，但當時只對 .jest-result.json 做了，
# 對它自己寫的 .asp-test-result.json 沒做。後果是**每一條 abort 路徑都留著上一輪的判決**：
# jq 不存在、cd 失敗、set -u 中止、操作者 Ctrl-C、CI step timeout、OOM、磁碟滿。
# 實際的利用路徑不需要惡意：跑過一次綠 → 改壞某個檔 → 再跑閘門但它中途 abort
# → 結果檔還是上一輪的綠、而且比 .git/index 新 → commit 直接放行。
# 實測：注入兩個 typecheck 錯誤後在第 3 秒 kill -9，結果檔原封不動是綠的。
rm -f .asp-test-result.json

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
  *'SPRITE-CHECK: CRASH'*)         SPRITE_SUM='sprites: 工具自己壞了（見輸出的堆疊）' ;;
  *'SPRITE-CHECK: FAIL'*)          SPRITE_SUM='sprites: 素材違規' ;;
  *'sha256 不符'*)                 SPRITE_SUM='sprites: sha256 不符（換圖沒更新 manifest）' ;;
  # 落到這裡代表 CLI 印了一個沒有 arm 認得的字串 —— 那本身就是要修的東西，
  # 不要把它猜成「素材違規」。先前正是這個 arm 把所有工具 crash 記成素材問題。
  *)                               SPRITE_SUM='sprites: 未知輸出（CLI 的 sentinel 與本 case 不同步）' ;;
esac

# sprite 工具自身的回歸測試。它驗的交付物還不存在，在素材進來之前，
# 這是唯一在維持那十幾條檢查誠實的東西（合成基準全綠 + 逐條變異體紅在該紅的地方）。
# 約 16 秒；若日後覺得太貴，搬去 CI 是可接受的取捨，但不要靜默拿掉。
# Grafana 版本變更觸發器。跨 panel DOM 是本專案唯一 unsupported 的部分，
# 而「每次 minor 升版重跑 G-ADR004-4」這條規則原本只活在 ARCHITECTURE.md 的散文裡 ——
# 升版的人不會去讀那一行。這道檢查把它變成機械的。
echo '--- Grafana 版本 ---'
# ⚠️ **只認未被註解掉的 `image:` 鍵，而且拒絕歧義。**
# 原本是 `grep -oE 'grafana/grafana:[0-9.]+' | head -1`，抓的是**整個檔案裡第一個文字命中**，
# 包含註解。於是「升版時把舊行註解起來留參考」這個再普通不過的動作就會讓檢查讀到舊版號、
# 與 VERIFIED 相符、整個閘門綠燈放行一個沒驗過的 Grafana。
GRAFANA_LINES=$(grep -nE '^[[:space:]]*image:[[:space:]]*"?grafana/grafana:' monitoring/docker-compose.yml || true)
GRAFANA_COUNT=$(printf '%s' "$GRAFANA_LINES" | grep -c . || true)
COMPOSE_TAG=$(printf '%s' "$GRAFANA_LINES" | head -1 | sed -E 's/.*grafana\/grafana:([0-9][0-9.]*).*/\1/')
VERIFIED_TAG=$(head -1 monitoring/VERIFIED-GRAFANA.txt 2>/dev/null | tr -d '[:space:]')
if [ "$GRAFANA_COUNT" -gt 1 ]; then
  echo "grafana-version: monitoring/docker-compose.yml 有 $GRAFANA_COUNT 個未註解的 grafana image 宣告，無法判斷哪個生效"
  printf '%s\n' "$GRAFANA_LINES" | sed 's/^/    /'
  GATE_OK=false; FAILED="$FAILED grafana-version"
  GRAFANA_SUM="grafana: $GRAFANA_COUNT 個 image 宣告，有歧義"
elif [ -z "$COMPOSE_TAG" ] || [ -z "$VERIFIED_TAG" ]; then
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
# ⚠️ **這一段只能提醒，絕對不能讓腳本中止。**
# 原本直接把 `$(date -u -d "$FACT_CHECK_DATE" +%s)` 代進算術。`date -d` 是 GNU 擴充 ——
# 在 BusyBox / alpine CI image / macOS 上它會失敗並回空字串，算術於是變成
# `( 1790047103 -  ) / 86400`，在 `set -u` 下**整個腳本中止**。
# 而中止發生在寫 .asp-test-result.json **之前**，所以留下的是上一輪的判決。
# 實測：在有兩個真 typecheck 錯誤的樹上，這條路徑讓閘門留下一個綠的結果檔。
FACT_CHECK_DATE='2026-09-16'
FACT_EPOCH=$(date -u -d "$FACT_CHECK_DATE" +%s 2>/dev/null || echo '')
if [ -n "$FACT_EPOCH" ]; then
  FACT_AGE_DAYS=$(( ( $(date -u +%s) - FACT_EPOCH ) / 86400 ))
  if [ "$FACT_AGE_DAYS" -gt 180 ]; then
    echo "fact-check: ADR-004 的外部事實查證距今 $FACT_AGE_DAYS 天（> 180），建議複查"
    GRAFANA_SUM="$GRAFANA_SUM；外部事實查證逾 $FACT_AGE_DAYS 天"
  fi
else
  echo "fact-check: 本機的 date 不支援 -d（非 GNU coreutils），跳過 180 天提醒"
  GRAFANA_SUM="$GRAFANA_SUM；查證日期算不出（date 非 GNU）"
fi

echo '--- sprite 工具自測 ---'
# ⚠️ 要有**最低斷言數**，理由與 jest 的 MIN_TESTS 完全相同：只看退出碼的話，
# 「變異體表被重構成空的」會讓第 [3] 節整個消失而退出碼照樣是 0 ——
# 而第 [3] 節正是「每一條檢查都紅在該紅的地方」的唯一證據。
MIN_SELFTEST=76
SELF_OUT=$(node tools/check-sprite-sheets.selftest.mjs 2>&1) || { GATE_OK=false; FAILED="$FAILED sprite-selftest"; }
printf '%s\n' "$SELF_OUT" | tail -2
SELF_PASS=$(printf '%s' "$SELF_OUT" | sed -nE 's/^([0-9]+) 通過 \/ ([0-9]+) 失敗$/\1/p' | tail -1)
SELF_FAIL=$(printf '%s' "$SELF_OUT" | sed -nE 's/^([0-9]+) 通過 \/ ([0-9]+) 失敗$/\2/p' | tail -1)
if [ -z "$SELF_PASS" ] || [ "$SELF_FAIL" != 0 ] || [ "$SELF_PASS" -lt "$MIN_SELFTEST" ]; then
  echo "sprite-selftest: 斷言數 ${SELF_PASS:-?} 通過 / ${SELF_FAIL:-?} 失敗（要求 >= $MIN_SELFTEST 通過且 0 失敗）"
  GATE_OK=false
  case "$FAILED" in *sprite-selftest*) ;; *) FAILED="$FAILED sprite-selftest" ;; esac
fi

echo '--- jest ---'
# 先刪：jest 沒起來時不會寫這個檔，殘留的舊檔會被誤當成本輪結果。
rm -f .jest-result.json
npx jest --ci --maxWorkers=4 --json --outputFile=.jest-result.json
JEST_EXIT=$?

# MIN_TESTS = 所有測試檔之和（core 四支 18 + sources/panelAlerts 13 + avatar/gaze 5 + avatar/flap 7 + avatar/spriteSheet 6 + components/MascotPanel 8）。
# 增刪測試時必須同步更新這個數字，否則閘門會對「測試被刪掉」無感。
MIN_TESTS=57

if [ "$JEST_EXIT" = 0 ] && [ -f .jest-result.json ] && jq -e \
  ".success == true and .numFailedTests == 0 and .numFailedTestSuites == 0 \
   and .numRuntimeErrorTestSuites == 0 and .numPendingTests == 0 \
   and ((.numTodoTests // 0) == 0) and .numPassedTests >= $MIN_TESTS" \
  .jest-result.json >/dev/null 2>&1; then
  JEST_OK=true
  SUM=$(jq -r '"\(.numPassedTests) pass / \(.numFailedTests) fail / \(.numTotalTestSuites) suites"' .jest-result.json)
else
  JEST_OK=false
  # 四種原因分開寫。原本一律寫成「jest 未通過或未產生結果」——
  # 刪掉一支測試檔時 jest 退出碼是 0、結果檔也在、success 是 true，
  # 只是 numPassedTests 少於 MIN_TESTS，而記下來的理由卻自相矛盾。
  if [ "$JEST_EXIT" != 0 ]; then
    SUM="jest 退出碼 $JEST_EXIT"
  elif [ ! -f .jest-result.json ]; then
    SUM='jest 沒寫出結果檔（設定壞掉或 crash）'
  else
    JP=$(jq -r '.numPassedTests // "?"' .jest-result.json 2>/dev/null)
    JF=$(jq -r '.numFailedTests // "?"' .jest-result.json 2>/dev/null)
    JS=$(jq -r '.numFailedTestSuites // "?"' .jest-result.json 2>/dev/null)
    JD=$(jq -r '((.numPendingTests // 0) + (.numTodoTests // 0))' .jest-result.json 2>/dev/null)
    if [ "$JP" != '?' ] && [ "$JF" = 0 ] && [ "$JS" = 0 ] && [ "$JD" = 0 ]; then
      SUM="jest 測試數 $JP 少於 MIN_TESTS=$MIN_TESTS（測試被刪掉了？）"
    else
      SUM="jest $JP pass / $JF fail / $JS suite 失敗 / $JD skipped-or-todo"
    fi
  fi
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
