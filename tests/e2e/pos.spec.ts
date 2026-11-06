/**
 * Task 11 — 收银台全链路 E2E。
 *
 * 扫码注入用 T5 S6 定案方案：electronApp.evaluate 内循环
 * webContents.sendInputEvent({type:'keyDown'})（≤15ms 间隔）+ keyDown Enter
 * ——与真扫码枪等效（真实事件管线 + 检测器全链路）。
 * page.keyboard（CDP 路径）不触发 before-input-event，禁用。
 *
 * 覆盖：空车结账 disabled → 扫码加购/重复合并 → 改数量单价（小计/合计整数分）
 * → 未命中条码 error toast → 搜索双击加购 → 删除行 → 清空 → 库存不足提示不阻断
 * → 结账成功（dialog + 购物车清空 + node 直读 DB 断言）。
 */

import { writeFileSync } from 'node:fs'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

const COLA_BARCODE = '6901234567890'
const COLA = '可口可乐 330ml'
const SPRITE = '雪碧 330ml'
const WATER = '农夫山泉 550ml'

/**
 * 扫码枪注入（S6）：主进程内 keyDown 连发（10ms 间隔 < 50ms 连发阈值）+ Enter。
 * evaluate 运行时签名为 fn(electron 模块, arg)——electron.BrowserWindow 取窗口。
 */
async function scanBarcode(electronApp: ElectronApplication, code: string): Promise<void> {
  await electronApp.evaluate(
    async (electron, { code: barcode }) => {
      const win = electron.BrowserWindow.getAllWindows()[0]
      const wc = win?.webContents
      if (!wc) throw new Error('E2E: 未找到主窗口')
      for (const ch of barcode) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        await new Promise((r) => setTimeout(r, 10))
      }
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    },
    { code }
  )
}

function cartRow(page: Page, name: string) {
  return page.locator('.cart-row').filter({ hasText: name })
}

function searchInput(page: Page) {
  return page.locator('.barcode-input input')
}

function qtyInput(page: Page, name: string) {
  return cartRow(page, name).locator('.cart-row__qty input')
}

function priceInput(page: Page, name: string) {
  return cartRow(page, name).locator('.cart-row__price input')
}

interface SaleHead {
  sale_no: string
  total_cents: number
  item_count: number
  status: string
}

function writeDbEvidence(dbPath: string, summary: string[]): void {
  const db = new Database(dbPath, { readonly: true })
  try {
    const sales = db
      .prepare('SELECT sale_no, total_cents, item_count, status, created_at FROM sales ORDER BY id')
      .all()
    const saleItems = db
      .prepare(
        'SELECT sale_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents FROM sale_items ORDER BY id'
      )
      .all()
    const products = db
      .prepare('SELECT barcode, name, default_price_cents, stock FROM products ORDER BY id')
      .all()
    const movements = db
      .prepare(
        'SELECT product_id, change_qty, before_stock, after_stock, source, source_id FROM stock_movements ORDER BY id'
      )
      .all()
    const text = [
      '=== Task 11 收银台 E2E — DB 断言转储（结账后）===',
      ...summary,
      '',
      '-- sales --',
      JSON.stringify(sales, null, 2),
      '-- sale_items --',
      JSON.stringify(saleItems, null, 2),
      '-- products（结账后库存）--',
      JSON.stringify(products, null, 2),
      '-- stock_movements --',
      JSON.stringify(movements, null, 2)
    ].join('\n')
    writeFileSync('.omo/evidence/task-11-db.txt', text)
  } finally {
    db.close()
  }
}

test.describe.serial('收银台：扫码/双击加购/购物车编辑/结账', () => {
  let app: LaunchedApp

  test.beforeAll(async () => {
    app = await launchApp()
    await waitForRoute(app.page, '/pos')

    // seed：better-sqlite3 直插（WAL 多连接，主进程下条语句即见）
    const db = new Database(app.dbPath)
    try {
      const insert = db.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
      )
      insert.run(COLA_BARCODE, COLA, 350, 100)
      insert.run('6902345678901', SPRITE, 350, 50)
      insert.run('6903456789012', WATER, 200, 1)
    } finally {
      db.close()
    }
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  test('空车：结账与清空按钮 disabled', async () => {
    const { page } = app
    await expect(page.locator('.cart-panel__checkout')).toBeDisabled()
    await expect(page.locator('.cart-clear-btn')).toBeDisabled()
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥0.00')
  })

  test('扫码加购：购物车行出现（默认售价预填），重复扫码合并 qty+1', async () => {
    const { page } = app
    await scanBarcode(app.electronApp, COLA_BARCODE)

    await expect(cartRow(page, COLA)).toHaveCount(1)
    await expect(qtyInput(page, COLA)).toHaveValue('1')
    await expect(priceInput(page, COLA)).toHaveValue('3.50')
    await expect(cartRow(page, COLA).locator('.cart-row__subtotal')).toHaveText('¥3.50')

    await scanBarcode(app.electronApp, COLA_BARCODE)
    await expect(cartRow(page, COLA)).toHaveCount(1)
    await expect(qtyInput(page, COLA)).toHaveValue('2')
    await expect(cartRow(page, COLA).locator('.cart-row__subtotal')).toHaveText('¥7.00')
  })

  test('改数量/单价：小计与合计整数分联动（元显示 2 位小数）', async () => {
    const { page } = app
    const row = cartRow(page, COLA)

    // 数量 2 → 3：3 × 3.50 = 10.50
    await qtyInput(page, COLA).fill('3')
    await qtyInput(page, COLA).blur()
    await expect(row.locator('.cart-row__subtotal')).toHaveText('¥10.50')
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥10.50')

    // 单价 3.50 → 2.50：3 × 2.50 = 7.50（证明单价编辑驱动合计）。
    // 逐键输入验证焦点保持：行 key 含 unit_price_cents（D16 分行语义），
    // 若改价逐键实时落 store，key 变化会销毁重建行 DOM 导致每键失焦
    await priceInput(page, COLA).fill('2')
    await expect(priceInput(page, COLA)).toBeFocused()
    await priceInput(page, COLA).pressSequentially('.50')
    await expect(priceInput(page, COLA)).toBeFocused()
    await priceInput(page, COLA).blur()
    await expect(row.locator('.cart-row__subtotal')).toHaveText('¥7.50')
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥7.50')

    // 单价改回 3.50（计划验收口径）
    await priceInput(page, COLA).fill('3.50')
    await priceInput(page, COLA).blur()
    await expect(row.locator('.cart-row__subtotal')).toHaveText('¥10.50')
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥10.50')
  })

  test('未命中条码：error toast + 购物车不受影响', async () => {
    const { page } = app
    await scanBarcode(app.electronApp, '0000000000000')

    await expect(page.locator('.el-message--error')).toContainText('未找到条码商品')
    await expect(page.locator('.cart-row')).toHaveCount(1)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥10.50')
  })

  test('搜索 + 双击商品行加购 → 删除行', async () => {
    const { page } = app
    await searchInput(page).fill(SPRITE)
    const spriteRow = page
      .locator('.pos-products-table .el-table__row')
      .filter({ hasText: SPRITE })
    await expect(spriteRow).toHaveCount(1)
    await spriteRow.dblclick()

    await expect(cartRow(page, SPRITE)).toHaveCount(1)
    await expect(page.locator('.cart-row')).toHaveCount(2)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥14.00')

    await cartRow(page, SPRITE).locator('.cart-row__remove').click()
    await expect(cartRow(page, SPRITE)).toHaveCount(0)
    await expect(page.locator('.cart-row')).toHaveCount(1)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥10.50')
  })

  test('清空购物车：恢复空车 disabled 态', async () => {
    const { page } = app
    await page.locator('.cart-clear-btn').click()
    await expect(page.locator('.cart-row')).toHaveCount(0)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥0.00')
    await expect(page.locator('.cart-panel__checkout')).toBeDisabled()
  })

  test('库存不足行内提示（D2 不阻断）：低库存商品数量改超量可继续结账', async () => {
    const { page } = app

    // 重建购物车：可乐扫两次（qty 2 @3.50）
    await scanBarcode(app.electronApp, COLA_BARCODE)
    await expect(qtyInput(page, COLA)).toHaveValue('1')
    await scanBarcode(app.electronApp, COLA_BARCODE)
    await expect(qtyInput(page, COLA)).toHaveValue('2')

    // 农夫山泉（库存 1）双击加购 → 数量改 5 → 行内黄条提示
    await searchInput(page).fill('农夫')
    const waterRow = page
      .locator('.pos-products-table .el-table__row')
      .filter({ hasText: WATER })
    await expect(waterRow).toHaveCount(1)
    await waterRow.dblclick()

    await qtyInput(page, WATER).fill('5')
    await qtyInput(page, WATER).blur()

    await expect(cartRow(page, WATER).locator('.cart-row__warn')).toContainText(
      '库存不足(负库存将产生)'
    )
    // 合计 = 2 × 3.50 + 5 × 2.00 = 17.00；结账不被阻断
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥17.00')
    await expect(page.locator('.cart-panel__checkout')).toBeEnabled()
  })

  test('结账：预览弹窗（T15 真预览）+ 购物车清空 + DB 落库断言（total_cents/item_count/库存）', async () => {
    const { page } = app

    await page.locator('.cart-panel__checkout').click()

    // Task 15：占位 dialog 已替换为小票预览弹窗（同源 ReceiptPreview 渲染）
    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.el-dialog__title')).toHaveText(/小票预览 · \d{8}-\d{4}/)
    // 未设置店名（shopName 空行仍占位）：默认模板 2 头部行 + 1 列头 + 2 明细 + 2 合计 + 2 底部 = 9 行
    await expect(dialog.locator('.receipt-line')).toHaveCount(9)
    await expect(dialog).toContainText('￥17.00') // 合计行（默认模板全角 ￥）
    await expect(dialog).toContainText('件数: 7')

    await page.screenshot({ path: '.omo/evidence/task-11-pos-e2e.png' })

    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()

    // 购物车清空 + 结账恢复 disabled
    await expect(page.locator('.cart-row')).toHaveCount(0)
    await expect(page.locator('.cart-panel__checkout')).toBeDisabled()

    // 搜索表格库存刷新：农夫山泉 -4（负库存标红，D2 允许）
    await expect(
      page.locator('.pos-products-table .el-table__row').filter({ hasText: WATER })
    ).toContainText('-4')

    // node 直读 DB：sales 1 行、明细 2 行、库存联动
    const db = new Database(app.dbPath, { readonly: true })
    let sales: SaleHead[]
    try {
      sales = db
        .prepare('SELECT sale_no, total_cents, item_count, status FROM sales ORDER BY id')
        .all() as SaleHead[]
      expect(sales).toHaveLength(1)
      expect(sales[0]).toMatchObject({ total_cents: 1700, item_count: 7, status: 'completed' })
      expect(sales[0]!.sale_no).toMatch(/^\d{8}-\d{4}$/)

      const items = db
        .prepare(
          'SELECT product_name, quantity, unit_price_cents, subtotal_cents FROM sale_items ORDER BY product_id'
        )
        .all() as Array<{
        product_name: string
        quantity: number
        unit_price_cents: number
        subtotal_cents: number
      }>
      expect(items).toEqual([
        { product_name: COLA, quantity: 2, unit_price_cents: 350, subtotal_cents: 700 },
        { product_name: WATER, quantity: 5, unit_price_cents: 200, subtotal_cents: 1000 }
      ])

      const stocks = db
        .prepare('SELECT name, stock FROM products ORDER BY id')
        .all() as Array<{ name: string; stock: number }>
      expect(stocks).toEqual([
        { name: COLA, stock: 98 },
        { name: SPRITE, stock: 50 },
        { name: WATER, stock: -4 }
      ])
    } finally {
      db.close()
    }

    writeDbEvidence(app.dbPath, [
      `sales: 1 行 { total_cents: 1700, item_count: 7, status: 'completed' } ✓`,
      'sale_items: 可口可乐 qty2@350=700 + 农夫山泉 qty5@200=1000 ✓',
      'products: 可口可乐 98 / 雪碧 50 / 农夫山泉 -4（负库存放行）✓'
    ])
  })
})
