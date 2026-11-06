import { appendFileSync } from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { DEFAULT_TEMPLATES } from '../../src/shared/receipt/default-template'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/**
 * Task 16 — 小票模板编辑器 E2E。
 *
 * 覆盖（计划 QA 场景）：实时预览联动（不保存即刷新：字号 class + 变量插值）、
 * 保存持久化（SPA 重挂载后表单值保持——规避 page.reload 文件重载竞态）、
 * 58mm 纸宽切换、唯一模板删除 disabled、名称清空保存 disabled、
 * 新建/复制/删除 CRUD、设为默认 → 结账预览使用默认模板
 * （printing:preview 为 T15 领地：handler 探测不到时跳过该断言并记录 evidence）。
 */

type RendererGlobal = {
  window: { api: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
}

const EVIDENCE_DIR = '.omo/evidence'
const DEFAULT_NAME = '默认小票'
const SECOND_NAME = '58mm 紧凑小票'
const MARKER_TEXT = 'E2E专用模板标记'

let app: LaunchedApp
let defaultTemplateId = 0

/** el-select 选项定位：aria-controls 锚点域（T9 终极方案，多 select 页面唯一可靠模式） */
async function selectOption(page: Page, select: Locator, label: string): Promise<void> {
  const listboxId = await select.locator('input').getAttribute('aria-controls')
  expect(listboxId).toBeTruthy()
  await select.click()
  const option = page.locator(`#${listboxId} .el-select-dropdown__item`, { hasText: label })
  await expect(option).toBeVisible()
  await option.first().click()
}

test.describe.serial('Task 16：小票模板编辑器（表单 + 实时预览 + CRUD）', () => {
  test.beforeAll(async () => {
    app = await launchApp()

    // seed：直插一行默认模板（绕过 CRUD——repo 行为由单测覆盖，E2E 验证 UI 链路）
    const db = new Database(app.dbPath)
    try {
      const info = db
        .prepare(
          'INSERT INTO print_templates (name, paper_width, config_json, is_default) VALUES (?, ?, ?, 1)'
        )
        .run(DEFAULT_NAME, '80mm', JSON.stringify(DEFAULT_TEMPLATES['80mm']))
      defaultTemplateId = Number(info.lastInsertRowid)
    } finally {
      db.close()
    }

    await app.page.locator('.el-menu-item').filter({ hasText: '小票模板' }).click()
    await waitForRoute(app.page, '/template-editor')
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  test('初始加载：列表出现模板并自动选中默认，预览同源渲染', async () => {
    const { page } = app
    const items = page.getByTestId('tpl-item')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText(DEFAULT_NAME)
    await expect(items.first().locator('.el-tag--success')).toContainText('默认')

    await expect(page.getByTestId('tpl-name')).toHaveValue(DEFAULT_NAME)
    await expect(page.getByTestId('receipt-paper')).toBeVisible()
    // 默认模板 header[0] = {shopName} doubleHeight bold：预览首行即其同源渲染
    const firstLine = page.locator('.tpl-preview .receipt-line').first()
    await expect(firstLine).toContainText('测试商店')
    await expect(firstLine).toHaveClass(/receipt-line--double-height/)
  })

  test('实时预览（不保存即刷新）：头部字号 标准→class 消失，倍高→恢复', async () => {
    const { page } = app
    const firstRow = page.getByTestId('tpl-row-header').first()
    const firstLine = page.locator('.tpl-preview .receipt-line').first()

    await selectOption(page, firstRow.getByTestId('tpl-size'), '标准')
    await expect(firstLine).not.toHaveClass(/receipt-line--double-height/)

    await selectOption(page, firstRow.getByTestId('tpl-size'), '倍高')
    await expect(firstLine).toHaveClass(/receipt-line--double-height/)
  })

  test('添加底部段落 {shopName} 欢迎光临 → 预览实时插值「测试商店 欢迎光临」', async () => {
    const { page } = app
    await page.getByTestId('tpl-add-footer').click()

    const footerRows = page.getByTestId('tpl-row-footer')
    await expect(footerRows).toHaveCount(3)
    await footerRows
      .last()
      .getByTestId('tpl-content')
      .fill('{shopName} 欢迎光临')

    await expect(page.getByTestId('receipt-paper')).toContainText('测试商店 欢迎光临')
    await page.screenshot({ path: `${EVIDENCE_DIR}/task-16-template-editor.png`, fullPage: true })
  })

  test('保存 → toast 成功 → SPA 重挂载后表单值保持', async () => {
    const { page } = app
    await page.getByTestId('tpl-save').click()
    await expect(page.locator('.el-message--success').filter({ hasText: '已保存' }).first()).toBeVisible()

    const db = new Database(app.dbPath)
    try {
      const row = db
        .prepare('SELECT config_json FROM print_templates WHERE id = ?')
        .get(defaultTemplateId) as { config_json: string }
      expect(row.config_json).toContain('欢迎光临')
    } finally {
      db.close()
    }

    // 刷新 = SPA 路由离开再回来（规避 page.reload 的 out/ 重建竞态——T8 learnings）
    await page.locator('.el-menu-item').filter({ hasText: '商品管理' }).click()
    await waitForRoute(page, '/products')
    await page.locator('.el-menu-item').filter({ hasText: '小票模板' }).click()
    await waitForRoute(page, '/template-editor')

    await expect(page.getByTestId('tpl-name')).toHaveValue(DEFAULT_NAME)
    await expect(page.getByTestId('tpl-row-footer')).toHaveCount(3)
    await expect(page.getByTestId('tpl-row-footer').last().getByTestId('tpl-content')).toHaveValue(
      '{shopName} 欢迎光临'
    )
    await expect(page.getByTestId('tpl-row-header').first()).toContainText('倍高')
    await expect(page.locator('.tpl-preview .receipt-line').first()).toHaveClass(
      /receipt-line--double-height/
    )
  })

  test('约束：唯一模板删除 disabled；名称清空保存 disabled；58mm 预览变窄', async () => {
    const { page } = app
    await expect(page.getByTestId('tpl-delete')).toBeDisabled()

    const nameInput = page.getByTestId('tpl-name')
    await nameInput.fill('')
    await expect(page.getByTestId('tpl-save')).toBeDisabled()
    await nameInput.fill(DEFAULT_NAME)
    await expect(page.getByTestId('tpl-save')).toBeEnabled()

    const paper = page.getByTestId('receipt-paper')
    await page.getByTestId('tpl-paper-58').click()
    const narrow = await paper.evaluate((el) => el.getBoundingClientRect().width)
    expect(narrow).toBeLessThan(240)
    expect(Math.abs(narrow - 221)).toBeLessThanOrEqual(5)

    await page.getByTestId('tpl-paper-80').click()
    const wide = await paper.evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.abs(wide - 307)).toBeLessThanOrEqual(5)

    await page.screenshot({ path: `${EVIDENCE_DIR}/task-16-constraints.png`, fullPage: true })
  })

  test('新建 58mm 模板（含特征行）→ 列表出现，删除按钮解禁', async () => {
    const { page } = app
    await page.getByTestId('tpl-new').click()
    await expect(page.getByTestId('tpl-draft-tag').last()).toBeVisible()

    await page.getByTestId('tpl-name').fill(SECOND_NAME)
    await page.getByTestId('tpl-paper-58').click()
    await page.getByTestId('tpl-add-footer').click()
    await page
      .getByTestId('tpl-row-footer')
      .last()
      .getByTestId('tpl-content')
      .fill(MARKER_TEXT)

    await page.getByTestId('tpl-save').click()
    await expect(page.locator('.el-message--success').filter({ hasText: '已创建' }).first()).toBeVisible()
    await expect(page.getByTestId('tpl-item')).toHaveCount(2)
    await expect(page.getByTestId('tpl-item').filter({ hasText: SECOND_NAME })).toContainText('58mm')
    await expect(page.getByTestId('tpl-delete')).toBeEnabled()
  })

  test('复制当前 → 保存 → 3 个；删除副本（确认弹窗）→ 回到 2 个', async () => {
    const { page } = app
    await page.getByTestId('tpl-item').filter({ hasText: DEFAULT_NAME }).click()
    await expect(page.getByTestId('tpl-name')).toHaveValue(DEFAULT_NAME)

    await page.getByTestId('tpl-copy').click()
    await expect(page.getByTestId('tpl-draft-tag').last()).toBeVisible()
    await expect(page.getByTestId('tpl-name')).toHaveValue(`${DEFAULT_NAME} 副本`)

    await page.getByTestId('tpl-save').click()
    await expect(page.locator('.el-message--success').filter({ hasText: '已创建' }).first()).toBeVisible()
    await expect(page.getByTestId('tpl-item')).toHaveCount(3)

    await page.getByTestId('tpl-delete').click()
    const box = page.locator('.el-message-box')
    await expect(box).toContainText(DEFAULT_NAME)
    await box.getByRole('button', { name: '删除' }).click()
    await expect(page.locator('.el-message--success').filter({ hasText: '已删除' }).first()).toBeVisible()
    await expect(page.getByTestId('tpl-item')).toHaveCount(2)
  })

  test('设为默认：默认标记移到 58mm 模板（DB 权威断言恰一个默认）', async () => {
    const { page } = app
    await page.getByTestId('tpl-item').filter({ hasText: SECOND_NAME }).click()
    await expect(page.getByTestId('tpl-name')).toHaveValue(SECOND_NAME)

    await page.getByTestId('tpl-default').getByText('设为默认').click()
    await expect(
      page.locator('.el-message--success').filter({ hasText: '已设为默认模板' }).first()
    ).toBeVisible()

    const secondItem = page.getByTestId('tpl-item').filter({ hasText: SECOND_NAME })
    await expect(secondItem.locator('.el-tag--success')).toHaveCount(1)
    const firstItem = page.getByTestId('tpl-item').filter({ hasText: DEFAULT_NAME })
    await expect(firstItem.locator('.el-tag--success')).toHaveCount(0)

    const db = new Database(app.dbPath)
    try {
      const defaults = db
        .prepare('SELECT name FROM print_templates WHERE is_default = 1')
        .all() as Array<{ name: string }>
      expect(defaults).toEqual([{ name: SECOND_NAME }])
    } finally {
      db.close()
    }
  })

  test('设为默认闭环：#/pos 结账预览使用该模板（T15 合并状态自适应）', async () => {
    const { page } = app
    // renderer 侧探测 printing:preview handler（listenerCount 探测不到 handle()——T9 坑）
    const hasPreview = await page.evaluate(() =>
      (globalThis as unknown as RendererGlobal).window.api
        .invoke('printing:preview', { sale_id: 1 })
        .then(
          () => true,
          (err: unknown) =>
            !(err instanceof Error && String(err.message).includes('No handler registered'))
        )
    )

    if (!hasPreview) {
      appendFileSync(
        `${EVIDENCE_DIR}/task-16-default-checkout.txt`,
        `SKIPPED (${new Date().toISOString()}): printing:preview handler 未注册——T15（打印编排）尚未合并完成。\n` +
          `设默认已由上一用例 DB 权威断言闭环（is_default=1 → '${SECOND_NAME}'）；\n` +
          `T15 合并后重跑本 spec 将执行结账→预览弹窗特征断言（${MARKER_TEXT}）。\n`
      )
      test.skip(true, 'T15 未合并：printing:preview 不可用，断言记录到 evidence')
    }

    // T15 已合并：真实结账 → 预览弹窗应含默认模板特征行
    const db = new Database(app.dbPath)
    try {
      db.prepare(
        'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
      ).run('6901111111111', '模板标记测试商品', 350, 10)
    } finally {
      db.close()
    }

    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')
    await page.locator('.barcode-input input').fill('模板标记测试商品')
    await page
      .locator('.pos-products-table .el-table__row')
      .filter({ hasText: '模板标记测试商品' })
      .first()
      .dblclick()
    await page.locator('.cart-panel__checkout').click()

    const dialog = page.locator('.el-dialog').filter({ hasText: /小票|预览|结账/ })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(MARKER_TEXT)
    appendFileSync(
      `${EVIDENCE_DIR}/task-16-default-checkout.txt`,
      `PASS (${new Date().toISOString()}): 结账预览弹窗使用默认模板 '${SECOND_NAME}'，含特征行 '${MARKER_TEXT}'。\n`
    )
  })

  test('明细列宽配置：单项填写 → 红字警示 + 保存阻断；四列齐全总和 48 → 预览列宽联动 + 落库；清空 → JSON 无 columnWidths', async () => {
    const { page } = app

    // 前序结账闭环用例把页面留在了收银台（预览弹窗未关）——先关弹窗再导航回模板编辑器
    await page.getByRole('button', { name: '取消' }).click()
    await page.locator('.el-overlay-dialog').waitFor({ state: 'hidden' })
    await page.locator('.el-menu-item').filter({ hasText: '小票模板' }).click()
    await waitForRoute(page, '/template-editor')

    await page.getByTestId('tpl-item').filter({ hasText: DEFAULT_NAME }).click()
    await expect(page.getByTestId('tpl-name')).toHaveValue(DEFAULT_NAME)

    /** el-input-number 输入（fill + Enter commit） */
    const fillWidth = async (testid: string, v: string): Promise<void> => {
      const input = page.getByTestId(testid).locator('input')
      await input.fill(v)
      await input.press('Enter')
    }

    // 只填名称列宽（其余留空）→ 已填键不全 → 红字警示
    await fillWidth('tpl-col-w-name', '20')
    await expect(page.getByTestId('tpl-col-w-sum')).toContainText('合计 20 / 48')
    await expect(page.getByTestId('tpl-col-w-warn')).toBeVisible()

    // 保存阻断：warning toast（不落库）
    await page.getByTestId('tpl-save').click()
    await expect(page.locator('.el-message--warning').first()).toBeVisible()

    // 补齐四列：20 + 4 + 12 + 12 = 48（80mm 总列数）→ 警示消失
    await fillWidth('tpl-col-w-qty', '4')
    await fillWidth('tpl-col-w-price', '12')
    await fillWidth('tpl-col-w-subtotal', '12')
    await expect(page.getByTestId('tpl-col-w-sum')).toContainText('合计 48 / 48')
    await expect(page.getByTestId('tpl-col-w-warn')).toHaveCount(0)

    // 预览列宽联动：名称列 24/48=50% → 20/48≈41.67%（colgroup 经 resolveColumnWidths 换算）
    await expect(page.locator('.receipt-items col').first()).toHaveAttribute(
      'style',
      /width:\s*41\.67%/
    )

    // 保存成功 → config_json 含四键 columnWidths
    await page.getByTestId('tpl-save').click()
    await expect(page.locator('.el-message--success').filter({ hasText: '已保存' }).first()).toBeVisible()
    const readConfig = (): Record<string, unknown> => {
      const db = new Database(app.dbPath)
      try {
        const row = db
          .prepare('SELECT config_json FROM print_templates WHERE id = ?')
          .get(defaultTemplateId) as { config_json: string }
        return JSON.parse(row.config_json) as Record<string, unknown>
      } finally {
        db.close()
      }
    }
    expect((readConfig().items as { columnWidths?: Record<string, number> }).columnWidths).toEqual({
      name: 20,
      qty: 4,
      price: 12,
      subtotal: 12
    })

    // 清空四项（未覆盖形态）→ 保存 → JSON 不含 columnWidths 字段（保持模板干净）
    await fillWidth('tpl-col-w-name', '')
    await fillWidth('tpl-col-w-qty', '')
    await fillWidth('tpl-col-w-price', '')
    await fillWidth('tpl-col-w-subtotal', '')
    await expect(page.getByTestId('tpl-col-w-sum')).toContainText('合计 0 / 48')
    await page.getByTestId('tpl-save').click()
    await expect(page.locator('.el-message--success').filter({ hasText: '已保存' }).first()).toBeVisible()
    expect(readConfig().config_json ?? JSON.stringify(readConfig())).not.toContain('columnWidths')

    await page.screenshot({ path: `${EVIDENCE_DIR}/task-16-column-widths.png`, fullPage: true })
  })

  test('image 段落：Logo 选择控件（列表为空 → select 禁用 + 上传入口 + 引导提示，文案输入已替换）', async () => {
    const { page } = app

    await page.getByTestId('tpl-item').filter({ hasText: DEFAULT_NAME }).click()
    await expect(page.getByTestId('tpl-name')).toHaveValue(DEFAULT_NAME)

    const firstRow = page.getByTestId('tpl-row-header').first()
    await selectOption(page, firstRow.getByTestId('tpl-type'), '图片 Logo')

    const logoSelect = firstRow.getByTestId('tpl-logo-select')
    // el-select 根 div 的可见性由内部 tooltip wrapper 控制（Playwright 判 hidden），
    // 断言落在内部 input 上（同 selectOption helper 的定位方式）
    const logoInput = logoSelect.locator('input')
    await expect(logoInput).toBeVisible()
    // E2E 隔离库 logos 为空：select 禁用 + 引导上传提示
    await expect(logoInput).toBeDisabled()
    await expect(firstRow.getByTestId('tpl-logo-upload')).toBeVisible()
    await expect(firstRow.getByText('请先在 设置→小票Logo 上传')).toBeVisible()

    // image 段落不再渲染文案输入（替换为 Logo 选择行）
    await expect(firstRow.getByTestId('tpl-content')).toHaveCount(0)
  })
})
