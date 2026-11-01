/// <reference lib="dom" />
import { test, expect } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Workbook } from 'exceljs'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/**
 * Task 18 报表 UI + 导出集成全链路 E2E。
 *
 * 预置数据全部 better-sqlite3 直插（WAL 多连接，主进程下条语句即见）：
 * - 3 商品（可乐 350 / 雪碧 300 / 薯片 750）
 * - 今日 2 单 completed：saleA（可乐×2+雪碧×1=1000 分）+ saleB（薯片×1=750 分）→ 合计 1750 分 '17.50'
 * - 今日 1 单 voided（雪碧×2=600 分）→ 汇总与明细均剔除（D3）
 * - 昨日 1 单 completed（可乐×1+雪碧×1=650 分）→ 切日期联动 + 月报分桶
 *
 * 导出链路走 T17 E2E_EXPORT_DIR 钩子（helpers.launchApp 透传 process.env →
 * spec 内先设 process.env['E2E_EXPORT_DIR'] 再 launchApp，主进程跳过 dialog 直写
 * 并返回路径）；文件断言 + exceljs 读回闭环。
 *
 * 月份期望动态推导：昨日与今日可能跨月（月初运行）也可能同月（月中运行），
 * 期望值按 ym(-1) === ym(0) 分支计算，任何日期运行均成立。
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

const TODAY = ymd(0)
const YESTERDAY = ymd(-1)

const SALE_A_NO = `${ymdCompact(0)}-0001` // 今日单 1：completed，可乐×2 + 雪碧×1 = 10.00
const SALE_B_NO = `${ymdCompact(0)}-0002` // 今日单 2：completed，薯片×1 = 7.50
const SALE_V_NO = `${ymdCompact(0)}-0003` // 今日单 3：voided，雪碧×2 = 6.00（汇总剔除）
const SALE_D_NO = `${ymdCompact(-1)}-0001` // 昨日单：completed，可乐×1 + 雪碧×1 = 6.50

// ── 月报期望（F3 修复）：由 seed 单分布动态聚合，与运行日期解耦 ──
//
// 期望不再按「今天是否 1 号」写日历分支（原分支把「上月 shortcut」当成
// 「昨日所在月」——仅 1 号重合，月中运行期望倒置）。唯一真相源是 seed 的
// completed 单落月分布，monthAgg(目标月) 对它聚合；运行日期只决定 seed 单
// 落在哪个月，期望与 UI 实际值恒同源。
//
// 日期稳定性推演（seed completed 单：TODAY×2 [1000+750] + YESTERDAY×1 [650]）：
// - 每月 1 号运行（昨日=上月末日，跨月）：本月 17.50/2单/1桶；上月 6.50/1/1
// - 月中/月末运行（昨日同月）：本月 24.00/3/2；上月（上一日历月，无 seed 单）0.00/0/0
// - 跨年 1-01 运行（昨日=去年 12-31）：上月（setMonth(-1)=去年 12 月）6.50/1/1
//   （setMonth 负数自动跨年进位）
// 任意日期下「UI 实际值」与「期望」都由同一批 seed 单落月决定——不存在分支倒置窗口。

/** seed 的 completed 单分布（金额分；与 seedDatabase 插入的单据一一对应） */
const SEED_COMPLETED: ReadonlyArray<{ day: string; cents: number }> = [
  { day: TODAY, cents: 1000 }, // saleA
  { day: TODAY, cents: 750 }, // saleB
  { day: YESTERDAY, cents: 650 } // saleD
]

function monthOf(day: string): string {
  return day.slice(0, 7)
}

interface MonthExpectation {
  /** 元字符串（'17.50'——与汇总卡显示一致） */
  total: string
  orders: number
  /** 分桶行数（仅含有销售的日） */
  buckets: number
}

function monthAgg(month: string): MonthExpectation {
  const hits = SEED_COMPLETED.filter((s) => monthOf(s.day) === month)
  const totalCents = hits.reduce((sum, s) => sum + s.cents, 0)
  return {
    total: (totalCents / 100).toFixed(2),
    orders: hits.length,
    buckets: new Set(hits.map((s) => s.day)).size
  }
}

/** 「本月」shortcut 目标月（今天所在月） */
const THIS_MONTH = monthOf(TODAY)

/**
 * 「上月」shortcut 目标月——与 ReportsView monthDate(-1) 同算法（setMonth(-1)），
 * 即**上一个日历月**（非「昨日所在月」——两者仅每月 1 号重合）。
 * 月末 31 号的 JS 滚月行为（如 3-31 setMonth(-1) → 3-03 → '2026-03'）两侧
 * 同算法复制，期望恒与 UI 实际选中的月同步。
 */
function prevCalendarMonth(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

const PREV_MONTH = prevCalendarMonth()

/** 导出目录（T17 钩子）：系统临时目录下按次隔离（跨平台——G11：禁硬编码 POSIX 路径，Windows 无 /tmp） */
const EXPORT_DIR = mkdtempSync(join(tmpdir(), 'e2e-exports-'))
const EVIDENCE_DIR = '.omo/evidence'

let app: LaunchedApp

/** 直插 seed：3 商品 + 4 单销售（头 + 快照明细行；created_at 直写绕过默认值） */
function seedDatabase(): void {
  const db = new Database(app.dbPath)
  try {
    const insertProduct = db.prepare(
      'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
    )
    const colaId = Number(
      insertProduct.run('6901234567890', 'E2E 可乐 330ml', 350, 10).lastInsertRowid
    )
    const spriteId = Number(
      insertProduct.run('6902345678901', 'E2E 雪碧 330ml', 300, 8).lastInsertRowid
    )
    insertProduct.run('6903456789012', 'E2E 薯片 75g', 750, 5)

    const insertSale = db.prepare(
      `INSERT INTO sales (sale_no, total_cents, item_count, status, voided_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insertItem = db.prepare(
      `INSERT INTO sale_items
         (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )

    // 今日 saleA：completed，可乐×2(700) + 雪碧×1(300) = 1000 分
    const saleA = Number(
      insertSale.run(SALE_A_NO, 1000, 3, 'completed', null, `${TODAY} 09:15:00`).lastInsertRowid
    )
    insertItem.run(saleA, colaId, 'E2E 可乐 330ml', '6901234567890', 2, 350, 700)
    insertItem.run(saleA, spriteId, 'E2E 雪碧 330ml', '6902345678901', 1, 300, 300)

    // 今日 saleB：completed，薯片×1 = 750 分（合计 1000+750=1750 → '17.50'）
    const saleB = Number(
      insertSale.run(SALE_B_NO, 750, 1, 'completed', null, `${TODAY} 14:30:00`).lastInsertRowid
    )
    insertItem.run(saleB, null, 'E2E 薯片 75g', '6903456789012', 1, 750, 750)

    // 今日 saleV：voided（status + voided_at 直写）——汇总/明细剔除对象
    const saleV = Number(
      insertSale.run(SALE_V_NO, 600, 2, 'voided', `${TODAY} 16:00:00`, `${TODAY} 15:45:00`)
        .lastInsertRowid
    )
    insertItem.run(saleV, spriteId, 'E2E 雪碧 330ml', '6902345678901', 2, 300, 600)

    // 昨日 saleD：completed，可乐×1 + 雪碧×1 = 650 分 → '6.50'（切日期联动 + 月报分桶）
    const saleD = Number(
      insertSale.run(SALE_D_NO, 650, 2, 'completed', null, `${YESTERDAY} 10:40:00`).lastInsertRowid
    )
    insertItem.run(saleD, colaId, 'E2E 可乐 330ml', '6901234567890', 1, 350, 350)
    insertItem.run(saleD, spriteId, 'E2E 雪碧 330ml', '6902345678901', 1, 300, 300)
  } finally {
    db.close()
  }
}

/** 日报汇总卡两个值（销售额 / 订单数） */
function dailyStatValues(page: LaunchedApp['page']) {
  return page.locator('[data-testid="daily-stats"] .stat-card__value')
}

function dailyRows(page: LaunchedApp['page']) {
  return page.locator('[data-testid="daily-table"] .el-table__row')
}

function monthlyStatValues(page: LaunchedApp['page']) {
  return page.locator('[data-testid="monthly-stats"] .stat-card__value')
}

function monthlyRows(page: LaunchedApp['page']) {
  return page.locator('[data-testid="monthly-table"] .el-table__row')
}

/** 点开日报导出 dropdown 并点指定格式菜单项（唯一会打开的 dropdown——无残留歧义） */
async function exportDailyAs(page: LaunchedApp['page'], format: 'txt' | 'xlsx' | 'docx'): Promise<void> {
  await page.locator('[data-testid="daily-export"] button').click()
  // getByRole 只命中 a11y 树内菜单项：月报 menu 常驻 DOM 但 display:none 不进 a11y 树（T13 同族坑规避）
  const item = page.getByRole('menuitem', { name: `导出 .${format}` })
  await expect(item).toBeVisible()
  await item.click()
  // 成功 toast：'已导出：日报{date}.{ext}'
  await expect(page.locator('.el-message--success')).toContainText('已导出')
  // 等待 toast 退场（3s 自动关闭）——避免下一次导出的 toast 叠加 strict 冲突
  await expect(page.locator('.el-message--success')).toHaveCount(0, { timeout: 6000 })
}

test.describe.serial('Task 18：报表查看与导出', () => {
  test.beforeAll(async () => {
    // T17 钩子：launchApp 的 env 透传 process.env → 先设变量再启动
    process.env['E2E_EXPORT_DIR'] = EXPORT_DIR
    app = await launchApp()
    seedDatabase()
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    delete process.env['E2E_EXPORT_DIR']
  })

  test('日报 tab 默认今天：汇总 17.50 / 订单数 2（voided 剔除）+ 明细 2 行', async () => {
    const { page } = app
    await page.locator('.el-menu-item').filter({ hasText: '报表统计' }).click()
    await waitForRoute(page, '/reports')
    await expect(page.locator('.reports__title')).toHaveText('报表统计')

    const stats = dailyStatValues(page)
    await expect(stats.nth(0)).toHaveText('17.50')
    await expect(stats.nth(1)).toHaveText('2')

    // 明细仅 completed 2 行（repo 同 WHERE——voided 不进明细）；金额/单号与 seed 一致
    const rows = dailyRows(page)
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: SALE_A_NO })).toBeVisible()
    await expect(rows.filter({ hasText: SALE_B_NO })).toBeVisible()
    await expect(rows.filter({ hasText: SALE_V_NO })).toHaveCount(0)
    const rowA = rows.filter({ hasText: SALE_A_NO }).locator('td')
    await expect(rowA.nth(2)).toHaveText('3')
    await expect(rowA.nth(3)).toHaveText('10.00')
    const rowB = rows.filter({ hasText: SALE_B_NO }).locator('td')
    await expect(rowB.nth(3)).toHaveText('7.50')
    // 状态 tag 全部「已完成」
    await expect(rows.locator('.el-tag')).toHaveCount(2)
    await expect(rows.locator('.el-tag').first()).toHaveText('已完成')
  })

  test('切日期联动：昨天快捷 → 汇总 6.50 / 订单数 1 / 明细 1 行', async () => {
    const { page } = app
    await page.locator('.reports__date-picker--daily').click()
    const shortcut = page.locator('.el-picker-panel__shortcut').filter({ hasText: '昨天' })
    await expect(shortcut).toBeVisible()
    await shortcut.click()

    const stats = dailyStatValues(page)
    await expect(stats.nth(0)).toHaveText('6.50')
    await expect(stats.nth(1)).toHaveText('1')
    await expect(dailyRows(page)).toHaveCount(1)
    await expect(dailyRows(page).first()).toContainText(SALE_D_NO)
  })

  test('切回今天 → 三格式导出：txt/xlsx/docx 落盘 + toast 已导出', async () => {
    const { page } = app
    await page.locator('.reports__date-picker--daily').click()
    const shortcut = page.locator('.el-picker-panel__shortcut').filter({ hasText: '今天' })
    await expect(shortcut).toBeVisible()
    await shortcut.click()
    await expect(dailyStatValues(page).nth(0)).toHaveText('17.50')

    await exportDailyAs(page, 'txt')
    await exportDailyAs(page, 'xlsx')
    await exportDailyAs(page, 'docx')

    // 三文件存在（T17 默认文件名：{日报}{period}.{ext}）
    const txtPath = join(EXPORT_DIR, `日报${TODAY}.txt`)
    const xlsxPath = join(EXPORT_DIR, `日报${TODAY}.xlsx`)
    const docxPath = join(EXPORT_DIR, `日报${TODAY}.docx`)
    expect(existsSync(txtPath)).toBe(true)
    expect(existsSync(xlsxPath)).toBe(true)
    expect(existsSync(docxPath)).toBe(true)
  })

  test('xlsx 读回：汇总 sheet 总销售额 17.50 / 订单数 2 / 明细 sheet 2 行', async () => {
    const xlsxPath = join(EXPORT_DIR, `日报${TODAY}.xlsx`)
    const wb = new Workbook()
    // Node Buffer 非 ArrayBuffer 子类型——契约层 cast（T17 learnings）
    await wb.xlsx.load(readFileSync(xlsxPath) as unknown as ArrayBuffer)

    const summary = wb.getWorksheet('汇总')
    expect(summary).toBeDefined()
    expect(summary!.getCell('B2').value).toBe(17.5) // 1750 分 → 17.50 元（数值 + numFmt）
    expect(summary!.getCell('B3').value).toBe(2)
    expect(summary!.getCell('B4').value).toBe(TODAY)

    const detail = wb.getWorksheet('明细')
    expect(detail).toBeDefined()
    expect(detail!.actualRowCount).toBe(3) // 表头 + 2 行 completed
  })

  test('txt 读回：含 17.50 合计行与明细单号（UTF-8 BOM 容忍）', async () => {
    const txt = readFileSync(join(EXPORT_DIR, `日报${TODAY}.txt`), 'utf8')
    expect(txt).toContain('总销售额: 17.50 元')
    expect(txt).toContain('订单数: 2')
    expect(txt).toContain(SALE_A_NO)
    expect(txt).toContain(SALE_B_NO)
    expect(txt).not.toContain(SALE_V_NO) // voided 不进导出
  })

  test('docx 读回：zip 存在且非空（结构断言留给 T17 round-trip 单测）', async () => {
    const docx = readFileSync(join(EXPORT_DIR, `日报${TODAY}.docx`))
    expect(docx.length).toBeGreaterThan(1000)
    expect(docx.subarray(0, 2).toString('latin1')).toBe('PK') // zip 魔数
  })

  test('月报 tab：当月汇总 + 按日分桶行正确', async () => {
    const { page } = app
    await page.getByRole('tab', { name: '月报' }).click()

    const expectThis = monthAgg(THIS_MONTH)
    const stats = monthlyStatValues(page)
    await expect(stats.nth(0)).toHaveText(expectThis.total)
    await expect(stats.nth(1)).toHaveText(String(expectThis.orders))

    // 分桶：仅含有销售的日（今日桶必有；昨日桶仅当昨日同月时可见）
    const rows = monthlyRows(page)
    await expect(rows).toHaveCount(expectThis.buckets)
    const todayRow = rows.filter({ hasText: TODAY })
    await expect(todayRow).toBeVisible()
    await expect(todayRow.locator('td').nth(1)).toHaveText('17.50')
    await expect(todayRow.locator('td').nth(2)).toHaveText('2')
    if (monthOf(YESTERDAY) === THIS_MONTH) {
      const yesterdayRow = rows.filter({ hasText: YESTERDAY })
      await expect(yesterdayRow.locator('td').nth(1)).toHaveText('6.50')
      await expect(yesterdayRow.locator('td').nth(2)).toHaveText('1')
    }

    // 月报导出按钮组存在且可用（月报三格式与日报同一 T17 链路，不在本 spec 重复点开
    // ——避免第二个 dropdown 实例的 popper 残留造成菜单项定位歧义）
    await expect(page.locator('[data-testid="monthly-export"] button')).toBeEnabled()
  })

  test('月报切月联动：上月快捷 → 上月期望（seed 分布推导，任意运行日期稳定）', async () => {
    const { page } = app
    await page.locator('.reports__date-picker--monthly').click()
    const shortcut = page.locator('.el-picker-panel__shortcut').filter({ hasText: '上月' })
    await expect(shortcut).toBeVisible()
    await shortcut.click()

    const expectPrev = monthAgg(PREV_MONTH)
    const stats = monthlyStatValues(page)
    await expect(stats.nth(0)).toHaveText(expectPrev.total)
    await expect(stats.nth(1)).toHaveText(String(expectPrev.orders))
    await expect(monthlyRows(page)).toHaveCount(expectPrev.buckets)

    // 月中/月末运行时上月无 seed 单（空月 0.00/0/0）——空态表格文案顺带锁定
    if (expectPrev.buckets === 0) {
      const empty = page.locator('[data-testid="monthly-table"] .el-empty')
      await expect(empty).toBeVisible()
      await expect(empty).toContainText('当月无销售')
    }
  })

  test('空数据日（2030-01-01）：汇总 0.00/0 + el-empty + 导出按钮仍可用', async () => {
    const { page } = app
    // 回日报 tab 并切到无数据的远期日期
    await page.getByRole('tab', { name: '日报' }).click()
    const dateInput = page.locator('.reports__date-picker--daily input')
    await dateInput.click()
    await dateInput.fill('2030-01-01')
    await dateInput.press('Enter')

    const stats = dailyStatValues(page)
    await expect(stats.nth(0)).toHaveText('0.00')
    await expect(stats.nth(1)).toHaveText('0')

    // 表格空态：el-empty '当日无销售'
    const empty = page.locator('[data-testid="daily-table"] .el-empty')
    await expect(empty).toBeVisible()
    await expect(empty).toContainText('当日无销售')

    // 导出按钮空数据日仍可用（导出含 0 值的空表）
    const exportBtn = page.locator('[data-testid="daily-export"] button')
    await expect(exportBtn).toBeEnabled()

    await exportBtn.click()
    const txtItem = page.getByRole('menuitem', { name: '导出 .txt' })
    await expect(txtItem).toBeVisible()
    await txtItem.click()
    await expect(page.locator('.el-message--success')).toContainText('已导出')
    await expect(page.locator('.el-message--success')).toHaveCount(0, { timeout: 6000 })

    // 空数据导出文件：存在 + 含 0.00 合计行
    const emptyTxtPath = join(EXPORT_DIR, '日报2030-01-01.txt')
    expect(existsSync(emptyTxtPath)).toBe(true)
    const txt = readFileSync(emptyTxtPath, 'utf8')
    expect(txt).toContain('总销售额: 0.00 元')
    expect(txt).toContain('订单数: 0')
    expect(txt).toContain('（无销售记录）')

    // 证据：空数据日截图
    await page.screenshot({ path: `${EVIDENCE_DIR}/task-18-empty-day.png`, fullPage: true })
  })

  test('证据落盘：日报数据态截图 + 导出文件副本', async () => {
    const { page } = app
    // 切回今天的数据态留证
    await page.locator('.reports__date-picker--daily').click()
    const shortcut = page.locator('.el-picker-panel__shortcut').filter({ hasText: '今天' })
    await expect(shortcut).toBeVisible()
    await shortcut.click()
    await expect(dailyStatValues(page).nth(0)).toHaveText('17.50')

    await page.screenshot({ path: `${EVIDENCE_DIR}/task-18-reports-e2e.png`, fullPage: true })

    // 月报分桶证据（附加；上月测试后 activeMonth 仍在上月——先切回本月）
    await page.getByRole('tab', { name: '月报' }).click()
    await page.locator('.reports__date-picker--monthly').click()
    const thisMonth = page.locator('.el-picker-panel__shortcut').filter({ hasText: '本月' })
    await expect(thisMonth).toBeVisible()
    await thisMonth.click()
    await expect(monthlyStatValues(page).nth(0)).toHaveText(monthAgg(THIS_MONTH).total)
    await page.screenshot({ path: `${EVIDENCE_DIR}/task-18-reports-monthly.png`, fullPage: true })

    // 导出文件副本（4 个：日报三格式 + 空数据日 txt）
    copyFileSync(join(EXPORT_DIR, `日报${TODAY}.txt`), `${EVIDENCE_DIR}/task-18-daily.txt`)
    copyFileSync(join(EXPORT_DIR, `日报${TODAY}.xlsx`), `${EVIDENCE_DIR}/task-18-daily.xlsx`)
    copyFileSync(join(EXPORT_DIR, `日报${TODAY}.docx`), `${EVIDENCE_DIR}/task-18-daily.docx`)
    copyFileSync(join(EXPORT_DIR, '日报2030-01-01.txt'), `${EVIDENCE_DIR}/task-18-empty-day.txt`)

    // 文字化证据：导出闭环摘要
    const expectThis = monthAgg(THIS_MONTH)
    const expectPrev = monthAgg(PREV_MONTH)
    writeFileSync(
      `${EVIDENCE_DIR}/task-18-export-summary.txt`,
      [
        'Task 18 报表导出闭环（E2E_EXPORT_DIR 钩子直写，exceljs/zip 读回断言全通过）',
        `导出目录: ${EXPORT_DIR}`,
        `日报（${TODAY}）: 日报${TODAY}.txt / .xlsx / .docx —— 汇总 17.50 元 / 2 单（voided 600 分剔除）`,
        `  xlsx 汇总!B2 = 17.5（数值+numFmt 0.00）；明细 sheet 2 行`,
        `  txt 含「总销售额: 17.50 元」；docx PK zip 魔数`,
        `空数据日（2030-01-01）: 日报2030-01-01.txt —— 含「总销售额: 0.00 元」「（无销售记录）」`,
        `月报（${THIS_MONTH}）: 汇总 ${expectThis.total} 元 / ${expectThis.orders} 单 / ${expectThis.buckets} 桶`,
        `上月（${PREV_MONTH}）联动: ${expectPrev.total} 元 / ${expectPrev.orders} 单 / ${expectPrev.buckets} 桶`,
        `（期望由 seed 单落月分布动态推导——任意运行日期稳定，F3 修复）`
      ].join('\n')
    )
  })
})
