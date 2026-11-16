import Database from 'better-sqlite3'
import { test, expect, type Page } from '@playwright/test'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/**
 * driver 通道实验设置 E2E（printer-diagnostics v2）：设置页打印卡片内
 * 「打印高级选项（实验）」折叠区的用户链路——真机免发版迭代全靠这条链路。
 *
 * 场景（只增不删，独立 spec；设置页本就走真 IPC，正常路径零 mock）：
 *  1. 折叠区常驻渲染：spooler 默认通道下也可见（不隐藏）+「仅 driver 通道生效」
 *     inert 标注（切 driver 消失 / 切回复现）+ dpi 说明 + A4 兜底警告文案在场
 *  2. 合法保存往返：dpi 填 203 + 默认页尺寸开 → 保存成功 toast → settings 表
 *     DB 断言（真实 IPC 往返）→ 离开再进设置页回显
 *  3. 清除路径：dpi 清空（EP input-number 清空 emit null）→ 保存 → DB 空串
 *     （null ≡ ''）→ 回显为空
 *  4. 非法值拒绝：① 真实 IPC（无 mock）——page.evaluate 直接 invoke settings:set
 *     越界 13 / 字符串 '203' → 主进程 validateSettingsPatch 中文报错（含值回显）；
 *     ② UI 回显链路——ipcMain.removeHandler + handle 重挂 settings:set throw 同款
 *     报错（diagnosis.spec.ts 注入模式），点保存 → error toast 展示剥前缀后的
 *     中文报错；mock 后置最后（重挂不可恢复，之后的场景不再真实保存）
 *
 * UI 层为何测不到校验：el-input-number min/max 在 change 时把越界值 clamp 回
 * 值域（EP verifyValue 源码行为），UI 永远发不出非法 dpi——IPC 校验是纵深防御
 * （防 preload 旁路/未来 UI 改动），其 E2E 证明只能走直接 invoke。
 */

/** page.evaluate 回调在 renderer 主世界执行（contextBridge 暴露 window.api） */
type RendererGlobal = {
  window: { api: { settings: { set: (patch: unknown) => Promise<unknown> } } }
}

test.describe.serial('driver 通道实验设置（v2）', () => {
  let app: LaunchedApp

  test.beforeAll(async () => {
    app = await launchApp()
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
  })

  async function gotoSettings(): Promise<void> {
    await app.page.locator('.el-menu-item').filter({ hasText: '系统设置' }).click()
    await waitForRoute(app.page, '/settings')
    await expect(app.page.getByTestId('save-print-btn')).toBeVisible()
  }

  /** 测试进程侧直读 settings 表（E2E_USER_DATA_DIR 隔离库） */
  function readSetting(key: string): string | null {
    const db = new Database(app.dbPath, { readonly: true })
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      return row ? row.value : null
    } finally {
      db.close()
    }
  }

  /** 展开高级折叠区（EP input-number fill+Enter commit 模式同 template-editor E2E） */
  async function expandAdvanced(page: Page): Promise<void> {
    const title = page.getByTestId('driver-advanced-collapse-title')
    const input = page.getByTestId('driver-dpi-input')
    if (!(await input.isVisible().catch(() => false))) {
      await title.click()
    }
    await expect(input).toBeVisible()
  }

  /**
   * 点保存并等成功 toast：用 .last()——ElMessage 追加式渲染，上一场景的 3s 时效
   * toast 可能仍在场（serial 场景间隔短），最新一条才是本次保存的回执。
   */
  async function savePrintAndExpectSuccess(page: Page): Promise<void> {
    await page.getByTestId('save-print-btn').click()
    await expect(
      page.locator('.el-message--success', { hasText: '打印设置已保存' }).last()
    ).toBeVisible()
  }

  test('场景一：折叠区常驻渲染 + 非 driver 通道「仅 driver 通道生效」标注 + A4 兜底警告在场', async () => {
    const { page } = app
    await gotoSettings()

    // 常驻可见：默认 spooler 通道下折叠区也在（不隐藏——避免用户切通道后找不到开关）
    const collapse = page.getByTestId('driver-advanced-collapse')
    await expect(collapse).toBeVisible()
    await expect(page.getByTestId('driver-advanced-collapse-title')).toContainText(
      '打印高级选项（实验）'
    )

    // 展开 → dpi 输入 + 页尺寸开关 + 说明文案
    await expandAdvanced(page)
    await expect(page.getByTestId('driver-page-size-switch')).toBeVisible()
    await expect(page.getByTestId('driver-dpi-hint')).toContainText('热敏打印机常见 203')
    await expect(page.getByTestId('driver-dpi-hint')).toContainText('诊断报告会记录')

    // A4 兜底警告（最优先文案护栏）
    const warning = page.getByTestId('driver-page-size-warning')
    await expect(warning).toContainText('启用后由驱动决定页尺寸')
    await expect(warning).toContainText('回退 A4')
    await expect(warning).toContainText('按 A4 分页')

    // spooler 通道 → inert 标注可见；切 driver → 消失；切回 → 复现
    const inertHint = page.getByTestId('driver-advanced-inert-hint')
    await expect(inertHint).toBeVisible()
    await expect(inertHint).toContainText('仅 driver 通道生效')
    await page.locator('.el-radio', { hasText: '驱动渲染' }).click()
    await expect(inertHint).toHaveCount(0)
    await page.locator('.el-radio', { hasText: '系统打印机' }).click()
    await expect(inertHint).toBeVisible()

    await page.screenshot({ path: '.omo/evidence/v2-task-8-advanced-collapse.png' })
  })

  test('场景二：dpi=203 + 默认页尺寸开 → 保存成功 → DB 落库 → 重进设置页回显', async () => {
    const { page } = app
    await gotoSettings()
    await expandAdvanced(page)

    // EP input-number 输入（fill + Enter commit——同 template-editor E2E 模式）
    const dpiInput = page.getByTestId('driver-dpi-input').locator('input')
    await dpiInput.fill('203')
    await dpiInput.press('Enter')
    await page.getByTestId('driver-page-size-switch').click()

    await savePrintAndExpectSuccess(page)

    // DB 断言（真实 IPC 往返——序列化：数字→十进制串 / true→'1'）
    expect(readSetting('driver_dpi')).toBe('203')
    expect(readSetting('driver_use_default_page_size')).toBe('1')

    // 离开 → 重进 → 回显
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')
    await gotoSettings()
    await expandAdvanced(page)
    await expect(page.getByTestId('driver-dpi-input').locator('input')).toHaveValue('203')
    await expect(page.getByTestId('driver-page-size-switch')).toHaveClass(/is-checked/)

    await page.screenshot({ path: '.omo/evidence/v2-task-8-e2e.png' })
  })

  test('场景三：dpi 清空保存 → 清除路径（null ≡ 空串）→ DB 空串 + 回显为空', async () => {
    const { page } = app
    await gotoSettings()
    await expandAdvanced(page)

    // EP input-number 清空 emit null（EP valueOnClear 默认）→ fill 空串 + Enter commit
    const dpiInput = page.getByTestId('driver-dpi-input').locator('input')
    await dpiInput.fill('')
    await dpiInput.press('Enter')

    await savePrintAndExpectSuccess(page)

    // 清除路径 DB 断言：driver_dpi 空串（null ≡ ''）；页尺寸开关未动 → true 保持
    expect(readSetting('driver_dpi')).toBe('')
    expect(readSetting('driver_use_default_page_size')).toBe('1')

    // 重进 → 回显为空（placeholder 态）+ 开关保持开
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')
    await gotoSettings()
    await expandAdvanced(page)
    await expect(page.getByTestId('driver-dpi-input').locator('input')).toHaveValue('')
    await expect(page.getByTestId('driver-page-size-switch')).toHaveClass(/is-checked/)
  })

  test('场景四：非法值拒绝——真实 IPC 中文报错（含值回显）+ UI 保存失败 toast 回显', async () => {
    const { page } = app
    await gotoSettings()
    await expandAdvanced(page)

    // ① 真实 IPC（无 mock）：直接 invoke 越界 13 → 主进程 validateSettingsPatch throw
    const errDpi = await page.evaluate(async () => {
      try {
        await (globalThis as unknown as RendererGlobal).window.api.settings.set({
          driver_dpi: 13
        })
        return ''
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    })
    expect(errDpi).toContain('driver_dpi 需为 50-1200 的整数（热敏打印机常见 203/300）')
    expect(errDpi).toContain('当前值：13')

    // 字符串类型拒绝：回显保留类型形态（带引号）
    const errStr = await page.evaluate(async () => {
      try {
        await (globalThis as unknown as RendererGlobal).window.api.settings.set({
          driver_dpi: '203'
        })
        return ''
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    })
    expect(errStr).toContain('driver_dpi 需为 50-1200 的整数')
    expect(errStr).toContain('当前值："203"')

    // 非法页尺寸类型拒绝
    const errBool = await page.evaluate(async () => {
      try {
        await (globalThis as unknown as RendererGlobal).window.api.settings.set({
          driver_use_default_page_size: 1
        })
        return ''
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    })
    expect(errBool).toContain('driver_use_default_page_size 仅接受 true/false（缺省 false）')
    expect(errBool).toContain('当前值：1')

    // ② UI 回显链路：重挂 settings:set throw 同款报错（diagnosis.spec.ts 注入模式；
    //    UI input-number 越界被 clamp，真实校验对 UI 不可达——mock 只补 toast 渲染半边）
    await app.electronApp.evaluate((electron) => {
      electron.ipcMain.removeHandler('settings:set')
      electron.ipcMain.handle('settings:set', async () => {
        throw new Error(
          'driver_dpi 需为 50-1200 的整数（热敏打印机常见 203/300），当前值：13'
        )
      })
    })

    await page.getByTestId('save-print-btn').click()
    const toast = page.locator('.el-message--error', { hasText: '保存失败' })
    await expect(toast).toBeVisible()
    // toast 回显剥除 invoke 前缀后的中文报错全文（含值回显）
    await expect(toast).toContainText('保存失败：driver_dpi 需为 50-1200 的整数')
    await expect(toast).toContainText('当前值：13')
    await expect(toast).not.toContainText('Error invoking remote method')

    // 保存被拒 → DB 值不变（场景三的清除态保持：dpi 空串 / 页尺寸 '1'）
    expect(readSetting('driver_dpi')).toBe('')
    expect(readSetting('driver_use_default_page_size')).toBe('1')

    await page.screenshot({ path: '.omo/evidence/v2-task-8-validation-toast.png' })
  })
})
