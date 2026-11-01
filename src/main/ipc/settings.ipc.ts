import { mkdir, copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { OpenDialogOptions } from 'electron'
import type { AppSettings, PrinterChannel } from '../../shared/types'
import { createSettingsRepo, type SettingsRepo } from '../db/repositories/settings.repo'

/**
 * 系统设置 IPC 薄层（Task 19）。
 *
 * 通道：settings:get / settings:set / settings:uploadLogo / settings:getLogoDataUrl
 * （preload 暴露 window.api.settings.*，与 T9/T10 的命名空间 API 统一模式一致）。
 *
 * 本文件分两部分：
 *  1. 纯映射/文件助手（rowsToAppSettings / appSettingsPatchToKv / importLogoFile /
 *     readLogoDataUrl）——零 Electron 依赖，vitest 直接单测（见 tests/unit/ipc/settings.ipc.test.ts）；
 *  2. registerSettingsIpc(db)——装配 ipcMain/dialog/app，`require('electron')` 懒加载
 *     （T2 database.ts 同款模式），保证本模块可被 vitest 纯 Node 环境导入。
 *
 * KV 序列化约定（settings 表 value TEXT）：
 *  - 字符串字段原样存（'' 合法）；
 *  - 可空字段（printer_name/tcp_host/com_port/logo_path/tcp_port）：null ≡ ''；
 *  - tcp_port 存十进制字符串；auto_cut 存 '1' / '0'。
 */

// ════════════════ 纯映射（可单测） ════════════════

/** 全默认值（DB 无任何行时的 settings:get 返回）：通道默认 spooler（D5 主通道） */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  shop_name: '',
  shop_phone: '',
  receipt_note: '',
  logo_path: null,
  printer_channel: 'spooler',
  printer_name: null,
  tcp_host: null,
  tcp_port: null,
  com_port: null,
  auto_cut: true
}

const VALID_CHANNELS: readonly string[] = ['spooler', 'tcp', 'serial']

/** 脏值防御：printer_channel 非法时回落默认 spooler */
function parseChannel(raw: string | undefined): PrinterChannel {
  return raw !== undefined && (VALID_CHANNELS as readonly string[]).includes(raw)
    ? (raw as PrinterChannel)
    : 'spooler'
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return null
  const port = Number.parseInt(raw, 10)
  return port >= 1 && port <= 65535 ? port : null
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  return fallback
}

/** '' ≡ null（可空字段归一） */
function nullableString(raw: string | undefined): string | null {
  return raw === undefined || raw === '' ? null : raw
}

/** KV 快照 → AppSettings（settings:get 返回值；缺 key 全走默认值） */
export function rowsToAppSettings(kv: Record<string, string>): AppSettings {
  return {
    shop_name: kv['shop_name'] ?? '',
    shop_phone: kv['shop_phone'] ?? '',
    receipt_note: kv['receipt_note'] ?? '',
    logo_path: nullableString(kv['logo_path']),
    printer_channel: parseChannel(kv['printer_channel']),
    printer_name: nullableString(kv['printer_name']),
    tcp_host: nullableString(kv['tcp_host']),
    tcp_port: parsePort(kv['tcp_port']),
    com_port: nullableString(kv['com_port']),
    auto_cut: parseBool(kv['auto_cut'], true)
  }
}

/** Partial<AppSettings> → KV 条目（settings:set 入参序列化；未知 key 忽略，只写契约 key） */
export function appSettingsPatchToKv(patch: Partial<AppSettings>): Record<string, string> {
  const kv: Record<string, string> = {}
  const str = (v: string | null | undefined): string => v ?? ''
  if (patch.shop_name !== undefined) kv['shop_name'] = patch.shop_name
  if (patch.shop_phone !== undefined) kv['shop_phone'] = patch.shop_phone
  if (patch.receipt_note !== undefined) kv['receipt_note'] = patch.receipt_note
  if (patch.logo_path !== undefined) kv['logo_path'] = str(patch.logo_path)
  if (patch.printer_channel !== undefined) kv['printer_channel'] = parseChannel(patch.printer_channel)
  if (patch.printer_name !== undefined) kv['printer_name'] = str(patch.printer_name)
  if (patch.tcp_host !== undefined) kv['tcp_host'] = str(patch.tcp_host)
  if (patch.tcp_port !== undefined) kv['tcp_port'] = String(patch.tcp_port ?? '')
  if (patch.com_port !== undefined) kv['com_port'] = str(patch.com_port)
  if (patch.auto_cut !== undefined) kv['auto_cut'] = patch.auto_cut ? '1' : '0'
  return kv
}

/** Logo 导入所需的最小 repo 面（结构兼容 SettingsRepo） */
interface LogoRepo {
  set(key: string, value: string): void
}

/** Logo 文件名（固定单文件，覆盖式更新） */
export const LOGO_FILENAME = 'logo.png'

/**
 * 导入 Logo：复制源 png 到 logosDir/logo.png 并写 settings.logo_path。
 * ★ Logo 不存 DB BLOB（文件系统 + 路径引用——计划 MUST NOT）。
 * ★ logosDir 由调用方注入（生产 = userData/logos，运行时取 app.getPath，不硬编码——E2E 隔离兼容）。
 */
export async function importLogoFile(
  srcPath: string,
  logosDir: string,
  repo: LogoRepo
): Promise<string> {
  await mkdir(logosDir, { recursive: true })
  const dest = join(logosDir, LOGO_FILENAME)
  await copyFile(srcPath, dest)
  repo.set('logo_path', dest)
  return dest
}

/**
 * 读 Logo 为 dataURL（ipcRenderer 无法读任意文件 → 专用通道；
 * T15/T16 预览的 Logo 数据源）。
 * 文件缺失/不可读 → null（优雅降级：无预览，不抛错）。
 */
export async function readLogoDataUrl(logoPath: string | null): Promise<string | null> {
  if (!logoPath) return null
  try {
    const buf = await readFile(logoPath)
    // 上传已限定 png（dialog filters），MIME 固定 image/png
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

// ════════════════ IPC 装配（Electron 侧） ════════════════

export function registerSettingsIpc(db: Database.Database): void {
  // 懒 require（T2 模式）：本模块的纯助手可在 vitest 纯 Node 环境导入
  const { ipcMain, dialog, app, BrowserWindow } = require('electron') as typeof import('electron')
  const repo: SettingsRepo = createSettingsRepo(db)

  const currentSettings = (): AppSettings => rowsToAppSettings(repo.getAll())

  ipcMain.handle('settings:get', (): AppSettings => currentSettings())

  ipcMain.handle('settings:set', (_event, req: Partial<AppSettings> | undefined): AppSettings => {
    repo.setMany(appSettingsPatchToKv(req ?? {}))
    return currentSettings()
  })

  /**
   * Logo 上传：主进程原生文件对话框（选 png）→ importLogoFile 复制入
   * userData/logos/logo.png + 写 settings.logo_path。
   * 用户取消 → 返回当前 logo_path（保持现状，不报错）。
   */
  ipcMain.handle(
    'settings:uploadLogo',
    async (event): Promise<{ logo_path: string | null }> => {
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
        return { logo_path: currentSettings().logo_path }
      }
      // userData 运行时取（E2E 下 E2E_USER_DATA_DIR 已重定向 → 隔离成立）
      const logosDir = join(app.getPath('userData'), 'logos')
      const dest = await importLogoFile(srcPath, logosDir, repo)
      return { logo_path: dest }
    }
  )

  /** Logo 缩略图数据源：主进程读文件转 dataURL（renderer 无任意文件读权限） */
  ipcMain.handle(
    'settings:getLogoDataUrl',
    async (): Promise<{ data_url: string | null }> => {
      const dataUrl = await readLogoDataUrl(currentSettings().logo_path)
      return { data_url: dataUrl }
    }
  )
}
