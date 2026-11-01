/**
 * F3 终审 QA 共享工具——复用基线 helpers（launchApp 隔离环境）
 * + 扫码枪注入（S6 定案）+ 证据落盘工具。
 */
import type { ElectronApplication, Page } from 'playwright'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export { launchApp, closeApp, waitForRoute, type LaunchedApp } from '../e2e/helpers'

/** 终审证据目录（每场景截图/输出） */
export const EVIDENCE = '.omo/evidence/final-qa'

export function evidenceLog(line: string): void {
  mkdirSync(EVIDENCE, { recursive: true })
  appendFileSync(join(EVIDENCE, 'qa-run.log'), `${new Date().toISOString()} ${line}\n`)
}

/** 扫码枪注入（S6 定案）：主进程 keyDown 连发（10ms < 50ms 阈值）+ Enter */
export async function scanBarcode(
  electronApp: ElectronApplication,
  code: string
): Promise<void> {
  await electronApp.evaluate(
    async (electron, { code: barcode }) => {
      const win = electron.BrowserWindow.getAllWindows()[0]
      const wc = win?.webContents
      if (!wc) throw new Error('QA: 未找到主窗口')
      for (const ch of barcode) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        await new Promise((r) => setTimeout(r, 10))
      }
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    },
    { code }
  )
}

/** 今日 'YYYY-MM-DD'（与主进程 localtime 同钟） */
export function todayYmd(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 隔离导出目录（T17 钩子 E2E_EXPORT_DIR）——系统临时目录（跨平台，G11） */
export function makeExportDir(): string {
  return mkdtempSync(join(tmpdir(), 'qa-exports-'))
}

/** SPA 路由离开再回来（等价刷新，规避 file:// 重载竞态——T8 learnings） */
export async function revisit(page: Page, menuText: string, route: string): Promise<void> {
  await page.locator('.el-menu-item').filter({ hasText: menuText }).click()
  await page.waitForURL((url) => url.hash === `#${route}`, { timeout: 10_000 })
}

/** mock 热敏打印机 TCP server（对端 FIN 后回 FIN） */
export async function startPrintMock(port: number, received: Buffer[]): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk: Buffer) => received.push(chunk))
    socket.on('end', () => socket.end())
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}
