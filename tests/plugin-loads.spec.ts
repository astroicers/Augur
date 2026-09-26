import { test, expect } from '@grafana/plugin-e2e';

const PLUGIN_ID = 'augur-mascot-panel';

/**
 * G-ADR004-1 的自動化：plugin 真的被 Grafana 載入了。
 *
 * ⚠️ **必須打清單端點，不是 settings 端點。**
 * 實測 `GET /api/plugins/augur-mascot-panel/settings` 回 `"enabled": false` ——
 * panel plugin 在 DB 裡沒有設定列，那個 false 是「沒有設定列」不是「沒啟用」。
 * 照 settings 端點寫會得到一條**永遠紅**的 e2e，然後有人跑去查 plugin 掛載，
 * 而掛載其實是好的。只有 `GET /api/plugins?core=0` 的清單才回
 * `enabled: true, signature: unsigned`。
 */
test('plugin 被載入且為未簽署（G-ADR004-1）', async ({ request }) => {
  const res = await request.get('/api/plugins?core=0');
  expect(res.ok()).toBeTruthy();

  const plugins = (await res.json()) as Array<{ id: string; enabled: boolean; signature: string }>;
  const mine = plugins.find((p) => p.id === PLUGIN_ID);

  // 找不到的常見原因：dist/ 沒建置、unsigned 白名單沒生效、殘留 MANIFEST.txt。
  expect(mine, `${PLUGIN_ID} 不在 /api/plugins?core=0 的清單裡`).toBeDefined();
  expect(mine!.enabled).toBe(true);
  expect(mine!.signature).toBe('unsigned');
});
