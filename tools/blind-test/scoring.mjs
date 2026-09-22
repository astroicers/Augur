/**
 * SP-V.1 方向辨識盲測的**出題與計分邏輯**，與頁面分開。
 *
 * **為什麼要分開**：門檻是「整體 ≥85% **且**沒有任何單一方向低於 60%」，
 * 第二條正是為了擋「七個方向全對、一個方向全錯」這種能湊到 85% 的分佈。
 * 兩條門檻的邊界行為必須可以自動驗（85.0 過 / 84.9 不過、60.0 過 / 59.9 不過）——
 * 寫在 `<script>` 裡就只能靠人手動點四十次去試，而那不會有人做第二次。
 *
 * ⚠️ 本檔跑在瀏覽器與 Node 兩邊，所以不碰 DOM、不碰 fs。
 */

/** 九個方向的中文標籤，index 即 row-major 格號（與 `gaze.ts` 同一套）。 */
export const DIRECTION_LABELS = [
  '左上', '正上', '右上',
  '正左', '正中', '正右',
  '左下', '正下', '右下',
];

/** 中央格不出題 —— 它是「沒有方向」，問它等於問一個沒有正確答案的題目。 */
export const CENTER_CELL = 4;

/**
 * 每個非中央格的題數。SP-V.1 的條文是「**至少** 4 題」，這裡取 **10**。
 *
 * ⚠️ **4 題是壞的選擇，而壞在一個不明顯的地方。** 每方向 n 題時，實際生效的門檻是
 * `ceil(0.6n)/n` —— n=4 時那是 **75%**，不是規格寫的 60%（只有 0/25/50/75/100 五個值可能）。
 * 二項分佈實算：
 *
 * | n | 實際門檻 | 真實力 50% 誤收 | 真實力 75% 誤退 | 總題數 |
 * |---|---|---|---|---|
 * | 4 | **75.0%** | 31.2% | **26.2%** | 32 |
 * | 10 | 60.0% | 37.7% | **7.8%** | 80 |
 * | 15 | 60.0% | 30.4% | 5.7% | 120 |
 *
 * 最要緊的是**誤退**那一欄：n=4 時一份真實可讀性 75% 的**好**畫稿，
 * 有超過四分之一的機率被退回去重畫。那是真的要花錢重畫的。
 * n=10 把它降到 7.8%，而且實際門檻正好落在規格寫的 60% 上。代價是 80 題、約四分鐘。
 *
 * （「誤收」那一欄不太會因為加題數而改善，因為 50% 離 60% 的門檻本來就很近 ——
 * 那是門檻位置的性質，不是樣本數的問題。要改善它得動 SP-V.1 的 60%，那是規格修訂。）
 */
export const MIN_QUESTIONS_PER_CELL = 10;

/**
 * 格號 → CSS `background-position`（3×3，每格 50%）。
 *
 * ⚠️ **這裡有一份，是為了讓 `index.html` 不要自己再抄一份。**
 * 原本頁面裡手寫了同樣的算式，而 repo 內沒有任何東西涵蓋 `index.html` ——
 * 把兩個項對調（column-major）是一個 token 的改動，會讓一份完美的交付被評成
 * 8/32 = 25.0% 未通過，而 selftest 全綠。
 *
 * ⚠️ 它與 `src/avatar/gaze.ts` 的 `cellToBackgroundPosition` 是同一個算式。
 * **沒有共用是刻意的** —— 這個檔要能在瀏覽器裡以純 ES module 直接載入，
 * 不能依賴 `src/` 的 TypeScript 建置產物。兩邊都有測試釘住同樣的語意。
 */
export function cellToBackgroundPosition(cell) {
  const c = Math.max(0, Math.min(8, Math.trunc(cell)));
  return `${(c % 3) * 50}% ${Math.trunc(c / 3) * 50}%`;
}

/**
 * 交付圖的尺寸預檢。回傳 `{ fatal, note }` —— `fatal` 非空就不該開始出題。
 *
 * ⚠️ **這支存在的理由是「把決策從 HTML 搬出來」。**
 * 先前這個判斷寫在 `index.html` 的 inline script 裡，而 selftest 只能用
 * `html.includes('...')` 去驗它 —— 那種斷言釘的是**字串拼法不是行為**：
 * 六個 mutate-run-revert 全部保留拼法、打壞行為，而 selftest 維持全綠，
 * 其中一個直接把已經移除的「邊長須可被 3 整除」規則原封不動加回去。
 * 搬到這裡之後 selftest 測的是真的函式，餵真的數字。
 *
 * **只有「不是正方形」是致命的** —— 3×3 等分格在非正方形上會變成長方形格，
 * 視線方向會被拉歪。邊長本身不影響顯示（舞台是 `background-size: 300% 300%`），
 * 所以 1024²／2048² 這類校稿尺寸照常出題，只是提醒 SP-7.1 的交付要求是正好 1536。
 */
export function preflightError(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { fatal: '讀不到圖片尺寸。沒有開始出題。', note: '' };
  }
  if (width !== height) {
    return { fatal: `這張圖是 ${width}×${height} —— 3×3 的 sheet 必須是正方形。沒有開始出題。`, note: '' };
  }
  if (width !== 1536) {
    return { fatal: '', note: `⚠️ 這張是 ${width}×${width}，可讀性測得出來，但 SP-7.1 的交付驗收要求正好 1536×1536。` };
  }
  return { fatal: '', note: '' };
}

/** SP-V.1 的兩條門檻。**百分比，不是比例** —— 規格寫的就是 85 與 60。 */
export const THRESHOLD_OVERALL_PCT = 85;
export const THRESHOLD_PER_DIRECTION_PCT = 60;

/**
 * 產生題目序列：8 個非中央格各 `perCell` 題，**隨機交錯**。
 *
 * `random` 注入是為了可測。洗牌用 Fisher–Yates —— `sort(() => random() - 0.5)`
 * 不是均勻洗牌，而題序不均勻會讓受測者摸出規律（例如「左上總是排在前面」），
 * 那會直接污染這個測驗要量的東西。
 */
export function buildQuestions(random, perCell = MIN_QUESTIONS_PER_CELL) {
  const cells = [];
  for (let c = 0; c < 9; c++) {
    if (c === CENTER_CELL) {
      continue;
    }
    for (let i = 0; i < perCell; i++) {
      cells.push(c);
    }
  }
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = cells[i];
    cells[i] = cells[j];
    cells[j] = t;
  }
  return cells;
}

/**
 * 計分。`answers` 是與題目序列等長的陣列，每項為所選格號，或 `null` 代表「不確定」。
 *
 * **「不確定」計為答錯**（SP-V.1 明文）。這不是嚴苛，是定義問題：
 * 使用者盯著 dashboard 時不會停下來想「這隻吉祥物在看哪裡」，
 * 讀不出來與讀錯在真實使用中是同一件事。
 */
export function score(questions, answers) {
  if (questions.length !== answers.length) {
    throw new Error(`題數 ${questions.length} 與答案數 ${answers.length} 不符`);
  }
  const perDirection = new Map();
  let correct = 0;
  const confusion = new Map();

  for (let i = 0; i < questions.length; i++) {
    const want = questions[i];
    const got = answers[i];
    const stat = perDirection.get(want) || { asked: 0, correct: 0 };
    stat.asked++;
    if (got === want) {
      stat.correct++;
      correct++;
    } else {
      // 「被誤判成什麼」是回饋給畫師的主體（SP-V.1「沒過怎麼辦」）——
      // 只說「左下不過」他不知道要改什麼；說「左下有 5 次被讀成正下」他就知道了。
      const key = `${want}->${got === null ? 'X' : got}`;
      confusion.set(key, (confusion.get(key) || 0) + 1);
    }
    perDirection.set(want, stat);
  }

  const directions = [...perDirection.entries()]
    .map(([cell, s]) => ({
      cell,
      label: DIRECTION_LABELS[cell],
      asked: s.asked,
      correct: s.correct,
      pct: (s.correct / s.asked) * 100,
    }))
    .sort((a, b) => a.cell - b.cell);

  const overallPct = questions.length === 0 ? 0 : (correct / questions.length) * 100;
  const worst = directions.reduce((w, d) => (w === null || d.pct < w.pct ? d : w), null);

  // ⚠️ **沒被問到的方向不得算通過。** `perDirection` 是以「被問到的格」為 key 建的，
  // 所以一個從頭到尾沒出題的方向**不會出現在 directions 裡**，也就永遠不可能
  // 讓單方向門檻失敗 —— 一份在該方向完全讀不出來的交付會拿到「通過」。
  // 實測：28 題的清單漏掉格 6，全對 → `{ overallPct: 100, passed: true }`。
  // 更極端：只含格 0 的 4 題清單全對，同樣 passed。這條必須 fail-closed。
  const expected = [];
  for (let c = 0; c < 9; c++) {
    if (c !== CENTER_CELL) {
      expected.push(c);
    }
  }
  const asked = new Set(directions.map((d) => d.cell));
  const missing = expected.filter((c) => !asked.has(c));

  return {
    total: questions.length,
    correct,
    overallPct,
    directions,
    worst,
    confusion: [...confusion.entries()]
      .map(([k, n]) => {
        const [want, got] = k.split('->');
        return {
          want: Number(want),
          wantLabel: DIRECTION_LABELS[Number(want)],
          got: got === 'X' ? null : Number(got),
          gotLabel: got === 'X' ? '不確定' : DIRECTION_LABELS[Number(got)],
          count: n,
        };
      })
      .sort((a, b) => b.count - a.count),
    missing,
    missingLabels: missing.map((c) => DIRECTION_LABELS[c]),
    ...verdict(overallPct, worst, missing),
  };
}

/**
 * 兩條門檻的判定。抽出來是為了讓邊界值可以單獨驗。
 *
 * ⚠️ 用 `>=` 而非 `>`：規格寫的是「整體 **≥**85%」「沒有任何單一方向**低於** 60%」，
 * 所以 85.0 與 60.0 都是**通過**。差一個等號就會讓剛好壓線的交付被退回去重畫。
 */
export function verdict(overallPct, worst, missing = []) {
  const overallOk = overallPct >= THRESHOLD_OVERALL_PCT;
  const perDirectionOk = worst === null ? false : worst.pct >= THRESHOLD_PER_DIRECTION_PCT;
  // 八個非中央方向少一個都不算數。見 `score()` 裡的說明。
  const coverageOk = missing.length === 0;
  return {
    overallOk,
    perDirectionOk,
    coverageOk,
    passed: overallOk && perDirectionOk && coverageOk,
    // 第二條門檻存在的理由：整體 85% 可以由「七個方向全對、一個全錯」達成，
    // 而那個全錯的方向在真實使用中就是永遠讀不出來。
    reason: !coverageOk
      ? `有 ${missing.length} 個方向從頭到尾沒被問到（${missing.map((c) => DIRECTION_LABELS[c]).join('、')}）—— 這不是通過也不是不通過，是這一輪不算數`
      : overallOk
        ? perDirectionOk
          ? '通過'
          : `整體達標但「${worst.label}」只有 ${worst.pct.toFixed(1)}%，低於 ${THRESHOLD_PER_DIRECTION_PCT}%`
        : `整體 ${overallPct.toFixed(1)}%，低於 ${THRESHOLD_OVERALL_PCT}%`,
  };
}
