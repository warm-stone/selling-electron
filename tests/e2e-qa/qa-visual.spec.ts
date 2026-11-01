/**
 * F3 终审 QA — C 系列：视觉抽查（7 页各一张 1280×800 截图）。
 *
 * 预置数据使每页非空（商品含负库存标红项 + 一笔今日销售）；
 * 断言：中文文案正确渲染（无乱码断言）+ 负库存标红可见；
 * 截图供人工复核布局无破碎。
 */
import Database from 'better-sqlite3'
import { test, expect } from '@playwright/test'
import { DEFAULT_TEMPLATES } from '../../src/shared/receipt/default-template'
import {
  EVIDENCE,
  closeApp,
  evidenceLog,
  launchApp,
  waitForRoute,
  type LaunchedApp
} from './qa-helpers'

let app: LaunchedApp

test.describe.serial('F3 QA · C：视觉抽查（7 页）', () => {
  test.beforeAll(async () => {
    app = await launchApp()
    await waitForRoute(app.page, '/pos')
    // 非空数据：2 商品（其一负库存）+ 1 笔今日 completed 销售 + 双模板
    // （模板 list 不触发 lazy seed——正常用户首单结账后即有，此处 DB 预置等价状态）
    const d = new Database(app.dbPath)
    try {
      const pid = Number(
        d
          .prepare(
            'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
          )
          .run('6903456789012', 'QA视觉可乐 330ml', 350, -4).lastInsertRowid
      )
      d.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
      ).run('6904567890123', 'QA视觉雪碧 500ml', 300, 12)
      const sid = Number(
        d
          .prepare(
            `INSERT INTO sales (sale_no, total_cents, item_count, status, created_at)
             VALUES (?, 700, 2, 'completed', datetime('now','localtime'))`
          )
          .run('209901010001').lastInsertRowid
      )
      d.prepare(
        `INSERT INTO sale_items
           (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
         VALUES (?, ?, 'QA视觉可乐 330ml', '6903456789012', 2, 350, 700)`
      ).run(sid, pid)
      const insTpl = d.prepare(
        'INSERT INTO print_templates (name, paper_width, config_json, is_default) VALUES (?, ?, ?, ?)'
      )
      insTpl.run('默认小票（58mm）', '58mm', JSON.stringify(DEFAULT_TEMPLATES['58mm']), 0)
      insTpl.run('默认小票（80mm）', '80mm', JSON.stringify(DEFAULT_TEMPLATES['80mm']), 1)
    } finally {
      d.close()
    }
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  test('窗口 1280×800 + 7 页截图（中文渲染 + 负库存标红可见）', async () => {
    const { page } = app

    // 窗口尺寸确认（主进程 BrowserWindow 1280×800）
    const size = await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const b = win.getBounds()
      return { w: b.width, h: b.height }
    })
    expect(size.w).toBe(1280)
    expect(size.h).toBe(800)

    const goto = async (menu: string, route: string): Promise<void> => {
      await page.locator('.el-menu-item').filter({ hasText: menu }).click()
      await waitForRoute(page, route)
    }

    // 1 收银台：搜索可见商品行（中文渲染检查）
    await goto('收银台', '/pos')
    await page.locator('.barcode-input input').fill('QA视觉')
    await expect(
      page.locator('.pos-products-table .el-table__row').filter({ hasText: 'QA视觉可乐 330ml' })
    ).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/c1-pos.png` })

    // 2 商品管理：负库存标红可见（class 在 tr 上）
    await goto('商品管理', '/products')
    const negRow = page
      .locator('.el-table__body-wrapper .el-table__row')
      .filter({ hasText: 'QA视觉可乐 330ml' })
    await expect(negRow).toBeVisible()
    await expect(negRow).toHaveClass(/stock-negative/)
    await expect(negRow).toContainText('-4')
    await page.screenshot({ path: `${EVIDENCE}/c2-products.png` })

    // 3 进货管理
    await goto('进货管理', '/purchases')
    await expect(page.locator('.purchases-view__title')).toHaveText('进货管理')
    await page.screenshot({ path: `${EVIDENCE}/c3-purchases.png` })

    // 4 销售记录（默认今天，见 seed 单）
    await goto('销售记录', '/sales-history')
    await expect(
      page.locator('.sales-history__table .el-table__row').filter({ hasText: '209901010001' })
    ).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/c4-sales-history.png` })

    // 5 报表统计
    await goto('报表统计', '/reports')
    await expect(page.locator('.reports__title')).toHaveText('报表统计')
    await page.screenshot({ path: `${EVIDENCE}/c5-reports.png` })

    // 6 小票模板（出厂 2 模板 + 预览中文渲染）
    await goto('小票模板', '/template-editor')
    await expect(page.getByTestId('tpl-item')).toHaveCount(2)
    await expect(page.getByTestId('receipt-paper')).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/c6-template-editor.png` })

    // 7 系统设置
    await goto('系统设置', '/settings')
    await expect(page.getByTestId('save-shop-btn')).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/c7-settings.png` })

    evidenceLog('C 视觉抽查 PASS: 7 页截图落盘 + 负库存标红 + 中文渲染断言')
  })
})
