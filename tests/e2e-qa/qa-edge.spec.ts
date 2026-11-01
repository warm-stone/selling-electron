/**
 * F3 终审 QA — B 系列：边界案例（全新隔离 app 会话）。
 *
 *  B6 空购物车结账 disabled
 *  B7 库存 1 商品买 5 → 黄条提示 + 结账成功负库存 + 商品列表标红
 *  B8 条码未命中 toast + 重复条码新增报错
 *  B9 删除有历史引用商品 → 确认弹窗含引用数 → 删除后历史明细快照仍可读
 *  B10 空数据日报 el-empty + 空表导出
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  EVIDENCE,
  closeApp,
  evidenceLog,
  launchApp,
  makeExportDir,
  revisit,
  scanBarcode,
  startPrintMock,
  waitForRoute,
  type LaunchedApp
} from './qa-helpers'

const STOCK1_NAME = 'QA孤品库存一件'
const STOCK1_BARCODE = '2301234567891'
const REF_NAME = 'QA被引用商品'
const REF_BARCODE = '2401234567898'
const EXPORT_DIR = makeExportDir()

let app: LaunchedApp
const received: Buffer[] = []

const cartRow = (page: Page, name: string): Locator =>
  page.locator('.cart-row').filter({ hasText: name })

test.describe.serial('F3 QA · B：边界案例', () => {
  test.beforeAll(async () => {
    process.env['E2E_EXPORT_DIR'] = EXPORT_DIR
    app = await launchApp()
    await waitForRoute(app.page, '/pos')
    // B7/B8/B9 数据直插（WAL 多连接，主进程下条语句即见）
    const d = new Database(app.dbPath)
    try {
      d.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
      )
        .run(STOCK1_BARCODE, STOCK1_NAME, 100, 1)
      d.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
      )
        .run(REF_BARCODE, REF_NAME, 200, 3)
    } finally {
      d.close()
    }
    await startPrintMock(19912, received)
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    delete process.env['E2E_EXPORT_DIR']
  })

  test('B6 空购物车：结账与清空按钮 disabled，合计 ¥0.00', async () => {
    const { page } = app
    await expect(page.locator('.cart-panel__checkout')).toBeDisabled()
    await expect(page.locator('.cart-clear-btn')).toBeDisabled()
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥0.00')
    await page.screenshot({ path: `${EVIDENCE}/b6-empty-cart.png` })
    evidenceLog('B6 PASS: 空车结账/清空 disabled')
  })

  test('B7 库存 1 买 5：黄条提示 + 结账成功负库存 + 商品列表标红', async () => {
    const { page } = app
    // 直插商品需重进商品页/收银台拉最新列表
    await revisit(page, '商品管理', '/products')
    await revisit(page, '收银台', '/pos')

    await scanBarcode(app.electronApp, STOCK1_BARCODE)
    await expect(cartRow(page, STOCK1_NAME)).toHaveCount(1)
    await expect(cartRow(page, STOCK1_NAME).locator('.cart-row__price input')).toHaveValue(
      '1.00'
    )

    await cartRow(page, STOCK1_NAME).locator('.cart-row__qty input').fill('5')
    await cartRow(page, STOCK1_NAME).locator('.cart-row__qty input').blur()

    // 行内黄条提示（D2 不阻断）
    await expect(cartRow(page, STOCK1_NAME).locator('.cart-row__warn')).toContainText(
      '库存不足'
    )
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥5.00')
    await expect(page.locator('.cart-panel__checkout')).toBeEnabled()
    await page.screenshot({ path: `${EVIDENCE}/b7-low-stock-warning.png` })

    // 结账成功（负库存放行）
    await page.locator('.cart-panel__checkout').click()
    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('合计: ￥5.00')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()

    // DB：负库存 -4
    const d = new Database(app.dbPath, { readonly: true })
    try {
      const row = d
        .prepare('SELECT stock FROM products WHERE barcode = ?')
        .get(STOCK1_BARCODE) as { stock: number }
      expect(row.stock).toBe(-4)
    } finally {
      d.close()
    }

    // 商品列表标红（stock-negative class 在 tr 上——Element Plus rowClassName）
    await revisit(page, '商品管理', '/products')
    const redRow = page
      .locator('.el-table__body-wrapper .el-table__row')
      .filter({ hasText: STOCK1_NAME })
    await expect(redRow).toBeVisible()
    await expect(redRow).toHaveClass(/stock-negative/)
    await expect(redRow).toContainText('-4')
    await page.screenshot({ path: `${EVIDENCE}/b7-negative-stock-red.png` })
    evidenceLog('B7 PASS: 黄条提示 + 结账成功 + DB -4 + 列表标红')
  })

  test('B8 条码未命中 toast + 重复条码新增报错（弹窗保留）', async () => {
    const { page } = app
    // 未命中条码：error toast + 购物车不受影响
    await revisit(page, '收银台', '/pos')
    const cartCountBefore = await page.locator('.cart-row').count()
    await scanBarcode(app.electronApp, '9999999999999')
    await expect(page.locator('.el-message--error').first()).toContainText('未找到条码商品')
    await expect(page.locator('.cart-row')).toHaveCount(cartCountBefore)
    await page.screenshot({ path: `${EVIDENCE}/b8-unknown-barcode.png` })

    // 重复条码新增：错误提示 + 弹窗保留
    await revisit(page, '商品管理', '/products')
    await page.getByRole('button', { name: '新增商品' }).click()
    const dialog = page.locator('.el-dialog')
    await expect(dialog).toBeVisible()
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '条码' })
      .locator('input')
      .fill(STOCK1_BARCODE)
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '名称' })
      .locator('input')
      .fill('QA重复条码商品')
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '库存' })
      .locator('.el-input-number input')
      .fill('1')
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '默认售价' })
      .locator('.el-input-number input')
      .fill('1.00')
    await dialog.getByRole('button', { name: '保存' }).click()

    await expect(page.locator('.el-message--error').first()).toContainText('条码已存在')
    await expect(dialog).toBeVisible() // 弹窗保留（用户输入不丢）
    await page.screenshot({ path: `${EVIDENCE}/b8-duplicate-barcode.png` })
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()
    evidenceLog('B8 PASS: 未命中 toast + 重复条码报错弹窗保留')
  })

  test('B9 删除有历史引用商品：引用数弹窗 → 快照仍可读', async () => {
    const { page } = app
    // 先卖一单 REF_NAME（产生历史引用）
    await revisit(page, '收银台', '/pos')
    await scanBarcode(app.electronApp, REF_BARCODE)
    await expect(cartRow(page, REF_NAME)).toHaveCount(1)
    await page.locator('.cart-panel__checkout').click()
    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()
    const saleNo = (await dialog.locator('.el-dialog__title').textContent())!.match(
      /(\d{8}-\d{4})/
    )![1]!
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()

    // 删除：确认弹窗含引用数
    await revisit(page, '商品管理', '/products')
    const row = page
      .locator('.el-table__body-wrapper .el-table__row')
      .filter({ hasText: REF_NAME })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '删除' }).click()

    const box = page.locator('.el-message-box')
    await expect(box).toBeVisible()
    await expect(box).toContainText('删除商品')
    await expect(box).toContainText(/关联 \d+ 条历史单据/)
    await page.screenshot({ path: `${EVIDENCE}/b9-delete-referenced.png` })
    await box.getByRole('button', { name: '删除', exact: true }).click()
    await expect(box).toBeHidden()

    // 商品列表不再出现
    await expect(row).toHaveCount(0)

    // DB：商品硬删 + sale_items 快照保留（product_id NULL）
    const d = new Database(app.dbPath, { readonly: true })
    try {
      const p = d
        .prepare('SELECT COUNT(*) AS n FROM products WHERE barcode = ?')
        .get(REF_BARCODE) as { n: number }
      expect(p.n).toBe(0)
      const item = d
        .prepare(
          'SELECT product_id, product_name, barcode FROM sale_items WHERE product_name = ?'
        )
        .get(REF_NAME) as { product_id: number | null; product_name: string; barcode: string }
      expect(item.product_id).toBeNull()
      expect(item.product_name).toBe(REF_NAME)
      expect(item.barcode).toBe(REF_BARCODE)
    } finally {
      d.close()
    }

    // 销售记录明细快照仍可读
    await revisit(page, '销售记录', '/sales-history')
    const saleRow = page
      .locator('.sales-history__table .el-table__row')
      .filter({ hasText: saleNo })
    await expect(saleRow).toBeVisible()
    await saleRow.dblclick()
    const detail = page.locator('.el-dialog').filter({ hasText: '销售明细' })
    await expect(detail).toBeVisible()
    await expect(detail).toContainText(REF_NAME)
    await page.screenshot({ path: `${EVIDENCE}/b9-snapshot-readable.png` })
    await page.keyboard.press('Escape')
    await expect(detail).toBeHidden()
    evidenceLog('B9 PASS: 引用数弹窗 + 硬删 + product_id NULL + 快照明细可读')
  })

  test('B10 空数据日：el-empty + 汇总 0.00/0 + 空表导出', async () => {
    const { page } = app
    await revisit(page, '报表统计', '/reports')

    // 切到无数据远期日期
    await page.locator('.reports__date-picker--daily').click()
    const dateInput = page.locator('.reports__date-picker--daily input')
    await dateInput.fill('2030-01-01')
    await dateInput.press('Enter')

    const stats = page.locator('[data-testid="daily-stats"] .stat-card__value')
    await expect(stats.nth(0)).toHaveText('0.00')
    await expect(stats.nth(1)).toHaveText('0')

    const empty = page.locator('[data-testid="daily-table"] .el-empty')
    await expect(empty).toBeVisible()
    await expect(empty).toContainText('当日无销售')
    await page.screenshot({ path: `${EVIDENCE}/b10-empty-day.png` })

    // 空表导出仍可用 → 文件含 0 值合计
    await page.locator('[data-testid="daily-export"] button').click()
    const txtItem = page.getByRole('menuitem', { name: '导出 .txt' })
    await expect(txtItem).toBeVisible()
    await txtItem.click()
    await expect(page.locator('.el-message--success').first()).toContainText('已导出')
    await expect(page.locator('.el-message--success')).toHaveCount(0, { timeout: 6000 })

    const emptyTxt = join(EXPORT_DIR, '日报2030-01-01.txt')
    expect(existsSync(emptyTxt), `空表 txt 应存在: ${emptyTxt}`).toBe(true)
    const txt = readFileSync(emptyTxt, 'utf8')
    expect(txt).toContain('总销售额: 0.00 元')
    expect(txt).toContain('订单数: 0')
    expect(txt).toContain('（无销售记录）')
    evidenceLog('B10 PASS: 空数据 el-empty + 空表导出 0 值文件')
  })
})
