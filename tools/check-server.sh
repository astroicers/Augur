#!/usr/bin/env bash
# 重啟 dev Grafana 並「驗證 plugin 真的被載入」。`npm run server` 的最後一步。
#
# 為什麼存在（2026-09-28 實地發生）：
#  - `docker compose up -d` 對「已在跑、設定沒變」的容器是 **no-op**；
#  - 而 Grafana 只在**行程啟動**時掃描 /var/lib/grafana/plugins；
#  - 於是一個啟動時沒載到 plugin 的容器（當時掛載點是空的）**永遠**不會被
#    `npm run server` 救回來：e2e 2 failed、面板清單裡沒有 Mascot，
#    而指令照樣 exit 0，沒有任何錯誤訊息。
# 修法：無條件 restart grafana（強迫重新掃描），然後等「Plugin registered 行的
# **計數**比 restart 前多一」—— 不打 API（/api/plugins 要 admin 憑證，
# 這支腳本不該去讀 .env），也**不用 `docker logs --since`**：
# --since 的基準是主機時鐘，而 WSL2 的主機時鐘與容器日誌時間戳可以偏差數秒，
# 實測第一版就因此把 restart 後真實出現的註冊行整段濾掉、白等 60 秒後報失敗。
# 計數從容器建立起單調成長，與時鐘無關。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

if ! docker ps --format '{{.Names}}' | grep -qx 'augur-grafana'; then
  echo 'check-server: augur-grafana 容器不在跑（docker compose up 失敗？）'
  exit 1
fi

# 先驗掛載：dist 的內容要在容器裡看得到。空目錄就是那次實地事故的形態。
if ! docker exec augur-grafana test -f /var/lib/grafana/plugins/augur-mascot-panel/plugin.json; then
  echo 'check-server: 容器內 /var/lib/grafana/plugins/augur-mascot-panel/plugin.json 不存在 ——'
  echo '  掛載點是空的。已知成因是 Docker/WSL2 重啟後 bind mount 掉了；'
  echo '  跑 docker compose -f monitoring/docker-compose.yml up -d --force-recreate grafana 重建。'
  exit 1
fi

count_registered() {
  docker logs augur-grafana 2>&1 | grep -c 'msg="Plugin registered" pluginId=augur-mascot-panel'
}
BEFORE=$(count_registered)
docker compose -f monitoring/docker-compose.yml restart grafana >/dev/null 2>&1 || {
  echo 'check-server: restart grafana 失敗'; exit 1
}

for i in $(seq 1 30); do
  NOW=$(count_registered)
  if [ "$NOW" -gt "$BEFORE" ]; then
    echo "check-server: augur-mascot-panel 已註冊（重啟後第 ${i} 次輪詢；累計註冊 ${NOW} 次）"
    exit 0
  fi
  sleep 2
done
echo 'check-server: 60 秒內沒等到新的 Plugin registered —— 看 docker logs augur-grafana 的 signature/scan 錯誤'
docker logs augur-grafana 2>&1 | grep -iE 'plugins\.|signature|error' | tail -10
exit 1
