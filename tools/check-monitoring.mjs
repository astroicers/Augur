#!/usr/bin/env node
/**
 * `monitoring/` 設定的自洽性檢查。`node tools/check-monitoring.mjs`。
 *
 * 這裡每一條都對應一個**已經發生過**的缺陷，而它們的共通點是**失敗時很安靜**：
 * 服務起不來但安裝腳本印「完成」、規則永遠停在 Normal、alertState 到不了 panel。
 * 沒有這道檢查的話，發現它們的方式是「幾天後有人問為什麼沒反應」。
 *
 * 退出碼：0 通過；1 設定有問題；2 工具錯誤（檔案讀不到、JSON/YAML 壞掉）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = (p) => path.join(ROOT, 'monitoring', p);

/**
 * windows_exporter v0.31.8 已移除的 collector 與其 metric 前綴。
 * 2026-09-22 實查該 tag 的 `docs/`：47 個 collector 裡沒有 `cs`。
 * 指定不存在的 collector 會讓**服務起不來**，而 msiexec 仍回 0。
 */
const REMOVED_COLLECTORS = { cs: 'v0.31.8 已移除；實體記憶體總量改由 memory collector 提供' };
const REMOVED_METRICS = {
  windows_cs_physical_memory_bytes: 'v0.31.8 已移除，改用 windows_memory_physical_total_bytes',
  windows_cs_logical_processors: 'v0.31.8 已移除',
};

const problems = [];
const checked = [];

function read(p) {
  try {
    return fs.readFileSync(p);
  } catch (err) {
    console.error(`MONITORING-CHECK: TOOL-ERROR  讀不到 ${path.relative(ROOT, p)}：${err.message}`);
    process.exit(2);
  }
}

// --- 1) PowerShell 腳本必須有 UTF-8 BOM ---
//
// 兩支腳本含中文註解與訊息，而它們要在 Windows 主機上以系統管理員身分執行。
// **Windows PowerShell 5.1 對「沒有 BOM 的 UTF-8」會用系統 ANSI codepage 解碼**
// （zh-TW 主機是 950），於是整個檔案變成亂碼、連解析都過不了 ——
// 操作者拿到的是一個訊息本身也是亂碼的 ParserError，指向一行他看不懂的地方。
// PowerShell 7 兩種都吃，所以在開發機上完全測不出來。
for (const f of ['windows/windows_exporter-install.ps1', 'windows/alloy-install.ps1']) {
  const buf = read(M(f));
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const nonAscii = buf.some((b) => b > 0x7f);
  // ⚠️ 三路，不是兩路。原本的 `else` 分支無條件印「有 BOM」，而它有兩條進入路徑：
  // 真的有 BOM、以及**純 ASCII 且沒有 BOM**。後者會讓報表聲稱驗過一件它沒驗的事。
  // 今天兩個檔都有 BOM 所以不會印錯，但只要有人把腳本改寫成純英文，
  // checked 裡就會出現一行假話 —— 而 checked 正是「這道檢查做了什麼」的唯一憑據。
  if (nonAscii && !hasBom) {
    problems.push(`${f}：含非 ASCII 但沒有 UTF-8 BOM —— Windows PowerShell 5.1 會以 ANSI codepage 解碼而無法解析`);
  } else if (hasBom) {
    checked.push(`${f} 有 BOM`);
  } else {
    checked.push(`${f} 純 ASCII，不需要 BOM`);
  }
}

// --- 2) ENABLED_COLLECTORS 不得含已移除的 collector ---
{
  const src = read(M('windows/windows_exporter-install.ps1')).toString('utf8');
  // ⚠️ 單引號、雙引號都要認。PowerShell 裡一旦要內插就得改雙引號，
  // 而先前只認單引號 → 閘門報「找不到 $collectors 宣告」，而它明明就在那裡。
  const m = /\$collectors\s*=\s*['"]([^'"]+)['"]/.exec(src);
  if (!m) {
    problems.push('windows_exporter-install.ps1：找不到 $collectors 宣告');
  } else {
    const list = m[1].split(',').map((s) => s.trim());
    const bad = list.filter((c) => c in REMOVED_COLLECTORS);
    if (bad.length) {
      problems.push(
        `windows_exporter-install.ps1：ENABLED_COLLECTORS 含已移除的 collector ${bad.join(', ')}` +
          `（${bad.map((c) => REMOVED_COLLECTORS[c]).join('；')}）—— 服務會起不來而 msiexec 仍回 0`
      );
    } else {
      checked.push(`ENABLED_COLLECTORS 的 ${list.length} 個 collector 都還存在`);
    }
  }
}

// --- 3) alert rule：不得用已移除的 metric，且每條都要有 dashboard/panel 註解 ---
// ⚠️ **掃整個目錄，不要寫死檔名清單。**
// 先前是寫死的三檔清單，於是同目錄放第四個 rules yml 就**完全不檢查** ——
// 實測丟一個含已移除 metric、且完全沒有 __dashboardUid__/__panelId__ 的
// rules-extra.yml 進去，`MONITORING-CHECK: PASS（6 項）` exit 0，規則數還是報 10。
// Grafana 會載入它，閘門不會看它。而「新增一個規則檔」正是最常見的動作。
const ALERTING_DIR = 'grafana/provisioning/alerting';
const RULE_FILES = (() => {
  let names;
  try {
    names = fs.readdirSync(M(ALERTING_DIR));
  } catch (err) {
    console.error(`MONITORING-CHECK: TOOL-ERROR  讀不到 ${ALERTING_DIR}：${err.message}`);
    process.exit(2);
  }
  // ⚠️ **不要用檔名前綴篩。** 先前是 `/^rules.*\.ya?ml$/i`，而 Grafana 載入的是
  // provisioning 目錄下的**每一個** `*.y(a)ml`，跟檔名叫什麼無關。於是
  // `alerts-windows.yml`、`poc-rules.yml`、`extra-alerts.yml` 這些一樣會生效的檔案
  // 對本檢查完全隱形 —— 實測把一條缺 annotation 的規則放進 `extra-alerts.yml`：
  // exit 0；同一個檔改名成 `rules-extra.yml`：exit 1。
  // 改成看**內容**：有 `groups:` 頂層鍵的才是規則檔。
  // contact point / 通知政策這類非規則檔沒有它，自然被排除（2026-10-02 刪除前的
  // contactpoints.yml / policies.yml 就是，實查兩者皆 0 個 `groups:`）。
  const found = names
    .filter((n) => /\.ya?ml$/i.test(n))
    .filter((n) => {
      try {
        return /^groups:/m.test(fs.readFileSync(M(`${ALERTING_DIR}/${n}`), 'utf8'));
      } catch {
        return false;
      }
    })
    .sort();
  if (!found.length) {
    console.error(`MONITORING-CHECK: TOOL-ERROR  ${ALERTING_DIR} 裡找不到任何含 groups: 的規則檔`);
    process.exit(2);
  }
  return found.map((n) => `${ALERTING_DIR}/${n}`);
})();

/**
 * 規則數的**下限**。理由與 jest 的 MIN_TESTS、selftest 的 MIN_SELFTEST 完全相同：
 * 這個檢查的每一條都是「對著切出來的 block 比對」，而 block 切不出來時
 * 迴圈一次都不跑、`problems` 保持空的、摘要照樣印 PASS ——
 * **刪規則或改寫法會讓這道閘門變得更綠，不是更紅。**
 * 實測：把 rules-poc.yml 換成合法的 flow-style YAML（Grafana 照樣載入），
 * 切塊結果 0 條，而閘門印 `PASS（6 項）` 並在證據行寫「0 條規則都帶了 …」。
 */
const MIN_RULES = 10;
const boundPanels = new Set();
let ruleCount = 0;
let titleTotal = 0;
for (const f of RULE_FILES) {
  const src = read(M(f)).toString('utf8');
  for (const [metric, why] of Object.entries(REMOVED_METRICS)) {
    // 只看真正的 expr，註解裡提到它是合法的（我們就在註解裡解釋為什麼不能用）。
    // ⚠️ **不能只看「行首是 expr:」的那一行** —— YAML 的折疊純量
    // （`expr: >-` 後面接縮排的多行）會讓 metric 出現在**下一行**，
    // 於是整條檢查完全隱形（實測改成折疊寫法後 PASS exit 0）。
    // 作法：把 expr 的整個區塊（含後續縮排行）攤平再比對，但跳過 `#` 註解行。
    const lines = src.split('\n');
    const bad = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*expr:/.test(lines[i])) {
        continue;
      }
      const indent = lines[i].match(/^\s*/)[0].length;
      let block = lines[i].replace(/^\s*expr:/, '');
      for (let j = i + 1; j < lines.length; j++) {
        const ind = lines[j].match(/^\s*/)[0].length;
        if (lines[j].trim() === '') {
          continue;
        }
        if (ind <= indent) {
          break;
        }
        block += '\n' + lines[j];
      }
      const code = block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      if (code.includes(metric)) {
        bad.push(i + 1);
      }
    }
    if (bad.length) {
      problems.push(`${f}：expr 用了已移除的 metric ${metric}（${why}）—— 規則會永遠停在 Normal/NoData`);
    }
  }
  // 逐條規則：title 之後必須出現 __dashboardUid__ 與 __panelId__
  //
  // ⚠️ **先以 `- title:` 為準切塊，`uid` 是選填的。**
  // 原本用 `split(/^\s*- uid:/m)`，於是一條**沒有 uid 的規則**會被整個併進
  // 上一條的 block、繼承它的 annotations 而通過檢查 —— 實測第三條規則被吸收，
  // PASS，而且印出來的「N 條規則」這個數字本身就是錯的（少算一條）。
  // Grafana 的 provisioning 不要求 uid，所以這不是假想的寫法。
  // ⚠️ **切塊、對帳、塊內提取三者必須吃同一種正規化，否則對帳自我抵銷。**
  // 2026-09-29 複審抓到兩條（實測）：
  //  - `- title : x`（冒號前有空白）與 `- 'title':`（引號鍵）都是合法 YAML、
  //    Grafana 照載，但切塊器與 titleTotal **一起**漏掉 —— 10==10、PASS、
  //    證據行還寫「title 數對得上」。對帳量與被對帳量共享盲點等於沒對。
  //  - titleTotal 對著**未剝註解**的原始 src 數，而它對帳的塊都剝了 ——
  //    一行 `# title: 舊名` 的純註解就讓合規設定誤紅，訊息還說
  //    「被併進上一條」這件沒發生的事（同檔 :165/:194 都剝，只有它沒剝）。
  // 現在三者都吃 srcCode（剝掉純註解行），鍵的拼寫統一放寬到
  // 選配引號 + 冒號前空白；titleTotal 只數**行首鍵位**（值裡的
  // `panel title:` 不在行首，不會被算進來）。
  const srcCode = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const blocks = srcCode.split(/^\s*-\s+(?=['"]?(?:uid|title)['"]?\s*:)/m).slice(1);
  // 切塊是以 `uid:` / `title:` 為第一個鍵為前提，而 YAML 的 mapping 是無序的，
  // Grafana 也不要求哪個鍵在前。第一個鍵是別的（例如 `condition:`）的規則會被
  // 整個併進上一條、繼承它的 annotations 而通過 —— 實測 ruleCount 停在 10，
  // 新加的那條一次都沒被數到。這裡不重寫成 YAML parser（SP-7.0 的零依賴精神），
  // 改用一個**互相對帳**的量：檔案裡有幾個 title，就該切出幾個 block。
  titleTotal += (srcCode.match(/^\s*(?:-\s+)?['"]?title['"]?\s*:/gm) || []).length;
  for (const b of blocks) {
    ruleCount++;
    const title = (/['"]?title['"]?\s*:\s*(\S+)/.exec(b) || [])[1] || '(無 title)';
    // ⚠️ **先把 `#` 註解行剝掉再比對。** 30 行前的 removed-metric 掃描已經這樣做了，
    // 這裡卻沒有 —— 於是把 annotations 整段註解掉（除錯時最常見的動作）
    // 仍然滿足「有 __dashboardUid__」。實測 exit 0。
    const bCode = b.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    if (!/__dashboardUid__:/.test(bCode) || !/__panelId__:/.test(bCode)) {
      problems.push(`${f}：規則 ${title} 缺少 __dashboardUid__ 或 __panelId__ —— alertState 到不了任何 panel，而且沒有任何錯誤訊息`);
    }
    // ⚠️ **單引號也是 YAML 字串。** 先前只認雙引號，而本 repo 的 YAML 到處用單引號
    // （每個 `expr:` 都是），於是有人照 house style 改寫或被 formatter 重排之後，
    // 閘門會報「__panelId__ 不是帶引號的字串」—— 一句**對著眼前的檔案顯然不成立**的話。
    // 訊息看得出來是假的，是閘門被關掉的最短路徑。
    // 只有**裸數字**才是 YAML 的 int（python3 yaml.safe_load 實查：'1' 與 "1" 都是 str，1 是 int）。
    const pid = (/__panelId__:\s*['"]?(\d+)['"]?/.exec(bCode) || [])[1];
    if (pid) {
      boundPanels.add(Number(pid));
    }
    if (bCode.includes('__panelId__:') && !/__panelId__:\s*['"]\d+['"]/.test(bCode)) {
      problems.push(`${f}：規則 ${title} 的 __panelId__ 是裸數字而不是字串 —— Grafana 的註解值必須是字串，請加引號`);
    }
  }
}
// ⚠️ **證據行不可以無條件 push。** `checked` 是這個檢查留下的唯一痕跡，
// 而在切塊失敗（0 條）時它會印「0 條規則都帶了 …」當成正面證據 ——
// 一句空泛真命題。BOM 檢查在 :53-63 已經為了同一個理由拆成三路。
if (ruleCount < MIN_RULES) {
  problems.push(
    `規則只切出 ${ruleCount} 條（下限 ${MIN_RULES}）—— 不是真的刪了規則，` +
      '就是切塊的前提不成立（flow-style YAML、或第一個鍵不是 uid/title）。' +
      '兩種都代表逐條檢查沒有真的跑過，不能當成通過'
  );
} else if (ruleCount !== titleTotal) {
  problems.push(
    `檔案裡有 ${titleTotal} 個 title 但只切出 ${ruleCount} 條規則 —— ` +
      '差額那幾條被併進上一條、繼承了它的 annotations，等於沒被檢查'
  );
} else {
  checked.push(`${ruleCount} 條規則都帶了 __dashboardUid__ / __panelId__（title 數對得上）`);
}

// --- 4) 規則綁的 panel id 必須真的存在於 provisioned dashboard ---
{
  const p = M('grafana/provisioning/dashboards/augur-poc.json');
  let dash;
  try {
    dash = JSON.parse(read(p).toString('utf8'));
  } catch (err) {
    console.error(`MONITORING-CHECK: TOOL-ERROR  augur-poc.json 不是合法 JSON：${err.message}`);
    process.exit(2);
  }
  // ⚠️ **要展開 row 裡的巢狀 panel。** Grafana 把收合 row 底下的 panel 放進
  // `row.panels`，而 `__panelId__` 照樣解析得到 —— 也就是說什麼都沒壞。
  // 先前只看頂層，於是「把兩個 panel 拖進一個 row 再收合起來」這個純 UI 動作
  // 會讓閘門報「規則綁了不存在的 panel id」並擋下 commit。
  // 反方向也要顧：`panels` 整個不存在時（schema-v2 匯出）先前會把**每一個**綁定
  // 都報成缺失 —— 那不是「發現問題」，是工具讀不懂檔案，該報 TOOL-ERROR。
  if (!Array.isArray(dash.panels)) {
    console.error('MONITORING-CHECK: TOOL-ERROR  augur-poc.json 沒有頂層 panels 陣列（dashboard schema 變了？）');
    process.exit(2);
  }
  const flatPanels = [];
  const walk = (list) => {
    for (const x of list || []) {
      flatPanels.push(x);
      if (Array.isArray(x.panels)) {
        walk(x.panels);
      }
    }
  };
  walk(dash.panels);
  const ids = new Set(flatPanels.map((x) => x.id));
  const missing = [...boundPanels].filter((id) => !ids.has(id));
  if (missing.length) {
    problems.push(`augur-poc.json：規則綁了不存在的 panel id ${missing.join(', ')}（dashboard 裡有 ${[...ids].join(', ')}）`);
  } else {
    checked.push(`規則綁的 panel id ${[...boundPanels].sort().join(', ')} 都存在於 dashboard`);
  }
  // 被綁的 panel 必須至少有一個 query target（alertState 的四個硬前提之一）
  for (const pn of flatPanels) {
    if (boundPanels.has(pn.id) && !(pn.targets || []).length) {
      problems.push(`augur-poc.json：panel ${pn.id} 被規則綁著卻沒有任何 query target —— alertState 恆為 undefined`);
    }
  }
  if (dash.time?.to !== 'now') {
    problems.push(`augur-poc.json：時間範圍結尾是 ${dash.time?.to}，必須是 now，否則收不到 alertState`);
  } else {
    checked.push('dashboard 時間範圍結尾為 now');
  }
}

if (problems.length) {
  console.log('MONITORING-CHECK: FAIL');
  problems.forEach((p) => console.log(`  ${p}`));
  process.exit(1);
}
console.log(`MONITORING-CHECK: PASS（${checked.length} 項）`);
checked.forEach((c) => console.log(`  ${c}`));
