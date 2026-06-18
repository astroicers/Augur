/**
 * 環境變數集中管理（SPEC §3 原則 5：所有部署相關值放這裡）。
 * 啟動時讀 env、驗必填、匯出 typed config；缺必填直接 throw，不要帶著半套設定跑。
 */

import type { AlertLang } from './core/types.js'

export interface AppConfig {
  /** HTTP server 監聽主機 */
  host: string
  /** HTTP server 監聽埠 */
  port: number
  /** Grafana webhook 的 Authorization 憑證 */
  webhookSecret: string
  /** AIRI 桌面版 server channel 的 WebSocket URL */
  airiWsUrl: string
  /** AIRI server channel 的 auth token */
  airiAuthToken: string
  /** 連上 AIRI 時這個 client 的識別名稱 */
  airiName: string
  /** webhook request body 的大小上限（位元組），防記憶體耗盡 */
  maxBodyBytes: number
  /** 播報語言（'zh' 繁中 / 'en' 英文） */
  alertLang: AlertLang
}

/** Node 20.12+/22 原生讀 .env，免額外套件。沒有 .env 就靠實際環境變數。 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile?.('.env')
  } catch {
    // 沒有 .env 檔屬正常情況，忽略
  }
}

function required(name: string): string {
  const v = process.env[name]
  if (v == null || v.trim() === '') {
    throw new Error(`[config] 缺少必填環境變數 ${name}（請參考 .env.example）`)
  }
  return v.trim()
}

function optional(name: string, fallback: string): string {
  const v = process.env[name]
  return v == null || v.trim() === '' ? fallback : v.trim()
}

export function loadConfig(): AppConfig {
  const portRaw = optional('PORT', '3001')
  const port = Number.parseInt(portRaw, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`[config] PORT 不是有效埠號：${portRaw}`)
  }

  const maxBodyRaw = optional('WEBHOOK_MAX_BODY_BYTES', '1048576') // 預設 1 MB
  const maxBodyBytes = Number.parseInt(maxBodyRaw, 10)
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error(`[config] WEBHOOK_MAX_BODY_BYTES 不是有效位元組數：${maxBodyRaw}`)
  }

  const langRaw = optional('ALERT_LANG', 'zh')
  if (langRaw !== 'zh' && langRaw !== 'en') {
    throw new Error(`[config] ALERT_LANG 只能是 zh 或 en：${langRaw}`)
  }

  return {
    host: optional('HOST', '127.0.0.1'),
    port,
    webhookSecret: required('WEBHOOK_SECRET'),
    airiWsUrl: required('AIRI_WS_URL'),
    airiAuthToken: required('AIRI_AUTH_TOKEN'),
    airiName: optional('AIRI_NAME', 'airi-ops-bridge'),
    maxBodyBytes,
    alertLang: langRaw,
  }
}
