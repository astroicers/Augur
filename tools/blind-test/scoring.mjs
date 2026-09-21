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

/** SP-V.1：每個非中央格至少 4 題。 */
export const MIN_QUESTIONS_PER_CELL = 4;

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
    ...verdict(overallPct, worst),
  };
}

/**
 * 兩條門檻的判定。抽出來是為了讓邊界值可以單獨驗。
 *
 * ⚠️ 用 `>=` 而非 `>`：規格寫的是「整體 **≥**85%」「沒有任何單一方向**低於** 60%」，
 * 所以 85.0 與 60.0 都是**通過**。差一個等號就會讓剛好壓線的交付被退回去重畫。
 */
export function verdict(overallPct, worst) {
  const overallOk = overallPct >= THRESHOLD_OVERALL_PCT;
  const perDirectionOk = worst === null ? false : worst.pct >= THRESHOLD_PER_DIRECTION_PCT;
  return {
    overallOk,
    perDirectionOk,
    passed: overallOk && perDirectionOk,
    // 第二條門檻存在的理由：整體 85% 可以由「七個方向全對、一個全錯」達成，
    // 而那個全錯的方向在真實使用中就是永遠讀不出來。
    reason: overallOk
      ? perDirectionOk
        ? '通過'
        : `整體達標但「${worst.label}」只有 ${worst.pct.toFixed(1)}%，低於 ${THRESHOLD_PER_DIRECTION_PCT}%`
      : `整體 ${overallPct.toFixed(1)}%，低於 ${THRESHOLD_OVERALL_PCT}%`,
  };
}
