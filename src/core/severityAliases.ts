/**
 * 嚴重度別名 → 標準嚴重度(#51,原 #35)。
 *
 * 很多組織的告警 label 不用 `critical`/`warning`,而是 `P1`、`sev1`、`disaster`、`high`。
 * 這些值在 `severity.ts` 的 `RANK` 查不到 → 排名 0 → 被任何門檻擋掉、表情一律 calm。
 * 本檔讓使用者用一行文字(`P1=critical, sev2=warning`)把它們接到標準嚴重度上。
 *
 * **不附內建別名表**:猜一張表會改變現有使用者的行為(今天某個值走 unknown、
 * 升版後突然變 critical 並開始出聲)。空設定 = 與先前完全相同,是本檔的第一條不變量。
 *
 * **別名以「前置正規化」的形式生效**,而不是給 `rankOf`/`meetsMin`/`severityToEmotion`
 * 加設定參數:`resolveSeverity(值, 別名表)` 先把值換成標準嚴重度,再餵給那三個函式。
 * 理由有二:
 *  1. 延續 2026-09-18 不擴 `Emotion` 那次裁定所依據的純函式語意 —— `severityToEmotion`
 *     只是 severity 的純函式(見 `src/avatar/AvatarController.ts` 的 `setReaction` 註解);
 *     加一個 config 參數正是那條理由擋的事。
 *  2. 「怎麼算同一個嚴重度」只能有一份定義。前置正規化讓三個函式共用同一個入口,
 *     不會出現「排名吃別名、表情不吃」的不一致。
 *
 * 純函式、零相依(只 import `severity.ts`)、不 import React —— 解析結果要能在
 * 面板之外(測試、日後的 CLI 或驗證器)重用。
 */
import { isKnownSeverity, normalize } from './severity'

/** 別名表:正規化後的別名 → 標準嚴重度(`RANK` 的鍵,已正規化)。 */
export type SeverityAliasMap = ReadonlyMap<string, string>

/**
 * 項目分隔符:半形與全形的逗號、分號,加換行。
 *
 * **全形要一起收**(#51 LOW-3):編輯器的說明是中文,使用者在中文輸入法下打出來的是
 * `,`(U+FF0C)與 `;`(U+FF1B)。只認半形的話整組設定會靜默失效 —— 一整串被當成
 * 「一個缺 `=` 的項目」略過,面板毫無反應而使用者看不出哪裡錯。
 */
const SEPARATOR = /[,;\n，；]/

/** `=` 分隔點:同理一併收全形 `＝`(U+FF1D)。 */
const EQUALS = /[=＝]/

/**
 * 被略過的原因。只有這四種 —— 與票文列的三類(缺 `=`、目標不是已知嚴重度、重複鍵)
 * 加上「別名那一側是空的」(`=critical`)對應。
 */
export type SkippedAliasReason = 'no-separator' | 'empty-alias' | 'unknown-target' | 'duplicate-alias'

export interface SkippedAlias {
  /** 原文(去頭尾空白),讓人在面板上認得出是哪一項。 */
  entry: string
  reason: SkippedAliasReason
}

export interface SeverityAliasConfig {
  /** 解析成功的項目。 */
  aliases: SeverityAliasMap
  /** 被略過的項目(格式錯誤);照原文順序。 */
  skipped: SkippedAlias[]
}

/**
 * 解析 `P1=critical, sev2=warning, disaster=critical` 這種設定字串。
 *
 * - 分隔:逗號、分號(半形與全形)、換行。空白項(例如結尾多一個逗號)直接忽略,
 *   不算「被略過」—— 那不是一個項目,報它只會讓真正的錯誤被雜訊淹掉。
 * - 大小寫與**前後**空白不敏感:兩側都走 `severity.ts` 的 `normalize`。
 *   中間的空白有作用 —— `sev 1` 不會命中 `sev1`。
 * - 第一個 `=`(或全形 `＝`)是分隔點,所以 `a=b=c` 的目標是 `b=c` → 不是已知嚴重度 → 略過。
 * - 重複鍵以**第一筆**為準,後來的那筆被略過(先寫先算,改後面不會悄悄覆蓋前面)。
 * - 非字串(含 `undefined`:舊 dashboard 的 JSON 沒有這個鍵)→ 空表、零略過。
 *
 * **不拋例外**:設定來自 dashboard JSON,任何輸入都只該讓這一項失效,不該讓播報中斷。
 *
 * 別名本身是已知嚴重度時(`critical=info`)**照常生效** —— 票文列的三類錯誤沒有它,
 * 不自行加禁令。語意就是「前置正規化」:值先換再查表,所以那是一次刻意的重新對映。
 */
export function parseSeverityAliases(spec: unknown): SeverityAliasConfig {
  const aliases = new Map<string, string>()
  const skipped: SkippedAlias[] = []
  if (typeof spec !== 'string') {return { aliases, skipped }}

  for (const raw of spec.split(SEPARATOR)) {
    const entry = raw.trim()
    if (entry === '') {continue}
    const at = entry.search(EQUALS)
    if (at < 0) {
      skipped.push({ entry, reason: 'no-separator' })
      continue
    }
    // entry 是字串,normalize 不會回 null;`?? ''` 只是不用 non-null 斷言。
    const alias = normalize(entry.slice(0, at)) ?? ''
    const target = normalize(entry.slice(at + 1)) ?? ''
    if (alias === '') {
      skipped.push({ entry, reason: 'empty-alias' })
    } else if (!isKnownSeverity(target)) {
      skipped.push({ entry, reason: 'unknown-target' })
    } else if (aliases.has(alias)) {
      skipped.push({ entry, reason: 'duplicate-alias' })
    } else {
      aliases.set(alias, target)
    }
  }
  return { aliases, skipped }
}

/**
 * 把一個嚴重度值換成它對映的標準嚴重度;沒命中別名就**原樣回傳**。
 *
 * 回傳 `unknown` 而不是 `string`:沒命中時要回傳原值(可能是 `undefined`/`null`/數字),
 * 而下游的 `rankOf`/`meetsMin`/`severityToEmotion` 本來就收 `unknown`(#19、#30)。
 * 空別名表是恆等函式 —— 這是「留空 = 行為完全相同」的機械保證。
 */
export function resolveSeverity(severity: unknown, aliases?: SeverityAliasMap): unknown {
  if (aliases === undefined || aliases.size === 0) {return severity}
  const key = normalize(severity)
  if (key === null) {return severity}
  return aliases.get(key) ?? severity
}

/**
 * `describeSkippedAliases` 的語言(#81)。
 *
 * **刻意不 import `core/types.ts` 的 `AlertLang`**:檔頭第一句就是「純函式、零相依
 * (只 import `severity.ts`)」,而那條不變量有一支既有測試逐項比對本檔的 import 清單。
 * 代價是這個聯集與 `AlertLang` 必須一致,由 `feed/__tests__/feedNotices.test.ts` 的雙向可指派斷言
 * 在 typecheck 時擋住漂移(單向只驗得到成員,驗不到「完全相同」)。
 */
export type SkippedAliasLang = 'zh' | 'en'

const REASON_TEXT: Record<SkippedAliasLang, Record<SkippedAliasReason, string>> = {
  zh: {
    'no-separator': '缺 `=`',
    'empty-alias': '`=` 左邊是空的',
    'unknown-target': '目標不是已知嚴重度(critical/error/warning/info/unknown)',
    'duplicate-alias': '別名重複,以第一筆為準',
  },
  en: {
    'no-separator': 'no `=`',
    'empty-alias': 'nothing on the left of `=`',
    'unknown-target': 'target is not a known severity (critical/error/warning/info/unknown)',
    'duplicate-alias': 'duplicate alias; the first one wins',
  },
}

/**
 * 把被略過的項目講成一句人看得懂的話;沒有被略過的項目回空字串。
 *
 * 純函式、不碰 DOM —— 面板要顯示就直接用。自 #81 起**面板真的在用它**:編輯模式下
 * 顯示一行提示(`feed/feedNotices.ts` 的 `skippedAliasNotice` 轉手這裡的輸出),
 * 寫錯的設定於是不再靜默失效。
 *
 * `lang` 預設 `'zh'` —— 與 #81 之前逐字相同的輸出,所以既有呼叫端與既有測試都不必改。
 */
export function describeSkippedAliases(skipped: readonly SkippedAlias[], lang: SkippedAliasLang = 'zh'): string {
  if (skipped.length === 0) {return ''}
  const text = REASON_TEXT[lang]
  if (lang === 'en') {
    const items = skipped.map((s) => `“${s.entry}” (${text[s.reason]})`).join(', ')
    return `Severity aliases: ${skipped.length} ${skipped.length === 1 ? 'entry' : 'entries'} skipped — ${items}`
  }
  const items = skipped.map((s) => `「${s.entry}」(${text[s.reason]})`).join('、')
  return `別名設定有 ${skipped.length} 項被略過:${items}`
}
