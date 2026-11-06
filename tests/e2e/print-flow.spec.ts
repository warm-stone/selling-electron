/**
 * Task 15 — 打印编排全流程 E2E：结账 → 预览 → 打印（mock TCP）→ 失败恢复 → 重打。
 *
 * 三个核心场景（G3 落库解耦 + G7 预览/打印同源 + D19 作废标记）：
 *  1. settings tcp 127.0.0.1:19910 + mock server：结账 → 预览弹窗（≥8 行含单号/店名）
 *     → 立即打印 → mock 收到字节含 1b40 且以 1d564200（切纸）结尾 + 销售落库
 *  2. tcp_port=1（不可达）→ 结账 → 打印 → error toast 含通道名 + 重打引导
 *     → 销售记录该单存在（已完成）→ 重打 → 预览弹窗正常（落库不受打印影响）
 *  3. voided 单重打 → 预览含「已作废」标记（D19）
 *
 * 扫码注入用 T5 S6 定案方案：electronApp.evaluate 内循环
 * webContents.sendInputEvent({type:'keyDown'}) + Enter（page.keyboard 不触发
 * before-input-event，禁用）。settings 直插 DB（WAL 多连接，主进程下条语句即见）。
 */

import { writeFileSync } from 'node:fs'
import net from 'node:net'
import { test, expect, type ElectronApplication } from '@playwright/test'
import Database from 'better-sqlite3'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

const COLA_BARCODE = '6901234567890'
const WATER_BARCODE = '6903456789012'
const COLA = 'E2E打印可乐 330ml'
const WATER = 'E2E打印矿泉水 550ml'
const SHOP_NAME = 'E2E打印小店'
const MOCK_HOST = '127.0.0.1'
const MOCK_PORT = 19910

/** 扫码枪注入（S6 定案）：主进程 keyDown 连发（10ms < 50ms 连发阈值）+ Enter */
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

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 今日紧凑日期（voided 单 sale_no 前缀，避开自动序列号段） */
function todayCompact(): string {
  const d = new Date()
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
}

test.describe.serial('Task 15：打印编排（结账→预览→打印→失败恢复→重打）', () => {
  let app: LaunchedApp
  let mockServer: net.Server
  const received: Buffer[] = []

  test.beforeAll(async () => {
    app = await launchApp()
    await waitForRoute(app.page, '/pos')

    // seed：商品 + 打印设置（tcp → mock server）+ 店铺信息（预览 vars 数据源）
    const db = new Database(app.dbPath)
    try {
      const insertProduct = db.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
      )
      insertProduct.run(COLA_BARCODE, COLA, 350, 100)
      insertProduct.run(WATER_BARCODE, WATER, 200, 50)
      const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      upsert.run('shop_name', SHOP_NAME)
      upsert.run('shop_phone', '13800001111')
      upsert.run('receipt_note', '谢谢惠顾')
      upsert.run('printer_channel', 'tcp')
      upsert.run('tcp_host', MOCK_HOST)
      upsert.run('tcp_port', String(MOCK_PORT))
    } finally {
      db.close()
    }

    // mock 热敏打印机 TCP server（T7/T19 验证模式）：收 chunk，对端 FIN 后回 FIN
    mockServer = net.createServer((socket) => {
      socket.on('data', (chunk: Buffer) => received.push(chunk))
      socket.on('end', () => socket.end())
    })
    await new Promise<void>((resolve) => mockServer.listen(MOCK_PORT, MOCK_HOST, resolve))
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    await new Promise<void>((resolve) => mockServer.close(() => resolve()))
  })

  const receivedHex = (): string => Buffer.concat(received).toString('hex')

  test('结账 → 预览弹窗（≥8 行含单号/店名）→ 立即打印 → mock 收到 1b40 开头/1d564200 结尾字节', async () => {
    const { page } = app
    received.length = 0

    // 加购两件（两条明细行）：扫码可乐 + 扫码矿泉水
    await scanBarcode(app.electronApp, COLA_BARCODE)
    await scanBarcode(app.electronApp, WATER_BARCODE)
    await expect(page.locator('.cart-row')).toHaveCount(2)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥5.50')

    await page.locator('.cart-panel__checkout').click()

    // 预览弹窗：单号（标题）+ 店名（首行 vars）+ 9 行 receipt-line（G7 同源渲染）
    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.el-dialog__title')).toHaveText(/小票预览 · \d{8}-\d{4}/)
    await expect(dialog).toContainText(SHOP_NAME)
    // 默认模板（80mm）：2 头部 + 1 列头 + 2 明细 + 2 合计 + 2 底部 = 9 ≥ 8
    await expect(dialog.locator('.receipt-line')).toHaveCount(9)

    await page.screenshot({ path: '.omo/evidence/task-15-print-flow.png' })

    await dialog.getByRole('button', { name: '立即打印' }).click()
    await expect(
      page.locator('.el-message--success', { hasText: '打印已发送' })
    ).toBeVisible()

    // mock server 收到字节：含 ESC @（init），以 GS V 66 0（全切）结尾，长度 > 200
    await expect.poll(receivedHex, { timeout: 5_000 }).toContain('1b40')
    expect(receivedHex()).toContain('1b520f') // ESC R 15 中文页
    expect(receivedHex()).toContain('1c26') // FS & 汉字模式（真机修复指令链）
    await expect
      .poll(
        () => (receivedHex().endsWith('1d564200') ? 'cut-ok' : 'pending'),
        { timeout: 5_000 }
      )
      .toBe('cut-ok')
    expect(receivedHex().length / 2).toBeGreaterThan(200)

    // 字节落盘 evidence
    writeFileSync('.omo/evidence/task-15-received-bytes.bin', Buffer.concat(received))

    // 打印与落库解耦基线：销售已完整落库
    const db = new Database(app.dbPath, { readonly: true })
    try {
      const sale = db
        .prepare('SELECT sale_no, total_cents, item_count, status FROM sales')
        .get() as { sale_no: string; total_cents: number; item_count: number; status: string }
      expect(sale).toMatchObject({ total_cents: 550, item_count: 2, status: 'completed' })
      expect(sale.sale_no).toMatch(/^\d{8}-\d{4}$/)
    } finally {
      db.close()
    }

    // 打印成功 → 弹窗自动关闭（收银流程完成）
    await expect(dialog).toBeHidden()
  })

  test('打印失败（tcp_port=1 不可达）→ error toast 含通道名与重打引导；销售记录完好可重打（G3）', async () => {
    const { page } = app

    // 打印设置切到不可达端口（DB 直改；编排器按次实时读取设置）
    const db = new Database(app.dbPath)
    try {
      db.prepare("UPDATE settings SET value = '1' WHERE key = 'tcp_port'").run()
    } finally {
      db.close()
    }

    // 再结账一单（可乐单件）
    await scanBarcode(app.electronApp, COLA_BARCODE)
    await expect(page.locator('.cart-row')).toHaveCount(1)
    await page.locator('.cart-panel__checkout').click()

    const dialog = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(dialog).toBeVisible()

    const bytesBefore = Buffer.concat(received).length
    await dialog.getByRole('button', { name: '立即打印' }).click()

    // 失败 toast：含通道名 + 重打引导（销售已保存——G3 文案）
    const errorToast = page.locator('.el-message--error').first()
    await expect(errorToast).toBeVisible()
    await expect(errorToast).toContainText('tcp')
    await expect(errorToast).toContainText('重打')

    // mock server 未收到任何新字节（不可达端口不触网）
    expect(Buffer.concat(received).length).toBe(bytesBefore)

    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()

    // 销售记录页：该单存在且已完成（打印失败绝不影响销售）
    await page.locator('.el-menu-item').filter({ hasText: '销售记录' }).click()
    await waitForRoute(page, '/sales-history')
    const row = page.locator('.sales-history__table .el-table__row').first()
    await expect(row).toContainText(/\d{8}-\d{4}/)
    await expect(row.locator('.el-tag--primary')).toHaveText('已完成')

    // 重打 → 预览弹窗正常（数据未受打印失败影响）
    await row.getByRole('button', { name: '重打小票' }).click()
    const reprint = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(reprint).toBeVisible()
    await expect(reprint.locator('.receipt-line')).toHaveCount(8) // 可乐单件：8 行
    await expect(reprint).toContainText(SHOP_NAME)

    await page.screenshot({ path: '.omo/evidence/task-15-failure-recovery.png' })

    await reprint.getByRole('button', { name: '取消' }).click()
    await expect(reprint).toBeHidden()
  })

  test('voided 单重打 → 预览含「已作废」标记（D19）', async () => {
    const { page } = app
    const saleNo = `${todayCompact()}-0901`

    // 直插一笔 voided 单（T13 seed 模式：status/voided_at/created_at SQL 直写 + 快照明细）
    const db = new Database(app.dbPath)
    try {
      const saleId = Number(
        db
          .prepare(
            `INSERT INTO sales (sale_no, total_cents, item_count, status, voided_at, created_at)
             VALUES (?, 350, 1, 'voided', datetime('now','localtime'), datetime('now','localtime'))`
          )
          .run(saleNo).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO sale_items
           (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
         VALUES (?, NULL, ?, ?, 1, 350, 350)`
      ).run(saleId, `${COLA}（已断链）`, COLA_BARCODE)
    } finally {
      db.close()
    }

    // sales-history 刷新（SPA 路由离开再回来，避开 file:// 重载竞态）
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')
    await page.locator('.el-menu-item').filter({ hasText: '销售记录' }).click()
    await waitForRoute(page, '/sales-history')

    const voidedRow = page.locator('.sales-history__table .el-table__row').filter({ hasText: saleNo })
    await expect(voidedRow.locator('.el-tag--danger')).toHaveText('已作废')
    await voidedRow.getByRole('button', { name: '重打小票' }).click()

    // 预览：弹窗提示 + 模板 footer 前「=== 已作废 ===」段落（组装期生效——与打印字节同源）
    const preview = page.locator('.el-dialog').filter({ hasText: '小票预览' })
    await expect(preview).toBeVisible()
    await expect(preview).toContainText(saleNo)
    await expect(preview).toContainText('=== 已作废 ===')
    await expect(preview).toContainText(SHOP_NAME)
    await preview.getByRole('button', { name: '取消' }).click()
    await expect(preview).toBeHidden()
  })
})
