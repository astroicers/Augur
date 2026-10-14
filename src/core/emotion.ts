/**
 * severity(+status) → Emotion，對映 `live2d/_archive/live2d-template-spec-v1.md` §6。
 * resolved 一律 resolved；firing 時依 severity：critical/error→critical、
 * warning→warning、info/unknown（及其餘）→calm。
 * （§6 未列 error；rank 3 的 error 併入 critical。）
 *
 * 入參一律收 `unknown`，與 `core/severity.ts` 同一個理由：告警來自 Grafana 的面板資料，
 * severity 可能缺值（`undefined`）、是 `null`，或根本不是字串。這層不信型別標註，
 * 只信 runtime 檢查——表情更新不該因為一筆髒資料整條中斷。
 * 正規化直接重用 `severity.ts` 的 `normalize`，不在本檔另寫一份。
 */
import type { Emotion, ParsedAlert } from './types'
import { normalize } from './severity'

export function severityToEmotion(severity: unknown, status: ParsedAlert['status']): Emotion {
  if (status === 'resolved') {return 'resolved'}
  // 非字串 → normalize 回 null → 落 default，與 unknown 同樣是 calm。
  switch (normalize(severity)) {
    case 'critical':
    case 'error':
      return 'critical'
    case 'warning':
      return 'warning'
    default:
      return 'calm' // info / unknown / 缺值 / 非字串 / 其餘
  }
}
