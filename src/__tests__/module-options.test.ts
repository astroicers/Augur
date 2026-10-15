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
