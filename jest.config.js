// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const base = require('./.config/jest.config');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...base,
  /**
   * ⚠️ **必須 spread `base.moduleNameMapper`**，不能只寫 png 那一條。
   * 腳手架帶了兩條（`identity-obj-proxy` 給 css/scss、`react-inlinesvg` 的 mock），
   * 整個物件覆蓋掉會把它們一起蓋掉。
   *
   * 這個覆蓋是**沉默的** —— 症狀不是「png 測試壞了」，而是某一天某支既有測試
   * 莫名變紅，而它看起來與 sprite 完全無關。承接它的是
   * `src/components/__tests__/MascotPanel.test.tsx`：那支會經 `useStyles2` /
   * `useTheme2` 走到 `@grafana/ui`，兩條 mapper 少一條它就會紅。
   * core 的那四支測試不會 —— 它們一支都沒有 import css 或 `@grafana/ui`。
   */
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '\\.(png|jpe?g|gif|webp)$': '<rootDir>/tools/jest/fileMock.js',
  },
};
