#!/usr/bin/env node
/**
 * 盲測頁的零依賴靜態伺服器。`node tools/blind-test/serve.mjs`。
 *
 * **為什麼不能直接用 `file://` 開**：頁面以 `<script type="module">` 匯入
 * `scoring.mjs`，而 ES module 在 `file://` 下會被 CORS 擋（Chrome/Firefox 皆然）。
 * 另一條路是把計分邏輯內嵌進 HTML，但那會讓它失去自動測試 —— 門檻的邊界行為
 * （85.0 過 / 84.9 不過）就只能靠人手動點四十次去試，而那不會有人做第二次。
 *
 * 只服務三個固定位置，不做任意路徑對映 —— 這是開在本機的驗收工具，
 * 給它一個能讀整個磁碟的 handler 沒有任何好處。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.PORT) || 8787;

const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png' };

const ROUTES = {
  '/': path.join(HERE, 'index.html'),
  '/index.html': path.join(HERE, 'index.html'),
  '/scoring.mjs': path.join(HERE, 'scoring.mjs'),
  '/sprite/directions.png': path.join(ROOT, 'src', 'img', 'sprite', 'directions.png'),
  '/fixture.png': path.join(ROOT, '.sprite-check', 'blind-test-fixture.png'),
};

http
  .createServer((req, res) => {
    const target = ROUTES[(req.url || '/').split('?')[0]];
    if (!target || !fs.existsSync(target)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        target
          ? `${path.relative(ROOT, target)} 不存在。\n` +
              '素材尚未交付；先跑 node tools/blind-test/make-fixture.mjs 產生編號假 sheet 驗這個頁面本身。\n'
          : '404\n'
      );
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  })
  .listen(PORT, () => {
    console.log(`SP-V.1 盲測頁：http://localhost:${PORT}/`);
    console.log('  /sprite/directions.png  ← 真素材（尚未交付時為 404，頁面會說明）');
    console.log('  /fixture.png            ← 編號假 sheet（先跑 make-fixture.mjs）');
  });
