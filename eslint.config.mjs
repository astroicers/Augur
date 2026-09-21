import { defineConfig } from 'eslint/config';
import baseConfig from './.config/eslint.config.mjs';

export default defineConfig([
  {
    ignores: [
      '**/logs',
      '**/*.log',
      '**/npm-debug.log*',
      '**/yarn-debug.log*',
      '**/yarn-error.log*',
      '**/.pnpm-debug.log*',
      '**/node_modules/',
      '.yarn/cache',
      '.yarn/unplugged',
      '.yarn/build-state.yml',
      '.yarn/install-state.gz',
      '**/.pnp.*',
      '**/pids',
      '**/*.pid',
      '**/*.seed',
      '**/*.pid.lock',
      '**/lib-cov',
      '**/coverage',
      '**/dist/',
      '**/artifacts/',
      '**/work/',
      '**/ci/',
      'test-results/',
      'playwright-report/',
      'blob-report/',
      'playwright/.cache/',
      'playwright/.auth/',
      '**/.idea',
      '**/.eslintcache',
      // sprite 檢查與一次性量測 harness 的**產出目錄**（SP-7.10 要求它不得進版控）。
      //
      // ⚠️ 這與「**不要**把 `tools/**` 加進 ignores」那條裁定不衝突，兩者性質相反：
      // `tools/` 是**要維護的原始碼**（手寫的 PNG defilter，lint 是它唯一的靜態檢查），
      // `.sprite-check/` 是**生成物與用完即丟的量測腳本**。對生成物 lint 沒有保護作用，
      // 只會讓閘門因為一個不進版控的檔而紅。
      '.sprite-check/',
    ],
  },
  ...baseConfig,
]);
