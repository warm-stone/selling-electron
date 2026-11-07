/**
 * T4.2 — SN 商品全链路 E2E（Phase 4 收口）。
 *
 * 覆盖（计划 §6 T4.2 五组场景）：
 *  A 全生命周期：建 SN 商品（前缀）→ 进货页 SN 行扫码录入（前缀自动匹配）→
 *    商品页展开台账 → 收银台扫 SN 加购 → 结账 → 小票预览含 SN 副行 →
 *    销售记录明细 SN 列 → 作废 → 台账回在库 → 再扫已售 SN 警告
 *  B 扫商品条码 → SN 加购弹窗 → 手输 SN 结账（D-SN5 第二入口）
 *  C 搜索双击 SN 商品行 → 同一弹窗（双入口同一拦截点）
 *  D 同 SN 重复加入购物车拒绝（D-SN7）
 *  E 批量计商品回归（扫两次合并 qty=2 → 库存 -2，老行为共存）
 *  F 58mm 默认模板超长 SN 副行截断（'*' 标记，全码不上纸——T3.1）
 *
 * 扫码注入用 T5 S6 定案方案（与 pos.spec / print-flow.spec 同一实现）：
 * electronApp.evaluate 内循环 webContents.sendInputEvent({type:'keyDown'})
 * （10ms 间隔 < 50ms 连发阈值）+ keyDown Enter——与真扫码枪等效
 * （真实事件管线 + before-input-event 检测桥全链路）。page.keyboard（CDP
 * 路径）不触发 before-input-event，禁用。
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { buildSnLines, SN_TRUNCATION_MARKER } from '../../src/shared/receipt/item-columns'
import { DEFAULT_TEMPLATES } from '../../src/shared/receipt/default-template'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

const PHONE_NAME = '测试手机'
const PHONE_BARCODE = '6901111111111'
const PHONE_PREFIX = 'TPS'
const SN1 = 'TPS0001'
const SN2 = 'TPS0002'
const COST_CENTS = 10000 // 进货成本 ¥100.00（单一成本价，D-SN10）

/** 批量计回归商品（E 组；better-sqlite3 直插，WAL 多连接主进程立即可见） */
const COLA_NAME = 'E2E 回归可乐 330ml'
const COLA_BARCODE = '6909999999999'

/** 超长 SN（34 字符 > 58mm 预算 avail=27 → 截断 26 + '*'） */
const LONG_SN = `TPS-${'A'.repeat(30)}`

/** 扫码枪注入（S6 定案）：主进程 keyDown 连发（10ms 间隔）+ Enter */
async function scanBarcode(electronApp: ElectronApplication, code: string): Promise<void> {
  await electronApp.evaluate(
    async (electron, { code: barcode }) => {
      const win = electron.BrowserWindow.getAllWindows()[0]
      const wc = win?.webContents
      if (!wc) throw new Error('E2E: 未找到主窗口')
      for (const ch of barcode) {
        // 大写字母需 shift 修饰：sendInputEvent 的字母 keyCode 渲染层一律
        // 映射为小写 key（US 布局），真枪输出大写时同样携带 Shift
        const isUpper = ch !== ch.toLowerCase()
        wc.sendInputEvent({
          type: 'keyDown',
          keyCode: ch.toLowerCase(),
          ...(isUpper ? { modifiers: ['shift'] } : {})
        })
        await new Promise((r) => setTimeout(r, 10))
      }
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    },
    { code }
  )
}

/** 测试机本地日期 yyyyMMdd（与主进程 SQL strftime 同源——D18 单号前缀） */
function localYmd(): string {
  const now = new Date()
  return (
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`
  )
}

function productRow(page: Page, name: string) {
  return page.locator('.el-table__body-wrapper .el-table__row').filter({ hasText: name })
}

/** 侧栏菜单导航（SPA 路由离开再回来 = 等价刷新，规避 file:// 重载竞态） */
async function gotoMenu(page: Page, label: string, route: string): Promise<void> {
  await page.locator('.el-menu-item').filter({ hasText: label }).click()
  await waitForRoute(page, route)
}

/** 收银台结账 → 确认弹窗（T10）→ 等小票预览弹窗（返回弹窗 locator 供断言） */
async function checkoutAndWaitPreview(page: Page) {
  await page.locator('.cart-panel__checkout').click()
  // Task 10：结账改为弹窗确认——散客快单不填字段直接确认（extras undefined 快单路径）
  const confirmBtn = page.locator('.checkout-dialog__confirm')
  await expect(confirmBtn).toBeVisible()
  await confirmBtn.click()
  const preview = page.locator('.el-dialog').filter({ hasText: '小票预览' })
  await expect(preview).toBeVisible()
  return preview
}

test.describe.serial('SN 商品全链路（T4.2）：建档→进货→台账→收银→作废→回滚', () => {
  let app: LaunchedApp

  test.beforeAll(async () => {
    app = await launchApp()
    await waitForRoute(app.page, '/pos')

    // seed：批量计回归商品（E 组用；tracking 走列默认 'quantity'——存量兼容）
    const db = new Database(app.dbPath)
    try {
      db.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
      ).run(COLA_BARCODE, COLA_NAME, 350, 10)
    } finally {
      db.close()
    }
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  // ═══════════ A 组：全生命周期 ═══════════

  test('A1 建档 SN 商品（前缀）：列表出现 SN 标签，库存 0（初始库存字段隐藏）', async () => {
    const { page } = app
    await gotoMenu(page, '商品管理', '/products')

    await page.getByRole('button', { name: '新增商品' }).click()
    const dialog = page.locator('.el-dialog')
    await expect(dialog).toBeVisible()

    // 选「SN 商品」类型（D-SN1 建后不可转）
    await page.getByTestId('product-tracking').getByText('SN 商品').click()
    // SN 类型隐藏初始库存（D-SN11：一律进货录入）
    await expect(dialog.locator('.el-form-item').filter({ hasText: '初始库存' })).toHaveCount(0)

    await dialog.locator('.el-form-item').filter({ hasText: '条码' }).locator('input').fill(PHONE_BARCODE)
    await dialog.locator('.el-form-item').filter({ hasText: '名称' }).locator('input').fill(PHONE_NAME)
    // el-input 的 data-testid 透传到原生 input（同 template-editor.spec 惯例）
    await page.getByTestId('product-sn-prefix').fill(PHONE_PREFIX)
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '默认售价' })
      .locator('.el-input-number input')
      .fill('99')
    await dialog.getByRole('button', { name: '保存' }).click()

    await expect(page.locator('.el-message--success').filter({ hasText: 'SN 商品已创建' })).toBeVisible()
    await expect(dialog).toBeHidden()

    const row = productRow(page, PHONE_NAME)
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(PHONE_BARCODE)
    await expect(row.locator('.cell-name__tag')).toHaveText('SN')
    await expect(row.locator('.cell-stock')).toHaveText('0')
    await expect(page.locator('.page-title__count')).toContainText('共 2 款商品')
  })

  test('A2 进货：新建单 0 行（D-SN9）→ SN 行扫码录入（前缀自动匹配）→ 单一成本价 → 提交', async () => {
    const { page } = app
    await gotoMenu(page, '进货管理', '/purchases')

    await page.getByTestId('create-purchase').click()
    const dialog = page.locator('.el-dialog').filter({ hasText: '新建进货单' })
    await expect(dialog).toBeVisible()

    const rows = page.locator('.create-form__table .el-table__row')
    // D-SN9：新建进货单默认 0 行（锁定产品决策）
    await expect(rows).toHaveCount(0)
    await expect(dialog.locator('.el-empty')).toContainText('请添加商品行')

    await page.getByTestId('add-sn-row').click()
    await expect(rows).toHaveCount(1)

    // 扫码录入 TPS0001：扫码桥 → 行追加 + 前缀唯一命中自动匹配商品（D-SN2）
    await scanBarcode(app.electronApp, SN1)
    await expect(rows.nth(0).locator('.sn-sub__tags .el-tag')).toHaveCount(1)
    await expect(rows.nth(0).locator('.sn-sub__tags .el-tag')).toContainText(SN1)
    await expect(rows.nth(0).locator('.el-select')).toContainText(PHONE_NAME)
    await expect(rows.nth(0).locator('.sn-qty')).toContainText('已录 1 个')

    // 再扫 TPS0002（数量 = SN 个数，禁手填——D-SN9）
    await scanBarcode(app.electronApp, SN2)
    await expect(rows.nth(0).locator('.sn-sub__tags .el-tag')).toHaveCount(2)
    await expect(rows.nth(0).locator('.sn-sub__count')).toHaveText('已录 2 个')

    // 单一成本价输入（对该行全部 SN 生效——D-SN10）
    await rows.nth(0).locator('.el-input-number input').fill('100')
    await dialog.locator('input[placeholder*="供应商"]').fill('SN 手机进货')
    await page.getByRole('button', { name: '提交入库' }).click()

    await expect(page.locator('.el-message--success').filter({ hasText: '入库成功' })).toBeVisible()
    await expect(
      page.locator('.purchases-view__table').filter({ hasText: `${localYmd()}-0001` })
    ).toBeVisible()
  })

  test('A2-DB 进货落库权威断言：明细展开 2 行（qty=1 同价）+ 台账 2 条 + stock=2 + 链式流水', async () => {
    const db = new Database(app.dbPath, { readonly: true })
    try {
      const phone = db
        .prepare('SELECT stock, tracking, sn_prefix FROM products WHERE barcode = ?')
        .get(PHONE_BARCODE) as { stock: number; tracking: string; sn_prefix: string }
      expect(phone).toEqual({ stock: 2, tracking: 'sn', sn_prefix: PHONE_PREFIX })

      const items = db
        .prepare('SELECT product_name, quantity, cost_price_cents, sn FROM purchase_items ORDER BY id')
        .all() as Array<{ product_name: string; quantity: number; cost_price_cents: number; sn: string | null }>
      expect(items).toEqual([
        { product_name: PHONE_NAME, quantity: 1, cost_price_cents: COST_CENTS, sn: SN1 },
        { product_name: PHONE_NAME, quantity: 1, cost_price_cents: COST_CENTS, sn: SN2 }
      ])

      const sns = db
        .prepare('SELECT sn, status, deleted FROM product_sns ORDER BY id')
        .all() as Array<{ sn: string; status: string; deleted: number }>
      expect(sns).toEqual([
        { sn: SN1, status: 'in_stock', deleted: 0 },
        { sn: SN2, status: 'in_stock', deleted: 0 }
      ])

      // 逐 SN 链式流水（0→1→2，source='purchase'——G5 审计链）
      const movements = db
        .prepare(
          `SELECT change_qty, before_stock, after_stock, source FROM stock_movements
            WHERE product_id = (SELECT id FROM products WHERE barcode = ?) ORDER BY id`
        )
        .all(PHONE_BARCODE) as Array<{ change_qty: number; before_stock: number; after_stock: number; source: string }>
      expect(movements).toEqual([
        { change_qty: 1, before_stock: 0, after_stock: 1, source: 'purchase' },
        { change_qty: 1, before_stock: 1, after_stock: 2, source: 'purchase' }
      ])
    } finally {
      db.close()
    }
  })

  test('A3 商品页 SN 台账（D-SN16）：展开行 2 条在库；切换含已售仍 2 条', async () => {
    const { page } = app
    await gotoMenu(page, '商品管理', '/products')

    const row = productRow(page, PHONE_NAME)
    await expect(row.locator('.cell-stock')).toHaveText('2')

    await row.locator('.el-table__expand-icon').click()
    const ledger = page.getByTestId('sn-ledger-table')
    await expect(ledger).toBeVisible()
    await expect(ledger.locator('.el-table__row')).toHaveCount(2)
    await expect(ledger.locator('.el-table__row').filter({ hasText: SN1 })).toHaveCount(1)
    await expect(ledger.locator('.el-table__row').filter({ hasText: SN2 })).toHaveCount(1)
    await expect(ledger.locator('.el-tag--success')).toHaveCount(2)

    // toggle 含已售（当前无已售 → 仍 2 条）
    await page.getByTestId('sn-ledger-filter').getByText('含已售').click()
    await expect(ledger.locator('.el-table__row')).toHaveCount(2)

    await page.screenshot({ path: '.omo/evidence/task-sn-products-ledger.png' })
  })

  test('A4 收银台扫 SN 直接加购（qty 锁 1）→ 结账 → 小票预览含 SN 副行', async () => {
    const { page } = app
    await gotoMenu(page, '收银台', '/pos')

    // 扫 SN（D-SN5 第一优先级：findSn 命中在库 → 直接加 SN 行）
    await scanBarcode(app.electronApp, SN1)
    const row = page.locator('.cart-row').filter({ hasText: PHONE_NAME })
    await expect(row).toHaveCount(1)
    await expect(row.locator('.cart-row__sn')).toHaveText(`SN：${SN1}`)
    await expect(row.locator('.cart-row__qty input')).toHaveValue('1')
    // D-SN7：SN 行数量控件禁用（quantity 恒 1）
    await expect(row.locator('.cart-row__qty input')).toBeDisabled()
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥99.00')

    const preview = await checkoutAndWaitPreview(page)
    await expect(preview.locator('.el-dialog__title')).toHaveText(/小票预览 · \d{8}-\d{4}/)
    // D-SN12：小票明细 SN 副行（数据驱动默认行为——T3.3）
    const snLine = preview.getByTestId('receipt-item-sn')
    await expect(snLine).toHaveCount(1)
    await expect(snLine).toContainText(`SN:${SN1}`)

    await page.screenshot({ path: '.omo/evidence/task-sn-products-pos-receipt.png' })
    await preview.getByRole('button', { name: '取消' }).click()
    await expect(preview).toBeHidden()
    await expect(page.locator('.cart-row')).toHaveCount(0)
  })

  test('A5 销售记录：明细弹窗 SN 列（D-SN12）→ 作废（确认）→ tag 已作废', async () => {
    const { page } = app
    await gotoMenu(page, '销售记录', '/sales-history')

    const rows = page.locator('.sales-history__table .el-table__row')
    await expect(rows).toHaveCount(1) // 今日仅 A4 一单（默认日期范围 = 今天）
    await expect(rows.first().locator('.el-tag--primary')).toHaveText('已完成')

    await rows.first().getByRole('button', { name: '查看明细' }).click()
    const detail = page.locator('.el-dialog').filter({ hasText: '销售明细' })
    await expect(detail).toBeVisible()
    const cells = detail.locator('.el-table__row').first().locator('td')
    await expect(cells.nth(0)).toContainText(PHONE_NAME)
    await expect(cells.nth(1)).toContainText(PHONE_BARCODE)
    await expect(cells.nth(2)).toHaveText(SN1) // SN 列
    await expect(cells.nth(3)).toHaveText('1')
    await expect(cells.nth(4)).toHaveText('99.00')
    await detail.locator('.el-dialog__close').click()
    await expect(detail).toBeHidden()

    // 作废：确认弹窗明示库存回滚 → success → tag 变化
    await rows.first().getByRole('button', { name: '作废', exact: true }).click()
    const box = page.locator('.el-message-box')
    await expect(box).toContainText('库存将回滚')
    await page.getByRole('button', { name: '确认作废' }).click()
    await expect(page.locator('.el-message--success').filter({ hasText: '已作废' })).toBeVisible()
    await expect(rows.first().locator('.el-tag--danger')).toHaveText('已作废')
  })

  test('A6 作废回滚：商品页台账 TPS0001 回在库（stock 2 + UI 在库 tag + DB 台账复位）', async () => {
    const { page } = app
    await gotoMenu(page, '商品管理', '/products')

    const row = productRow(page, PHONE_NAME)
    await expect(row.locator('.cell-stock')).toHaveText('2') // 1 → 2（void 回滚）

    await row.locator('.el-table__expand-icon').click()
    const ledger = page.getByTestId('sn-ledger-table')
    await expect(ledger.locator('.el-table__row').filter({ hasText: SN1 })).toHaveCount(1)
    await expect(
      ledger.locator('.el-table__row').filter({ hasText: SN1 }).locator('.el-tag--success')
    ).toHaveText('在库')

    // DB 权威：SN 状态复位 + sale_item_id 断链（D-SN8）
    const db = new Database(app.dbPath, { readonly: true })
    try {
      const sn1 = db
        .prepare('SELECT status, sale_item_id, deleted FROM product_sns WHERE sn = ?')
        .get(SN1) as { status: string; sale_item_id: number | null; deleted: number }
      expect(sn1).toEqual({ status: 'in_stock', sale_item_id: null, deleted: 0 })
    } finally {
      db.close()
    }
  })

  test('A7 再售 TPS0002 → 结账 → 重扫同 SN：警告「该 SN 已售出」（D-SN6 拒绝态）', async () => {
    const { page } = app
    await gotoMenu(page, '收银台', '/pos')

    await scanBarcode(app.electronApp, SN2)
    const row = page.locator('.cart-row').filter({ hasText: PHONE_NAME })
    await expect(row).toHaveCount(1)
    await expect(row.locator('.cart-row__sn')).toContainText(SN2)

    const preview = await checkoutAndWaitPreview(page)
    await preview.getByRole('button', { name: '取消' }).click()
    await expect(preview).toBeHidden()

    // 重扫已售 SN → 警告 toast，不产生负库存语义
    await scanBarcode(app.electronApp, SN2)
    await expect(page.locator('.el-message--warning').filter({ hasText: '该 SN 已售出' })).toBeVisible()
    await expect(page.locator('.cart-row')).toHaveCount(0)
  })

  // ═══════════ B/C/D 组：SN 加购弹窗双入口 + 购物车重复拒绝 ═══════════

  test('B 扫 SN 商品条码 → SN 加购弹窗 → 手输在库 SN → 加购（D-SN5 第二入口）', async () => {
    const { page } = app

    await scanBarcode(app.electronApp, PHONE_BARCODE)
    const dialog = page.locator('.el-dialog').filter({ hasText: 'SN 加购' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(PHONE_NAME)
    await expect(page.getByTestId('sn-entry-input')).toBeVisible()

    // 手动输入（TPS0001 已随作废回在库）→ 确认按钮提交
    await page.getByTestId('sn-entry-input').fill(SN1)
    await page.getByTestId('sn-entry-confirm').click()
    await expect(dialog).toBeHidden()

    const row = page.locator('.cart-row').filter({ hasText: PHONE_NAME })
    await expect(row).toHaveCount(1)
    await expect(row.locator('.cart-row__sn')).toHaveText(`SN：${SN1}`)

    await page.locator('.cart-clear-btn').click()
    await expect(page.locator('.cart-row')).toHaveCount(0)
  })

  test('C 搜索双击 SN 商品行 → 同一 SN 加购弹窗 → 录 SN 加购', async () => {
    const { page } = app

    await page.locator('.barcode-input input').fill(PHONE_NAME)
    const productRow = page.locator('.pos-products-table .el-table__row').filter({ hasText: PHONE_NAME })
    await expect(productRow).toHaveCount(1)
    await productRow.dblclick()

    const dialog = page.locator('.el-dialog').filter({ hasText: 'SN 加购' })
    await expect(dialog).toBeVisible()
    await page.getByTestId('sn-entry-input').fill(SN1)
    await page.getByTestId('sn-entry-confirm').click()
    await expect(dialog).toBeHidden()

    await expect(page.locator('.cart-row').filter({ hasText: PHONE_NAME })).toHaveCount(1)
    await expect(page.locator('.cart-row__sn')).toHaveText(`SN：${SN1}`)
  })

  test('D 同 SN 重复加入购物车拒绝（D-SN7）：error 提示 + 弹窗保留 + 车内仍 1 行', async () => {
    const { page } = app
    // 上一用例购物车已有 TPS0001；再开弹窗录同一 SN
    const productRow = page.locator('.pos-products-table .el-table__row').filter({ hasText: PHONE_NAME })
    await productRow.dblclick()

    const dialog = page.locator('.el-dialog').filter({ hasText: 'SN 加购' })
    await expect(dialog).toBeVisible()
    await page.getByTestId('sn-entry-input').fill(SN1)
    await page.getByTestId('sn-entry-confirm').click()

    await expect(
      page.locator('.el-message--error').filter({ hasText: '该 SN 已在购物车中' })
    ).toBeVisible()
    // 弹窗保留（用户可换 SN 重试）→ 手动关闭
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()

    await expect(page.locator('.cart-row')).toHaveCount(1)
    await page.locator('.cart-clear-btn').click()
    await expect(page.locator('.cart-row')).toHaveCount(0)
  })

  // ═══════════ E 组：批量计商品回归（零行为变化） ═══════════

  test('E 批量计回归：扫两次合并 qty=2（D16）→ 结账 → 库存 -2、明细无 SN 副行', async () => {
    const { page } = app

    await scanBarcode(app.electronApp, COLA_BARCODE)
    const row = page.locator('.cart-row').filter({ hasText: COLA_NAME })
    await expect(row).toHaveCount(1)
    await expect(row.locator('.cart-row__qty input')).toHaveValue('1')
    await scanBarcode(app.electronApp, COLA_BARCODE)
    // D16 合并：同 key 重复加购 qty+1 单行（老行为与 SN 路径共存）
    await expect(row.locator('.cart-row__qty input')).toHaveValue('2')
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥7.00')

    const preview = await checkoutAndWaitPreview(page)
    // 批量计行无 SN 副行（数据驱动：item.sn null → 不渲染——T3.3）
    await expect(preview.getByTestId('receipt-item-sn')).toHaveCount(0)
    await preview.getByRole('button', { name: '取消' }).click()
    await expect(preview).toBeHidden()

    // DB 权威：库存 10 → 8；明细 quantity=2、sn NULL
    const db = new Database(app.dbPath, { readonly: true })
    try {
      const cola = db
        .prepare('SELECT stock FROM products WHERE barcode = ?')
        .get(COLA_BARCODE) as { stock: number }
      expect(cola.stock).toBe(8)
      const item = db
        .prepare('SELECT quantity, sn FROM sale_items WHERE product_name = ?')
        .get(COLA_NAME) as { quantity: number; sn: string | null }
      expect(item).toEqual({ quantity: 2, sn: null })
    } finally {
      db.close()
    }
  })

  // ═══════════ F 组：58mm 模板超长 SN 截断（T3.1/R3） ═══════════

  test("F 58mm 默认模板：超长 SN（34 字符）小票副行截断 + '*' 标记，全码不上纸", async () => {
    const { page } = app

    // 切默认模板到 58mm（直改 DB——print.service 每次组装实时读默认模板；
    // A4 首次预览已触发惰性 seed，防御性兜底插入 58mm 行）
    const switchDb = new Database(app.dbPath)
    try {
      const has58 = switchDb
        .prepare("SELECT COUNT(*) AS n FROM print_templates WHERE paper_width = '58mm'")
        .get() as { n: number }
      if (has58.n === 0) {
        switchDb
          .prepare(
            'INSERT INTO print_templates (name, paper_width, config_json, is_default) VALUES (?, ?, ?, 0)'
          )
          .run('默认小票（58mm）', '58mm', JSON.stringify(DEFAULT_TEMPLATES['58mm']))
      }
      switchDb.prepare('UPDATE print_templates SET is_default = 0').run()
      switchDb
        .prepare("UPDATE print_templates SET is_default = 1 WHERE paper_width = '58mm'")
        .run()
    } finally {
      switchDb.close()
    }

    // 进货超长 SN：先扫在库 SN 验证即时拒绝（D-SN6/17），再扫长 SN（前缀自动匹配）
    await gotoMenu(page, '进货管理', '/purchases')
    await page.getByTestId('create-purchase').click()
    const dialog = page.locator('.el-dialog').filter({ hasText: '新建进货单' })
    await expect(dialog).toBeVisible()
    await page.getByTestId('add-sn-row').click()
    const rows = page.locator('.create-form__table .el-table__row')
    await expect(rows).toHaveCount(1)

    await scanBarcode(app.electronApp, SN1)
    await expect(page.locator('.el-message--error').filter({ hasText: '已在库' })).toBeVisible()
    await expect(rows.nth(0).locator('.sn-sub__tags .el-tag')).toHaveCount(0)

    await scanBarcode(app.electronApp, LONG_SN)
    await expect(rows.nth(0).locator('.sn-sub__tags .el-tag')).toHaveCount(1)
    await expect(rows.nth(0).locator('.sn-sub__tags .el-tag')).toContainText(LONG_SN)
    await expect(rows.nth(0).locator('.el-select')).toContainText(PHONE_NAME)
    await rows.nth(0).locator('.el-input-number input').fill('50')
    await page.getByRole('button', { name: '提交入库' }).click()
    await expect(
      page.locator('.purchases-view__table').filter({ hasText: `${localYmd()}-0002` })
    ).toBeVisible()

    // POS 扫长 SN → 结账 → 预览：SN 副行截断（购物车/数据层全码完整）
    await gotoMenu(page, '收银台', '/pos')
    await scanBarcode(app.electronApp, LONG_SN)
    const row = page.locator('.cart-row').filter({ hasText: PHONE_NAME })
    await expect(row).toHaveCount(1)
    await expect(row.locator('.cart-row__sn')).toContainText(LONG_SN)

    const preview = await checkoutAndWaitPreview(page)
    await expect(preview.locator('.receipt-paper')).toHaveClass(/receipt-paper--58mm/)
    const snLine = preview.getByTestId('receipt-item-sn')
    await expect(snLine).toHaveCount(1)

    // G7 同源断言：渲染文本 = buildSnLines('58mm') 的截断形态（前 avail-1 列 + '*'）
    const expectedLines = buildSnLines(LONG_SN, '58mm')
    expect(expectedLines).toHaveLength(1)
    const rendered = ((await snLine.textContent()) ?? '').trim()
    expect(rendered).toBe(expectedLines[0]!.trim())
    expect(rendered).toContain(SN_TRUNCATION_MARKER)
    expect(rendered.endsWith(SN_TRUNCATION_MARKER)).toBe(true)
    // 全码不整体上纸（纸面截断仅显示用途——R3；数据层 sale_items.sn 全码）
    expect(rendered).not.toContain(LONG_SN)
    await expect(preview).not.toContainText(LONG_SN)

    await page.screenshot({ path: '.omo/evidence/task-sn-products-58mm-truncation.png' })
    await preview.getByRole('button', { name: '取消' }).click()
    await expect(preview).toBeHidden()
  })
})
