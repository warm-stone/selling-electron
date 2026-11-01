import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { initDatabase } from './db/database'
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

  // 拒绝新窗口，外部链接交给系统默认浏览器
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
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
    const db = initDatabase()
    registerProductsIpc(db)
    registerSalesIpc(db)
    registerPurchasesIpc(db) // Task 9：进货管理（IPC 统一装配模式）
    registerReportsExportIpc(db) // Task 17：报表导出（reports:export；数据源走 report.service——T14 统一）
    registerReportsIpc(db) // Task 14：日/月报查询（reports:daily/monthly；剔除 voided + SQL 分桶）
    registerSettingsIpc(db) // Task 19：系统设置（店铺信息/打印配置/Logo）
    registerPrintingIpc(db) // Task 15：打印编排（preview/print；T19 打印机枚举/测试打印）
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
