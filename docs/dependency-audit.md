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

量測佐證 —— **看 sourcemap 列出的模組來源**：

```bash
npm run build
node tools/check-bundle-deps.mjs
```

乾淨 build 的輸出是
`BUNDLE-DEPS: PASS  bundle 裡的 node_modules 模組只有 grafana-public-path.js`。

> **【2026-09-22 訂正：先前這裡寫的兩種方法都驗不出東西】**
>
> 這一段原本寫「看 AMD 的 `define([...])` 清單，輸出應該只有三個 `@grafana/*` 加 React」。
> **兩件事都錯：**
>
> 1. **通過條件在乾淨 build 上就不成立。** 實際輸出是
>    `define(["@emotion/css","@grafana/data","@grafana/runtime","@grafana/ui","module","react"])`
>    —— `@emotion/css` 與 `module` 本來就在 `.config/` 託管的 externals 清單裡。
>    照文件判定的人會認定「多出兩項 → 整份 audit 失效」，然後去追一個不存在的問題。
>
> 2. **方向剛好反了，所以它偵測不到它宣稱要偵測的東西。** 被 **externalise** 的東西才會
>    出現在 define 清單裡，被**打包進去**的不會 —— 而稽核要防的正是「打包進去」那一種。
>    實測：在 `src/module.ts` 加一行 `import Cookies from 'js-cookie'`，
>    bundle 由 **25,558 → 27,299 bytes**（js-cookie 整包編了進去），
>    而 define 清單**與基準逐字相同**，複驗者會結論「沒有多出東西，裁決仍成立」。
>    更早的那版 `grep -c 'js-cookie' dist/module.js` 同樣讀 **0**（壓縮後套件名不留字面字串）。
>
> 真正量得到的是 **sourcemap 的 `sources`** —— webpack 逐筆列出編進 bundle 的每個模組
> 與路徑。同一個實驗裡 js-cookie 指名道姓出現在
> `webpack://augur-mascot-panel/../node_modules/js-cookie/src/js.cookie.js`。
> 清單是離散的（多一個少一個看得出來），不像位元組數會逐版漂移。
>
> 已做成機械檢查 `tools/check-bundle-deps.mjs` 並納入 commit 閘 ——
> 散文形式的複驗指令沒人會跑，而且這份文件的兩個版本都示範了它會怎麼寫錯。
> 該檢查稽核的是**磁碟上現有的 dist**，所以要權威的結論就先 `npm run build`。
> （一度想加「dist 比 src 舊就失敗」，但那是誤紅：webpack 對未變動的輸出不重寫檔案，
> 所以正確的 build 也會被判過期。內容相同本來就表示 bundle 是對的。）

> ⚠️ **原本這裡寫的是 `grep -c 'js-cookie|react-router|react-use' dist/module.js` 必須為 0，
> 那條驗不出東西。** 打包後的程式碼是壓縮過的 —— 套件名不會以字面字串出現在 bundle 裡。
> 真的有人 `import Cookies from 'js-cookie'` 時，js-cookie 的程式碼會被編進去、
> bundle 變大，而那個 grep **仍然是 0**。要看的是 AMD `define([...])` 的相依清單：
> 被 externalise 的東西會出現在那裡，被打包進去的不會。
>
> **也不要引用絕對位元組數。** 先前這裡寫「24,967 bytes」，它在寫下的同一天就因為
> 一次無關的改動變成 25,112。`sprite-sheet-spec.md` SP-7.8 引用的 20,915 同樣早就過期。
> 位元組數每次 build 都會動，而**沒有任何東西依賴它的確切值** —— 要判斷的是
> 「相依清單有沒有多出東西」，那是離散的、看得出來的。

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
npm run build
node tools/check-bundle-deps.mjs
```

**第三條是這份裁決的核心**：出貨的 `dist/module.js` 裡一旦出現 `grafana-public-path.js`
以外的 `node_modules` 模組，上面整套推論就不成立 —— 表示有人 import 了會被打包進去的
第三方程式碼。清單是離散的，多一個少一個看得出來；位元組數不是。

⚠️ 這條**不要**改回看 AMD `define([...])` 清單或 grep 套件名 —— 兩種都實測驗不出東西，
理由見上方〈量測佐證〉的訂正框。
