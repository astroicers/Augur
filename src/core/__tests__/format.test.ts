/**
 * `formatAlert` 的播報句單元測試（#39 AC-2）。
 *
 * 在本票之前，`format.ts` 只有 `format-plan.test.ts` 經 `buildBroadcastPlan` 間接
 * 覆蓋播報句，且用的全是乾淨 severity；於是「嚴重度缺值時念出 `undefined`」
 * （QA 在 #38 記錄）一路無人攔。這支直接打 `formatAlert`，並對**整句**下斷言——
 * 中文句以「，」串接，省略方式不同會產生不同的破碎句，只斷言「不含 undefined」
 * 會讓「整句省略嚴重度」與「念 unknown」兩種實作都算過。
 */
import { formatAlert } from '../format';
import type { ParsedAlert } from '../types';

function mk(over: Partial<ParsedAlert> = {}): ParsedAlert {
  return {
    status: 'firing',
    source: 'grafana',
    name: 'HighCPU',
    severity: 'critical',
    instance: 'host-1',
    summary: 'CPU high',
    value: 95.2,
    startsAt: '2026-01-01T00:00:00Z',
    fingerprint: 'fp-1',
    ...over,
  };
}

/** 型別標註說 severity 是 string，但本票要測的正是「標註不可信」的那些值。 */
function withSeverity(severity: unknown, over: Partial<ParsedAlert> = {}): ParsedAlert {
  return { ...mk(over), severity } as unknown as ParsedAlert;
}

/** 缺值/非字串都收斂成這個字串（= `panelAlerts.ts` 的 `?? 'unknown'`）。 */
const DIRTY: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['空字串', ''],
  ['全空白', '   '],
  ['數字 0', 0],
  ['數字 42', 42],
  ['NaN', NaN],
  ['空物件', {}],
  ['有 severity 欄位的物件', { severity: 'critical' }],
  ['空陣列', []],
  ['單元素陣列', ['critical']],
  ['true', true],
  ['function', () => 'critical'],
];

// ---- 乾淨輸入：既有行為一字未改 ----

test('firing：中文句帶名稱、嚴重度、對象、數值、摘要', () => {
  expect(formatAlert(mk())).toBe(
    '偵測到告警：HighCPU，嚴重度 critical，受影響對象 host-1，目前數值 95.20，CPU high。',
  );
});

test('firing：英文句同構（lang=en）', () => {
  expect(formatAlert(mk(), 'en')).toBe(
    'Alert firing: HighCPU, severity critical, on host-1, current value 95.20, CPU high.',
  );
});

test('resolved：不帶嚴重度子句（兩種語言）', () => {
  const a = mk({ status: 'resolved' });
  expect(formatAlert(a)).toBe('告警已恢復：HighCPU，受影響對象 host-1，目前數值 95.20，CPU high。');
  expect(formatAlert(a, 'en')).toBe('Alert resolved: HighCPU, on host-1, current value 95.20, CPU high.');
});

test('lang 預設為 zh', () => {
  expect(formatAlert(mk())).toBe(formatAlert(mk(), 'zh'));
});

// ---- #39 AC-2：嚴重度缺值、null、非字串 ----

test('AC-2：髒嚴重度一律念 unknown，整句釘死（zh）', () => {
  const expected = '偵測到告警：HighCPU，嚴重度 unknown，受影響對象 host-1，目前數值 95.20，CPU high。';
  // 斷言帶上 label，失敗時的 diff 直接說是哪一筆髒值，不必數迴圈。
  for (const [label, v] of DIRTY) {
    expect([label, formatAlert(withSeverity(v))]).toEqual([label, expected]);
  }
});

test('AC-2：髒嚴重度一律念 unknown，整句釘死（en）', () => {
  for (const [, v] of DIRTY) {
    expect(formatAlert(withSeverity(v), 'en')).toBe(
      'Alert firing: HighCPU, severity unknown, on host-1, current value 95.20, CPU high.',
    );
  }
});

test('AC-2：播報句不含 undefined / null / [object Object] 等 JS 轉字串痕跡', () => {
  for (const [, v] of DIRTY) {
    for (const lang of ['zh', 'en'] as const) {
      const text = formatAlert(withSeverity(v), lang);
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('null');
      expect(text).not.toContain('[object Object]');
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('=>');
      expect(text).not.toContain('function');
    }
  }
});

test('AC-2：髒嚴重度與字串 unknown 的播報句完全一致', () => {
  const baseline = { zh: formatAlert(withSeverity('unknown')), en: formatAlert(withSeverity('unknown'), 'en') };
  for (const [, v] of DIRTY) {
    expect(formatAlert(withSeverity(v))).toBe(baseline.zh);
    expect(formatAlert(withSeverity(v), 'en')).toBe(baseline.en);
  }
});

test('AC-2：髒嚴重度時嚴重度子句不被省略——子句數與乾淨輸入相同', () => {
  const clean = formatAlert(mk()).split('，').length;
  for (const [, v] of DIRTY) {
    expect(formatAlert(withSeverity(v)).split('，').length).toBe(clean);
  }
});

test('AC-2：resolved 不念嚴重度，髒值也不滲進句子', () => {
  for (const [, v] of DIRTY) {
    expect(formatAlert(withSeverity(v, { status: 'resolved' }))).toBe(
      '告警已恢復：HighCPU，受影響對象 host-1，目前數值 95.20，CPU high。',
    );
  }
});

test('AC-2：髒嚴重度不拋例外（最小 ParsedAlert，連可選欄位都缺）', () => {
  for (const [, v] of DIRTY) {
    const bare = withSeverity(v);
    delete bare.instance;
    delete bare.summary;
    delete bare.value;
    expect(() => formatAlert(bare)).not.toThrow();
    expect(formatAlert(bare)).toBe('偵測到告警：HighCPU，嚴重度 unknown。');
    expect(formatAlert(bare, 'en')).toBe('Alert firing: HighCPU, severity unknown.');
  }
});

// ---- 正規化：與 severity.ts 的 normalize 同一份 ----

test('嚴重度去空白、轉小寫後才念出（不是原樣轉手）', () => {
  expect(formatAlert(withSeverity(' CRITICAL '))).toBe(
    '偵測到告警：HighCPU，嚴重度 critical，受影響對象 host-1，目前數值 95.20，CPU high。',
  );
  expect(formatAlert(withSeverity('\tWarning\n'), 'en')).toBe(
    'Alert firing: HighCPU, severity warning, on host-1, current value 95.20, CPU high.',
  );
});

test('未知但合法的字串嚴重度照原字念（只正規化，不改寫成 unknown）', () => {
  expect(formatAlert(withSeverity('fatal'))).toContain('嚴重度 fatal');
  expect(formatAlert(withSeverity('Sev1'), 'en')).toContain('severity sev1');
});

// ---- #46：name / instance / summary / value 的缺值與非字串 ----

/**
 * 型別標註說 `name: string`、`instance?: string`、`summary?: string`、`value?: number`，
 * 但這四個欄位與 severity 同樣來自 Grafana 的面板資料，標註一樣不可信（#46）。
 * 下面每一條都用**整句比對**：只斷言「不含 undefined」會讓「省略整個子句」與
 * 「換個詞念」兩種實作都算過，而這兩者是不同的句型（#39 的教訓）。
 */
function withField(field: keyof ParsedAlert, value: unknown, over: Partial<ParsedAlert> = {}): ParsedAlert {
  return { ...mk(over), [field]: value } as unknown as ParsedAlert;
}

/** 四個欄位共用的髒值清單：缺值、空白、以及各類非字串。 */
const DIRTY_FIELD: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['空字串', ''],
  ['全空白', '   '],
  ['空物件', {}],
  ['有同名欄位的物件', { name: 'HighCPU' }],
  ['空陣列', []],
  ['單元素陣列', ['HighCPU']],
  ['多元素陣列', [1, 2]],
  ['數字 0', 0],
  ['數字 42', 42],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['true', true],
  ['false', false],
  ['function', () => 'HighCPU'],
];

/**
 * 對四個欄位**同時**都算髒的值：從共用清單扣掉有限數字——`0` / `42` 對 `value`
 * 是完全正常的值，只有對 name/instance/summary 才算髒。
 */
const DIRTY_EVERY_FIELD: Array<[string, unknown]> = [
  ...DIRTY_FIELD.filter(([label]) => !label.startsWith('數字')),
  ['-Infinity', -Infinity],
];

/** `value` 專用：再補上「看起來像數字的字串」——它對 name 合法，對 value 仍是非數字。 */
const DIRTY_VALUE: Array<[string, unknown]> = [...DIRTY_EVERY_FIELD, ['數字字串', '95.2']];

/** 句子裡絕不該出現的 JS 轉字串痕跡（票文列的前三個 + 實測會漏出的其餘幾個）。 */
const ARTIFACTS = ['undefined', 'null', '[object Object]', 'NaN', 'Infinity', 'true', 'false', '=>', 'function'];

// AC-1：name

test('AC-1：name 髒值時 zh 念「未命名告警」，整句釘死', () => {
  const expected = '偵測到告警：未命名告警，嚴重度 critical，受影響對象 host-1，目前數值 95.20，CPU high。';
  for (const [label, v] of DIRTY_FIELD) {
    expect([label, formatAlert(withField('name', v))]).toEqual([label, expected]);
  }
});

test('AC-1：name 髒值時 en 念 "unnamed alert"，整句釘死', () => {
  const expected = 'Alert firing: unnamed alert, severity critical, on host-1, current value 95.20, CPU high.';
  for (const [label, v] of DIRTY_FIELD) {
    expect([label, formatAlert(withField('name', v), 'en')]).toEqual([label, expected]);
  }
});

test('AC-1：resolved 時 name 髒值一樣換成替代詞，整句釘死（兩種語言）', () => {
  for (const [label, v] of DIRTY_FIELD) {
    const a = withField('name', v, { status: 'resolved' });
    expect([label, formatAlert(a)]).toEqual([
      label,
      '告警已恢復：未命名告警，受影響對象 host-1，目前數值 95.20，CPU high。',
    ]);
    expect([label, formatAlert(a, 'en')]).toEqual([
      label,
      'Alert resolved: unnamed alert, on host-1, current value 95.20, CPU high.',
    ]);
  }
});

test('AC-1：name 髒值時名稱子句不被省略——子句數與乾淨輸入相同（兩種語言）', () => {
  const cleanZh = formatAlert(mk()).split('，').length;
  const cleanEn = formatAlert(mk(), 'en').split(', ').length;
  for (const [label, v] of DIRTY_FIELD) {
    expect([label, formatAlert(withField('name', v)).split('，').length]).toEqual([label, cleanZh]);
    expect([label, formatAlert(withField('name', v), 'en').split(', ').length]).toEqual([label, cleanEn]);
  }
});

// AC-2：instance / summary / value

test('AC-2：instance 髒值時整個「受影響對象」子句消失，整句釘死（兩種語言）', () => {
  for (const [label, v] of DIRTY_FIELD) {
    expect([label, formatAlert(withField('instance', v))]).toEqual([
      label,
      '偵測到告警：HighCPU，嚴重度 critical，目前數值 95.20，CPU high。',
    ]);
    expect([label, formatAlert(withField('instance', v), 'en')]).toEqual([
      label,
      'Alert firing: HighCPU, severity critical, current value 95.20, CPU high.',
    ]);
  }
});

test('AC-2：summary 髒值時整個摘要子句消失，整句釘死（兩種語言）', () => {
  for (const [label, v] of DIRTY_FIELD) {
    expect([label, formatAlert(withField('summary', v))]).toEqual([
      label,
      '偵測到告警：HighCPU，嚴重度 critical，受影響對象 host-1，目前數值 95.20。',
    ]);
    expect([label, formatAlert(withField('summary', v), 'en')]).toEqual([
      label,
      'Alert firing: HighCPU, severity critical, on host-1, current value 95.20.',
    ]);
  }
});

/**
 * `value` 不在 AC-2 列出的兩個欄位裡，但票文標題寫的是「其他欄位」，而它是同一個缺陷：
 * 舊實作的 `formatNumber` 第一行 `if (!Number.isFinite(n)) return String(n)` 正好
 * 產出本票要擋的字串（`{}` → `[object Object]`、`[1, 2]` → `1,2`、`NaN` → `NaN`）。
 */
test('AC-2（延伸）：value 非數字或非有限值時整個數值子句消失，整句釘死（兩種語言）', () => {
  for (const [label, v] of DIRTY_VALUE) {
    expect([label, formatAlert(withField('value', v))]).toEqual([
      label,
      '偵測到告警：HighCPU，嚴重度 critical，受影響對象 host-1，CPU high。',
    ]);
    expect([label, formatAlert(withField('value', v), 'en')]).toEqual([
      label,
      'Alert firing: HighCPU, severity critical, on host-1, CPU high.',
    ]);
  }
});

test('AC-2：髒欄位與該欄位整個缺席的句子逐字相同（instance / summary / value）', () => {
  for (const field of ['instance', 'summary', 'value'] as const) {
    const absent = mk();
    delete absent[field];
    for (const [label, v] of field === 'value' ? DIRTY_VALUE : DIRTY_FIELD) {
      expect([label, field, formatAlert(withField(field, v))]).toEqual([label, field, formatAlert(absent)]);
      expect([label, field, formatAlert(withField(field, v), 'en')]).toEqual([
        label,
        field,
        formatAlert(absent, 'en'),
      ]);
    }
  }
});

test('AC-1/AC-2：四個欄位同時是髒值時仍組得出句子，整句釘死（兩種語言）', () => {
  for (const [label, v] of DIRTY_EVERY_FIELD) {
    const a = { ...mk(), name: v, instance: v, summary: v, value: v } as unknown as ParsedAlert;
    expect([label, formatAlert(a)]).toEqual([label, '偵測到告警：未命名告警，嚴重度 critical。']);
    expect([label, formatAlert(a, 'en')]).toEqual([label, 'Alert firing: unnamed alert, severity critical.']);
  }
});

test('AC-1/AC-2：任一欄位髒值都不讓 JS 轉字串痕跡漏進句子（兩種語言）', () => {
  for (const field of ['name', 'instance', 'summary', 'value'] as const) {
    for (const [label, v] of field === 'value' ? DIRTY_VALUE : DIRTY_FIELD) {
      for (const lang of ['zh', 'en'] as const) {
        const text = formatAlert(withField(field, v), lang);
        for (const artifact of ARTIFACTS) {
          expect([label, field, lang, artifact, text.includes(artifact)]).toEqual([
            label,
            field,
            lang,
            artifact,
            false,
          ]);
        }
      }
    }
  }
});

test('AC-1/AC-2：髒值不拋例外，連 severity 也一起髒掉時也不拋', () => {
  for (const [, v] of DIRTY_EVERY_FIELD) {
    const a = { ...mk(), name: v, severity: v, instance: v, summary: v, value: v } as unknown as ParsedAlert;
    expect(() => formatAlert(a)).not.toThrow();
    expect(formatAlert(a)).toBe('偵測到告警：未命名告警，嚴重度 unknown。');
    expect(formatAlert(a, 'en')).toBe('Alert firing: unnamed alert, severity unknown.');
  }
});

// AC-3：正常字串逐字不變

test('AC-3：前後有空白的正常字串原樣念出（判空才 trim，輸出不 trim）', () => {
  expect(formatAlert(withField('instance', ' host-1 '))).toBe(
    '偵測到告警：HighCPU，嚴重度 critical，受影響對象  host-1 ，目前數值 95.20，CPU high。',
  );
  expect(formatAlert(withField('name', ' HighCPU '), 'en')).toBe(
    'Alert firing:  HighCPU , severity critical, on host-1, current value 95.20, CPU high.',
  );
});

test('AC-3：有限數值的格式化規則未變（整數、兩位小數、極小值、極大值、負值、0）', () => {
  const cases: Array<[unknown, string]> = [
    [42, '42'],
    [0, '0'],
    [-5, '-5'],
    [95.2, '95.20'],
    [-0.5, '-0.50'],
    [0.004, '0.0040'],
    [1e21, '1000000000000000000000'],
  ];
  for (const [v, expected] of cases) {
    expect([v, formatAlert(withField('value', v), 'en')]).toEqual([
      v,
      `Alert firing: HighCPU, severity critical, on host-1, current value ${expected}, CPU high.`,
    ]);
  }
});

test('AC-3：name/instance/summary 是一般字串時整句與修補前逐字相同', () => {
  expect(formatAlert(mk({ name: 'DiskFull', instance: 'db-7', summary: '磁碟將滿' }))).toBe(
    '偵測到告警：DiskFull，嚴重度 critical，受影響對象 db-7，目前數值 95.20，磁碟將滿。',
  );
  expect(formatAlert(mk({ name: 'DiskFull', instance: 'db-7', summary: 'disk almost full' }), 'en')).toBe(
    'Alert firing: DiskFull, severity critical, on db-7, current value 95.20, disk almost full.',
  );
});

// ---- #71：speakValue 關掉時不念「目前數值」子句 ----

/**
 * 把開著時的句子裡那一段數值子句**整段**切掉（含一側的分隔符），當成 AC-2 的期望值。
 * 它可能在句中（後面接分隔符）也可能是最後一段（前面接分隔符、後面是句末符號）。
 */
function dropValueClause(sentence: string, lang: 'zh' | 'en', value: string): string {
  const clause = lang === 'zh' ? `目前數值 ${value}` : `current value ${value}`;
  const sep = lang === 'zh' ? '，' : ', ';
  expect(sentence).toContain(clause);
  return sentence.includes(`${clause}${sep}`)
    ? sentence.replace(`${clause}${sep}`, '')
    : sentence.replace(`${sep}${clause}`, '');
}

test('#71 AC-1：省略 opts、傳 undefined、傳 true 三者與預設逐字相同', () => {
  for (const lang of ['zh', 'en'] as const) {
    for (const status of ['firing', 'resolved'] as const) {
      const a = mk({ status });
      const baseline = formatAlert(a, lang);
      expect([lang, status, formatAlert(a, lang, undefined)]).toEqual([lang, status, baseline]);
      expect([lang, status, formatAlert(a, lang, {})]).toEqual([lang, status, baseline]);
      expect([lang, status, formatAlert(a, lang, { speakValue: undefined })]).toEqual([lang, status, baseline]);
      expect([lang, status, formatAlert(a, lang, { speakValue: true })]).toEqual([lang, status, baseline]);
      // 開著時數值照念（AC-1 的「行為完全相同」有這一半才是成立的）。
      expect(baseline).toContain(lang === 'zh' ? '目前數值 95.20' : 'current value 95.20');
    }
  }
});

test('#71 AC-2：關掉後中英兩套都不含數值子句，整句就是開著時少掉那一段', () => {
  expect(formatAlert(mk(), 'zh', { speakValue: false })).toBe(
    '偵測到告警：HighCPU，嚴重度 critical，受影響對象 host-1，CPU high。',
  );
  expect(formatAlert(mk(), 'en', { speakValue: false })).toBe(
    'Alert firing: HighCPU, severity critical, on host-1, CPU high.',
  );
  const resolved = mk({ status: 'resolved' });
  expect(formatAlert(resolved, 'zh', { speakValue: false })).toBe(
    '告警已恢復：HighCPU，受影響對象 host-1，CPU high。',
  );
  expect(formatAlert(resolved, 'en', { speakValue: false })).toBe('Alert resolved: HighCPU, on host-1, CPU high.');
});

test('#71 AC-2：各種句型下，其餘子句（名稱、嚴重度、摘要、恢復句）與開著時逐字相同', () => {
  // 刻意涵蓋「少掉別的子句」的句型：數值子句的前後鄰居不同，切掉它的位置也不同。
  const shapes: Array<[string, ParsedAlert, string]> = [
    ['完整', mk(), '95.20'],
    ['沒有對象', mk({ instance: undefined }), '95.20'],
    ['沒有摘要（數值是最後一段）', mk({ summary: undefined }), '95.20'],
    ['只有名稱與數值', mk({ instance: undefined, summary: undefined }), '95.20'],
    ['恢復句', mk({ status: 'resolved' }), '95.20'],
    ['恢復句只有數值', mk({ status: 'resolved', instance: undefined, summary: undefined }), '95.20'],
    ['名稱缺值（念替代詞）', mk({ name: undefined as unknown as string }), '95.20'],
    ['嚴重度缺值（念 unknown）', mk({ severity: undefined as unknown as string }), '95.20'],
    ['整數數值', mk({ value: 1 }), '1'],
    ['極大數值', mk({ value: 1e21 }), '1000000000000000000000'],
  ];
  for (const [label, a, spoken] of shapes) {
    for (const lang of ['zh', 'en'] as const) {
      const on = formatAlert(a, lang);
      const off = formatAlert(a, lang, { speakValue: false });
      expect([label, lang, off]).toEqual([label, lang, dropValueClause(on, lang, spoken)]);
      expect(off).not.toContain(lang === 'zh' ? '目前數值' : 'current value');
    }
  }
});

test('#71 AC-2：沒有可念數值時，關與開逐字相同（關掉不是「少一個子句」而是「本來就沒有」）', () => {
  // `value` 缺值／念不出來時本來就沒有那一段（#46），關掉不該讓句子再變一次。
  const noValue: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['NaN', NaN],
    ['字串 "95.2"', '95.2'],
    ['null', null],
    ['空物件', {}],
  ];
  for (const [label, v] of noValue) {
    for (const lang of ['zh', 'en'] as const) {
      const a = withField('value', v);
      expect([label, lang, formatAlert(a, lang, { speakValue: false })]).toEqual([
        label,
        lang,
        formatAlert(a, lang),
      ]);
    }
  }
});

test('#71：關掉後句子的子句數剛好少一段（中文以「，」、英文以「, 」串接）', () => {
  expect(formatAlert(mk()).split('，').length - formatAlert(mk(), 'zh', { speakValue: false }).split('，').length).toBe(
    1,
  );
  expect(
    formatAlert(mk(), 'en').split(', ').length - formatAlert(mk(), 'en', { speakValue: false }).split(', ').length,
  ).toBe(1);
});
