import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/**
 * Task 9 进货管理全链路 E2E。
 *
 * 商品预置：T8（商品管理）并行未合并时，products:create/products:list
 * handler 不存在——按计划 Dependencies 约定：**better-sqlite3 直插商品**
 * 绕过 products:create；products:list 若无真实 handler，则在主进程注册
 * 与契约一致的最小 stub（静态 fixture，不触碰 T8 源码领地）。
 * stub 与直插事实写入 evidence。
 */

interface FixtureProduct {
  id: number
  barcode: string | null
  name: string
  default_price_cents: number | null
  stock: number
  created_at: string
  updated_at: string
}

/** renderer 侧全局形态（E2E 文件在 node tsconfig 下 typecheck，window 经 globalThis 断言收窄） */
type RendererGlobal = { window: { api: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } } }

let app: LaunchedApp
let stubbedProductsList = false
let colaId = 0
let spriteId = 0

/** 测试机本地日期 yyyyMMdd（与主进程 SQL strftime 同源） */
function localYmd(): string {
  const now = new Date()
  return (
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`
  )
}

test.describe.serial('Task 9：进货入库全链路', () => {
  test.beforeAll(async () => {
    app = await launchApp()
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  test('预置商品：better-sqlite3 直插 + 必要时注册 products:list stub', async () => {
    // 直插 2 商品（绕过 T8 的 products:create——WAL 多连接，主进程立即可见）
    const seed = new Database(app.dbPath)
    const insert = seed.prepare(
      'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
    )
    colaId = Number(
      insert.run('6901234567890', '测试可乐 330ml', 350, 0).lastInsertRowid
    )
    spriteId = Number(
      insert.run('6902345678901', '测试雪碧 330ml', 350, 0).lastInsertRowid
    )
    seed.close()

    // renderer 侧探测 products:list 是否已有真实 handler（T8 并行合并状态自适应；
    // 注：主进程 ipcMain.listenerCount 探测不到 handle() 注册的 handler——实测坑）
    const hasReal = await app.page.evaluate(() =>
      (globalThis as unknown as RendererGlobal).window.api.invoke('products:list', {}).then(
        () => true,
        (err: unknown) =>
          !(err instanceof Error && String(err.message).includes('No handler registered'))
      )
    )
    if (hasReal) {
      stubbedProductsList = false
      return
    }
    const fixture: FixtureProduct[] = [
      {
        id: colaId,
        barcode: '6901234567890',
        name: '测试可乐 330ml',
        default_price_cents: 350,
        stock: 0,
        created_at: '2026-11-01 09:00:00',
        updated_at: '2026-11-01 09:00:00'
      },
      {
        id: spriteId,
        barcode: '6902345678901',
        name: '测试雪碧 330ml',
        default_price_cents: 350,
        stock: 0,
        created_at: '2026-11-01 09:00:00',
        updated_at: '2026-11-01 09:00:00'
      }
    ]
    await app.electronApp.evaluate(({ ipcMain }, products: FixtureProduct[]) => {
      ipcMain.handle('products:list', (_event, req?: { keyword?: string }) => {
        const kw = typeof req?.keyword === 'string' ? req.keyword.trim() : ''
        if (!kw) return products
        return products.filter(
          (p) => p.name.includes(kw) || (p.barcode ?? '').includes(kw)
        )
      })
    }, fixture)
    stubbedProductsList = true
  })

  test('新建 2 行进货单 → 列表出现单号（yyyyMMdd-0001）', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '进货管理' }).click()
    await waitForRoute(page, '/purchases')
    await expect(page.locator('.purchases-view__title')).toHaveText('进货管理')

    await page.getByTestId('create-purchase').click()
    await expect(page.locator('.el-dialog').filter({ hasText: '新建进货单' })).toBeVisible()

    const rows = page.locator('.create-form__table .el-table__row')
    await expect(rows).toHaveCount(1)

    // el-select 选项定位坑（全量 E2E 实测 strict violation 根因）：
    // ① popper teleport 到 body 后关闭即 DOM 残留（外层 .el-select__popper display:none，
    //    item 本体永远 display:block）——按 class/role 全局定位必命中残留；
    // ② 关闭/打开都是渐隐动画——动画重叠窗口内残留项仍 :visible、新项可能未展开到非零框，
    //    ':visible + .first()/.last()/getByRole' 都会拿错目标，toHaveCount(1) 也会在"假唯一"
    //    窗口（残留可见+新项未可见）提前通过。
    // 稳定方案：aria-controls 锚点——每行 select 的内部 input[aria-controls] 精确指向本
    // 下拉的 listbox（UL.el-select-dropdown__list）元素 id，按 id 圈定选项域，零时序/零残留歧义
    const selectProduct = async (rowIdx: number, keyword: string): Promise<void> => {
      const row = rows.nth(rowIdx)
      const listboxId = await row.locator('.el-select input').getAttribute('aria-controls')
      await row.locator('.el-select').click()
      const option = page.locator(`#${listboxId} .el-select-dropdown__item`, { hasText: keyword })
      await expect(option).toBeVisible()
      await option.first().click()
    }

    // 行 1：测试可乐 qty=10 cost=2.00
    await selectProduct(0, '可乐')
    await expect(rows.nth(0).locator('.el-select')).toContainText('测试可乐 330ml')
    await rows.nth(0).locator('.el-input-number input').first().fill('10')
    await rows.nth(0).locator('.el-input-number input').nth(1).fill('2.00')

    // 行 2：测试雪碧 qty=5 cost=3.00
    await page.getByRole('button', { name: '+ 添加行' }).click()
    await expect(rows).toHaveCount(2)
    await selectProduct(1, '雪碧')
    await expect(rows.nth(1).locator('.el-select')).toContainText('测试雪碧 330ml')
    await rows.nth(1).locator('.el-input-number input').first().fill('5')
    await rows.nth(1).locator('.el-input-number input').nth(1).fill('3.00')

    await page.locator('.el-dialog input[placeholder*="供应商"]').fill('E2E 测试进货')
    await page.getByRole('button', { name: '提交入库' }).click()

    await expect(page.locator('.el-message--success')).toContainText(`${localYmd()}-0001`)
    await expect(
      page.locator('.purchases-view__table').filter({ hasText: `${localYmd()}-0001` })
    ).toBeVisible()
    await expect(page.locator('.purchases-view__table')).toContainText('E2E 测试进货')
    await expect(page.locator('.purchases-view__table')).toContainText('2')
  })

  test('DB 权威断言：库存 +10/+5，流水 2 行 source=purchase，明细快照正确', async () => {
    const db = new Database(app.dbPath)
    try {
      const order = db
        .prepare('SELECT id, order_no, note FROM purchase_orders')
        .get() as { id: number; order_no: string; note: string | null }
      expect(order.order_no).toBe(`${localYmd()}-0001`)
      expect(order.note).toBe('E2E 测试进货')

      const stocks = db
        .prepare('SELECT id, stock FROM products ORDER BY id')
        .all() as Array<{ id: number; stock: number }>
      expect(stocks).toEqual([
        { id: colaId, stock: 10 },
        { id: spriteId, stock: 5 }
      ])

      const movements = db
        .prepare(
          `SELECT product_id, change_qty, before_stock, after_stock, source, source_id
             FROM stock_movements ORDER BY id`
        )
        .all() as Array<{
        product_id: number
        change_qty: number
        before_stock: number
        after_stock: number
        source: string
        source_id: number
      }>
      expect(movements).toEqual([
        { product_id: colaId, change_qty: 10, before_stock: 0, after_stock: 10, source: 'purchase', source_id: order.id },
        { product_id: spriteId, change_qty: 5, before_stock: 0, after_stock: 5, source: 'purchase', source_id: order.id }
      ])

      const items = db
        .prepare(
          `SELECT order_id, product_id, product_name, barcode, quantity, cost_price_cents
             FROM purchase_items ORDER BY id`
        )
        .all() as Array<{
        order_id: number
        product_id: number
        product_name: string
        barcode: string | null
        quantity: number
        cost_price_cents: number
      }>
      expect(items).toEqual([
        {
          order_id: order.id,
          product_id: colaId,
          product_name: '测试可乐 330ml',
          barcode: '6901234567890',
          quantity: 10,
          cost_price_cents: 200
        },
        {
          order_id: order.id,
          product_id: spriteId,
          product_name: '测试雪碧 330ml',
          barcode: '6902345678901',
          quantity: 5,
          cost_price_cents: 300
        }
      ])
    } finally {
      db.close()
    }
  })

  test('明细弹窗核对：快照名/条码/数量/成本价', async () => {
    const { page } = app
    await page.getByRole('button', { name: '查看明细' }).click()
    const detail = page.locator('.el-dialog').filter({ hasText: '进货明细' })
    await expect(detail).toBeVisible()
    await expect(detail).toContainText(`${localYmd()}-0001`)
    await expect(detail).toContainText('测试可乐 330ml')
    await expect(detail).toContainText('测试雪碧 330ml')
    await expect(detail).toContainText('6901234567890')
    await expect(detail).toContainText('6902345678901')
    await expect(detail).toContainText('2.00')
    await expect(detail).toContainText('3.00')
    await detail.locator('.el-dialog__close').click()
  })

  test('商品页库存联动 + 截图留证', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '商品管理' }).click()
    await waitForRoute(page, '/products')
    if (!stubbedProductsList) {
      // T8 已合并：商品页应反映入库后的库存
      await expect(page.locator('body')).toContainText('测试可乐 330ml')
      await expect(page.locator('body')).toContainText('测试雪碧 330ml')
    }
    // stub 场景下商品页仍为 T8 占位——库存断言已由上一用例 DB 权威覆盖（见 evidence）

    await page.locator('.el-menu-item').filter({ hasText: '进货管理' }).click()
    await waitForRoute(page, '/purchases')
    await page.getByRole('button', { name: '查看明细' }).click()
    await expect(
      page.locator('.el-dialog').filter({ hasText: '进货明细' })
    ).toBeVisible()
    await page.screenshot({ path: '.omo/evidence/task-9-purchase-e2e.png', fullPage: true })
  })
})
