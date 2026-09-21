# 相依與 `npm audit` 裁決

> **結論先講：8 筆 audit 命中全部不進 `dist/`，不修，也不跑 `npm audit fix --force`。**
> 下面每一個數字都是 2026-09-21 當下跑出來的原始輸出，不是引用別份文件的值。

## 當下的命中（2026-09-21，`npm audit --json`）

```
總數 8 → moderate 3, high 5
```

| 套件 | 嚴重度 | direct | 經由 |
|---|---|---|---|
| `@grafana/data` | high | **是** | `dompurify` |
| `@grafana/runtime` | high | **是** | `@grafana/data` |
| `@grafana/ui` | high | **是** | `@grafana/data` |
| `dompurify` | moderate | 否 | DOMPurify: Cross-realm IN_PLACE sanitization |
| `js-cookie` | high | 否 | JavaScript Cookie: Per-instance prototype hijack |
| `react-router` | moderate | 否 | React Router: Open redirect via backslash in `<Link>` |
| `react-router-dom-v5-compat` | moderate | 否 | `react-router` |
| `react-use` | high | 否 | `js-cookie` |

**兩處先前記錄的更正**：

- 「命中全在 devDependencies 的 transitive」是**錯的**。三筆 `isDirect: true` 的
  `@grafana/data` / `@grafana/ui` / `@grafana/runtime` 在 `package.json` 的
  **`dependencies`**，不是 devDependencies。
- 「全在 `react-router-dom-v5-compat` 鏈」是**錯的**。至少三條鏈：
  `dompurify`（經 `@grafana/data`）、`js-cookie → react-use`（三者皆經）、
  `react-router → react-router-dom-v5-compat`（經 `@grafana/ui`）。
- `P2-handoff.md` 記的「8 個漏洞（5 high）」與另一處記的「3 moderate / 5 high」
  **其實一致**（3 + 5 = 8），不是矛盾。

## 為什麼不修：它們不在出貨的檔案裡

`.config/bundler/externals.ts` 把三個 `@grafana/*` 標為 external，
所以它們與其相依鏈**不會被打包**，執行期由 Grafana 本體提供：

```
/^@grafana\/ui/i
/^@grafana\/runtime/i
/^@grafana\/data/i
```

量測佐證（2026-09-21）：

```
$ ls -l dist/module.js
24967 bytes
$ grep -c 'js-cookie\|react-router\|react-use' dist/module.js
0
```

> 順帶更正：`docs/sprite/sprite-sheet-spec.md` SP-7.8 引用的 `dist/module.js`
> **20,915 bytes 已過期**，當下是 24,967。

## ⚠️ 這裡有一個給下一個人的陷阱

**`@grafana/schema` 與 `@grafana/i18n` 不在 externals。**

兩者都在 `package.json` 的 `dependencies`（皆為 `13.1.0`），
但 `externals.ts` 的清單裡沒有它們 —— 裡面有的是上游的 `i18next`，那是不同的套件。

所以：**現在 `src/` 對這兩個是零 import，一旦有人 import，它們會真的進 bundle。**
`dist/module.js` 會無聲地變大，而 typecheck 與 lint 一個都不會紅。

（這也是為什麼「從 `package.json` 拿掉它們可以減少 audit 噪音」是錯的：
實查 `@grafana/{data,ui,runtime}` 三者都直接相依 `@grafana/schema@13.1.0`、
前兩者還相依 `@grafana/i18n@13.1.0` —— 從頂層拿掉不會讓它們離開 `node_modules`，
audit 數字一筆都不會變。移除它們無害，但也無益。）

## 為什麼**不得**跑 `npm audit fix --force`

實跑 `npm audit fix --dry-run --force`（2026-09-21），逐字輸出：

```
npm warn audit Updating @grafana/runtime to 13.2.2, which is outside your stated dependency range.
npm warn While resolving: @grafana/runtime@13.2.2
npm warn Found: react@18.3.1
npm warn   peer react@">=19" from @grafana/data@13.2.2
npm warn Could not resolve dependency:
npm warn peer react@">=19" from @grafana/runtime@13.2.2
```

兩個獨立的理由：

1. **它會破壞 ADR-004 決策 1 明文的編譯期 pin。** `@grafana/*` 釘在 13.1.0 是設計，
   不是疏忽 —— plugin 對著較舊的 API 編譯、由較新的 Grafana（13.2.x）在執行期提供實作，
   這是 externals 模型的整個重點。
2. **13.2.2 要求 `react >= 19`，本專案是 18.3.1。** 這是計畫沒預期到的第二道牆：
   即使願意動 pin，升上去也會留下一個解不開的 peer dependency。

## 複驗方式

```bash
npm audit --json | jq '.metadata.vulnerabilities'
npm run build && ls -l dist/module.js
grep -c 'js-cookie\|react-router\|react-use' dist/module.js   # 必須是 0
```

第三條是這份裁決的核心 —— **它一旦不是 0，上面整套推論就不成立**，
表示有人 import 了本來不會進 bundle 的東西，或 externals 設定被改動了。
