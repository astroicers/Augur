/**
 * Panel 選項的**註冊面**(`src/module.ts`)。
 *
 * 為什麼需要這一支:`addTextInput({ path })` 的 `path` 在 `@grafana/data` 的型別上
 * 只是 `string`,**不是** `keyof TOptions`——把 `path` 打錯(`severityAliasesX`)
 * 不會讓 `npm run typecheck` 變紅(2026-10-14 實測:改成不存在的鍵,`tsc --noEmit` 仍 exit 0)。
 * 失敗形態是沉默的:編輯器把值寫進一個沒人讀的鍵,面板讀到的永遠是預設值,
 * 使用者設了別名卻完全沒反應,而全部單元測試照樣全綠(core 的測試只走純函式,
 * 面板測試直接餵 options 物件,兩邊都繞過註冊)。
 *
 * 所以這裡跑的是真的 `PanelOptionsEditorBuilder`,斷言打在註冊結果上,
 * 而不是讀 `module.ts` 的原始碼字串。
 */
import { PanelOptionsEditorBuilder, standardEditorsRegistry } from '@grafana/data';
import { plugin } from '../module';
import { DEFAULT_OPTIONS, type MascotPanelOptions } from '../panelOptions';
import { parseSeverityAliases } from '../core/severityAliases';
import { parseQuietHours } from '../director/BroadcastDirector';

/**
 * 編輯器元件本身由 Grafana 在執行期注入（`standardEditorsRegistry` 在 app 啟動時才填）。
 * 這支測試不渲染編輯器，只看註冊結果，所以給每個 id 一個不渲染的樁就夠。
 */
standardEditorsRegistry.setInit(() =>
  ['text', 'number', 'slider', 'select', 'radio', 'boolean', 'unit', 'color'].map((id) => ({
    id,
    name: id,
    editor: () => null,
  }))
);

function registeredOptions() {
  const builder = new PanelOptionsEditorBuilder<MascotPanelOptions>();
  plugin.getPanelOptionsSupplier()(builder, { data: [], options: DEFAULT_OPTIONS });
  return builder.getItems();
}

test('每個註冊的選項 path 都是 MascotPanelOptions 的實際欄位（打錯 path 會沉默失效）', () => {
  const known = Object.keys(DEFAULT_OPTIONS);
  const paths = registeredOptions().map((o) => o.path);
  expect(paths.length).toBeGreaterThan(0);
  for (const p of paths) {
    expect(known).toContain(p);
  }
  // 同一個鍵不該註冊兩次（後者會蓋掉前者的編輯器）。
  expect(new Set(paths).size).toBe(paths.length);
});

test('#51 AC-1：severityAliases 註冊在編輯器上，預設值是空字串', () => {
  const opt = registeredOptions().find((o) => o.path === 'severityAliases');
  expect(opt).toBeDefined();
  expect(opt!.defaultValue).toBe('');
  expect(DEFAULT_OPTIONS.severityAliases).toBe('');
});

test('#51 AC-4：severityAliases 的說明有一句說明與一個範例', () => {
  const opt = registeredOptions().find((o) => o.path === 'severityAliases');
  const description = opt?.description ?? '';
  // 範例要是**解析得出來**的格式，不是看起來像範例的字。
  const example = /([A-Za-z0-9]+=[a-z]+(?:,\s*[A-Za-z0-9]+=[a-z]+)*)/.exec(description)?.[1];
  expect(example).toBeDefined();
  const { aliases, skipped } = parseSeverityAliases(example);
  expect(skipped).toEqual([]);
  expect(aliases.size).toBeGreaterThan(0);
  // 說明要講到「留空」的語意（AC-1 的使用者可見面）。
  expect(description).toContain('留空');
  // LOW-4：講的是「前後空白」不計 —— 中間的空白有作用，說成「空白不計」會誤導。
  expect(description).toContain('大小寫與前後空白不計');
});

test('#63 AC-1：quietHours／quietAllowCritical 註冊在編輯器上，預設是「沒有排程靜音」', () => {
  const quiet = registeredOptions().find((o) => o.path === 'quietHours');
  expect(quiet).toBeDefined();
  expect(quiet!.defaultValue).toBe('');
  expect(DEFAULT_OPTIONS.quietHours).toBe('');

  const allow = registeredOptions().find((o) => o.path === 'quietAllowCritical');
  expect(allow).toBeDefined();
  expect(allow!.defaultValue).toBe(false);
  expect(DEFAULT_OPTIONS.quietAllowCritical).toBe(false);
});

test('#63 AC-6：quietHours 的說明寫明 dashboard 層級、端點規則、與 ADR-007 的關係，且範例解析得出來', () => {
  const description = registeredOptions().find((o) => o.path === 'quietHours')?.description ?? '';
  // 範例要是**解析得出來**的格式，不是看起來像範例的字。
  const example = /(\d{1,2}:\d{2}-\d{1,2}:\d{2})/.exec(description)?.[1];
  expect(example).toBeDefined();
  expect(parseQuietHours(example).range).not.toBeNull();
  // 兩種靜音是不同層級的開關（AC-6），說明裡要講清楚，否則使用者會以為它取代了靜音鈕。
  expect(description).toContain('dashboard');
  expect(description).toContain('任一個成立就不念');
  // 端點規則不能只寫在程式裡（AC-2 要求「寫明」）。
  expect(description).toContain('起點算在內、終點不算');
  // 本地時間的代價（跨時區、日光節約）要說，不然「所有觀看者共用」會被讀成同一個絕對時段。
  expect(description).toContain('本地時間');
  expect(description).toContain('留空');
});

test('#63 AC-3：quietAllowCritical 的說明寫明只對排程靜音生效、且經別名判斷', () => {
  const description = registeredOptions().find((o) => o.path === 'quietAllowCritical')?.description ?? '';
  expect(description).toContain('別名');
  expect(description).toContain('只對上面這個時段生效');
});

test('#63：quietAllowCritical 只在設了時段且開著語音時顯示（沒設時段時它無從生效）', () => {
  const allow = registeredOptions().find((o) => o.path === 'quietAllowCritical');
  const showIf = allow!.showIf!;
  const base = { ...DEFAULT_OPTIONS };
  expect(showIf({ ...base, quietHours: '22:00-07:00' })).toBe(true);
  expect(showIf({ ...base, quietHours: '   ' })).toBeFalsy();
  expect(showIf({ ...base })).toBeFalsy();
  expect(showIf({ ...base, quietHours: '22:00-07:00', enableTTS: false })).toBeFalsy();
});

test('#71 AC-1：speakValue 註冊在編輯器上，預設是「開」（念數值）', () => {
  const opt = registeredOptions().find((o) => o.path === 'speakValue');
  expect(opt).toBeDefined();
  expect(opt!.defaultValue).toBe(true);
  expect(DEFAULT_OPTIONS.speakValue).toBe(true);
});

test('#71 AC-4：speakValue 的說明寫明用途（條件只是 0／1 或查 ALERTS 時數值沒有意義）', () => {
  const description = registeredOptions().find((o) => o.path === 'speakValue')?.description ?? '';
  expect(description).toContain('ALERTS');
  expect(description).toContain('0／1');
  expect(description).toContain('沒有意義');
  // 關掉只少那一段，其餘逐字不變（AC-2 的使用者可見面）。
  expect(description).toContain('逐字不變');
});

test('#71：speakValue 不受「開啟語音」左右 —— 播報紀錄的句子也吃它，所以不藏起來', () => {
  const opt = registeredOptions().find((o) => o.path === 'speakValue');
  expect(opt!.showIf).toBeUndefined();
});
