import type { PluginOptions } from '@grafana/plugin-e2e';
import { defineConfig } from '@playwright/test';
import baseConfig from './.config/playwright.config';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig<PluginOptions>(baseConfig, {
  use: {
    // P2：本專案不使用腳手架的根層 provisioning/（未落地），開發環境只有 monitoring/ 一套。
    // @grafana/plugin-e2e 的 readProvisionedDashboard/DataSource 預設讀 cwd 下的 'provisioning'，
    // 不指過去會 ENOENT。
    provisioningRootDir: 'monitoring/grafana/provisioning',

    /**
     * ⚠️ **必須覆寫預設值。** `.config/playwright.config.ts` 的預設是
     * `process.env.GRAFANA_URL || 'http://localhost:3000'`，而本專案的 Grafana 刻意避開 3000
     * （本機還有其他 stack 綁著它）。
     *
     * 不覆寫的後果**不是連不上**，是更糟的：`@grafana/plugin-e2e` 的 `auth.setup`
     * 會拿 admin 帳密去登入 3000 上那台**無關的 Grafana**，然後在上面跑測試。
     * 有些會綠（登入成功、頁面開得起來），而綠的原因與本專案毫無關係。
     */
    baseURL: process.env.GRAFANA_URL ?? 'http://127.0.0.1:3002',
  },
  testDir: './tests',
  // Add your own configuration here.
  // See https://grafana.com/developers/plugin-tools/how-to-guides/extend-configurations#extend-the-playwright-config for further info.
});
