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
  },
  // Add your own configuration here.
  // See https://grafana.com/developers/plugin-tools/how-to-guides/extend-configurations#extend-the-playwright-config for further info.
});
