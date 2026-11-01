import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/**
 * Task 13 销售记录查询全链路 E2E。
 *
 * 预置数据全部 better-sqlite3 直插（绕过 UI，WAL 多连接主进程立即可见）：
 * - 2 商品（可乐 stock=10 / 雪碧 stock=8，直插即基线库存 S）
 * - 昨日 2 单 completed（sale1 可乐×2+雪碧×1；sale2 可乐×1 → 作废目标）
 * - 今日 1 单 voided（sale3 雪碧×2，status/voided_at/created_at 全 SQL 直写）
 *
 * 日期边界（T10 repo 语义）：date(created_at) >= from AND <= to——两端 inclusive，
 * created_at 为 localtime 'YYYY-MM-DD HH:MM:SS'；筛选传 'YYYY-MM-DD'。
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 测试机本地日期 'YYYY-MM-DD'（offsetDays 负数回退，与主进程 localtime 同钟） */
function ymd(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** yyyyMMdd 紧凑形态（sale_no 日期前缀——D18） */
function ymdCompact(offsetDays: number): string {
  return ymd(offsetDays).replaceAll('-', '')
}

const YESTERDAY = ymd(-1)
const TODAY = ymd(0)
const SALE1_NO = `${ymdCompact(-1)}-0001` // 昨日第一单：completed，可乐×2 + 雪碧×1
const SALE2_NO = `${ymdCompact(-1)}-0002` // 昨日第二单：completed，可乐×1（作废目标）
const SALE3_NO = `${ymdCompact(0)}-0001` // 今日单：voided，雪碧×2

interface StockRow {
  id: number
  stock: number
}

interface MovementRow {
  product_id: number
  change_qty: number
  before_stock: number
  after_stock: number
  source: string
  source_id: number
}

let app: LaunchedApp
let colaId = 0
let spriteId = 0
let sale2Id = 0

/** 直插 seed：商品 + 3 单销售（头 + 快照明细行） */
function seedDatabase(): void {
  const db = new Database(app.dbPath)
  try {
    const insertProduct = db.prepare(
      'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
    )
    colaId = Number(
      insertProduct.run('6901234567890', 'E2E 可乐 330ml', 350, 10).lastInsertRowid
    )
    spriteId = Number(
      insertProduct.run('6902345678901', 'E2E 雪碧 330ml', 300, 8).lastInsertRowid
    )

    const insertSale = db.prepare(
      `INSERT INTO sales (sale_no, total_cents, item_count, status, voided_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insertItem = db.prepare(
      `INSERT INTO sale_items
         (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )

    // 昨日 2 单 completed（created_at 直写昨日，绕过 datetime('now') 默认值）
    const sale1Id = Number(
      insertSale.run(SALE1_NO, 1000, 3, 'completed', null, `${YESTERDAY} 09:15:00`)
        .lastInsertRowid
    )
    insertItem.run(sale1Id, colaId, 'E2E 可乐 330ml', '6901234567890', 2, 350, 700)
    insertItem.run(sale1Id, spriteId, 'E2E 雪碧 330ml', '6902345678901', 1, 300, 300)

    sale2Id = Number(
      insertSale.run(SALE2_NO, 350, 1, 'completed', null, `${YESTERDAY} 10:40:00`)
        .lastInsertRowid
    )
    insertItem.run(sale2Id, colaId, 'E2E 可乐 330ml', '6901234567890', 1, 350, 350)

    // 今日 1 单 voided（status + voided_at 直写）
    const sale3Id = Number(
      insertSale.run(SALE3_NO, 600, 2, 'voided', `${TODAY} 11:00:00`, `${TODAY} 10:30:00`)
        .lastInsertRowid
    )
    insertItem.run(sale3Id, spriteId, 'E2E 雪碧 330ml', '6902345678901', 2, 300, 600)
  } finally {
    db.close()
  }
}

function readStocks(): { cola: number; sprite: number } {
  const db = new Database(app.dbPath)
  try {
    const rows = db
      .prepare('SELECT id, stock FROM products ORDER BY id')
      .all() as StockRow[]
    const byId = new Map(rows.map((r) => [r.id, r.stock]))
    return { cola: byId.get(colaId) ?? -1, sprite: byId.get(spriteId) ?? -1 }
  } finally {
    db.close()
  }
}

function readVoidMovements(): MovementRow[] {
  const db = new Database(app.dbPath)
  try {
    return db
      .prepare(
        `SELECT product_id, change_qty, before_stock, after_stock, source, source_id
           FROM stock_movements WHERE source = 'void' ORDER BY id`
      )
      .all() as MovementRow[]
  } finally {
    db.close()
  }
}

function mainTableRows(page: LaunchedApp['page']) {
  return page.locator('.sales-history__table .el-table__row')
}

test.describe.serial('Task 13：销售记录查询与作废', () => {
  test.beforeAll(async () => {
    app = await launchApp()
    seedDatabase()
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  test('默认日期范围=今天：仅今日 voided 单可见（danger tag）', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '销售记录' }).click()
    await waitForRoute(page, '/sales-history')
    await expect(page.locator('.sales-history__title')).toHaveText('销售记录')

    const rows = mainTableRows(page)
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(SALE3_NO)
    await expect(rows.first().locator('.el-tag--danger')).toHaveText('已作废')
  })

  test('日期范围含昨日（最近 7 天快捷）→ 3 行', async () => {
    const { page } = app
    // 打开 daterange 面板 → 点「最近 7 天」shortcut（含昨日与今日，零日历交互）
    await page.locator('.sales-history__date-range').click()
    const shortcut = page
      .locator('.el-picker-panel__shortcut')
      .filter({ hasText: '最近 7 天' })
    await expect(shortcut).toBeVisible()
    await shortcut.click()

    await expect(mainTableRows(page)).toHaveCount(3)
  })

  test('状态筛选：已完成 2 行 / 已作废 1 行 / 全部 3 行', async () => {
    const { page } = app
    const rows = mainTableRows(page)

    await page.locator('.el-radio').filter({ hasText: '已完成' }).click()
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: SALE1_NO })).toBeVisible()
    await expect(rows.filter({ hasText: SALE2_NO })).toBeVisible()
    await expect(rows.filter({ hasText: SALE3_NO })).toHaveCount(0)

    await page.locator('.el-radio').filter({ hasText: '已作废' }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(SALE3_NO)
    await expect(rows.first().locator('.el-tag--danger')).toHaveText('已作废')

    await page.locator('.el-radio').filter({ hasText: '全部' }).click()
    await expect(rows).toHaveCount(3)
  })

  test('双击行打开明细：头信息 + 快照行（名/条码/数量/单价/小计）与 seed 一致', async () => {
    const { page } = app
    const row = mainTableRows(page).filter({ hasText: SALE1_NO })
    // 双击第一列（单号格，无交互元素）——避开行内按钮
    await row.locator('td').first().dblclick()

    const detail = page.locator('.el-dialog').filter({ hasText: '销售明细' })
    await expect(detail).toBeVisible()
    // 销售头：单号 / 时间 / 合计（1000 分 → 10.00 元）
    await expect(detail).toContainText(SALE1_NO)
    await expect(detail).toContainText(`${YESTERDAY} 09:15:00`)
    await expect(detail.locator('.sales-history__detail-meta')).toContainText('10.00')

    // 行表格（快照列）：可乐×2 @3.50=7.00；雪碧×1 @3.00=3.00
    const itemRows = detail.locator('.el-table__row')
    await expect(itemRows).toHaveCount(2)
    const colaCells = itemRows.first().locator('td')
    await expect(colaCells.nth(0)).toContainText('E2E 可乐 330ml')
    await expect(colaCells.nth(1)).toContainText('6901234567890')
    await expect(colaCells.nth(2)).toHaveText('2')
    await expect(colaCells.nth(3)).toHaveText('3.50')
    await expect(colaCells.nth(4)).toHaveText('7.00')
    const spriteCells = itemRows.nth(1).locator('td')
    await expect(spriteCells.nth(0)).toContainText('E2E 雪碧 330ml')
    await expect(spriteCells.nth(1)).toContainText('6902345678901')
    await expect(spriteCells.nth(2)).toHaveText('1')
    await expect(spriteCells.nth(3)).toHaveText('3.00')
    await expect(spriteCells.nth(4)).toHaveText('3.00')

    await detail.locator('.el-dialog__close').click()
    await expect(detail).toBeHidden()
  })

  test('操作按钮打开明细：voided 单加印「该单已作废」提示', async () => {
    const { page } = app
    const row = mainTableRows(page).filter({ hasText: SALE3_NO })
    await row.getByRole('button', { name: '查看明细' }).click()

    const detail = page.locator('.el-dialog').filter({ hasText: '销售明细' })
    await expect(detail).toBeVisible()
    await expect(detail.locator('.el-alert--warning')).toBeVisible()
    await expect(detail).toContainText('该单已作废')
    // voided 单快照明细仍在（雪碧×2）
    await expect(detail.locator('.el-table__row')).toHaveCount(1)
    await expect(detail.locator('.el-table__row').first()).toContainText('E2E 雪碧 330ml')

    await detail.locator('.el-dialog__close').click()
    await expect(detail).toBeHidden()
  })

  test('作废流程：确认弹窗（库存将回滚）→ tag 变化 → DB 库存 +qty → 再点作废 disabled', async () => {
    const { page } = app
    const row = mainTableRows(page).filter({ hasText: SALE2_NO })

    // 作废前基线（可乐 S=10；sale2 可乐 qty Q=1 → 期望作废后 11）
    const before = readStocks()
    expect(before.cola).toBe(10)
    expect(before.sprite).toBe(8)

    await row.getByRole('button', { name: '作废', exact: true }).click()

    // 确认弹窗：明示库存回滚（作废不得无确认直接执行）
    const box = page.locator('.el-message-box')
    await expect(box).toBeVisible()
    await expect(box).toContainText(SALE2_NO)
    await expect(box).toContainText('库存将回滚')

    await page.getByRole('button', { name: '确认作废' }).click()
    await expect(page.locator('.el-message--success')).toContainText('已作废')

    // 列表刷新后 tag 变化（completed → danger '已作废'）
    await expect(row.locator('.el-tag--danger')).toHaveText('已作废')

    // DB 权威断言：可乐库存 +1（10→11），雪碧不变；void 流水审计行正确
    const after = readStocks()
    expect(after.cola).toBe(11)
    expect(after.sprite).toBe(8)
    const movements = readVoidMovements()
    expect(movements).toEqual([
      {
        product_id: colaId,
        change_qty: 1,
        before_stock: 10,
        after_stock: 11,
        source: 'void',
        source_id: sale2Id
      }
    ])

    // 幂等保护：已作废单的作废按钮 disabled
    await expect(row.getByRole('button', { name: '作废', exact: true })).toBeDisabled()

    // 证据：作废后列表（2 个 danger tag：今日单 + 刚作废的昨日单）
    await expect(mainTableRows(page).locator('.el-tag--danger')).toHaveCount(2)
    await page.screenshot({
      path: '.omo/evidence/task-13-void-flow.png',
      fullPage: true
    })

    // 证据：DB 断言 dump
    const db = new Database(app.dbPath)
    try {
      const sale2 = db
        .prepare('SELECT sale_no, status, voided_at FROM sales WHERE id = ?')
        .get(sale2Id) as { sale_no: string; status: string; voided_at: string }
      writeFileSync(
        '.omo/evidence/task-13-void-db.txt',
        [
          'Task 13 作废回滚 DB 断言（E2E 直读隔离 userData/pos.db）',
          `作废目标: ${SALE2_NO} (id=${sale2Id}, 可乐 ×1)`,
          '',
          `[sales] status=${sale2.status} voided_at=${sale2.voided_at}（期望 voided + 非空时间）`,
          `[products] 作废前 stock: 可乐=${before.cola} 雪碧=${before.sprite}`,
          `[products] 作废后 stock: 可乐=${after.cola} 雪碧=${after.sprite}（期望 +1 / 不变）`,
          '[stock_movements] source=void:',
          JSON.stringify(movements, null, 2),
          '',
          `断言结果: 全部通过（${sale2.status === 'voided' && after.cola === before.cola + 1 ? 'PASS' : 'FAIL'}）`
        ].join('\n')
      )
    } finally {
      db.close()
    }
  })

  test('重打小票占位：voided 单按钮可用，点击出「打印功能集成中」不报错', async () => {
    const { page } = app
    // D19：voided 单重打按钮保留可用
    const voidedRow = mainTableRows(page).filter({ hasText: SALE3_NO })
    const voidedReprint = voidedRow.getByRole('button', { name: '重打小票' })
    await expect(voidedReprint).toBeEnabled()

    // 点击不报错（printing:preview 未实装 → 占位 toast；T15 接管后自然升级）
    await voidedReprint.click()
    await expect(page.locator('.el-message--info')).toContainText('打印功能集成中')

    // completed 单按钮同样可用（仅断言 enabled，避免双 toast 叠加的 strict 冲突）
    const completedRow = mainTableRows(page).filter({ hasText: SALE1_NO })
    await expect(completedRow.getByRole('button', { name: '重打小票' })).toBeEnabled()
  })

  test('分页 20/页 + 明细弹窗截图留证', async () => {
    const { page } = app
    await expect(page.locator('.el-pagination')).toBeVisible()
    await expect(page.locator('.el-pagination__total')).toContainText('共 3 条')
    expect(page.locator('.el-pagination .el-pager li.number')).toHaveCount(1)

    // 双击昨日第一单打开明细 → 截图（列表 + 筛选 + 明细弹窗同框）
    const row = mainTableRows(page).filter({ hasText: SALE1_NO })
    await row.locator('td').first().dblclick()
    const detail = page.locator('.el-dialog').filter({ hasText: '销售明细' })
    await expect(detail).toBeVisible()

    await page.screenshot({
      path: '.omo/evidence/task-13-history-e2e.png',
      fullPage: true
    })
  })
})
