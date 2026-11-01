import { _electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface LaunchedApp {
  electronApp: ElectronApplication
  page: Page
  /** 本次运行的隔离 userData 目录（E2E_USER_DATA_DIR 重定向） */
  userDataDir: string
  /** 隔离目录下的 DB 路径（Task 2 initDatabase 落地后为 userData/pos.db） */
  dbPath: string
}

/**
 * 启动被测应用：构建产物入口（package.json main → out/main/index.js），
 * userData 重定向到临时目录——E2E 绝不触碰真实用户数据。
 */
export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pos-e2e-'))
  const electronApp = await _electron.launch({
    args: ['.'],
    env: { ...process.env, E2E_USER_DATA_DIR: userDataDir }
  })
  const page = await electronApp.firstWindow()
  return { electronApp, page, userDataDir, dbPath: join(userDataDir, 'pos.db') }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  await launched.electronApp.close()
}

/** 等待 hash 路由到达指定路径（如 waitForRoute(page, '/pos') → URL 为 #/pos） */
export async function waitForRoute(page: Page, path: string): Promise<void> {
  await page.waitForURL((url) => url.hash === `#${path}`, { timeout: 10_000 })
}
