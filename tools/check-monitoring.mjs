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
  if (nonAscii && !hasBom) {
    problems.push(`${f}：含非 ASCII 但沒有 UTF-8 BOM —— Windows PowerShell 5.1 會以 ANSI codepage 解碼而無法解析`);
  } else {
    checked.push(`${f} 有 BOM`);
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
const RULE_FILES = ['grafana/provisioning/alerting/rules-perf.yml', 'grafana/provisioning/alerting/rules-security.yml', 'grafana/provisioning/alerting/rules-poc.yml'];
const boundPanels = new Set();
let ruleCount = 0;
for (const f of RULE_FILES) {
  const src = read(M(f)).toString('utf8');
  for (const [metric, why] of Object.entries(REMOVED_METRICS)) {
    // 只看真正的 expr 行，註解裡提到它是合法的（我們就在註解裡解釋為什麼不能用）
    const bad = src.split('\n').filter((l) => l.includes(metric) && /^\s*expr:/.test(l));
    if (bad.length) {
      problems.push(`${f}：expr 用了已移除的 metric ${metric}（${why}）—— 規則會永遠停在 Normal/NoData`);
    }
  }
  // 逐條規則：title 之後必須出現 __dashboardUid__ 與 __panelId__
  const blocks = src.split(/^\s*- uid:/m).slice(1);
  for (const b of blocks) {
    ruleCount++;
    const title = (/title:\s*(\S+)/.exec(b) || [])[1] || '(無 title)';
    if (!/__dashboardUid__:/.test(b) || !/__panelId__:/.test(b)) {
      problems.push(`${f}：規則 ${title} 缺少 __dashboardUid__ 或 __panelId__ —— alertState 到不了任何 panel，而且沒有任何錯誤訊息`);
    }
    // ⚠️ **單引號也是 YAML 字串。** 先前只認雙引號，而本 repo 的 YAML 到處用單引號
    // （每個 `expr:` 都是），於是有人照 house style 改寫或被 formatter 重排之後，
    // 閘門會報「__panelId__ 不是帶引號的字串」—— 一句**對著眼前的檔案顯然不成立**的話。
    // 訊息看得出來是假的，是閘門被關掉的最短路徑。
    // 只有**裸數字**才是 YAML 的 int（python3 yaml.safe_load 實查：'1' 與 "1" 都是 str，1 是 int）。
    const pid = (/__panelId__:\s*['"]?(\d+)['"]?/.exec(b) || [])[1];
    if (pid) {
      boundPanels.add(Number(pid));
    }
    if (b.includes('__panelId__:') && !/__panelId__:\s*['"]\d+['"]/.test(b)) {
      problems.push(`${f}：規則 ${title} 的 __panelId__ 是裸數字而不是字串 —— Grafana 的註解值必須是字串，請加引號`);
    }
  }
}
checked.push(`${ruleCount} 條規則都帶了 __dashboardUid__ / __panelId__`);

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
