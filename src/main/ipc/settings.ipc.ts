import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { OpenDialogOptions } from 'electron'
import type { AppSettings, LogoInfo } from '../../shared/types'
import { typedHandle } from './typed-handle'
import { createSettingsRepo, type SettingsRepo } from '../db/repositories/settings.repo'
import { createLogoRepo, type LogoRepo } from '../db/repositories/logo.repo'
import {
  appSettingsPatchToKv,
  importLogoFile,
  readRecentSalespersons,
  removeLogoFile,
  rowsToAppSettings,
  rowsToLogoInfos,
  validateSettingsPatch
} from '../services/settings.service'

/**
 * 系统设置 IPC 薄层（Task 19；多 Logo 架构改造；P1-3 分层修复后只剩装配）。
 *
 * 通道：settings:get / settings:set / settings:listLogos /
 * settings:uploadLogo / settings:deleteLogo / settings:getRecentSalespersons
 * （preload 暴露 window.api.settings.*，与 T9/T10 的命名空间 API 统一模式一致）。
 *
 * 业务助手（纯映射/校验/Logo 文件操作）已下沉 services/settings.service.ts
 * ——零 Electron 依赖、vitest 直接单测（tests/unit/ipc/settings.ipc.test.ts），
 * 兄弟域（printing.ipc）复用 rowsToAppSettings 走 service 层而非横向 import。
 * 本文件只保留 registerSettingsIpc(db)：装配 ipcMain/dialog/app，
 * `require('electron')` 懒加载（T2 database.ts 同款模式）。
 *
 * KV 序列化约定见 settings.service.ts 文件头注释。
 */

export function registerSettingsIpc(db: Database.Database): void {
  // 懒 require（T2 模式）：本模块纯助手可在 vitest 纯 Node 环境导入
  const { ipcMain, dialog, app, BrowserWindow } = require('electron') as typeof import('electron')
  const repo: SettingsRepo = createSettingsRepo(db)
  const logoRepo: LogoRepo = createLogoRepo(db)

  const currentSettings = (): AppSettings => rowsToAppSettings(repo.getAll())
  // userData 运行时取（E2E 下 E2E_USER_DATA_DIR 已重定向 → 隔离成立）
  const logosDir = (): string => join(app.getPath('userData'), 'logos')
  const currentLogoInfos = (): Promise<LogoInfo[]> =>
    rowsToLogoInfos(logoRepo.list(), logosDir())

  typedHandle(ipcMain, 'settings:get', () => currentSettings())

  typedHandle(ipcMain, 'settings:set', (req) => {
    const patch = req ?? {}
    // v2 实验键值域校验先行：写错值 throw 中文错误（不静默吞——防真机验证失真）
    validateSettingsPatch(patch)
    repo.setMany(appSettingsPatchToKv(patch))
    return currentSettings()
  })

  typedHandle(ipcMain, 'settings:getRecentSalespersons', () => readRecentSalespersons(repo))

  /** Logo 列表：DB 行 + 文件读取 → LogoInfo[]（文件缺失行自动跳过） */
  typedHandle(ipcMain, 'settings:listLogos', async () => currentLogoInfos())

  /**
   * Logo 上传：主进程原生文件对话框（选 png）→ 复制 userData/logos/
   * <uuid>.png + INSERT。用户取消 → 返回当前列表（保持现状，不报错）。
   * event 参数：对话框父窗口定位（BrowserWindow.fromWebContents）。
   */
  typedHandle(ipcMain, 'settings:uploadLogo', async (_req, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择 Logo 图片',
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      properties: ['openFile']
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const [srcPath] = picked.filePaths
    if (picked.canceled || !srcPath) {
      return currentLogoInfos()
    }
    await importLogoFile(srcPath, logosDir(), logoRepo)
    return currentLogoInfos()
  })

  /**
   * Logo 删除：删 DB 行 + 删文件 → 返回最新列表（模板引用残留由渲染端
   * 跳过——image 段落 logoId 查不到 logoBuffers 时静默跳过，不做引用检查）。
   */
  typedHandle(ipcMain, 'settings:deleteLogo', async (req) => {
    await removeLogoFile(req?.id ?? Number.NaN, logosDir(), logoRepo)
    return currentLogoInfos()
  })
}
