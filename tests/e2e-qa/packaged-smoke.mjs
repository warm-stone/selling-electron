/**
 * F3 终审 QA — B11：打包产物冒烟（electron-builder --dir → linux-unpacked）。
 *
 * 启动 unpacked 二进制（DISPLAY=:0 + E2E_USER_DATA_DIR 隔离）→
 * 断言：主窗口出现 + 首启建库（pos.db 落地）+ 导航可用。
 */
import { _electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const EVIDENCE = '.omo/evidence/final-qa'
const log = (line) => appendFileSync(join(EVIDENCE, 'qa-run.log'), `${new Date().toISOString()} ${line}\n`)

const exe = 'release/linux-unpacked/selling-electron'
if (!existsSync(exe)) {
  console.error(`B11 FAIL: 产物二进制不存在: ${exe}`)
  process.exit(1)
}

const userDataDir = mkdtempSync(join('/tmp/opencode', 'qa-packaged-'))
mkdirSync(EVIDENCE, { recursive: true })

const app = await _electron.launch({
  executablePath: exe,
  args: [exe],
  env: { ...process.env, E2E_USER_DATA_DIR: userDataDir }
})

try {
  const page = await app.firstWindow()
  const url = page.url()
  console.log('B11 窗口 URL:', url)

  await page.waitForURL((u) => u.hash === '#/pos', { timeout: 15_000 })

  const menuItems = await page.locator('.el-menu-item').count()
  console.log('B11 侧边菜单项数:', menuItems)
  if (menuItems !== 7) throw new Error(`期望 7 个菜单项，实际 ${menuItems}`)

  await page.locator('.el-menu-item').filter({ hasText: '商品管理' }).click()
  await page.waitForURL((u) => u.hash === '#/products', { timeout: 10_000 })
  console.log('B11 导航 → /products OK')

  await page.screenshot({ path: `${EVIDENCE}/b11-packaged-smoke.png` })

  const dbPath = join(userDataDir, 'pos.db')
  if (!existsSync(dbPath)) throw new Error(`首启建库失败: ${dbPath} 不存在`)
  console.log('B11 首启建库 OK:', dbPath)

  const asar = 'release/linux-unpacked/resources/app.asar'
  if (!existsSync(asar)) throw new Error('app.asar 缺失')
  console.log('B11 app.asar OK')

  log('B11 PASS: unpacked 产物启动 + 窗口/导航/首启建库/asar 全通过')
  console.log('B11 SMOKE: PASS')
} finally {
  await app.close()
}
