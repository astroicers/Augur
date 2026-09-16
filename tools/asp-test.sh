#!/usr/bin/env bash
# 產生 ASP ship-gate 讀的 .asp-test-result.json。
# 必須驗「真的跑過幾條」而非退出碼：
#  - --passWithNoTests 在零命中時會 exit 0 並印 'No tests found'
#  - numTotalTests 把 skipped 算進去（test.skip x18 會騙過 >=18 的判定）
#  - suite 跑不起來時（正是 .js 後綴的失敗模式）numFailedTests 是 0，只有
#    numFailedTestSuites / numRuntimeErrorTestSuites 會反應
# 本腳本的【最後一個動作】必須是寫 .asp-test-result.json —— hook 的判定是
# [ ! "$IDX" -nt "$TR" ]，而 git status / git diff 會刷新 .git/index 的 mtime。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
npx jest --ci --maxWorkers=4 --json --outputFile=.jest-result.json
JEST_EXIT=$?
if jq -e '.success == true and .numFailedTests == 0 and .numFailedTestSuites == 0 and .numRuntimeErrorTestSuites == 0 and .numPendingTests == 0 and ((.numTodoTests // 0) == 0) and .numPassedTests >= 18' .jest-result.json >/dev/null; then
  PASSED=true
else
  PASSED=false
fi
SUM=$(jq -r '"\(.numPassedTests) pass / \(.numFailedTests) fail / \(.numTotalTestSuites) suites"' .jest-result.json)
jq -n --argjson p "$PASSED" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg cmd 'npx jest --ci --maxWorkers=4' --arg s "$SUM" \
  '{passed:$p,timestamp:$ts,test_command:$cmd,summary:$s}' > .asp-test-result.json
cat .asp-test-result.json
[ "$PASSED" = true ] || exit 1
exit $JEST_EXIT
