/**
 * Task 8 — 商品管理全链路 E2E。
 *
 * 覆盖：新增 → 列表出现 → 搜索过滤（名称/条码前缀）→ 编辑库存 →
 * DB 流水断言（node 直读 launchApp 返回的 dbPath）→ 重复条码错误 →
 * 负库存标红 → 删除确认（无引用/带历史引用 willOrphan 文案）→ 分页。
 */

import { test, expect, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

const BARCODE = '6901234567890'
const NAME = '可口可乐 330ml'

interface MovementRow {
  change_qty: number
  before_stock: number
  after_stock: number
  source: string
}

function movementsOf(dbPath: string, productId: number): MovementRow[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db
      .prepare('SELECT change_qty, before_stock, after_stock, source FROM stock_movements WHERE product_id = ? ORDER BY id')
      .all(productId) as MovementRow[]
  } finally {
    db.close()
  }
}

function productIdByBarcode(dbPath: string, barcode: string): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.prepare('SELECT id FROM products WHERE barcode = ?').get(barcode) as
      | { id: number }
      | undefined
    expect(row, `商品应存在：${barcode}`).toBeDefined()
    return row!.id
  } finally {
    db.close()
  }
}

async function openCreateDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新增商品' }).click()
  await expect(page.locator('.el-dialog')).toBeVisible()
}

async function fillProductForm(
  page: Page,
  fields: { barcode?: string; name: string; stock: number; price: number | null }
): Promise<void> {
  const dialog = page.locator('.el-dialog')
  if (fields.barcode !== undefined) {
    await dialog.locator('.el-form-item').filter({ hasText: '条码' }).locator('input').fill(fields.barcode)
  }
  await dialog.locator('.el-form-item').filter({ hasText: '名称' }).locator('input').fill(fields.name)
  await dialog
    .locator('.el-form-item')
    .filter({ hasText: '库存' })
    .locator('.el-input-number input')
    .fill(String(fields.stock))
  await dialog
    .locator('.el-form-item')
    .filter({ hasText: '默认售价' })
    .locator('.el-input-number input')
    .fill(fields.price === null ? '' : String(fields.price))
}

async function submitDialog(page: Page): Promise<void> {
  await page.locator('.el-dialog').getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.el-dialog')).toBeHidden()
}

/**
 * 重新进入商品页（拉取最新数据）。不用 page.reload()：并行任务的 E2E 会触发
 * 并发 build，out/ 重建瞬间 file:// 重载会 ERR_FILE_NOT_FOUND（实测竞态）；
 * SPA 路由离开再回来等价刷新且零文件重载。
 */
async function revisitProducts(page: Page): Promise<void> {
  await page.locator('.el-menu-item').filter({ hasText: '进货管理' }).click()
  await waitForRoute(page, '/purchases')
  await page.locator('.el-menu-item').filter({ hasText: '商品管理' }).click()
  await waitForRoute(page, '/products')
}

function tableRows(page: Page) {
  return page.locator('.el-table__body-wrapper .el-table__row')
}

function rowByName(page: Page, name: string) {
  return tableRows(page).filter({ hasText: name })
}

async function openEditDialog(page: Page, name: string): Promise<void> {
  await rowByName(page, name).getByRole('button', { name: '编辑' }).click()
  await expect(page.locator('.el-dialog')).toBeVisible()
}

test.describe.serial('商品管理全链路', () => {
  let app: LaunchedApp

  test.beforeAll(async () => {
    app = await launchApp()
    await waitForRoute(app.page, '/pos')
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  test('新增商品 → 列表出现（金额分→元显示）', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '商品管理' }).click()
    await waitForRoute(page, '/products')

    await openCreateDialog(page)
    await fillProductForm(page, { barcode: BARCODE, name: NAME, stock: 100, price: 3.5 })
    await submitDialog(page)

    const row = rowByName(page, NAME)
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(BARCODE)
    await expect(row).toContainText('100')
    await expect(row).toContainText('¥3.50')
    await expect(page.locator('.page-title__count')).toContainText('共 1 款商品')

    await page.screenshot({ path: '.omo/evidence/task-8-products-e2e.png' })
  })

  test('搜索过滤：条码前缀命中 / 无匹配空态 / 清空恢复', async () => {
    const { page } = app
    const search = page.locator('.page-actions__search input')

    await search.fill(BARCODE)
    await expect(tableRows(page)).toHaveCount(1)
    await expect(rowByName(page, NAME)).toHaveCount(1)

    // 名称子串同样命中
    await search.fill('可口可乐')
    await expect(tableRows(page)).toHaveCount(1)

    await search.fill('雪碧')
    await expect(tableRows(page)).toHaveCount(0)
    await expect(page.locator('.el-empty')).toContainText('未找到匹配商品')

    await search.fill('')
    await expect(tableRows(page)).toHaveCount(1)
  })

  test('编辑库存 100→80：行更新 + DB 流水 {change:-20, before:100, after:80, source:manual}', async () => {
    const { page } = app
    await openEditDialog(page, NAME)
    const dialog = page.locator('.el-dialog')
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '库存' })
      .locator('.el-input-number input')
      .fill('80')
    await submitDialog(page)

    const row = rowByName(page, NAME)
    await expect(row).toContainText('80')

    const productId = productIdByBarcode(app.dbPath, BARCODE)
    const movements = movementsOf(app.dbPath, productId)
    // 创建 0→100 + 调整 100→80 = 2 条
    expect(movements).toHaveLength(2)
    expect(movements[1]).toMatchObject({
      change_qty: -20,
      before_stock: 100,
      after_stock: 80,
      source: 'manual'
    })
  })

  test('重复条码新增：错误提示「条码已存在」，弹窗保留', async () => {
    const { page } = app
    await openCreateDialog(page)
    await fillProductForm(page, { barcode: BARCODE, name: '山寨可乐', stock: 0, price: null })
    await page.locator('.el-dialog').getByRole('button', { name: '保存' }).click()

    await expect(page.locator('.el-message--error')).toContainText('条码已存在')
    // 校验失败弹窗不关闭（用户可修正输入）
    await expect(page.locator('.el-dialog')).toBeVisible()

    await page.locator('.el-dialog').getByRole('button', { name: '取消' }).click()
    await expect(page.locator('.el-dialog')).toBeHidden()
    await expect(rowByName(page, '山寨可乐')).toHaveCount(0)
  })

  test('负库存标红（D2：允许，行 class stock-negative）', async () => {
    const { page } = app
    await openEditDialog(page, NAME)
    const dialog = page.locator('.el-dialog')
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '库存' })
      .locator('.el-input-number input')
      .fill('-5')
    await submitDialog(page)

    const row = rowByName(page, NAME)
    await expect(row).toHaveClass(/stock-negative/)
    await expect(row).toContainText('-5')

    // 标红行截图留证（错误/边界场景证据）
    await page.screenshot({ path: '.omo/evidence/task-8-error-cases.png' })
  })

  test('删除（无引用）：确认弹窗明示库存废弃 → 行消失', async () => {
    const { page } = app
    await rowByName(page, NAME).getByRole('button', { name: '删除' }).click()

    const box = page.locator('.el-message-box')
    await expect(box).toBeVisible()
    await expect(box).toContainText(`确定删除商品「${NAME}」吗？`)
    await expect(box).toContainText('库存及库存流水将废弃')
    await box.getByRole('button', { name: '删除' }).click()

    await expect(rowByName(page, NAME)).toHaveCount(0)
    await expect(page.locator('.page-title__count')).toContainText('共 0 款商品')
  })

  test('删除（带历史引用）：弹窗含引用数文案，快照行保留且 product_id 置 NULL', async () => {
    const { page } = app

    // 新建商品 B
    await openCreateDialog(page)
    await fillProductForm(page, { barcode: '6908888888888', name: '农夫山泉 550ml', stock: 10, price: 2 })
    await submitDialog(page)
    await expect(rowByName(page, '农夫山泉 550ml')).toHaveCount(1)

    // node 直写一条历史销售引用（快照设计：sale_items.product_id → 商品）
    const productId = productIdByBarcode(app.dbPath, '6908888888888')
    const db = new Database(app.dbPath)
    try {
      const sale = db
        .prepare("INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-9001', 200, 1)")
        .run()
      db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
         VALUES (?, ?, '农夫山泉 550ml', '6908888888888', 1, 200, 200)`
      ).run(Number(sale.lastInsertRowid), productId)
    } finally {
      db.close()
    }

    // 重新进入页面（拉取带 willOrphan 的列表）
    await revisitProducts(page)

    await rowByName(page, '农夫山泉 550ml').getByRole('button', { name: '删除' }).click()
    const box = page.locator('.el-message-box')
    await expect(box).toContainText('该商品关联 1 条历史单据')
    await expect(box).toContainText('保留商品快照')
    await box.getByRole('button', { name: '删除' }).click()

    await expect(rowByName(page, '农夫山泉 550ml')).toHaveCount(0)

    // DB 断言：快照行保留、product_id 断链置 NULL、商品行硬删
    const verify = new Database(app.dbPath, { readonly: true })
    try {
      const item = verify.prepare('SELECT product_id, product_name FROM sale_items').get() as {
        product_id: number | null
        product_name: string
      }
      expect(item.product_name).toBe('农夫山泉 550ml')
      expect(item.product_id).toBeNull()
      expect(
        verify.prepare('SELECT COUNT(*) AS n FROM products WHERE id = ?').get(productId)
      ).toEqual({ n: 0 })
    } finally {
      verify.close()
    }
  })

  test('分页：每页 20 条，翻页正确', async () => {
    const { page } = app

    // node 直写 25 个商品（合计 25 款）
    const db = new Database(app.dbPath)
    try {
      const insert = db.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, NULL, 0)'
      )
      for (let i = 1; i <= 25; i++) {
        insert.run(`BULK${String(i).padStart(6, '0')}`, `批量商品 ${String(i).padStart(2, '0')}`)
      }
    } finally {
      db.close()
    }

    await revisitProducts(page)

    await expect(page.locator('.page-title__count')).toContainText('共 25 款商品')
    await expect(tableRows(page)).toHaveCount(20)
    await expect(page.locator('.el-pagination')).toContainText('25')

    // Element Plus 页码为 li.number（非 button 元素）
    await page.locator('.el-pagination .el-pager li.number', { hasText: '2' }).click()
    await expect(tableRows(page)).toHaveCount(5)
    // 列表 id DESC（新创建在前）：第 2 页为批量商品 05..01
    await expect(tableRows(page).first()).toContainText('批量商品 05')
  })
})
