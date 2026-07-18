/**
 * severity(+status) → Emotion，對映 Live2D template spec §6。
 * resolved 一律 resolved；firing 時依 severity：critical/error→critical、
 * warning→warning、info/unknown（及其餘）→calm。
 * （§6 未列 error；rank 3 的 error 併入 critical。）
 */
import type { Emotion, ParsedAlert } from './types.js'

export function severityToEmotion(severity: string, status: ParsedAlert['status']): Emotion {
  if (status === 'resolved') return 'resolved'
  switch (severity.trim().toLowerCase()) {
    case 'critical':
    case 'error':
      return 'critical'
    case 'warning':
      return 'warning'
    default:
      return 'calm' // info / unknown / 其餘
  }
}
