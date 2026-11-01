import { existsSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/** 侧边导航定义（路径 ↔ 中文标签），与 src/renderer/src/router/index.ts 一一对应 */
const NAV_ITEMS = [
  { path: '/pos', label: '收银台' },
  { path: '/products', label: '商品管理' },
  { path: '/purchases', label: '进货管理' },
  { path: '/sales-history', label: '销售记录' },
  { path: '/reports', label: '报表统计' },
  { path: '/settings', label: '系统设置' }
]

/**
 * 已替换占位的业务路由（页面内容验收由各任务的专属 E2E spec 覆盖；
 * 各任务落地时在此追加自己的路由，占位断言只对未实现路由生效）。
 */
const IMPLEMENTED_ROUTES = new Set([
  '/purchases',
  '/products',
  '/settings',
  '/sales-history',
  '/pos',
  '/reports',
])
test.describe.serial('应用骨架冒烟：导航与路由', () => {
  let app: LaunchedApp

  test.beforeAll(async () => {
    app = await launchApp()
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  test('侧边导航渲染 7 个中文菜单项', async () => {
    const items = app.page.locator('.el-menu-item')
    await expect(items).toHaveCount(7)
    for (const { label } of NAV_ITEMS) {
      await expect(items.filter({ hasText: label })).toHaveCount(1)
    }
  })

  test('userData 已隔离到临时目录（不污染真实用户数据）', async () => {
    const actual = await app.electronApp.evaluate(({ app }) => app.getPath('userData'))
    expect(actual).toBe(app.userDataDir)
    expect(existsSync(app.userDataDir)).toBe(true)
  })

  test('点击导航逐项切换路由，未实现路由保持空态占位', async () => {
    const { page } = app
    for (const { path, label } of NAV_ITEMS) {
      await page.locator('.el-menu-item').filter({ hasText: label }).click()
      await waitForRoute(page, path)
      if (!IMPLEMENTED_ROUTES.has(path)) {
        await expect(page.locator('.placeholder-page__title')).toHaveText(label)
        await expect(page.locator('.el-empty')).toBeVisible()
        await expect(page.locator('.el-empty')).toContainText('建设中')
      }
    }
    // 回收银台（应用主页）截图留证
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')
    await page.screenshot({ path: '.omo/evidence/task-6-nav-e2e.png' })
  })
})
