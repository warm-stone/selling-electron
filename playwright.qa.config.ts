import { defineConfig } from '@playwright/test'

/**
 * F3 终审 QA 专用配置（独立于基线 tests/e2e）：
 * - testDir 指向 tests/e2e-qa（不污染基线 63 用例）
 * - 无 globalSetup（build 已由终审前置步骤完成）
 * - workers=1：单实例锁 + 窗口焦点互不干扰（与基线同决策）
 */
export default defineConfig({
  testDir: 'tests/e2e-qa',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results-qa'
})
