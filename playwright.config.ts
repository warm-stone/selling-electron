import { defineConfig } from '@playwright/test'

/**
 * Electron E2E 配置（Playwright _electron）
 * - 无浏览器项目：_electron.launch 直接驱动应用自带 Electron 二进制，无需 `playwright install`
 * - globalSetup 先构建 out/ 产物（启动方案决策详见 tests/e2e/global-setup.ts）
 * - 强制串行（workers=1）：应用单实例锁 + 窗口焦点互不干扰
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  globalSetup: './tests/e2e/global-setup.ts'
})
