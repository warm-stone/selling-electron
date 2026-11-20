import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { initDatabase } from './db/database'
import { detectDbState, removeDbFiles } from './db/legacy-db'
import { initLogger, logError, logWarn } from './common/logger'
import { registerCustomersIpc } from './ipc/customers.ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics.ipc'
import { registerReportsExportIpc } from './ipc/reports-export.ipc'
import { registerReportsIpc } from './ipc/reports.ipc'
import { registerPrintingIpc } from './ipc/printing.ipc'
import { registerProductsIpc } from './ipc/products.ipc'
import { registerPurchasesIpc } from './ipc/purchases.ipc'
import { registerSalesIpc } from './ipc/sales.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerTemplatesIpc } from './ipc/templates.ipc'
import { attachScannerBridge } from './scanner/scanner-bridge'

// ── E2E 数据隔离（Task 6）：测试进程通过环境变量注入临时 userData，避免污染真实用户数据 ──
// 必须在 app ready 前设置；正常 dev/生产环境不注入该变量，零影响
if (process.env['E2E_USER_DATA_DIR']) {
  app.setPath('userData', process.env['E2E_USER_DATA_DIR'])
}

// ── P2-3：进程级异常兜底 + 文件日志（userData/logs/main.log，同步写 + 1MB 轮转）──
// 此前主进程零日志、零异常兜底：崩溃无现场、renderer 进程消失白屏无恢复。
initLogger(join(app.getPath('userData'), 'logs'))

// uncaughtException：主进程状态已不可信——同步落日志后受控退出（不带病运行；
// 销售已落库不受影响，重开应用可从销售记录重打小票——G3 既有语义）
process.on('uncaughtException', (error) => {
  logError('uncaughtException', error)
  app.exit(1)
})

// unhandledRejection：多为 IPC/打印链路的漏网 Promise——记录后继续运行
// （业务失败本就有 { ok:false } / reject 回传 renderer，此处仅兜「没人接」的）
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason)
})

// renderer 进程崩溃（OOM/原生崩溃）：记录后重载页面降级恢复——renderer 无
// 持久状态（购物车不持久化是已知设计边界），重载成本低、白屏不可接受
app.on('render-process-gone', (_event, webContents, details) => {
  logError(
    'render-process-gone',
    new Error(`reason=${details.reason} exitCode=${details.exitCode}`)
  )
  if (!webContents.isDestroyed()) {
    webContents.reload()
  }
})

// GPU/utility 等子进程消失：仅留痕（Electron 会自动重启必要子进程，不干预）
app.on('child-process-gone', (_event, details) => {
  logWarn('child-process-gone', `type=${details.type} reason=${details.reason}`)
})

/**
 * 旧库清理确认（仅 LEGACY_DB_PROMPT_VERSION 版本生效——用户定案「仅本版本有效」）：
 * 迁移合并后旧增量库不兼容，migrator 守卫会直接报错拒启动；本版本升级为
 * 启动期确认弹窗引导用户删除旧数据以继续（或退出自行备份）。
 * 版本号变更后本段自动失效（回落 migrator 报错防线），届时可整体移除。
 *
 * @returns true=继续启动；false=用户选择退出（调用方 app.exit）
 */
const LEGACY_DB_PROMPT_VERSION = '1.0.0-beta'

function confirmLegacyDbCleanup(): boolean {
  if (app.getVersion() !== LEGACY_DB_PROMPT_VERSION) return true
  const dir = app.getPath('userData')
  if (detectDbState(dir) !== 'legacy') return true

  logWarn('legacy-db', `检测到不兼容旧库，弹窗询问是否删除（userData: ${dir}）`)
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: '检测到旧版本数据',
    message: `检测到旧版本「销存系统」的数据库，与当前版本（${LEGACY_DB_PROMPT_VERSION}）不兼容。`,
    detail:
      '继续使用前需要删除旧数据：库中全部商品、进货与销售记录将被清空，且不可恢复。\n' +
      '如需保留数据，请点击「退出」，并自行备份数据目录中的 pos.db（含 -wal / -shm 文件）。\n\n' +
      '是否删除旧数据并继续？',
    buttons: ['退出', '删除旧数据并继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (choice !== 1) return false

  removeDbFiles(dir)
  logWarn('legacy-db', '旧库已删除（含 -wal/-shm），将按初始化 schema 重建')
  return true
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 拒绝新窗口，外部链接交给系统默认浏览器。
  // P3 安全：scheme 白名单——仅放行 http/https；file://、自定义协议处理程序等
  // 一律拒绝（renderer 不加载远程内容，此为纵深防御；非法 URL 同样拒绝）
  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const protocol = new URL(details.url).protocol
      if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(details.url)
      } else {
        logWarn('window-open', `已拒绝非 http(s) 协议的外链打开：${protocol}`)
      }
    } catch {
      logWarn('window-open', `已拒绝非法 URL 的外链打开：${details.url}`)
    }
    return { action: 'deny' }
  })

  // 扫码枪桥（Task 11 装配 T5 交付）：命中条码由 bridge 内部统一 send('scanner:barcode')
  // 推给 preload.onBarcode；onBarcode 回调为主进程侧扩展位，无额外动作故传空。
  attachScannerBridge(mainWindow, () => {})

  // dev：加载 electron-vite HMR 服务；prod：加载本地构建产物
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── 单实例锁：第二实例直接退出，并聚焦已有窗口 ──
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // 旧库确认（仅 1.0.0-beta 生效）：用户拒绝删除 → 直接退出，不触碰旧数据
    if (!confirmLegacyDbCleanup()) {
      app.exit(0)
      return
    }
    const db = initDatabase()
    registerProductsIpc(db)
    registerSalesIpc(db)
    registerCustomersIpc(db) // 计划任务 7：客户管理（list/create/update；T11 CustomersView 消费）
    registerPurchasesIpc(db) // Task 9：进货管理（IPC 统一装配模式）
    registerReportsExportIpc(db) // Task 17：报表导出（reports:export；数据源走 report.service——T14 统一）
    registerReportsIpc(db) // Task 14：日/月报查询（reports:daily/monthly；剔除 voided + SQL 分桶）
    registerSettingsIpc(db) // Task 19：系统设置（店铺信息/打印配置/Logo）
    const printing = registerPrintingIpc(db) // Task 15：打印编排（preview/print；T19 打印机枚举/测试打印）
    // busy 门禁数据源接线：诊断的 L1 修复/repair 在打印队列在途时让路（T9）
    registerDiagnosticsIpc(db, { printQueueBusy: printing.isBusy }) // printer-diagnostics T9：打印诊断（diagnose/repair/diagnoseExport）
    registerTemplatesIpc(db) // Task 16：小票模板（五通道 CRUD + setDefault 互斥）

    createWindow()

    // macOS dock 激活时无窗则重建
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
