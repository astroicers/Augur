/**
 * 斷句切點規則的單一事實源（#59）。
 *
 * 面板有兩份斷句實作、伺服器還有第三份，三者的切點集合**彼此不同**：
 *
 * - `speaker.ts` 的 `splitForRemoteVoice`：把一則切成不超過 N 字的「段」，給 Web Speech 的遠端聲線用。
 * - `remoteSpeaker.ts` 的 `splitClauses`：把一則切成至少 16 字的「句」，逐句向外部語音服務要音訊。
 * - `tools/tts-server/textsplit.py` 的 `SENTENCE_SPLIT`：伺服器端再切一次。**本模組不管它**
 *   （Python 不 import TypeScript），但它與 `splitClauses` 的差異也記在下面，
 *   並由共用語料 `__fixtures__/split-corpus.json` 兩邊同時釘住。
 *
 * 本模組只收**切點**（哪些位置可以切）。「每段幾字」「太短併段」那層仍留在各自的檔案裡 ——
 * 兩者的聚合規則本質不同（上限 vs 下限），沒有共用的部分。
 *
 * ## 三份實作的差異與理由
 *
 * | # | 差異 | `splitForRemoteVoice` | `splitClauses` | `textsplit.py` | 理由（出處） |
 * | - | ---- | --------------------- | -------------- | -------------- | ------------ |
 * | 1 | 全形 `，。！？；` | 切 | 切 | 切 | 三份共有，無分歧（引入：`7128ab5`／`fee41b3`） |
 * | 2 | 全形頓號 `、` | **切** | 不切 | 不切 | **理由未知**。`splitForRemoteVoice` 自 `7128ab5` 引入時就在切點集合裡，該 commit 只寫「盡量在標點後切」；`splitClauses`（`fee41b3`）與 Python（`d135467`）從未收過它，也沒有任何 commit／ADR 說明為何不收 |
 * | 3 | 全形冒號 `：` | **不切** | 切 | 切 | **理由未知**。`splitForRemoteVoice` 自 `7128ab5` 起就沒有它；後續兩次切點修正（`931ed0d` F1、`4c8c5fd` R2）都只動半形那一段，沒有任何 commit／ADR 提到全形冒號。注意兩邊的影響不對稱：少一個切點對 `splitForRemoteVoice` 只是某一段變長（仍受字數上限約束），對 `splitClauses` 則是少一次請求 |
 * | 4 | 半形句點 `.` | **切**（後面不接數字或 `/`） | 不切 | 不切 | 伺服器端的 `textsplit.py` 註解記下不切的理由：「半形 `.` 不切（client 也不切；`91.35`、`grafana.local`）」（`d135467`）。`splitForRemoteVoice` 切它的理由未見記錄，但 `931ed0d`（複審 F1）為它補上了「後接數字或 `/` 不切」的條件，正是為了 `91.35`／`http://`。守衛擋不住「點後面是字母」，所以 `grafana.local` 在 `splitForRemoteVoice` 上仍是切點（語料裡標為 `suspect`） |
 * | 5 | 半形 `,;?!` | 切（後面不接數字或 `/`） | 切（同條件） | 切（同條件） | 條件三份一致。`splitForRemoteVoice` 的來源是 `931ed0d`（複審 F1：「切點排除『半形 . , : 後接數字或 /』：192.168.1.20、91.35 不再被拆進兩段（與 splitClauses 一致）」）；`splitClauses`／Python 的來源是 `250ebbd`（ADR-005 複審：「半形冒號在 192.168.1.20:9182 這類數字裡被切開」） |
 * | 6 | 半形冒號 `:` | **不切** | 切（後面不接數字或 `/`） | 切（同條件，且不在 `[:` 內） | `splitForRemoteVoice` 不切的理由有明確出處：`4c8c5fd`（第二輪複審 R2）——「上一輪把半形 `:` 加進切點，反而讓 IPv6（`fe80::1ff:…`）與 Windows 路徑（`C:\`）多了舊版沒有的切點。改成冒號不是切點；`Alert firing: X` 本來就靠冒號後的空白切」。**同一條理由沒有被套用到 `splitClauses`／Python**，而那兩份不以空白為切點（差異 7），所以 `fe80::1ff` 與 `C:\` 在它們身上**現在仍會被切開**。這是 R2 之後留下的分歧，沒有任何 commit／ADR 說明為何只改一邊 → **理由未知**（語料裡標為 `suspect`，見 `__fixtures__/split-corpus.json`） |
 * | 7 | 空白 `\s` | **切** | 不切 | 不切 | `splitForRemoteVoice` 自 `7128ab5` 引入時就有，該 commit 未記理由；但 `4c8c5fd`（R2）明文依賴它（「`Alert firing: X` 本來就靠冒號後的空白切」，且記載「另試過只在冒號後接空白時才切的分支，變異證明它與空白切點重複，拿掉」），所以**現在**它的存在有出處。`splitClauses`／Python 不收它的理由未見記錄；可觀察到的後果是英文長句在它們身上只能靠標點切 |
 * | 8 | 注音標註 `字[:ㄅ…]` 裡的 `:` | 不適用（`:` 本來就不是切點） | **會切**（`[` 後的 `:` 後面接注音，不是數字） | 不切（`(?<!\[:)`） | Python 的例外有明確出處：`d135467`（第三輪複審 P2）。註解同時記下「注音標註是前一個模型 BreezyVoice 的前處理產物；換成 Qwen3-TTS 後輸入裡不再有它，這條保留無害」。`splitClauses` 沒有這條 —— 面板端從來不產注音標註，所以現行輸入上無法觀察到差別 |
 *
 * 另有三項**不屬於切點**、但語料同樣釘住的聚合層差異，記在這裡免得下一個人以為是切點造成的：
 *
 * - `splitForRemoteVoice` 保證「切出來的段接起來等於原文」（`speaker.ts` 的檔內註解：boundary
 *   的位置換算靠這個）；`splitClauses` 會丟掉只有空白的片段（`.filter((s) => s.trim() !== '')`），
 *   Python 還會對每一段 `.strip()`。所以後兩者接起來**不**等於原文。
 * - 空字串：`splitForRemoteVoice('')` → `['']`、`splitClauses('')` → `['']`（有測試釘住）、
 *   Python `clauses('')` → `[]`。
 * - 沒有標點的超長字串：`splitForRemoteVoice` 硬切（且不切在 UTF-16 代理對中間，`931ed0d` F7），
 *   `splitClauses`／Python 沒有上限，整串成為一段。
 *
 * 以上差異**本票一律不改**（#59 票文：行為一律不變）。要改哪一條，先改語料再改實作。
 * 每一條都有對應的斷言：`__tests__/splitCorpus.test.ts` 的〈語料釘住的三份差異〉那一組。
 */

// ---------------------------------------------------------------------------
// 共用的切點字元（差異 1、5）
// ---------------------------------------------------------------------------

/** 三份實作共有的全形切點。字元類別裡的順序不影響語意。 */
export const SHARED_FULLWIDTH = '，。！？；';

/** 三份實作共有的半形切點。都受 `NOT_BEFORE_DIGIT_OR_SLASH` 約束。 */
export const SHARED_ASCII = ',;?!';

/**
 * 半形標點後面接數字或 `/` 時不切（差異 5）。
 * 沒有這條，`192.168.1.20`、`91.35`、`1,234`、`http://` 會被切成兩段／兩次請求，
 * 而數值單獨成段時實測最容易念錯（`931ed0d` F1、`250ebbd`）。
 */
export const NOT_BEFORE_DIGIT_OR_SLASH = '(?![\\d/])';

// ---------------------------------------------------------------------------
// 各自的差異，以具名常數表達（AC-3）
// ---------------------------------------------------------------------------

/** 差異 2：只有 `splitForRemoteVoice` 在頓號後切。 */
export const REMOTE_VOICE_ONLY_FULLWIDTH = '、';

/** 差異 7：只有 `splitForRemoteVoice` 以空白為切點。 */
export const REMOTE_VOICE_ONLY_WHITESPACE = '\\s';

/** 差異 4：只有 `splitForRemoteVoice` 在半形句點後切。 */
export const REMOTE_VOICE_ONLY_ASCII = '.';

/** 差異 3：只有 `splitClauses`（與 Python）在全形冒號後切。 */
export const CLAUSE_ONLY_FULLWIDTH = '：';

/** 差異 6：只有 `splitClauses`（與 Python）在半形冒號後切。 */
export const CLAUSE_ONLY_ASCII = ':';

// ---------------------------------------------------------------------------
// 兩份實作各自的切點正規式
// ---------------------------------------------------------------------------

/**
 * `splitForRemoteVoice` 的切點（`speaker.ts`）。
 * 全形 `，。！？；、` 與空白一律切；半形 `,.;?!` 後面不接數字或 `/` 時才切；半形 `:` 不是切點。
 */
export const REMOTE_VOICE_SPLIT_POINT = new RegExp(
  `(?<=[${SHARED_FULLWIDTH}${REMOTE_VOICE_ONLY_FULLWIDTH}${REMOTE_VOICE_ONLY_WHITESPACE}])` +
    `|(?<=[${SHARED_ASCII}${REMOTE_VOICE_ONLY_ASCII}])${NOT_BEFORE_DIGIT_OR_SLASH}`
);

/**
 * `splitClauses` 的切點（`remoteSpeaker.ts`）。
 * 全形 `，：；。！？` 一律切；半形 `,:;?!` 後面不接數字或 `/` 時才切；半形 `.` 不是切點。
 */
export const CLAUSE_SPLIT_POINT = new RegExp(
  `(?<=[${SHARED_FULLWIDTH}${CLAUSE_ONLY_FULLWIDTH}]` +
    `|[${SHARED_ASCII}${CLAUSE_ONLY_ASCII}]${NOT_BEFORE_DIGIT_OR_SLASH})`
);
