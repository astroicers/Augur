import { test, expect } from '@grafana/plugin-e2e';

/**
 * G-ADR004-2 的自動化：panel 真的從 `alertState` 走到播報。
 *
 * 驗的是 **feed 裡出現那一行**而不是「有沒有聲音」—— headless 環境沒有語音引擎，
 * 而 `enableTTS` 關掉時 panel 仍會更新畫面。要驗的是導播管線通了，不是喇叭響了。
 *
 * ⚠️ `PocAlwaysFiring` 配 `for: 0s`，所以不需要等 pending。
 * 但若 dashboard 是在規則建立**之前**被載入的，`hasAlertRules` latch 不會更新，
 * 這條會逾時 —— 那是環境問題不是程式問題，重新載入頁面即可。
 */
test('POC 告警走完導播管線並出現在 feed（G-ADR004-2）', async ({ gotoDashboardPage, readProvisionedDashboard }) => {
  // ⚠️ 只給檔名 —— readProvisionedDashboard 自己會補 provisioningRootDir + 'dashboards/'。
  // 寫成 'dashboards/augur-poc.json' 會變成 .../dashboards/dashboards/augur-poc.json。
  const dashboard = await readProvisionedDashboard({ fileName: 'augur-poc.json' });
  const page = await gotoDashboardPage(dashboard);

  const panel = page.getPanelByTitle('Mascot（G-ADR004-1 / alertState 探測）');

  // alertState chip 是觀測出口。看到 `—` 表示 Grafana 根本沒送 alert state，
  // 那指向四個硬前提之一沒滿足，而不是播報邏輯壞了。
  await expect(panel.locator.getByTestId('alert-state-chip')).toContainText('alerting', {
    timeout: 60_000,
  });

  await expect(panel.locator.getByText('PocAlwaysFiring')).toBeVisible({ timeout: 60_000 });
});
