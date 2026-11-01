/**
 * F3 终审 QA — A 系列：跨任务集成全链路（单一连续会话，最高优先级）。
 *
 * 单任务测试可能全绿但集成断裂——本 spec 用一个 app 会话串起：
 *  A1 完整业务流：设置店名 → 商品新增 3 个（无条码/生僻字/超长名）→ 进货 2 行 →
 *     收银台扫码（S6 注入）+ 双击混合加购 → 改数量单价 → 结账 → 预览弹窗全要素 →
 *     立即打印（tcp mock 19911）→ 销售记录查该单 → 明细正确
 *  A2 作废闭环：再结账 1 单 → 作废 → DB 库存回滚 → 日报不含该单 → voided 重打预览含「已作废」
 *  A3 模板编辑→打印生效：改头部字号倍高 + 加 footer '{shopName} 谢谢惠顾' → 保存 →
 *     设默认 → 结账新单 → 预览反映新模板
 *  A4 报表导出闭环：日报（含当日数据）→ 三格式导出 → exceljs 读回 + docx 解压 + txt 合计
 *  A5 打印机失败恢复：settings tcp_port=1 → 结账打印 → 错误 toast 含「重打」→ 销售记录完好
 *
 * 生僻字事实修正：'龘'(U+9F98) 是 GBK 内字符（iconv-lite EUC-CN 0xFD93 可编码，
 * roundtrip 成立）——不触发降级。真正的 GBK 外字符（CJK 扩展 B '𠀀' U+20000 等）
 * 才降级 '?'。P2 商品名同时含两者，分别验证两侧行为。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import iconv from 'iconv-lite'
import { Workbook } from 'exceljs'
import Database from 'better-sqlite3'
import type net from 'node:net'
import { test, expect, type Locator } from '@playwright/test'
import {
  EVIDENCE,
  closeApp,
  evidenceLog,
  launchApp,
  makeExportDir,
  revisit,
  scanBarcode,
  startPrintMock,
  todayYmd,
  waitForRoute,
  type LaunchedApp
} from './qa-helpers'

const SHOP = 'QA测试店'
const MOCK_PORT = 19911

// 商品（名称列宽 ≤ 24 列均安全显示；P3 30 字符超宽截断）
const P1_NAME = 'QA无码商品小食' // 无条码 → 双击加购
const P2_NAME = 'QA龘𠀀生僻商品' // 龘=GBK内(FD93 保留)；𠀀=GBK外(打印侧降级'?')
const P2_BARCODE = '2101234567897'
const P3_NAME = 'QA超长名称商品一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑' // 30 字符
const P3_PREFIX_24COLS = 'QA超长名称商品一二三四五' // 24 列截断前缀（2 + 11×2 列）
const P3_BARCODE = '2202345678904'

let app: LaunchedApp
let mockServer: net.Server
const received: Buffer[] = []
const EXPORT_DIR = makeExportDir()
const TODAY = todayYmd()

/** 今日销售单（scenario 内累积；A1/A2/A3/A5 各一单） */
const saleNos: string[] = []

const receivedBytes = (): Buffer => Buffer.concat(received)
const receivedHex = (): string => receivedBytes().toString('hex')

function db(): Database.Database {
  return new Database(app.dbPath)
}

function readStocks(): Record<string, number> {
  const d = db()
  try {
    const rows = d.prepare('SELECT name, stock FROM products').all() as Array<{
      name: string
      stock: number
    }>
    return Object.fromEntries(rows.map((r) => [r.name, r.stock]))
  } finally {
    d.close()
  }
}

test.describe.serial('F3 QA · A：跨任务集成全链路', () => {
  test.beforeAll(async () => {
    process.env['E2E_EXPORT_DIR'] = EXPORT_DIR
    app = await launchApp()
    await waitForRoute(app.page, '/pos')
    mockServer = await startPrintMock(MOCK_PORT, received)
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    if (mockServer)
      await new Promise<void>((resolve) => mockServer.close(() => resolve()))
    delete process.env['E2E_EXPORT_DIR']
  })

  // ═══════════ A1 完整业务流 ═══════════

  test('A1-设置：店名保存 + tcp 打印通道配置', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '系统设置' }).click()
    await waitForRoute(page, '/settings')

    await page.getByTestId('shop-name-input').fill(SHOP)
    await page.getByTestId('save-shop-btn').click()
    await expect(page.locator('.el-message--success').first()).toContainText('店铺信息已保存')
    await expect(page.locator('.el-message--success')).toHaveCount(0, { timeout: 6000 })

    await page.locator('.el-radio', { hasText: '网络打印机' }).click()
    await page.getByTestId('tcp-host-input').fill('127.0.0.1')
    await page.getByTestId('tcp-port-input').fill(String(MOCK_PORT))
    await page.getByTestId('save-print-btn').click()
    await expect(page.locator('.el-message--success').first()).toContainText('打印设置已保存')
    await expect(page.locator('.el-message--success')).toHaveCount(0, { timeout: 6000 })

    const d = db()
    try {
      const get = (k: string) =>
        (d.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string })
          .value
      expect(get('shop_name')).toBe(SHOP)
      expect(get('printer_channel')).toBe('tcp')
      expect(get('tcp_port')).toBe(String(MOCK_PORT))
    } finally {
      d.close()
    }
    await page.screenshot({ path: `${EVIDENCE}/a1-settings.png` })
    evidenceLog('A1-设置 PASS: shop_name/tcp 通道落库')
  })

  test('A1-商品：新增 3 个（无条码 / 生僻字含 GBK 外 / 30 字符超长名）', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '商品管理' }).click()
    await waitForRoute(page, '/products')

    const addProduct = async (fields: {
      barcode?: string
      name: string
      stock: number
      price: number
    }): Promise<void> => {
      await page.getByRole('button', { name: '新增商品' }).click()
      const dialog = page.locator('.el-dialog')
      await expect(dialog).toBeVisible()
      if (fields.barcode !== undefined) {
        await dialog
          .locator('.el-form-item')
          .filter({ hasText: '条码' })
          .locator('input')
          .fill(fields.barcode)
      }
      await dialog
        .locator('.el-form-item')
        .filter({ hasText: '名称' })
        .locator('input')
        .fill(fields.name)
      await dialog
        .locator('.el-form-item')
        .filter({ hasText: '库存' })
        .locator('.el-input-number input')
        .fill(String(fields.stock))
      await dialog
        .locator('.el-form-item')
        .filter({ hasText: '默认售价' })
        .locator('.el-input-number input')
        .fill(String(fields.price))
      await dialog.getByRole('button', { name: '保存' }).click()
      await expect(dialog).toBeHidden()
    }

    await addProduct({ name: P1_NAME, stock: 5, price: 3.0 }) // 无条码
    await addProduct({ barcode: P2_BARCODE, name: P2_NAME, stock: 0, price: 5.0 })
    await addProduct({ barcode: P3_BARCODE, name: P3_NAME, stock: 0, price: 8.0 })

    await revisit(page, '进货管理', '/purchases')
    await revisit(page, '商品管理', '/products')

    const rows = page.locator('.el-table__body-wrapper .el-table__row')
    await expect(rows.filter({ hasText: P1_NAME })).toBeVisible()
    await expect(rows.filter({ hasText: P2_NAME })).toBeVisible()
    await expect(rows.filter({ hasText: P3_NAME })).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/a1-products.png` })
    evidenceLog('A1-商品 PASS: 3 商品（无条码/生僻/超长名）入列表')
  })

  test('A1-进货：2 行进货单（库存充足）→ 库存联动', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '进货管理' }).click()
    await waitForRoute(page, '/purchases')

    await page.getByTestId('create-purchase').click()
    await expect(
      page.locator('.el-dialog').filter({ hasText: '新建进货单' })
    ).toBeVisible()

    const rows = page.locator('.create-form__table .el-table__row')
    const selectProduct = async (rowIdx: number, keyword: string): Promise<void> => {
      const row = rows.nth(rowIdx)
      const listboxId = await row.locator('.el-select input').getAttribute('aria-controls')
      await row.locator('.el-select').click()
      const option = page.locator(`#${listboxId} .el-select-dropdown__item`, {
        hasText: keyword
      })
      await expect(option).toBeVisible()
      await option.first().click()
    }

    await selectProduct(0, P2_NAME)
    await rows.nth(0).locator('.el-input-number input').first().fill('20')
    await rows.nth(0).locator('.el-input-number input').nth(1).fill('2.00')

    await page.getByRole('button', { name: '+ 添加行' }).click()
    await selectProduct(1, P3_NAME)
    await rows.nth(1).locator('.el-input-number input').first().fill('15')
    await rows.nth(1).locator('.el-input-number input').nth(1).fill('4.00')

    await page.locator('.el-dialog input[placeholder*="供应商"]').fill('QA 终审进货')
    await page.getByRole('button', { name: '提交入库' }).click()

    await expect(page.locator('.el-message--success').first()).toContainText(/入库成功|进货单/)
    await page.screenshot({ path: `${EVIDENCE}/a1-purchases.png` })

    const stocks = readStocks()
    expect(stocks[P1_NAME]).toBe(5)
    expect(stocks[P2_NAME]).toBe(20)
    expect(stocks[P3_NAME]).toBe(15)
    evidenceLog('A1-进货 PASS: P2 0→20, P3 0→15（DB 库存联动）')
  })

  test('A1-收银：扫码（S6 注入）+ 双击混合加购 → 改数量单价 → 合计联动', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')

    // 扫码加购 P2（S6 注入：真实事件管线 + 扫码检测器全链路）
    await scanBarcode(app.electronApp, P2_BARCODE)
    const cartRow = (name: string): Locator =>
      page.locator('.cart-row').filter({ hasText: name })
    await expect(cartRow(P2_NAME)).toHaveCount(1)
    await expect(cartRow(P2_NAME).locator('.cart-row__price input')).toHaveValue('5.00')

    // 双击加购 P1（无条码，搜索 + 双击）与 P3（超长名）
    const addByDblClick = async (name: string): Promise<void> => {
      await page.locator('.barcode-input input').fill(name)
      const row = page
        .locator('.pos-products-table .el-table__row')
        .filter({ hasText: name })
      await expect(row).toHaveCount(1)
      await row.dblclick()
      await expect(cartRow(name)).toHaveCount(1)
    }
    await addByDblClick(P1_NAME)
    await addByDblClick(P3_NAME)

    // 改数量/单价：P2 qty2 @4.50 = 9.00；P1 qty2 @3.00 = 6.00；P3 qty1 @8.00 = 8.00
    const qty = (name: string) => cartRow(name).locator('.cart-row__qty input')
    const price = (name: string) => cartRow(name).locator('.cart-row__price input')
    await qty(P2_NAME).fill('2')
    await qty(P2_NAME).blur()
    await price(P2_NAME).fill('4.50')
    await price(P2_NAME).blur()
    await expect(cartRow(P2_NAME).locator('.cart-row__subtotal')).toHaveText('¥9.00')

    await qty(P1_NAME).fill('2')
    await qty(P1_NAME).blur()
    await expect(cartRow(P1_NAME).locator('.cart-row__subtotal')).toHaveText('¥6.00')

    await expect(page.locator('.cart-row')).toHaveCount(3)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥23.00')
    await page.screenshot({ path: `${EVIDENCE}/a1-pos-cart.png` })
    evidenceLog('A1-收银 PASS: 扫码+双击混合 3 行，改量改价合计 ¥23.00')
  })

  test('A1-结账预览：店名/单号/商品行/合计/截断/生僻字两侧行为', async () => {
    const { page } = app
    await page.locator('.cart-panel__checkout').click()

    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()

    // 单号（标题）
    await expect(dialog.locator('.el-dialog__title')).toHaveText(/小票预览 · (\d{8}-\d{4})/)
    const saleNo = (
      await dialog.locator('.el-dialog__title').textContent()
    )!.match(/(\d{8}-\d{4})/)![1]
    saleNos.push(saleNo)

    // 店名 + 合计 + 件数
    await expect(dialog).toContainText(SHOP)
    await expect(dialog).toContainText('合计: ￥23.00')
    await expect(dialog).toContainText('件数: 5')

    // 商品行：P1/P2 全名可见；P3 超长名截断（完整名不出现，24 列前缀出现）
    await expect(dialog).toContainText(P1_NAME)
    await expect(dialog).toContainText(P2_NAME) // 预览侧 GBK 外字符按原文渲染（文档化差异）
    await expect(dialog).not.toContainText(P3_NAME)
    await expect(dialog).toContainText(P3_PREFIX_24COLS)

    await page.screenshot({ path: `${EVIDENCE}/a1-receipt-preview.png` })

    // 立即打印 → tcp mock 收到字节：1b40 开头 + 1d564200（切纸）结尾
    received.length = 0
    await dialog.getByRole('button', { name: '立即打印' }).click()
    await expect(
      page.locator('.el-message--success', { hasText: '打印已发送' })
    ).toBeVisible()
    await expect.poll(receivedHex, { timeout: 5_000 }).toContain('1b40')
    await expect
      .poll(() => (receivedHex().endsWith('1d564200') ? 'cut-ok' : 'pending'), {
        timeout: 5_000
      })
      .toBe('cut-ok')

    // GBK 解码打印字节：龘（GBK 内）保留 FD93；𠀀（GBK 外）降级 '?'
    const decoded = iconv.decode(receivedBytes(), 'gbk')
    expect(decoded).toContain('QA龘?生僻商品')
    expect(decoded).not.toContain(P2_NAME)
    expect(receivedHex()).toContain('fd93') // 龘 的 GBK 字节实证
    // 超长名截断同样出现在打印字节（同名网格数学）
    expect(decoded).toContain(P3_PREFIX_24COLS)
    expect(decoded).not.toContain(P3_NAME)
    writeFileSync(`${EVIDENCE}/a1-printed-bytes.bin`, receivedBytes())
    writeFileSync(
      `${EVIDENCE}/a1-printed-decoded.txt`,
      `单号: ${saleNo}\nGBK 解码全文:\n${decoded}`
    )

    // DB 断言：销售落库 + 库存联动（P1 5-2=3；P2 20-2=18；P3 15-1=14）
    const d = db()
    try {
      const sale = d
        .prepare('SELECT sale_no, total_cents, item_count, status FROM sales WHERE sale_no = ?')
        .get(saleNo) as { total_cents: number; item_count: number; status: string }
      expect(sale).toMatchObject({ total_cents: 2300, item_count: 5, status: 'completed' })
    } finally {
      d.close()
    }
    const stocks = readStocks()
    expect(stocks[P1_NAME]).toBe(3)
    expect(stocks[P2_NAME]).toBe(18)
    expect(stocks[P3_NAME]).toBe(14)

    // 打印成功 → 弹窗自动关闭
    await expect(dialog).toBeHidden()
    evidenceLog(
      `A1-结账打印 PASS: ${saleNo} 预览全要素 + mock 字节 1b40…1d564200 + 龘FD93保留/𠀀降级'?' + 落库/库存联动`
    )
  })

  test('A1-销售记录：查该单 → 明细正确', async () => {
    const { page } = app
    const saleNo = saleNos[0]!
    await page.locator('.el-menu-item').filter({ hasText: '销售记录' }).click()
    await waitForRoute(page, '/sales-history')

    const row = page
      .locator('.sales-history__table .el-table__row')
      .filter({ hasText: saleNo })
    await expect(row).toBeVisible()
    await expect(row.locator('.el-tag--primary')).toHaveText('已完成')
    await expect(row).toContainText('23.00')

    // 双击打开明细：快照行（名/数量/单价/小计）
    await row.dblclick()
    const detail = page.locator('.el-dialog').filter({ hasText: '销售明细' })
    await expect(detail).toBeVisible()
    await expect(detail).toContainText(saleNo)
    await expect(detail).toContainText(P1_NAME)
    await expect(detail).toContainText(P2_NAME)
    await expect(detail).toContainText(P3_NAME) // 明细表格无 24 列截断（与票据网格无关）
    await expect(detail).toContainText('￥23.00')
    await page.screenshot({ path: `${EVIDENCE}/a1-sales-detail.png` })
    await page.keyboard.press('Escape')
    await expect(detail).toBeHidden()
    evidenceLog('A1-销售记录 PASS: 单号可见 + 明细快照 3 行正确')
  })

  // ═══════════ A2 作废闭环 ═══════════

  test('A2-再结账 1 单（P2 单件）→ 记录单号', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')
    await scanBarcode(app.electronApp, P2_BARCODE)
    await expect(page.locator('.cart-row')).toHaveCount(1)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥5.00')

    await page.locator('.cart-panel__checkout').click()
    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()
    const saleNo = (
      await dialog.locator('.el-dialog__title').textContent()
    )!.match(/(\d{8}-\d{4})/)![1]
    saleNos.push(saleNo)
    received.length = 0
    await dialog.getByRole('button', { name: '立即打印' }).click()
    await expect(
      page.locator('.el-message--success', { hasText: '打印已发送' })
    ).toBeVisible()
    await expect.poll(receivedHex, { timeout: 5_000 }).toContain('1b40')
    await expect(dialog).toBeHidden()

    expect(readStocks()[P2_NAME]).toBe(17) // 18 - 1
    evidenceLog(`A2-再结账 PASS: ${saleNo} ¥5.00，P2 库存 18→17`)
  })

  test('A2-作废：确认弹窗 → tag 变化 → DB 库存回滚（17→18）', async () => {
    const { page } = app
    const saleNo = saleNos[1]!
    await page.locator('.el-menu-item').filter({ hasText: '销售记录' }).click()
    await waitForRoute(page, '/sales-history')

    const row = page
      .locator('.sales-history__table .el-table__row')
      .filter({ hasText: saleNo })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '作废', exact: true }).click()

    const box = page.locator('.el-message-box')
    await expect(box).toBeVisible()
    await expect(box).toContainText(saleNo)
    await expect(box).toContainText('库存将回滚')
    await page.screenshot({ path: `${EVIDENCE}/a2-void-confirm.png` })
    await page.getByRole('button', { name: '确认作废' }).click()

    await expect(page.locator('.el-message--success').first()).toContainText('已作废')
    await expect(row.locator('.el-tag--danger')).toHaveText('已作废')

    // DB 权威断言：库存回滚 + status/voided_at + void 流水
    const d = db()
    try {
      const sale = d
        .prepare('SELECT status, voided_at FROM sales WHERE sale_no = ?')
        .get(saleNo) as { status: string; voided_at: string }
      expect(sale.status).toBe('voided')
      expect(sale.voided_at).toBeTruthy()
      const movements = d
        .prepare(
          `SELECT change_qty, before_stock, after_stock, source FROM stock_movements
             WHERE source = 'void'`
        )
        .all() as Array<{
        change_qty: number
        before_stock: number
        after_stock: number
        source: string
      }>
      expect(movements).toEqual([
        { change_qty: 1, before_stock: 17, after_stock: 18, source: 'void' }
      ])
    } finally {
      d.close()
    }
    expect(readStocks()[P2_NAME]).toBe(18)
    evidenceLog('A2-作废 PASS: DB 库存回滚 17→18 + void 流水 + status=voided')
  })

  test('A2-日报：作废单剔除（汇总 23.00/1 单，明细无该单）', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '报表统计' }).click()
    await waitForRoute(page, '/reports')

    const stats = page.locator('[data-testid="daily-stats"] .stat-card__value')
    await expect(stats.nth(0)).toHaveText('23.00') // A1 单；A2 voided 剔除
    await expect(stats.nth(1)).toHaveText('1')

    const rows = page.locator('[data-testid="daily-table"] .el-table__row')
    await expect(rows).toHaveCount(1)
    await expect(rows.filter({ hasText: saleNos[0]! })).toBeVisible()
    await expect(rows.filter({ hasText: saleNos[1]! })).toHaveCount(0)
    await page.screenshot({ path: `${EVIDENCE}/a2-reports-exclude-voided.png` })
    evidenceLog('A2-日报剔除 PASS: 汇总 23.00/1，明细无作废单')
  })

  test('A2-voided 重打：预览含「已作废」', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '销售记录' }).click()
    await waitForRoute(page, '/sales-history')

    const row = page
      .locator('.sales-history__table .el-table__row')
      .filter({ hasText: saleNos[1]! })
    await row.getByRole('button', { name: '重打小票' }).click()

    const preview = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(preview).toBeVisible()
    await expect(preview).toContainText(saleNos[1]!)
    await expect(preview).toContainText('已作废')
    await page.screenshot({ path: `${EVIDENCE}/a2-voided-reprint.png` })
    await preview.getByRole('button', { name: '取消' }).click()
    await expect(preview).toBeHidden()
    evidenceLog('A2-voided 重打 PASS: 预览含「已作废」标记')
  })

  // ═══════════ A3 模板编辑 → 打印生效 ═══════════

  test('A3-模板编辑：头部字号倍高 + footer {shopName} 谢谢惠顾 → 保存 → 设默认', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '小票模板' }).click()
    await waitForRoute(page, '/template-editor')

    // 出厂 lazy seed 两模板：58mm 在前（非默认）、80mm 默认（A1 结账已触发 seed）
    const items = page.getByTestId('tpl-item')
    await expect(items).toHaveCount(2)
    const defaultItem = items.filter({ hasText: '默认小票（80mm）' })
    await expect(defaultItem.locator('.el-tag--success')).toContainText('默认')
    await defaultItem.click() // 显式选中默认 80mm（编辑目标）
    await expect(page.getByTestId('tpl-name')).toHaveValue(/默认小票/)

    // el-select 选项定位：aria-controls 锚点域（每次打开重新锚定）
    const selectOption = async (select: Locator, label: string): Promise<void> => {
      const listboxId = await select.locator('input').getAttribute('aria-controls')
      await select.click()
      const option = page.locator(`#${listboxId} .el-select-dropdown__item`, {
        hasText: label
      })
      await expect(option).toBeVisible()
      await option.first().click()
    }

    // 头部字号：标准 →（预览 class 消失）→ 倍高（预览 class 恢复，真实编辑动作）
    const headerSize = page.getByTestId('tpl-row-header').first().getByTestId('tpl-size')
    await selectOption(headerSize, '标准')
    await expect(
      page.locator('.tpl-preview .receipt-line').first()
    ).not.toHaveClass(/receipt-line--double-height/)
    await selectOption(headerSize, '倍高')
    await expect(
      page.locator('.tpl-preview .receipt-line').first()
    ).toHaveClass(/receipt-line--double-height/)

    // 加 footer 段落 '{shopName} 谢谢惠顾'（编辑器预览用 demo 变量'测试商店'）
    await page.getByTestId('tpl-add-footer').click()
    const footerRows = page.getByTestId('tpl-row-footer')
    await footerRows
      .last()
      .getByTestId('tpl-content')
      .fill('{shopName} 谢谢惠顾')
    await expect(page.getByTestId('receipt-paper')).toContainText('测试商店 谢谢惠顾')

    await page.getByTestId('tpl-save').click()
    await expect(
      page.locator('.el-message--success').filter({ hasText: '已保存' }).first()
    ).toBeVisible()

    // 设为默认（该模板已是默认——radio 已选中；点击幂等，以 DB 为权威断言）
    await page
      .getByTestId('tpl-default')
      .locator('.el-radio', { hasText: '设为默认' })
      .click()

    await page.screenshot({ path: `${EVIDENCE}/a3-template-edited.png` })

    // DB：默认恰一个 + 默认模板 config 含 footer + 头部倍高
    const d = db()
    try {
      const defaults = d
        .prepare('SELECT COUNT(*) AS n FROM print_templates WHERE is_default = 1')
        .get() as { n: number }
      expect(defaults.n).toBe(1)
      const cfg = d
        .prepare('SELECT config_json FROM print_templates WHERE is_default = 1')
        .get() as { config_json: string }
      expect(cfg.config_json).toContain('谢谢惠顾')
      expect(cfg.config_json).toContain('doubleHeight')
    } finally {
      d.close()
    }
    evidenceLog('A3-模板编辑 PASS: 倍高+footer 保存 + DB 恰一默认含新 config')
  })

  test('A3-结账新单 → 预览反映新模板（footer 插值 + 头部倍高）', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')

    await scanBarcode(app.electronApp, P3_BARCODE)
    await expect(page.locator('.cart-row')).toHaveCount(1)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥8.00')
    await page.locator('.cart-panel__checkout').click()

    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()
    const saleNo = (
      await dialog.locator('.el-dialog__title').textContent()
    )!.match(/(\d{8}-\d{4})/)![1]
    saleNos.push(saleNo)

    // 新模板生效：footer 行 '{shopName} 谢谢惠顾' 插值；头部倍高 class
    await expect(dialog).toContainText(`${SHOP} 谢谢惠顾`)
    await expect(
      dialog.locator('.receipt-line--double-height').first()
    ).toBeVisible()

    await page.screenshot({ path: `${EVIDENCE}/a3-new-template-preview.png` })
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()

    expect(readStocks()[P3_NAME]).toBe(13) // 14 - 1
    evidenceLog(`A3-打印生效 PASS: ${saleNo} 预览含新 footer + 倍高头部`)
  })

  // ═══════════ A4 报表导出闭环 ═══════════

  test('A4-日报（含当日数据）→ 三格式导出 → 读回断言闭环', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '报表统计' }).click()
    await waitForRoute(page, '/reports')

    // 当日汇总：A1 23.00 + A3 8.00 = 31.00 / 2 单（A2 voided 剔除）
    const stats = page.locator('[data-testid="daily-stats"] .stat-card__value')
    await expect(stats.nth(0)).toHaveText('31.00')
    await expect(stats.nth(1)).toHaveText('2')

    const exportAs = async (format: 'txt' | 'xlsx' | 'docx'): Promise<void> => {
      await page.locator('[data-testid="daily-export"] button').click()
      const item = page.getByRole('menuitem', { name: `导出 .${format}` })
      await expect(item).toBeVisible()
      await item.click()
      await expect(page.locator('.el-message--success').first()).toContainText('已导出')
      await expect(page.locator('.el-message--success')).toHaveCount(0, { timeout: 6000 })
    }
    await exportAs('txt')
    await exportAs('xlsx')
    await exportAs('docx')

    const txtPath = join(EXPORT_DIR, `日报${TODAY}.txt`)
    const xlsxPath = join(EXPORT_DIR, `日报${TODAY}.xlsx`)
    const docxPath = join(EXPORT_DIR, `日报${TODAY}.docx`)
    expect(existsSync(txtPath), `txt 应存在: ${txtPath}`).toBe(true)
    expect(existsSync(xlsxPath), `xlsx 应存在: ${xlsxPath}`).toBe(true)
    expect(existsSync(docxPath), `docx 应存在: ${docxPath}`).toBe(true)

    // txt 读回：合计 + 两单号 + 作废单不出现
    const txt = readFileSync(txtPath, 'utf8')
    expect(txt).toContain('总销售额: 31.00 元')
    expect(txt).toContain('订单数: 2')
    expect(txt).toContain(saleNos[0]!)
    expect(txt).toContain(saleNos[2]!)
    expect(txt).not.toContain(saleNos[1]!)

    // xlsx 读回：汇总 sheet B2=31.0 / B3=2 / 明细 sheet 3 行（表头+2）
    const wb = new Workbook()
    await wb.xlsx.load(readFileSync(xlsxPath) as unknown as ArrayBuffer)
    const summary = wb.getWorksheet('汇总')
    expect(summary).toBeDefined()
    expect(summary!.getCell('B2').value).toBe(31.0)
    expect(summary!.getCell('B3').value).toBe(2)
    expect(summary!.getCell('B4').value).toBe(TODAY)
    const detail = wb.getWorksheet('明细')
    expect(detail).toBeDefined()
    expect(detail!.actualRowCount).toBe(3)

    // docx 解压：zip 魔数 + word/document.xml 含标题（{period} 销售报表）与合计
    const docxBuf = readFileSync(docxPath)
    expect(docxBuf.subarray(0, 2).toString('latin1')).toBe('PK')
    const zip = await JSZip.loadAsync(docxBuf)
    const docXml = await zip.file('word/document.xml')!.async('string')
    expect(docXml).toContain(`${TODAY} 销售报表`)
    expect(docXml).toContain('31.00')

    // 导出文件副本留证
    for (const p of [txtPath, xlsxPath, docxPath]) {
      writeFileSync(
        join(EVIDENCE, `a4-${p.split('.').pop()}`),
        readFileSync(p)
      )
    }
    await page.screenshot({ path: `${EVIDENCE}/a4-reports-daily.png` })
    evidenceLog('A4-导出闭环 PASS: 31.00/2 单；txt+xlsx(B2=31.0)+docx(标题/合计) 读回一致')
  })

  // ═══════════ A5 打印机失败恢复 ═══════════

  test('A5-失败恢复：tcp_port=1 → 结账打印 → 错误 toast 含「重打」→ 销售记录完好', async () => {
    const { page } = app

    // 设置页把 tcp 端口改为 1（不可达）
    await page.locator('.el-menu-item').filter({ hasText: '系统设置' }).click()
    await waitForRoute(page, '/settings')
    await page.getByTestId('tcp-port-input').fill('1')
    await page.getByTestId('save-print-btn').click()
    await expect(page.locator('.el-message--success').first()).toContainText('打印设置已保存')

    // 结账一单（P3 单件）
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')
    await scanBarcode(app.electronApp, P3_BARCODE)
    await expect(page.locator('.cart-row')).toHaveCount(1)
    await page.locator('.cart-panel__checkout').click()

    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()
    const saleNo = (
      await dialog.locator('.el-dialog__title').textContent()
    )!.match(/(\d{8}-\d{4})/)![1]
    saleNos.push(saleNo)

    const bytesBefore = receivedBytes().length
    await dialog.getByRole('button', { name: '立即打印' }).click()

    // 错误 toast：含通道名 tcp + 重打引导（G3：销售已保存）
    const errorToast = page.locator('.el-message--error').first()
    await expect(errorToast).toBeVisible()
    await expect(errorToast).toContainText('tcp')
    await expect(errorToast).toContainText('重打')
    await page.screenshot({ path: `${EVIDENCE}/a5-print-error-toast.png` })

    // mock 未收到新字节
    expect(receivedBytes().length).toBe(bytesBefore)

    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()

    // 销售记录完好：该单存在且已完成，可重打
    await page.locator('.el-menu-item').filter({ hasText: '销售记录' }).click()
    await waitForRoute(page, '/sales-history')
    const row = page
      .locator('.sales-history__table .el-table__row')
      .filter({ hasText: saleNo })
    await expect(row).toBeVisible()
    await expect(row.locator('.el-tag--primary')).toHaveText('已完成')
    await row.getByRole('button', { name: '重打小票' }).click()
    const reprint = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(reprint).toBeVisible()
    await expect(reprint).toContainText(saleNo)
    await reprint.getByRole('button', { name: '取消' }).click()
    await expect(reprint).toBeHidden()

    const d = db()
    try {
      const sale = d
        .prepare('SELECT status, total_cents FROM sales WHERE sale_no = ?')
        .get(saleNo) as { status: string; total_cents: number }
      expect(sale).toMatchObject({ status: 'completed', total_cents: 800 })
    } finally {
      d.close()
    }
    evidenceLog(`A5-失败恢复 PASS: ${saleNo} 落库不受打印失败影响，重打可用`)
  })
})
