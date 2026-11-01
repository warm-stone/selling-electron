/// <reference lib="dom" />
// page.evaluate 回调在浏览器执行（location/getComputedStyle 等 DOM 全局）；
// tsconfig.node.json 无 DOM lib，经 lib 指令为当前文件注入（零 tsconfig 改动）
import { test, expect } from '@playwright/test'
import { stringWidth } from '../../src/shared/receipt/char-grid'
import { ITEM_COLUMN_WIDTHS } from '../../src/shared/receipt/item-columns'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/**
 * Task 12 — 小票预览 demo 页 E2E：58/80mm 纸宽容器、超长商品名截断、
 * 同源视觉锚点（mono-cjk / white-space: pre / bold class）。
 */
test.describe.serial('小票预览 demo：同源渲染 58/80mm', () => {
  let app: LaunchedApp

  test.beforeAll(async () => {
    app = await launchApp()
    // 先等初始路由 finalize（URL 出现 #/pos ⟹ 路由回调已注册）：
    // vue-router 的 setupListeners 在首次导航完成时才注册——在其之前改 hash，
    // popstate 无人接收且初始导航会以过期快照覆写 URL（Windows CI 冷启动 chunk
    // 加载慢时该盲窗可达数十~数百 ms，hash 导航被吞）。菜单点击的其他 spec 天然免疫。
    await waitForRoute(app.page, '/pos')
    await app.page.evaluate(() => {
      location.hash = '#/receipt-preview-demo'
    })
    await waitForRoute(app.page, '/receipt-preview-demo')
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  test('80mm：容器 307px（±5）、shopName 插值、加粗 class、等宽字体、white-space: pre', async () => {
    const { page } = app
    const paper = page.getByTestId('receipt-paper')
    await expect(paper).toBeVisible()

    const width = await paper.evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.abs(width - 307)).toBeLessThanOrEqual(5)

    // 变量插值（{shopName} → 值）
    await expect(page.locator('.receipt-line').first()).toContainText('中文测试收银')
    // 段落属性映射 class
    await expect(page.locator('.receipt-line--bold').first()).toBeVisible()
    await expect(page.locator('.receipt-line--double-height').first()).toBeVisible()
    await expect(page.locator('.receipt-divider').first()).toBeVisible()
    await expect(page.locator('.receipt-cut').first()).toBeVisible()
    // 同源视觉锚点：mono-cjk 等宽 + pad 空格原样渲染（单测中 scoped CSS 不注入，在此锁定）
    await expect(page.locator('.mono-cjk').first()).toBeVisible()
    const whiteSpace = await page
      .locator('.receipt-line')
      .first()
      .evaluate((el) => getComputedStyle(el).whiteSpace)
    expect(whiteSpace).toBe('pre')

    // 等宽字体实际生效（mono-cjk → NSimSun/SimSun/monospace 栈，非等宽即违约）
    const fontFamily = await paper.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(fontFamily.toLowerCase()).toContain('mono')

    const boldWeight = await page
      .locator('.receipt-line--bold')
      .first()
      .evaluate((el) => getComputedStyle(el).fontWeight)
    expect(Number(boldWeight)).toBeGreaterThanOrEqual(700)
  })

  test('切换 58mm：容器 221px（±5）、items 行满宽 32 列', async () => {
    const { page } = app
    await page.getByTestId('demo-paper-58').click()
    const paper = page.getByTestId('receipt-paper')
    const width = await paper.evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.abs(width - 221)).toBeLessThanOrEqual(5)

    const rows = page.locator('.receipt-items tr.receipt-line')
    const count = await rows.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      const text = await rows.nth(i).textContent()
      expect(stringWidth(text ?? '')).toBe(32)
    }
  })

  test('超长商品名（58mm）：行 stringWidth ≤ 32、名称列 ≤ 12、完整名不出现；截图留证', async () => {
    const { page } = app
    await page.getByTestId('demo-sample-long').click()
    const longName = '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'

    const rows = page.locator('.receipt-items tbody tr.receipt-line')
    const firstItem = rows.nth(1) // nth(0) 为列头行
    const rowText = await firstItem.textContent()
    expect(stringWidth(rowText ?? '')).toBeLessThanOrEqual(32)

    const nameText = await firstItem.locator('td').first().textContent()
    expect(stringWidth(nameText ?? '')).toBeLessThanOrEqual(ITEM_COLUMN_WIDTHS['58mm'].name)

    await expect(page.locator('body')).not.toContainText(longName)
    await page.screenshot({ path: '.omo/evidence/task-12-paperwidth.png' })
  })

  test('切回 80mm + 超长名：行 stringWidth ≤ 48、名称列 ≤ 24（双纸宽网格一致）', async () => {
    const { page } = app
    await page.getByTestId('demo-paper-80').click()
    const rows = page.locator('.receipt-items tbody tr.receipt-line')
    const firstItem = rows.nth(1)
    const rowText = await firstItem.textContent()
    expect(stringWidth(rowText ?? '')).toBeLessThanOrEqual(48)
    const nameText = await firstItem.locator('td').first().textContent()
    expect(stringWidth(nameText ?? '')).toBeLessThanOrEqual(ITEM_COLUMN_WIDTHS['80mm'].name)
  })
})
