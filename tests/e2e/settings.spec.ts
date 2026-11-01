import { existsSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { test, expect } from '@playwright/test'
import { closeApp, launchApp, waitForRoute, type LaunchedApp } from './helpers'

/**
 * 系统设置页 E2E（Task 19）。
 *
 * 场景（验收调整版：预览变量闭环 deferred 到 T15，本任务验收为
 * DB 值正确 + 重新进入页面回显 + 测试打印字节到达）：
 *  1. 店名保存 → settings 表 DB 断言 + 离开再进入页面回显
 *  2. tcp 通道 + 127.0.0.1:19910 mock server → 测试打印 → 字节含 1b40
 *  3. spooler 优雅降级（Linux 无打印机）：下拉仅「自动选择」不崩溃；测试打印错误 toast 含通道名
 *  4. Logo 上传（E2E patch dialog.showOpenDialog 注入固定 png）→ DB logo_path +
 *     dataURL 预览 + 清除
 */

/** 1×1 透明 PNG（上传/预览断言用） */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const MOCK_PRINT_HOST = '127.0.0.1'
const MOCK_PRINT_PORT = 19910

test.describe.serial('系统设置页（Task 19）', () => {
  let app: LaunchedApp
  let mockServer: net.Server
  const receivedChunks: Buffer[] = []

  test.beforeAll(async () => {
    app = await launchApp()
    // mock 打印机 TCP server（T7 测试模式：127.0.0.1:19910）
    mockServer = net.createServer((socket) => {
      socket.on('data', (chunk: Buffer) => receivedChunks.push(chunk))
      socket.on('end', () => socket.end())
    })
    await new Promise<void>((resolve) => mockServer.listen(MOCK_PRINT_PORT, MOCK_PRINT_HOST, resolve))
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    await new Promise<void>((resolve) => mockServer.close(() => resolve()))
  })

  async function gotoSettings(): Promise<void> {
    await app.page.locator('.el-menu-item').filter({ hasText: '系统设置' }).click()
    await waitForRoute(app.page, '/settings')
    await expect(app.page.getByTestId('save-shop-btn')).toBeVisible()
  }

  /** 测试进程侧直读 settings 表（E2E_USER_DATA_DIR 隔离库） */
  function readSetting(key: string): string | null {
    const db = new Database(app.dbPath, { readonly: true })
    try {
      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(key) as { value: string } | undefined
      return row ? row.value : null
    } finally {
      db.close()
    }
  }

  test('店铺信息保存：DB 值正确 + 离开再进入回显', async () => {
    const { page } = app
    await gotoSettings()

    await page.getByTestId('shop-name-input').fill('我的小店')
    await page.getByTestId('shop-phone-input').fill('13800000000')
    await page.getByTestId('receipt-note-input').fill('谢谢惠顾')
    await page.getByTestId('save-shop-btn').click()

    await expect(page.locator('.el-message--success', { hasText: '店铺信息已保存' })).toBeVisible()

    // DB 断言（settings 表 KV）
    expect(readSetting('shop_name')).toBe('我的小店')
    expect(readSetting('shop_phone')).toBe('13800000000')
    expect(readSetting('receipt_note')).toBe('谢谢惠顾')

    // 离开 → 重新进入 → 回显（变量闭环 deferred T15 前的回显级验收）
    await page.locator('.el-menu-item').filter({ hasText: '收银台' }).click()
    await waitForRoute(page, '/pos')
    await gotoSettings()

    await expect(page.getByTestId('shop-name-input')).toHaveValue('我的小店')
    await expect(page.getByTestId('shop-phone-input')).toHaveValue('13800000000')
    await expect(page.getByTestId('receipt-note-input')).toHaveValue('谢谢惠顾')
    await page.screenshot({ path: '.omo/evidence/task-19-shopname-flow.png' })
  })

  test('打印设置保存（tcp 通道）：DB 值正确', async () => {
    const { page } = app

    await page.locator('.el-radio', { hasText: '网络打印机' }).click()
    await page.getByTestId('tcp-host-input').fill(MOCK_PRINT_HOST)
    await page.getByTestId('tcp-port-input').fill(String(MOCK_PRINT_PORT))
    await page.locator('.auto-cut-switch').click() // 默认开 → 切关

    await page.getByTestId('save-print-btn').click()
    await expect(page.locator('.el-message--success', { hasText: '打印设置已保存' })).toBeVisible()

    expect(readSetting('printer_channel')).toBe('tcp')
    expect(readSetting('tcp_host')).toBe(MOCK_PRINT_HOST)
    expect(readSetting('tcp_port')).toBe(String(MOCK_PRINT_PORT))
    expect(readSetting('auto_cut')).toBe('0')
  })

  test('测试打印（tcp 通道）：mock server 收到最小 ESC/POS 字节（含 1b40）', async () => {
    const { page } = app
    receivedChunks.length = 0

    await page.getByTestId('test-print-btn').click()
    await expect(page.locator('.el-message--success', { hasText: '测试打印已发送' })).toBeVisible()

    const receivedHex = (): string => Buffer.concat(receivedChunks).toString('hex')
    await expect.poll(receivedHex, { timeout: 5_000 }).toContain('1b40')
    // ESC @ 初始化 + ESC a 1 居中 + 'test' + LF×2 + GS V 66 0 全切（T4 契约字节逐段断言）
    expect(receivedHex()).toContain('1b6101')
    expect(receivedHex()).toContain(Buffer.from('test', 'ascii').toString('hex'))
    expect(receivedHex()).toContain('1d564200')
  })

  test('无打印机环境优雅降级（Linux spooler）：下拉不崩溃显示「自动选择」，测试打印错误 toast 含通道名', async () => {
    const { page } = app

    // 切回 spooler 通道（仅表单值，测试打印用当前表单值）
    await page.locator('.el-radio', { hasText: '系统打印机' }).click()
    await expect(page.locator('.printer-select')).toContainText('自动选择')

    // Linux 无打印子系统：printers 列表为空 → 下拉仅「自动选择」，不崩溃
    await page.locator('.printer-select').click()
    await expect(page.locator('.el-select-dropdown__item')).toHaveCount(1)
    await expect(page.locator('.el-select-dropdown__item')).toHaveText('自动选择')
    await page.locator('.el-select-dropdown__item').filter({ hasText: '自动选择' }).click()

    // spooler 在 Linux 不可用：错误被捕获为 error toast（含通道名），非崩溃
    await page.getByTestId('test-print-btn').click()
    const errorToast = page.locator('.el-message--error', { hasText: '测试打印失败' }).first()
    await expect(errorToast).toBeVisible()
    await expect(errorToast).toContainText('spooler')

    await page.screenshot({ path: '.omo/evidence/task-19-graceful-degrade.png' })
  })

  test('Logo 上传（patch dialog 注入 png）→ DB logo_path + dataURL 预览 + 清除', async () => {
    const { page } = app

    // E2E 注入固定 png：写入临时文件 + patch 主进程 dialog.showOpenDialog
    const srcLogo = join(app.userDataDir, 'e2e-logo-src.png')
    writeFileSync(srcLogo, Buffer.from(PNG_1PX_BASE64, 'base64'))
    await app.electronApp.evaluate((electron, logoPath: string) => {
      electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [logoPath] })
    }, srcLogo)

    await page.getByTestId('upload-logo-btn').click()
    await expect(page.locator('.el-message--success', { hasText: 'Logo 已更新' })).toBeVisible()

    // 预览：img dataURL
    const preview = page.getByTestId('logo-preview')
    await expect(preview).toBeVisible()
    const src = await preview.getAttribute('src')
    expect(src).toMatch(/^data:image\/png;base64,/)

    // DB：文件系统 + 路径引用（非 BLOB），指向 userData/logos/logo.png
    const expectedLogoPath = join(app.userDataDir, 'logos', 'logo.png')
    expect(readSetting('logo_path')).toBe(expectedLogoPath)
    expect(existsSync(expectedLogoPath)).toBe(true)

    // 清除 → 预览消失 + DB 归空
    await page.getByTestId('clear-logo-btn').click()
    await expect(page.locator('.el-message--success', { hasText: 'Logo 已清除' })).toBeVisible()
    await expect(page.getByTestId('logo-preview')).toHaveCount(0)
    expect(readSetting('logo_path') ?? '').toBe('')
  })
})
