/**
 * Phase 0 smoke test — 驗證調查項目 1（講話 API）+ 2（連線位址）對「實機」成立。
 *
 * 用法：填好 .env（AIRI_WS_URL / AIRI_AUTH_TOKEN）後執行：
 *   pnpm smoke
 *
 * 成功標準：終端印出「已連上」，且 AIRI 桌面角色把測試語音念出來。
 */
import { Client } from '@proj-airi/server-sdk'
import { loadDotEnv, loadConfig } from '../src/config.js'

// server-sdk 把 invalid token / 斷線錯誤以非同步事件丟出，會逸出成 uncaughtException。
// 攔下來印乾淨訊息，不要噴整片 stack trace。
process.on('uncaughtException', (err) => {
  console.error('[smoke] 連線失敗：', err instanceof Error ? err.message : err)
  process.exit(1)
})

loadDotEnv()
const config = loadConfig()

const TEST_LINE = '這是 Augur 運維語音橋接的測試訊息，如果你聽得到，代表連線正常。'

console.log(`[smoke] 連線到 ${config.airiWsUrl}（name=${config.airiName}）…`)

const client = new Client({
  name: config.airiName,
  url: config.airiWsUrl,
  token: config.airiAuthToken,
  onError: (err: unknown) => console.error('[smoke] error：', err instanceof Error ? err.message : err),
})

try {
  await client.ready()
  console.log('[smoke] 已連上，狀態：', client.connectionStatus)

  const ok = client.send({ type: 'input:text', data: { text: TEST_LINE } })
  console.log(
    ok
      ? '[smoke] 已送出測試語音，請看桌面角色是否開口念出。'
      : '[smoke] 送出失敗（未連上）。',
  )

  // 給 TTS 一點時間再關閉
  await new Promise((resolve) => setTimeout(resolve, 3000))
} catch (err) {
  console.error('[smoke] 連線 / 送出失敗：', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  client.close()
  // ws handle 可能讓 process 不結束，保險強制退出
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}
