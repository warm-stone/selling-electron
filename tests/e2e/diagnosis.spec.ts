import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { analyzeSnapshot } from '../../src/main/printing/diagnostics/analyze'
import type {
  DiagnosticReport,
  PrintDiagnosticSnapshot
} from '../../src/main/printing/diagnostics/schema'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/**
 * 打印机诊断 E2E（printer-diagnostics Wave 4 / T10）。
 *
 * 场景（计划三场景 + 证据补充场景）：
 *  1. 面板与按钮渲染：设置页第四张卡片「打印机诊断」存在，「开始诊断」可见；
 *     无报告时「导出报告」禁用
 *  2. 非 Windows 平台守卫（G11 真实链路，win32 跳过）：点「开始诊断」→ 主进程
 *     平台守卫 {ok:false} → error toast 含「仅 Windows」，UI 不崩
 *  3. 导出按钮禁用态：无报告（Linux 诊断失败后）仍 disabled
 *  4. 报告三区渲染（依赖注入）：主进程 ipcMain 重挂 printing:diagnose 返回
 *     fixture 报告（真实 analyzeSnapshot 产出）→ 对话框三区/打印机行/发现徽章
 *  5. L2 修复确认流：PURGE 按钮弹 ElMessageBox 破坏半径文案 → 确认 → repair
 *     返回 done+verify → 成功 toast + 徽章翻「已验证」
 *  6. UAC 拒绝路径：repair 返回 needs-manual outcome → info 提示（非红条）
 *  7. 导出真实链路：报告就位后导出 → E2E_EXPORT_DIR 钩子直写 txt（BOM）→
 *     成功 toast 带路径
 *
 * mock 策略：_electron 启动真 app，renderer 侧 mock 不可达（contextBridge 只读）；
 * 依赖注入落在主进程 IPC 边界——ipcMain.removeHandler + handle 重挂（mock 的
 * 报告/结果为纯 JSON，无真实打印机/PowerShell 依赖，Linux CI 可跑）。报告由
 * 真实 analyzeSnapshot 从 T2 fixtures 产出（findings 不手造）。
 */

/** fixture 快照 → 真实 analyzeSnapshot 报告（渲染输入；findings 零手造） */
function buildReport(fixtureName: string, collectedAt: string): DiagnosticReport {
  const snapshot = JSON.parse(
    readFileSync(`tests/unit/printing/diagnostics/fixtures/${fixtureName}.json`, 'utf8')
  ) as PrintDiagnosticSnapshot
  return { schemaVersion: 1, collectedAt, snapshot, findings: analyzeSnapshot(snapshot) }
}

/** spooler-dead 报告，复核后形态（spooler-stopped → verify-passed） */
function spoolerDeadVerifyPassed(collectedAt: string): DiagnosticReport {
  const report = buildReport('spooler-dead', collectedAt)
  report.findings[0]!.status = 'verify-passed'
  return report
}

test.describe.serial('打印机诊断（T10）', () => {
  let app: LaunchedApp
  let exportDir: string

  test.beforeAll(async () => {
    // E2E_EXPORT_DIR：diagnostics.ipc exportFn 的测试钩子（跳过保存对话框直写文件）
    exportDir = mkdtempSync(join(tmpdir(), 'pos-e2e-diag-export-'))
    process.env['E2E_EXPORT_DIR'] = exportDir
    app = await launchApp()
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    delete process.env['E2E_EXPORT_DIR']
  })

  async function gotoSettings(): Promise<void> {
    // 上一场景可能遗留打开的诊断对话框——先收起（modal overlay 会拦截侧边栏菜单点击）
    const closeBtn = app.page.getByTestId('diagnosis-dialog-close')
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click()
      await app.page.locator('[data-testid="diagnosis-dialog"]').waitFor({ state: 'hidden' })
    }
    await app.page.locator('.el-menu-item').filter({ hasText: '系统设置' }).click()
    await waitForRoute(app.page, '/settings')
    await expect(app.page.getByTestId('diagnosis-start-btn')).toBeVisible()
  }

  /** 主进程重挂 diagnose handler 返回 fixture 报告（依赖注入点） */
  async function mockDiagnose(report: DiagnosticReport): Promise<void> {
    await app.electronApp.evaluate((electron, payload: DiagnosticReport) => {
      electron.ipcMain.removeHandler('printing:diagnose')
      electron.ipcMain.handle('printing:diagnose', async () => ({ ok: true, report: payload }))
    }, report)
  }

  /** 主进程重挂 repair handler 返回固定 outcome（done+verify / needs-manual） */
  async function mockRepair(
    outcome: { status: 'done' | 'needs-manual' | 'dry-run'; detail?: string },
    verify?: DiagnosticReport
  ): Promise<void> {
    await app.electronApp.evaluate(
      (
        electron,
        payload: { outcome: { status: string; detail?: string }; verify?: DiagnosticReport }
      ) => {
        electron.ipcMain.removeHandler('printing:repair')
        // res 信封：ok=true + outcome + verify（preload/invoke 原样回传）
        electron.ipcMain.handle('printing:repair', async () => ({ ok: true, ...payload }))
      },
      { outcome, verify }
    )
  }

  test('场景一：第四张卡片「打印机诊断」渲染 + 无报告时导出禁用', async () => {
    const { page } = app
    await gotoSettings()

    const card = page.locator('.diagnosis-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('打印机诊断')
    await expect(card).toContainText('一键采集环境、定位根因')
    await expect(page.getByTestId('diagnosis-start-btn')).toBeVisible()
    await expect(page.getByTestId('diagnosis-start-btn')).toBeEnabled()

    const exportBtn = page.getByTestId('diagnosis-export-btn')
    await expect(exportBtn).toBeVisible()
    await expect(exportBtn).toBeDisabled()

    await page.screenshot({ path: '.omo/evidence/task-10-panel-render.png' })
  })

  test('场景二：非 Windows 平台守卫（G11）——点「开始诊断」得 error toast，UI 不崩', async () => {
    test.skip(process.platform === 'win32', '本场景验证非 Windows 平台守卫——Windows 真机链路见 docs/windows-manual-checklist.md 第 10 节')
    const { page } = app
    await gotoSettings()

    await page.getByTestId('diagnosis-start-btn').click()
    const errorToast = page.locator('.el-message--error', { hasText: '仅 Windows' })
    await expect(errorToast).toBeVisible()

    // 错误态对话框收起（el-dialog 关闭保留 DOM 节点——断言隐藏而非卸载）；按钮回到可点
    await expect(page.locator('[data-testid="diagnosis-dialog"]')).toBeHidden()
    await expect(page.getByTestId('diagnosis-start-btn')).toBeEnabled()
    await page.screenshot({ path: '.omo/evidence/task-10-diagnosis-error.png' })
  })

  test('场景三：无报告（诊断失败后）导出按钮保持禁用', async () => {
    const { page } = app
    await gotoSettings()
    await expect(page.getByTestId('diagnosis-export-btn')).toBeDisabled()
  })

  test('场景四：注入 fixture 报告 → 对话框三区渲染 + 导出解锁', async () => {
    const { page } = app
    await gotoSettings()
    await mockDiagnose(buildReport('printer-name-mismatch', '2026-11-12T10:00:00+08:00'))

    await page.getByTestId('diagnosis-start-btn').click()

    // 区 1：spooler Running → success tag「运行中」
    const system = page.locator('[data-testid="diagnosis-zone-system"]')
    await expect(system).toBeVisible()
    await expect(system).toContainText('运行中')
    await expect(system).toContainText('Operational')

    // 区 2：打印机行（名称 + 在线 tag + 驱动 + 端口）
    const printerRow = page.locator('[data-testid="diagnosis-printer-row"]')
    await expect(printerRow).toHaveCount(1)
    await expect(printerRow.first()).toContainText('POS-80 (副本 2)')
    await expect(printerRow.first()).toContainText('在线')

    // 区 3：printer-name-mismatch 发现（[高] + 待处理徽章 + 人工引导）
    const findings = page.locator('[data-testid="diagnosis-finding"]')
    await expect(findings).toHaveCount(1)
    await expect(findings.first()).toContainText('[高]')
    await expect(findings.first()).toContainText('在系统中不存在')
    await expect(page.locator('[data-testid="finding-badge-pending"]')).toContainText('待处理')
    await expect(findings.first()).toContainText('人工处理步骤')

    // 报告就位 → 卡片导出按钮解锁
    await expect(page.getByTestId('diagnosis-export-btn')).toBeEnabled()

    await page.screenshot({ path: '.omo/evidence/task-10-report-render.png' })
  })

  test('场景五：L2 修复确认流——PURGE 破坏半径文案 → 确认 → done+verify → 徽章「已验证」', async () => {
    const { page } = app
    await gotoSettings()
    const verifyReport = spoolerDeadVerifyPassed('2026-11-12T10:01:00+08:00')
    await mockDiagnose(buildReport('spooler-dead', '2026-11-12T10:00:00+08:00'))
    await mockRepair({ status: 'done' }, verifyReport)

    await page.getByTestId('diagnosis-start-btn').click()
    await expect(page.locator('[data-testid="diagnosis-finding"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="diagnosis-finding"]')).toContainText('[严重]')
    await expect(page.locator('[data-testid="diagnosis-finding"]')).toContainText('Stopped')

    // L2 按钮 → ElMessageBox 破坏半径文案（计划逐字锁定）
    await page.getByTestId('repair-btn-PURGE_QUEUE_RESTART_SPOOLER').click()
    const box = page.locator('.el-message-box')
    await expect(box).toBeVisible()
    await expect(box).toContainText('将停止打印服务并清空本机所有打印机的队列任务')
    await page.screenshot({ path: '.omo/evidence/task-10-repair-flow.png' })

    await box.getByRole('button', { name: '执行' }).click()

    // repair 返回 done + verify → 成功 toast + 报告刷新为「已验证」
    await expect(page.locator('.el-message--success', { hasText: '修复动作已执行' })).toBeVisible()
    await expect(page.locator('[data-testid="finding-badge-verify-passed"]')).toContainText('已验证')
    await expect(page.locator('[data-testid="repair-btn-PURGE_QUEUE_RESTART_SPOOLER"]')).toHaveCount(0)
  })

  test('场景六：UAC 拒绝路径——repair 返回 needs-manual → info 提示（非红条）', async () => {
    const { page } = app
    await gotoSettings()
    await mockDiagnose(buildReport('spooler-dead', '2026-11-12T10:02:00+08:00'))
    await mockRepair({
      status: 'needs-manual',
      detail: '用户取消了管理员授权（UAC），未执行任何系统改动——可稍后重试；若不便授权，请按报告引导人工处理'
    })

    await page.getByTestId('diagnosis-start-btn').click()
    await expect(page.getByTestId('repair-btn-PURGE_QUEUE_RESTART_SPOOLER')).toBeVisible()

    await page.getByTestId('repair-btn-PURGE_QUEUE_RESTART_SPOOLER').click()
    const box = page.locator('.el-message-box')
    await box.getByRole('button', { name: '执行' }).click()

    // needs-manual → info toast（引导文案，非 error 红条）
    await expect(
      page.locator('.el-message--info', { hasText: '用户取消了管理员授权' })
    ).toBeVisible()
    await expect(page.locator('.el-message--error')).toHaveCount(0)
    // 无 verify → 报告未刷新，finding 仍 pending（按钮保留可重试）
    await expect(page.locator('[data-testid="finding-badge-pending"]')).toBeVisible()
  })

  test('场景七：导出真实链路——E2E_EXPORT_DIR 直写 txt（BOM + 报告正文）+ 成功 toast', async () => {
    const { page } = app
    await gotoSettings()
    // 报告已在场景六就位（spooler-dead pending）
    await expect(page.getByTestId('diagnosis-export-btn')).toBeEnabled()

    await page.getByTestId('diagnosis-export-btn').click()

    await expect(
      page.locator('.el-message--success', { hasText: '报告已导出' })
    ).toBeVisible()

    const files = readdirSync(exportDir)
    expect(files.length).toBeGreaterThanOrEqual(1)
    const exported = readFileSync(join(exportDir, files[0]!))
    expect(exported[0]).toBe(0xef) // UTF-8 BOM（T8 契约：EF BB BF）
    expect(exported[1]).toBe(0xbb)
    expect(exported[2]).toBe(0xbf)
    const text = exported.toString('utf8').slice(1)
    expect(text).toContain('打印机诊断报告')
    expect(text).toContain('spooler-stopped')
    expect(text).toContain('\r\n')

    copyFileSync(join(exportDir, files[0]!), '.omo/evidence/task-10-export.txt')
  })
})
