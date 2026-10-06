// G-ADR005-1/2/3/5 的瀏覽器 POC（ADR-005）：真 Grafana + 真語音服務 + 無頭 Chromium（預設 autoplay 政策）。
// 以 API 建一個暫時 dashboard、跑完刪除；登入用 cookie（⚠️ 不能用 extraHTTPHeaders 帶 Authorization：
// 它會加到發往語音服務的請求上，CORS 預檢就多要求 authorization 標頭而失敗 —— 那是測試假象）。
//
//   GRAFANA_URL=http://127.0.0.1:3002 TTS_URL=http://127.0.0.1:8765 node tools/tts-server/eval/browser-poc.mjs
//
// 帳密以 `docker exec augur-grafana printenv` 取得、只留在記憶體，不印出。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const G = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3002';
const TTS = process.env.TTS_URL ?? 'http://127.0.0.1:8765';
const env = (k) => execSync(`docker exec augur-grafana printenv ${k}`).toString().trim();
const user = env('GF_SECURITY_ADMIN_USER');
const pass = env('GF_SECURITY_ADMIN_PASSWORD');
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const api = (path, init = {}) =>
  fetch(G + path, {
    ...init,
    headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const UID = 'adr005-poc';
const created = await api('/api/dashboards/db', {
  method: 'POST',
  body: JSON.stringify({
    overwrite: true,
    dashboard: {
      uid: UID,
      title: 'ADR-005 POC（暫時，跑完刪除）',
      schemaVersion: 39,
      panels: [
        {
          id: 1,
          type: 'augur-mascot-panel',
          title: 'external tts',
          gridPos: { x: 0, y: 0, w: 14, h: 12 },
          options: { enableTTS: true, ttsEndpoint: TTS, ttsTimeoutSec: 3, alertLang: 'zh' },
        },
      ],
    },
  }),
});
console.log('建立暫時 dashboard', created.status);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  console.log('登入', (await ctx.request.post(`${G}/login`, { data: { user, password: pass } })).status());
  const page = await ctx.newPage();
  const tts = [];
  page.on(
    'response',
    (r) =>
      r.url().startsWith(TTS) &&
      tts.push({ status: r.status(), acao: r.headers()['access-control-allow-origin'] ?? null })
  );
  page.on('requestfailed', (r) => r.url().startsWith(TTS) && tts.push({ failed: r.failure()?.errorText }));
  const chip = () => page.getByTestId('voice-chip').textContent();
  const open = async () => {
    tts.length = 0;
    await page.goto(`${G}/d/${UID}`);
    await page.getByTestId('tts-preview').waitFor({ timeout: 30000 });
    await page.locator('[data-sprite-state="ready"]').waitFor({ timeout: 30000 });
  };
  const waitChip = (s, ms) =>
    page
      .waitForFunction((x) => document.querySelector('[data-testid="voice-chip"]')?.textContent?.includes(x), s, {
        timeout: ms,
      })
      .catch(() => {});

  // G1／G2／G5：真服務。試聽本身是使用者手勢（內含 unlock）。
  await open();
  console.log('\n[G1/G2/G5] 開頁時聲線標籤：', await chip());
  await page.getByTestId('tts-preview').click();
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    samples.push([
      Date.now() - t0,
      await page.evaluate(() => {
        const m = document.querySelector('[data-layer="mouth"]');
        if (!m) {
          return 'no-layer';
        }
        const cs = getComputedStyle(m);
        return cs.display === 'none' || cs.visibility === 'hidden' ? 'hidden' : 'show:' + cs.backgroundPosition;
      }),
    ]);
    await page.waitForTimeout(40);
  }
  const flips = samples.filter((x, i) => i && x[1] !== samples[i - 1][1]);
  console.log('語音服務回應：', JSON.stringify(tts));
  console.log('播放後聲線標籤：', await chip());
  console.log('嘴型取樣', samples.length, '次；狀態：', [...new Set(samples.map((x) => x[1]))].join(' | '));
  console.log('嘴型切換', flips.length, '次；首次 @', flips[0]?.[0], 'ms；最後 @', flips.at(-1)?.[0], 'ms');

  // G3：三種失敗，各自重新載入頁面。
  for (const [name, handler] of [
    ['服務回 500', (r) => r.fulfill({ status: 500, body: 'boom', headers: { 'access-control-allow-origin': '*' } })],
    [
      '服務回 502（失控截斷）',
      (r) => r.fulfill({ status: 502, body: 'runaway', headers: { 'access-control-allow-origin': '*' } }),
    ],
    ['連不上', (r) => r.abort('connectionrefused')],
    [
      '逾時（6 秒才回、逾時 3 秒）',
      async (r) => {
        await new Promise((x) => setTimeout(x, 6000));
        try {
          await r.fulfill({ status: 500 });
        } catch {}
      },
    ],
  ]) {
    await page.route(`${TTS}/**`, handler);
    await open();
    await page.getByTestId('tts-preview').click();
    await waitChip('已降級', 15000);
    console.log(`\n[G3] ${name}：`, await chip());
    await page.unroute(`${TTS}/**`);
  }

  // 恢復：無熔斷，服務回來下一則就回到外部語音。
  await open();
  await page.route(`${TTS}/**`, (r) => r.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' } }));
  await page.getByTestId('tts-preview').click();
  await waitChip('已降級', 15000);
  console.log('\n[恢復] 失敗後：', await chip());
  await page.unroute(`${TTS}/**`);
  await page.waitForTimeout(12000); // 等降級那則（無頭環境沒有聲線）的 watchdog 收掉
  await page.getByTestId('tts-preview').click();
  await waitChip('外部語音（', 20000);
  console.log('[恢復] 服務回來後：', await chip());
} finally {
  await browser.close();
  console.log('\n刪除暫時 dashboard', (await api(`/api/dashboards/uid/${UID}`, { method: 'DELETE' })).status);
}
