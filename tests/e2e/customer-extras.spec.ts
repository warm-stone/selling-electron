/// <reference lib="dom" />
/**
 * 计划任务 14 — 客户与附加信息 E2E（customer-order-extras 收口）。
 *
 * 9 组场景（serial 共享一个 Electron 实例——照 pos.spec / sn-products.spec
 * 的组织模式：beforeAll launchApp + seed 直插，afterAll closeApp）：
 *  1 散客快单：加购 → 结账弹窗零填写直接确认 → 落库 + DB 直读断言
 *    sale_extras 0 行、customers 0 行（快单零追加）
 *  2 新客建档：结账填 张三/13800138000/北京路 1 号 + 国补/订单备注/销售人员
 *    → DB 断言 customers 1 行 + sale_extras.customer_id 关联 + 各字段按填写落库
 *  3 同电话关联：二次结账同电话 13800138000 → DB 断言 customers 仍 1 行、
 *    两单 extras 同一 customer_id（find-or-create 命中不重建）
 *  4 必填校验×2：填姓名不填电话 → 确认阻断（表单红字）+ 弹窗不关；勾国补
 *    不填姓名 → 阻断；DB 断言两轮阻断零落库
 *  5 预填：已有客户电话 13800138000 失焦 → 姓名自动带出「张三」+
 *    「已关联客户」提示可见；取消零落库
 *  6 salesperson 记忆：结账填销售人员「张三」→ 第二次打开结账弹窗 →
 *    下拉选项含「张三」（settings recent_salespersons 队列 DB 直读断言）
 *  7 订单侧改附加：销售记录双击单据 → 明细弹窗编辑区改国补/订单备注/
 *    换绑客户（新电话 13900139000）→ 保存 → detail 展示区刷新正确 +
 *    DB 断言 find-or-create 建档
 *  8 客户管理：/customers 新增（李四/13900139000 → 冲突改号重交）→ 列表
 *    出现 → 编辑改名 → 搜索 → 电话冲突 ElMessage（再建同号）
 *  9 日报导出三格式：勾国补结账后日报导出 txt/xlsx/docx → 读回断言新列
 *    （是否国补/订单备注）与国补小计（照 reports.spec 的 E2E_EXPORT_DIR
 *    读回模式：xlsx 汇总!B2/B5 + jszip 解 docx document.xml）
 *
 * 扫码注入与 pos.spec 同方案：electronApp.evaluate 内循环
 * webContents.sendInputEvent({type:'keyDown'})+Enter（真实事件管线）。
 *
 * 数据用具体值；DB 断言全程 better-sqlite3 只读直读 E2E_USER_DATA_DIR 下
 * pos.db（WAL 多连接，主进程下条语句即见——既有惯例）。
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import JSZip from 'jszip'
import { Workbook } from 'exceljs'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

// ── 测试数据（具体值）──

const COLA_BARCODE = '6915550000001'
const COLA = '附加测试可乐 330ml'
const PRICE_CENTS = 350 // ¥3.50

const CUST_NAME = '张三'
const CUST_PHONE = '13800138000'
const CUST_ADDRESS = '北京路 1 号'
const CUST_NOTE = 'VIP 客户'
const SALESPERSON_WANG = '王五' // 场景 2 结账销售人员
const SALESPERSON_ZHANG = '张三' // 场景 6 结账销售人员
const ORDER_NOTE_2 = '老客送货' // 场景 2 订单备注
const NEW_PHONE = '13900139000' // 场景 7 换绑新电话（find-or-create 建档）
const LISI_PHONE = '13900139001' // 场景 8 李四（13900139000 已被场景 7 占用 → 改号重交）
const SUBSIDY_NOTE_9 = '国补订单留档' // 场景 9 国补单订单备注

const EVIDENCE_DIR = '.omo/evidence'

/** 导出目录（T17 钩子）：launchApp 透传 process.env → beforeAll 先设再启动 */
const EXPORT_DIR = mkdtempSync(join(tmpdir(), 'e2e-extras-exports-'))

/** 测试机本地日期 'YYYY-MM-DD'（导出文件名与主进程 localtime 同口径） */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function ymd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
const TODAY = ymd()

// ── DB 行类型（node 直读断言）──

interface SaleRow {
  id: number
  sale_no: string
  total_cents: number
  item_count: number
  status: string
}
interface ExtraRow {
  sale_id: number
  customer_id: number | null
  is_national_subsidy: number
  order_note: string | null
  salesperson: string | null
}
interface CustomerRow {
  id: number
  name: string
  phone: string
  address: string
  note: string
}

/** 只读直读 DB（WAL 多连接——主进程写入即见；用后即关照既有惯例） */
function withDb<T>(app: LaunchedApp, fn: (db: Database.Database) => T): T {
  const db = new Database(app.dbPath, { readonly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

// ── UI helper（既有 spec 同源模式）──

/** 扫码枪注入：主进程 keyDown 连发（10ms 间隔 < 50ms 连发阈值）+ Enter */
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

function cartRow(page: Page, name: string): Locator {
  return page.locator('.cart-row').filter({ hasText: name })
}

/** 结账弹窗（合计金额条为本弹窗独有文案——与销售明细/小票预览互斥） */
function checkoutDialog(page: Page): Locator {
  return page.locator('.el-dialog').filter({ hasText: '合计金额' })
}

/** 侧栏菜单导航（SPA 路由切换 = 等价刷新，规避 file:// 重载竞态） */
async function gotoMenu(page: Page, label: string, route: string): Promise<void> {
  await page.locator('.el-menu-item').filter({ hasText: label }).click()
  await waitForRoute(page, route)
}

/** 扫码加购一条可乐 → 购物车 1 行 ¥3.50 */
async function addCola(app: LaunchedApp): Promise<void> {
  await scanBarcode(app.electronApp, COLA_BARCODE)
  await expect(cartRow(app.page, COLA)).toHaveCount(1)
  await expect(cartRow(app.page, COLA).locator('.cart-row__qty input')).toHaveValue('1')
  await expect(app.page.locator('.cart-panel__total-value')).toHaveText('¥3.50')
}

/** 结账确认 → 等小票预览 → 取消关闭（结账成功链路：关弹窗→清车→预览） */
async function confirmCheckoutAndWaitPreviewClose(page: Page): Promise<void> {
  await page.getByTestId('checkout-dialog-confirm').click()
  const preview = page.locator('.el-dialog').filter({ hasText: '小票预览' })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: '取消' }).click()
  await expect(preview).toBeHidden()
}

/**
 * el-select（filterable + allow-create）录入自定义值：点开 → 填过滤输入 →
 * 点创建选项（allow-create 生成项与输入文本同标签——aria-controls 圈定
 * 本 select 的下拉域，照 template-editor.spec 终极方案，零 popper 残留歧义）
 */
async function typeIntoSelect(page: Page, select: Locator, text: string): Promise<void> {
  const listboxId = await select.locator('input').getAttribute('aria-controls')
  expect(listboxId).toBeTruthy()
  await select.click()
  const input = select.locator('input')
  await input.fill(text)
  const option = page.locator(`#${listboxId} .el-select-dropdown__item`, { hasText: text })
  await expect(option).toBeVisible()
  await option.click()
}

/** 点开 el-select 断言下拉含指定选项（不录入） */
async function expectSelectOptionVisible(page: Page, select: Locator, text: string): Promise<void> {
  const listboxId = await select.locator('input').getAttribute('aria-controls')
  expect(listboxId).toBeTruthy()
  await select.click()
  const option = page.locator(`#${listboxId} .el-select-dropdown__item`, { hasText: text })
  await expect(option).toBeVisible()
}

/** 点开日报导出 dropdown 并点指定格式菜单项（照 reports.spec 模式） */
async function exportDailyAs(
  page: LaunchedApp['page'],
  format: 'txt' | 'xlsx' | 'docx'
): Promise<void> {
  await page.locator('[data-testid="daily-export"] button').click()
  const item = page.getByRole('menuitem', { name: `导出 .${format}` })
  await expect(item).toBeVisible()
  await item.click()
  // 成功 toast 按文案过滤定位（上一用例的 success toast 可能尚未退场——叠加时
  // 未过滤的 locator 会 strict 冲突）
  await expect(page.locator('.el-message--success').filter({ hasText: '已导出' })).toBeVisible()
  // 等全部 success toast 退场（3s 自动关闭）——避免下一次导出叠加 strict 冲突
  await expect(page.locator('.el-message--success')).toHaveCount(0, { timeout: 6000 })
}

/** docx 读回：zip → word/document.xml（照 docx.exporter.test 模式） */
async function readDocumentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('docx 缺少 word/document.xml')
  return entry.async('string')
}

/** docx 首表首行（表头）单元格文本序列（tbl → tr → w:t） */
function firstTableRowTexts(xml: string): string[] {
  const table = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)?.[0] ?? ''
  const firstRow = table.match(/<w:tr[^>]*>[\s\S]*?<\/w:tr>/)?.[0] ?? ''
  return [...firstRow.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]!)
}

test.describe.serial('客户与附加信息（T14）：快单/建档/关联/校验/预填/记忆/改附加/客户管理/导出', () => {
  let app: LaunchedApp
  /** 场景 2 建的国补单号（场景 7 改附加、场景 9 明细断言复用） */
  let subsidySaleNo = ''
  /** 场景 9 勾国补结账的单号（导出读回定位行） */
  let subsidy9SaleNo = ''

  test.beforeAll(async () => {
    // T17 钩子：launchApp 的 env 透传 process.env → 先设变量再启动
    process.env['E2E_EXPORT_DIR'] = EXPORT_DIR
    app = await launchApp()
    await waitForRoute(app.page, '/pos')

    // seed：better-sqlite3 直插（WAL 多连接，主进程下条语句即见）
    const db = new Database(app.dbPath)
    try {
      db.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
      ).run(COLA_BARCODE, COLA, PRICE_CENTS, 100)
    } finally {
      db.close()
    }
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    delete process.env['E2E_EXPORT_DIR']
  })

  // ═══════════ 场景 1：散客快单 ═══════════

  test('1 散客快单：加购 → 结账弹窗零填写直接确认 → DB 断言 sale_extras/customers 0 行', async () => {
    const { page } = app
    await addCola(app)

    await page.locator('.cart-panel__checkout').click()
    const dlg = checkoutDialog(page)
    await expect(dlg).toBeVisible()
    await expect(dlg.getByTestId('checkout-total').locator('.checkout-dialog__total-value')).toHaveText('¥3.50')

    // 零填写直接确认：弹窗关 → 小票预览（结账成功链路）
    await confirmCheckoutAndWaitPreviewClose(page)
    await expect(dlg).toBeHidden()
    await expect(page.locator('.cart-row')).toHaveCount(0)
    await expect(page.locator('.cart-panel__total-value')).toHaveText('¥0.00')

    // node 直读 DB：销售 1 行；快单零追加——sale_extras 0 行、customers 0 行
    withDb(app, (db) => {
      const sales = db
        .prepare('SELECT sale_no, total_cents, item_count, status FROM sales')
        .all() as SaleRow[]
      expect(sales).toHaveLength(1)
      expect(sales[0]).toMatchObject({
        total_cents: PRICE_CENTS,
        item_count: 1,
        status: 'completed'
      })
      expect(sales[0]!.sale_no).toMatch(/^\d{8}-\d{4}$/)
      expect((db.prepare('SELECT COUNT(*) AS n FROM sale_extras').get() as { n: number }).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(0)
    })
  })

  // ═══════════ 场景 2：新客建档 ═══════════

  test('2 新客建档：张三/13800138000/北京路 1 号 + 国补/备注/销售人员 → DB 全量落库', async () => {
    const { page } = app
    await addCola(app)

    await page.locator('.cart-panel__checkout').click()
    const dlg = checkoutDialog(page)
    await expect(dlg).toBeVisible()

    await dlg.getByTestId('checkout-customer-name').fill(CUST_NAME)
    await dlg.getByTestId('checkout-customer-phone').fill(CUST_PHONE)
    await dlg.getByTestId('checkout-customer-address').fill(CUST_ADDRESS)
    await dlg.getByTestId('checkout-customer-note').fill(CUST_NOTE)
    // 勾国补（开 → is-checked 即时重校验：姓名/电话已填 → 无错误浮出）
    const subsidySwitch = dlg.getByTestId('checkout-subsidy-switch')
    await subsidySwitch.click()
    await expect(subsidySwitch).toHaveClass(/is-checked/)
    await expect(dlg.locator('.el-form-item__error')).toHaveCount(0)
    await dlg.getByTestId('checkout-order-note').fill(ORDER_NOTE_2)
    await typeIntoSelect(page, dlg.getByTestId('checkout-salesperson-select'), SALESPERSON_WANG)
    await expect(dlg.getByTestId('checkout-salesperson-select')).toContainText(SALESPERSON_WANG)

    await page.screenshot({ path: `${EVIDENCE_DIR}/task-14-checkout-filled.png` })
    await confirmCheckoutAndWaitPreviewClose(page)

    // node 直读 DB：customers 1 行（四字段按填写落库）+ extras 关联 + 附加字段
    withDb(app, (db) => {
      const customers = db
        .prepare('SELECT id, name, phone, address, note FROM customers')
        .all() as CustomerRow[]
      expect(customers).toEqual([
        {
          id: 1,
          name: CUST_NAME,
          phone: CUST_PHONE,
          address: CUST_ADDRESS,
          note: CUST_NOTE
        }
      ])

      const extras = db
        .prepare(
          'SELECT sale_id, customer_id, is_national_subsidy, order_note, salesperson FROM sale_extras'
        )
        .all() as ExtraRow[]
      expect(extras).toEqual([
        {
          sale_id: 2, // 场景 1 的快单无 extras 行——本单 sale_id=2
          customer_id: 1,
          is_national_subsidy: 1,
          order_note: ORDER_NOTE_2,
          salesperson: SALESPERSON_WANG
        }
      ])

      subsidySaleNo = (
        db.prepare('SELECT sale_no FROM sales WHERE id = 2').get() as { sale_no: string }
      ).sale_no
      expect(subsidySaleNo).toMatch(/^\d{8}-\d{4}$/)
    })
  })

  // ═══════════ 场景 3：同电话关联 ═══════════

  test('3 同电话关联：二次结账同号 13800138000 → customers 仍 1 行、两单 extras 同一 customer_id', async () => {
    const { page } = app
    await addCola(app)

    await page.locator('.cart-panel__checkout').click()
    const dlg = checkoutDialog(page)
    await expect(dlg).toBeVisible()

    // 只填电话 → 失焦查询命中 → find-or-create 关联既有客户（不重建）
    await dlg.getByTestId('checkout-customer-phone').fill(CUST_PHONE)
    await dlg.getByTestId('checkout-customer-phone').blur()
    await confirmCheckoutAndWaitPreviewClose(page)

    withDb(app, (db) => {
      const customers = db
        .prepare('SELECT id, name, phone FROM customers')
        .all() as Array<{ id: number; name: string; phone: string }>
      expect(customers).toHaveLength(1)
      expect(customers[0]).toEqual({ id: 1, name: CUST_NAME, phone: CUST_PHONE })

      const extras = db
        .prepare(
          'SELECT sale_id, customer_id, is_national_subsidy FROM sale_extras ORDER BY sale_id'
        )
        .all() as Array<{ sale_id: number; customer_id: number | null; is_national_subsidy: number }>
      expect(extras).toEqual([
        { sale_id: 2, customer_id: 1, is_national_subsidy: 1 }, // 场景 2 国补单
        { sale_id: 3, customer_id: 1, is_national_subsidy: 0 } // 本单：同客户，未勾国补
      ])
    })
  })

  // ═══════════ 场景 4：必填校验×2 ═══════════

  test('4 必填校验：填姓名不填电话 / 勾国补不填姓名 → 红字阻断 + 弹窗不关 + DB 零新增', async () => {
    const { page } = app
    await addCola(app)

    await page.locator('.cart-panel__checkout').click()
    const dlg = checkoutDialog(page)
    await expect(dlg).toBeVisible()

    // 校验一：填姓名、不填电话 → 确认被阻断（后端规则一文案逐字一致）
    await dlg.getByTestId('checkout-customer-name').fill('赵敏')
    await page.getByTestId('checkout-dialog-confirm').click()
    await expect(
      dlg.locator('.el-form-item__error').filter({ hasText: '填写客户姓名或地址时，电话不能为空' })
    ).toBeVisible()
    await expect(dlg).toBeVisible() // 弹窗不关，可修改后重试

    // 校验二：清空姓名 + 勾国补 → 确认阻断（姓名/电话两字段同文案红字）
    await dlg.getByTestId('checkout-customer-name').fill('')
    const subsidySwitch = dlg.getByTestId('checkout-subsidy-switch')
    await subsidySwitch.click()
    await expect(subsidySwitch).toHaveClass(/is-checked/)
    await page.getByTestId('checkout-dialog-confirm').click()
    await expect(
      dlg
        .locator('.el-form-item__error')
        .filter({ hasText: '参与国补需填写客户姓名和电话' })
        .first()
    ).toBeVisible()
    await expect(dlg).toBeVisible()

    await page.screenshot({ path: `${EVIDENCE_DIR}/task-14-validation-blocked.png` })
    // 取消（零 IPC 零落库）——购物车保留，场景 5 复用本条可乐
    await dlg.getByTestId('checkout-dialog-cancel').click()
    await expect(dlg).toBeHidden()

    // node 直读 DB：两轮阻断零落库（sales 仍 3、extras 仍 2、customers 仍 1）
    withDb(app, (db) => {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(3)
      expect((db.prepare('SELECT COUNT(*) AS n FROM sale_extras').get() as { n: number }).n).toBe(2)
      expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(1)
    })
  })

  // ═══════════ 场景 5：预填 ═══════════

  test('5 预填：已建档电话 13800138000 失焦 → 姓名自动带出「张三」+ 已关联客户提示可见', async () => {
    const { page } = app
    // 购物车留有场景 4 取消后的 1 条可乐
    await expect(cartRow(page, COLA)).toHaveCount(1)

    await page.locator('.cart-panel__checkout').click()
    const dlg = checkoutDialog(page)
    await expect(dlg).toBeVisible()

    await dlg.getByTestId('checkout-customer-phone').fill(CUST_PHONE)
    await dlg.getByTestId('checkout-customer-phone').blur()
    // 命中档案四字段原值自动带入（phone 全等命中——防同名误关联）
    await expect(dlg.getByTestId('checkout-customer-name')).toHaveValue(CUST_NAME)
    await expect(dlg.getByTestId('checkout-customer-address')).toHaveValue(CUST_ADDRESS)
    await expect(dlg.getByTestId('checkout-customer-note')).toHaveValue(CUST_NOTE)
    await expect(dlg.getByTestId('checkout-customer-hint')).toBeVisible()
    await expect(dlg.getByTestId('checkout-customer-hint')).toHaveText(
      `已关联客户：${CUST_NAME}（信息已带入，可修改）`
    )

    // 取消：零 IPC 零落库（DB 无新增）
    await dlg.getByTestId('checkout-dialog-cancel').click()
    await expect(dlg).toBeHidden()
    withDb(app, (db) => {
      expect((db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(3)
      expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(1)
    })

    // 清车（场景 6 干净起点）
    await page.locator('.cart-clear-btn').click()
    await expect(page.locator('.cart-row')).toHaveCount(0)
  })

  // ═══════════ 场景 6：salesperson 记忆 ═══════════

  test('6 salesperson 记忆：结账填「张三」→ 第二次打开结账弹窗下拉选项含「张三」', async () => {
    const { page } = app

    // 第一单：填销售人员张三结账（事务内 push settings recent 队列）
    await addCola(app)
    await page.locator('.cart-panel__checkout').click()
    const dlg = checkoutDialog(page)
    await expect(dlg).toBeVisible()
    await typeIntoSelect(page, dlg.getByTestId('checkout-salesperson-select'), SALESPERSON_ZHANG)
    await expect(dlg.getByTestId('checkout-salesperson-select')).toContainText(SALESPERSON_ZHANG)
    await confirmCheckoutAndWaitPreviewClose(page)

    // node 直读 DB：settings recent_salespersons = [张三, 王五]（张三置顶）
    withDb(app, (db) => {
      const setting = db
        .prepare("SELECT value FROM settings WHERE key = 'recent_salespersons'")
        .get() as { value: string }
      expect(setting.value).toBe(`["${SALESPERSON_ZHANG}","${SALESPERSON_WANG}"]`)
    })

    // 第二次打开结账弹窗：下拉选项含张三（每次打开重拉——上单刚用过的姓名即时入列）
    await addCola(app)
    await page.locator('.cart-panel__checkout').click()
    await expect(dlg).toBeVisible()
    await expectSelectOptionVisible(
      page,
      dlg.getByTestId('checkout-salesperson-select'),
      SALESPERSON_ZHANG
    )
    await page.screenshot({ path: `${EVIDENCE_DIR}/task-14-salesperson-memory.png` })

    // 收起下拉（点弹窗内合计条非交互区——EP select 点击外部即收起；
    // popper 覆盖层不收会拦截后续按钮点击）
    await dlg.locator('.checkout-dialog__total').click()

    // 取消不落库 + 清车
    await dlg.getByTestId('checkout-dialog-cancel').click()
    await expect(dlg).toBeHidden()
    await page.locator('.cart-clear-btn').click()
    await expect(page.locator('.cart-row')).toHaveCount(0)
  })

  // ═══════════ 场景 7：订单侧改附加 ═══════════

  test('7 订单侧改附加：双击国补单 → 改国补/订单备注/换绑 13900139000 → 保存 + find-or-create 建档', async () => {
    const { page } = app
    await gotoMenu(page, '销售记录', '/sales-history')

    const rows = page.locator('.sales-history__table .el-table__row')
    await expect(rows).toHaveCount(4) // 场景 1/2/3/6 四单（默认日期范围=今天）

    // 双击场景 2 的国补单（当前已勾国补 + 绑张三）
    const targetRow = rows.filter({ hasText: subsidySaleNo })
    await expect(targetRow).toHaveCount(1)
    await targetRow.dblclick()

    const detail = page.locator('.el-dialog').filter({ hasText: '销售明细' })
    await expect(detail).toBeVisible()

    // 展示区初值：客户四行 + 国补 tag + 订单备注 + 销售人员
    await expect(detail.getByTestId('detail-customer-name')).toHaveText(CUST_NAME)
    await expect(detail.getByTestId('detail-customer-phone')).toHaveText(CUST_PHONE)
    await expect(detail.getByTestId('detail-customer-address')).toHaveText(CUST_ADDRESS)
    await expect(detail.getByTestId('detail-customer-note')).toHaveText(CUST_NOTE)
    await expect(detail.getByTestId('detail-subsidy')).toHaveText('国补')
    await expect(detail.getByTestId('detail-order-note')).toHaveText(ORDER_NOTE_2)
    await expect(detail.getByTestId('detail-salesperson')).toHaveText(SALESPERSON_WANG)

    // 编辑区：初值快照（无改动保存禁用）
    const editArea = detail.getByTestId('extra-edit')
    await expect(editArea.getByTestId('extra-is-subsidy')).toHaveClass(/is-checked/)
    await expect(editArea.getByTestId('extra-customer-phone')).toHaveValue(CUST_PHONE)
    await expect(editArea.getByTestId('extra-order-note')).toHaveValue(ORDER_NOTE_2)
    await expect(editArea.getByTestId('extra-save')).toBeDisabled()

    // 改国补（开 → 关）+ 改订单备注 + 换绑新电话（未建档 → 将以「13900139000」新建客户）
    await editArea.getByTestId('extra-is-subsidy').click()
    await expect(editArea.getByTestId('extra-is-subsidy')).not.toHaveClass(/is-checked/)
    await editArea.getByTestId('extra-order-note').fill('改约周五配送')
    await editArea.getByTestId('extra-customer-phone').fill(NEW_PHONE)
    await editArea.getByTestId('extra-customer-phone').blur()
    await expect(editArea.getByTestId('extra-phone-hint')).toBeVisible()
    await expect(editArea.getByTestId('extra-phone-hint')).toHaveText(
      `将以「${NEW_PHONE}」新建客户`
    )

    await expect(editArea.getByTestId('extra-save')).toBeEnabled()
    await editArea.getByTestId('extra-save').click()
    await expect(
      page.locator('.el-message--success').filter({ hasText: '附加信息已保存' })
    ).toBeVisible()

    // 保存后展示区刷新（res 即更新后明细）：国补否、新备注、新电话裸客户
    await expect(detail.getByTestId('detail-subsidy')).toHaveText('否')
    await expect(detail.getByTestId('detail-order-note')).toHaveText('改约周五配送')
    await expect(detail.getByTestId('detail-customer-phone')).toHaveText(NEW_PHONE)
    await expect(detail.getByTestId('detail-customer-name')).toHaveText('—')
    await expect(detail.getByTestId('detail-salesperson')).toHaveText(SALESPERSON_WANG) // 未改动

    await page.screenshot({ path: `${EVIDENCE_DIR}/task-14-extra-edit-saved.png` })
    await detail.locator('.el-dialog__close').click()
    await expect(detail).toBeHidden()

    // node 直读 DB：find-or-create 建裸电话客户 + extras 行按 patch 更新
    withDb(app, (db) => {
      const customers = db
        .prepare('SELECT id, name, phone FROM customers ORDER BY id')
        .all() as Array<{ id: number; name: string; phone: string }>
      expect(customers).toEqual([
        { id: 1, name: CUST_NAME, phone: CUST_PHONE },
        { id: 2, name: '', phone: NEW_PHONE } // 裸电话建档（姓名可后续客户管理补录）
      ])

      const extra = db
        .prepare(
          `SELECT sale_id, customer_id, is_national_subsidy, order_note, salesperson
             FROM sale_extras WHERE sale_id = (SELECT id FROM sales WHERE sale_no = ?)`
        )
        .get(subsidySaleNo) as ExtraRow
      expect(extra).toEqual({
        sale_id: 2,
        customer_id: 2,
        is_national_subsidy: 0,
        order_note: '改约周五配送',
        salesperson: SALESPERSON_WANG
      })
    })
  })

  // ═══════════ 场景 8：客户管理 ═══════════

  test('8 客户管理：新增（冲突改号）→ 列表出现 → 编辑改名 → 搜索 → 再建同号冲突 ElMessage', async () => {
    const { page } = app
    await gotoMenu(page, '客户管理', '/customers')

    const tableRows = page.getByTestId('customer-table').locator('.el-table__row')
    // 初始：张三 + 场景 7 的裸电话客户，共 2 位
    await expect(page.locator('.page-title__count')).toHaveText('共 2 位客户')

    // 新增李四/13900139000 → 电话冲突（该号已被场景 7 find-or-create 建档）→ 弹窗不关
    await page.getByTestId('customer-create-btn').click()
    const createDlg = page.locator('.el-dialog').filter({ hasText: '新增客户' })
    await expect(createDlg).toBeVisible()
    await createDlg.getByTestId('customer-name').fill('李四')
    await createDlg.getByTestId('customer-phone').fill(NEW_PHONE)
    await createDlg.getByTestId('customer-save-btn').click()
    await expect(
      page.locator('.el-message--error').filter({ hasText: '该电话已被客户「」使用' })
    ).toBeVisible()
    await expect(createDlg).toBeVisible()

    // 改号重交 → 创建成功 → 弹窗关 + 列表出现
    await createDlg.getByTestId('customer-phone').fill(LISI_PHONE)
    await createDlg.getByTestId('customer-save-btn').click()
    await expect(
      page.locator('.el-message--success').filter({ hasText: '客户已创建' })
    ).toBeVisible()
    await expect(createDlg).toBeHidden()
    await expect(page.locator('.page-title__count')).toHaveText('共 3 位客户')
    const lisiRow = tableRows.filter({ hasText: LISI_PHONE })
    await expect(lisiRow).toHaveCount(1)
    await expect(lisiRow).toContainText('李四')

    // 编辑改名：李四 → 李四丰
    await lisiRow.getByTestId('customer-edit-btn').click()
    const editDlg = page.locator('.el-dialog').filter({ hasText: '编辑客户' })
    await expect(editDlg).toBeVisible()
    await expect(editDlg.getByTestId('customer-name')).toHaveValue('李四')
    await expect(editDlg.getByTestId('customer-phone')).toHaveValue(LISI_PHONE)
    await editDlg.getByTestId('customer-name').fill('李四丰')
    await editDlg.getByTestId('customer-save-btn').click()
    await expect(
      page.locator('.el-message--success').filter({ hasText: '客户已保存' })
    ).toBeVisible()
    await expect(editDlg).toBeHidden()
    await expect(tableRows.filter({ hasText: LISI_PHONE })).toContainText('李四丰')

    // 搜索（300ms 防抖——expect 自动等待）：命中唯一改名行
    await page.getByTestId('customer-search').fill('李四丰')
    await expect(tableRows).toHaveCount(1)
    await expect(tableRows.first()).toContainText(LISI_PHONE)
    await page.screenshot({ path: `${EVIDENCE_DIR}/task-14-customers-search.png` })

    // 再建同号（赵六/13900139001）→ 电话冲突 ElMessage（message 内嵌现有客户姓名）+ 弹窗不关
    await page.getByTestId('customer-create-btn').click()
    const createDlg2 = page.locator('.el-dialog').filter({ hasText: '新增客户' })
    await expect(createDlg2).toBeVisible()
    await createDlg2.getByTestId('customer-name').fill('赵六')
    await createDlg2.getByTestId('customer-phone').fill(LISI_PHONE)
    await createDlg2.getByTestId('customer-save-btn').click()
    await expect(
      page
        .locator('.el-message--error')
        .filter({ hasText: `该电话已被客户「李四丰」使用` })
    ).toBeVisible()
    await expect(createDlg2).toBeVisible()
    await createDlg2.getByRole('button', { name: '取消' }).click()
    await expect(createDlg2).toBeHidden()

    // node 直读 DB：新增档案四字段落库 + 改名持久化
    withDb(app, (db) => {
      const lisi = db
        .prepare('SELECT name, phone, address, note FROM customers WHERE phone = ?')
        .get(LISI_PHONE) as { name: string; phone: string; address: string; note: string }
      expect(lisi).toEqual({ name: '李四丰', phone: LISI_PHONE, address: '', note: '' })
      expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(3)
    })
  })

  // ═══════════ 场景 9：日报导出三格式 ═══════════

  test('9a 勾国补结账：今日 5 单 17.50、国补小计 3.50（复用张三档案）', async () => {
    const { page } = app
    await gotoMenu(page, '收银台', '/pos')
    await addCola(app)

    await page.locator('.cart-panel__checkout').click()
    const dlg = checkoutDialog(page)
    await expect(dlg).toBeVisible()

    // 电话失焦带出张三档案 → 勾国补（姓名/电话已满足）+ 订单备注
    await dlg.getByTestId('checkout-customer-phone').fill(CUST_PHONE)
    await dlg.getByTestId('checkout-customer-phone').blur()
    await expect(dlg.getByTestId('checkout-customer-name')).toHaveValue(CUST_NAME)
    const subsidySwitch = dlg.getByTestId('checkout-subsidy-switch')
    await subsidySwitch.click()
    await expect(subsidySwitch).toHaveClass(/is-checked/)
    await dlg.getByTestId('checkout-order-note').fill(SUBSIDY_NOTE_9)
    await confirmCheckoutAndWaitPreviewClose(page)

    // DB 直读：国补单落库（今日唯一国补单——场景 7 已把场景 2 单改回非国补）
    withDb(app, (db) => {
      subsidy9SaleNo = (
        db
          .prepare(
            `SELECT s.sale_no FROM sales s
               JOIN sale_extras se ON se.sale_id = s.id
              WHERE se.is_national_subsidy = 1 ORDER BY s.id`
          )
          .get() as { sale_no: string }
      ).sale_no
      expect(subsidy9SaleNo).toMatch(/^\d{8}-\d{4}$/)
      expect((db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(5)
      expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(3)
    })

    // 报表页（日报默认今天）：汇总三卡 17.50 / 5 / 3.50
    await gotoMenu(page, '报表统计', '/reports')
    const stats = page.locator('[data-testid="daily-stats"] .stat-card__value')
    await expect(stats.nth(0)).toHaveText('17.50')
    await expect(stats.nth(1)).toHaveText('5')
    await expect(stats.nth(2)).toHaveText('3.50') // 国补销售额卡（尾部追加）

    // 明细新列：本单「国补」+ 备注；场景 2 单被场景 7 改后为「否」+ 新备注（编辑下游闭环）
    const rows = page.locator('[data-testid="daily-table"] .el-table__row')
    await expect(rows).toHaveCount(5)
    const subsidy9Cells = rows.filter({ hasText: subsidy9SaleNo }).locator('td')
    await expect(subsidy9Cells.nth(5)).toHaveText('国补')
    await expect(subsidy9Cells.nth(6)).toHaveText(SUBSIDY_NOTE_9)
    const editedCells = rows.filter({ hasText: subsidySaleNo }).locator('td')
    await expect(editedCells.nth(5)).toHaveText('否')
    await expect(editedCells.nth(6)).toHaveText('改约周五配送')
    // 是否国补列仅 true 渲染 el-tag——success tag 恰 1 个（状态列为 primary）
    await expect(rows.locator('.el-tag--success')).toHaveCount(1)

    await page.screenshot({ path: `${EVIDENCE_DIR}/task-14-reports-daily.png` })
  })

  test('9b 日报三格式导出读回：txt/xlsx/docx 新列与国补小计（E2E_EXPORT_DIR）', async () => {
    const { page } = app
    await exportDailyAs(page, 'txt')
    await exportDailyAs(page, 'xlsx')
    await exportDailyAs(page, 'docx')

    const txtPath = join(EXPORT_DIR, `日报${TODAY}.txt`)
    const xlsxPath = join(EXPORT_DIR, `日报${TODAY}.xlsx`)
    const docxPath = join(EXPORT_DIR, `日报${TODAY}.docx`)
    expect(existsSync(txtPath)).toBe(true)
    expect(existsSync(xlsxPath)).toBe(true)
    expect(existsSync(docxPath)).toBe(true)

    // txt 读回：汇总块国补行 + 明细新列表头 + 国补单行（是 + 备注）
    const txt = readFileSync(txtPath, 'utf8')
    expect(txt).toContain('总销售额: 17.50 元')
    expect(txt).toContain('订单数: 5')
    expect(txt).toContain('国补销售额: 3.50 元')
    expect(txt).toContain('是否国补')
    expect(txt).toContain('订单备注')
    const subsidy9Line = txt.split('\r\n').find((l) => l.includes(subsidy9SaleNo))
    expect(subsidy9Line).toBeDefined()
    expect(subsidy9Line!).toContain('是')
    expect(subsidy9Line!).toContain(SUBSIDY_NOTE_9)

    // xlsx 读回：汇总 B2/B3/B5（国补小计新行）+ 明细 F/G 新列表头 + 国补单行
    const wb = new Workbook()
    await wb.xlsx.load(readFileSync(xlsxPath) as unknown as ArrayBuffer)
    const summary = wb.getWorksheet('汇总')
    expect(summary).toBeDefined()
    expect(summary!.getCell('B2').value).toBe(17.5)
    expect(summary!.getCell('B3').value).toBe(5)
    expect(summary!.getCell('B5').value).toBe(3.5)
    const detail = wb.getWorksheet('明细')
    expect(detail).toBeDefined()
    expect(detail!.getCell('F1').value).toBe('是否国补')
    expect(detail!.getCell('G1').value).toBe('订单备注')
    expect(detail!.actualRowCount).toBe(6) // 表头 + 5 行
    let subsidy9XlsxRow = 0
    for (let r = 2; r <= detail!.actualRowCount; r++) {
      if (detail!.getCell(`A${r}`).value === subsidy9SaleNo) {
        subsidy9XlsxRow = r
        break
      }
    }
    expect(subsidy9XlsxRow).toBeGreaterThan(0)
    expect(detail!.getCell(`F${subsidy9XlsxRow}`).value).toBe('是')
    expect(detail!.getCell(`G${subsidy9XlsxRow}`).value).toBe(SUBSIDY_NOTE_9)

    // docx 读回：汇总段国补行 + 明细表头 7 列（尾部追加两列）
    const docx = readFileSync(docxPath)
    expect(docx.subarray(0, 2).toString('latin1')).toBe('PK') // zip 魔数
    const xml = await readDocumentXml(docx)
    expect(xml).toContain('国补销售额：3.50 元')
    expect(firstTableRowTexts(xml)).toEqual([
      '单号',
      '时间',
      '商品数',
      '合计（元）',
      '状态',
      '是否国补',
      '订单备注'
    ])
    expect(xml).toContain(SUBSIDY_NOTE_9)

    // 文字化证据：导出闭环摘要
    writeFileSync(
      `${EVIDENCE_DIR}/task-14-export-summary.txt`,
      [
        'T14 客户与附加信息 E2E — 日报三格式导出读回闭环',
        `导出目录: ${EXPORT_DIR}`,
        `日报（${TODAY}）: 5 单 17.50 元 / 国补小计 3.50 元（勾国补单 ${subsidy9SaleNo}）`,
        '  txt: 「国补销售额: 3.50 元」+ 新列表头（是否国补/订单备注）',
        '  xlsx: 汇总!B2=17.5 / B3=5 / B5=3.5；明细 F1/G1 新列、国补行 F=是 G=国补订单留档',
        '  docx: 「国补销售额：3.50 元」+ 明细表头 7 列'
      ].join('\n')
    )
  })
})
