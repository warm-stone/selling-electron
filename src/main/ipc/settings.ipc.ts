import { mkdir, copyFile, readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { OpenDialogOptions } from 'electron'
import type { AppSettings, LogoInfo, PrinterChannel } from '../../shared/types'
import { typedHandle } from './typed-handle'
import { createSettingsRepo, type SettingsRepo } from '../db/repositories/settings.repo'
import { createLogoRepo, type LogoRepo, type LogoRow } from '../db/repositories/logo.repo'
import { pngBufferToDataUrl } from '../printing/print.service'
import { parseRecentSalespersons, RECENT_SALESPERSONS_KEY } from '../services/salesperson-history'

/**
 * 系统设置 IPC 薄层（Task 19；多 Logo 架构改造）。
 *
 * 通道：settings:get / settings:set / settings:listLogos /
 * settings:uploadLogo / settings:deleteLogo / settings:getRecentSalespersons
 * （preload 暴露 window.api.settings.*，与 T9/T10 的命名空间 API 统一模式一致）。
 *
 * 本文件分两部分：
 *  1. 纯映射/文件助手（rowsToAppSettings / appSettingsPatchToKv /
 *     importLogoFile / rowsToLogoInfos / removeLogoFile）——零 Electron
 *     依赖，vitest 直接单测（见 tests/unit/ipc/settings.ipc.test.ts）；
 *  2. registerSettingsIpc(db)——装配 ipcMain/dialog/app，`require('electron')`
 *     懒加载（T2 database.ts 同款模式），保证本模块可被 vitest 纯 Node
 *     环境导入。
 *
 * KV 序列化约定（settings 表 value TEXT）：
 *  - 字符串字段原样存（'' 合法）；
 *  - 可空字段（printer_name/tcp_host/com_port/tcp_port/driver_dpi）：null ≡ ''；
 *  - tcp_port 存十进制字符串；auto_cut 存 '1' / '0'；
 *  - v2 driver 通道实验键（printer-diagnostics v2）：driver_dpi 存十进制
 *    字符串、driver_use_default_page_size 存 '1' / '0'（缺省 false）。读侧
 *    rowsToAppSettings 条件产出归一值；写侧序列化 + 50-1200 值域校验
 *    （validateSettingsPatch）。
 *  - 旧 logo_path 行（单 Logo 时代残留）不再读写，DB 残留行无害（不做迁移）。
 */

// ════════════════ 纯映射（可单测） ════════════════

/**
 * 全默认值（DB 无任何行时的 settings:get 返回）：通道默认 spooler（D5 主通道）。
 * v2 driver 通道实验键（driver_dpi/driver_use_default_page_size）缺省不产出
 * （可选字段——rowsToAppSettings 条件产出，见其注释）。
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  shop_name: '',
  shop_phone: '',
  receipt_note: '',
  printer_channel: 'spooler',
  printer_name: null,
  tcp_host: null,
  tcp_port: null,
  com_port: null,
  auto_cut: true
}

/** 合法通道值（driver = 打印机驱动 GDI 渲染兜底——固件无中文字模、RAW 打不出中文的云热敏机兼容通道） */
const VALID_CHANNELS: readonly string[] = ['spooler', 'tcp', 'serial', 'driver']

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

/**
 * driver 通道实验键归一读（printer-diagnostics v2）：
 * 十进制字符串 → number（仅格式解析——50-1200 值域校验归 validateSettingsPatch，
 * 读侧不提前做：DB 旁路写入的越界值仍如实回显，交诊断/设置页呈现）；
 * ''/脏值 → null（null ≡ '' 可空惯例，同 tcp_port parsePort 模式）。
 */
function parseDriverDpi(raw: string | undefined): number | null {
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return null
  return Number.parseInt(raw, 10)
}

/**
 * 非法值回显（校验报错「当前值」渲染）：数字直印（NaN/Infinity 无引号），
 * 其余走 JSON.stringify——字符串带引号（'203' → "203"）、对象/布尔原形，
 * 序列化失败（循环引用等旁路值）回落 String。类型信息可见是回显的价值。
 */
function echoInvalidValue(v: unknown): string {
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v)
  try {
    const j = JSON.stringify(v)
    if (j !== undefined) return j
  } catch {
    // 循环引用等 JSON 不可序列化值 → String 兜底
  }
  return String(v)
}

/**
 * settings:set 入参校验（printer-diagnostics v2）：driver 通道实验键值域。
 * 与 printer_channel 的静默回落（parseChannel）刻意不同——实验键写错值若被
 * 静默吞掉，用户会以为 13/13.5/'203' 已生效而真机验证全盘失真，故逐类
 * 中文报错 throw（→ invoke reject → renderer error toast 回显）：
 *  - driver_dpi：null/undefined 合法（清除/缺省——null ≡ '' KV 惯例）；
 *    非空必须整数且 50 ≤ v ≤ 1200（0/负/小数/字符串/超界全拒绝）
 *  - driver_use_default_page_size：仅 true/false（undefined 缺省 false）
 * 既有键不校验（printer_channel 走 parseChannel 静默回落——历史语义不变）。
 */
export function validateSettingsPatch(patch: Partial<AppSettings>): void {
  const dpi = patch.driver_dpi
  if (dpi !== undefined && dpi !== null) {
    if (typeof dpi !== 'number' || !Number.isInteger(dpi) || dpi < 50 || dpi > 1200) {
      throw new Error(
        `driver_dpi 需为 50-1200 的整数（热敏打印机常见 203/300），当前值：${echoInvalidValue(dpi)}`
      )
    }
  }
  const useDefault = patch.driver_use_default_page_size
  if (useDefault !== undefined && typeof useDefault !== 'boolean') {
    throw new Error(
      `driver_use_default_page_size 仅接受 true/false（缺省 false），当前值：${echoInvalidValue(useDefault)}`
    )
  }
}

/** KV 快照 → AppSettings（settings:get 返回值；缺 key 全走默认值） */
export function rowsToAppSettings(kv: Record<string, string>): AppSettings {
  const settings: AppSettings = {
    shop_name: kv['shop_name'] ?? '',
    shop_phone: kv['shop_phone'] ?? '',
    receipt_note: kv['receipt_note'] ?? '',
    printer_channel: parseChannel(kv['printer_channel']),
    printer_name: nullableString(kv['printer_name']),
    tcp_host: nullableString(kv['tcp_host']),
    tcp_port: parsePort(kv['tcp_port']),
    com_port: nullableString(kv['com_port']),
    auto_cut: parseBool(kv['auto_cut'], true)
  }
  // v2 driver 通道实验键条件产出：DB 无行 → 键缺省（可选字段，旧契约消费方
  // 零感知）；有行 → 归一值（dpi 数字或 null；页尺寸开关布尔，脏值回落 false）。
  // 「恰好白名单键」回归锁见 tests/unit/ipc/settings.ipc.test.ts——缺省态不扩键。
  if (kv['driver_dpi'] !== undefined) settings.driver_dpi = parseDriverDpi(kv['driver_dpi'])
  if (kv['driver_use_default_page_size'] !== undefined) {
    settings.driver_use_default_page_size = parseBool(kv['driver_use_default_page_size'], false)
  }
  return settings
}

/** Partial<AppSettings> → KV 条目（settings:set 入参序列化；未知 key 忽略，只写契约 key） */
export function appSettingsPatchToKv(patch: Partial<AppSettings>): Record<string, string> {
  const kv: Record<string, string> = {}
  const str = (v: string | null | undefined): string => v ?? ''
  if (patch.shop_name !== undefined) kv['shop_name'] = patch.shop_name
  if (patch.shop_phone !== undefined) kv['shop_phone'] = patch.shop_phone
  if (patch.receipt_note !== undefined) kv['receipt_note'] = patch.receipt_note
  if (patch.printer_channel !== undefined) kv['printer_channel'] = parseChannel(patch.printer_channel)
  if (patch.printer_name !== undefined) kv['printer_name'] = str(patch.printer_name)
  if (patch.tcp_host !== undefined) kv['tcp_host'] = str(patch.tcp_host)
  if (patch.tcp_port !== undefined) kv['tcp_port'] = String(patch.tcp_port ?? '')
  if (patch.com_port !== undefined) kv['com_port'] = str(patch.com_port)
  if (patch.auto_cut !== undefined) kv['auto_cut'] = patch.auto_cut ? '1' : '0'
  // v2 实验键序列化（生产入口先经 validateSettingsPatch 值域校验）：
  // driver_dpi null → ''（null ≡ '' 可空惯例，同 tcp_port）/ 数字 → 十进制字符串；
  // driver_use_default_page_size → '1' / '0'（auto_cut 模式）。
  if (patch.driver_dpi !== undefined) {
    kv['driver_dpi'] = patch.driver_dpi === null ? '' : String(patch.driver_dpi)
  }
  if (patch.driver_use_default_page_size !== undefined) {
    kv['driver_use_default_page_size'] = patch.driver_use_default_page_size ? '1' : '0'
  }
  return kv
}

/** 最近销售人员读取所需的最小 repo 面（结构兼容 SettingsRepo） */
interface RecentSalespersonsReaderRepo {
  get(key: string): string | null
}

/**
 * 读取最近销售人员队列（settings:getRecentSalespersons 数据源）：
 * settings KV 的 recent_salespersons JSON 字符串 → string[]。
 * 三态天然容错（parseRecentSalespersons 脏值防御）：repo 无 key
 * （get → null）/ 空串 / 损坏 JSON / 非数组 → []。
 * ★ recent_salespersons 不进 AppSettings 白名单（定案：独立通道读，
 *   settings:get 不泄漏）；写侧随结账事务组装（不做独立写通道）。
 */
export function readRecentSalespersons(repo: RecentSalespersonsReaderRepo): string[] {
  return parseRecentSalespersons(repo.get(RECENT_SALESPERSONS_KEY))
}

// ════════════════ Logo 文件助手（多 Logo 架构，可单测） ════════════════

/** Logo 写入所需的最小 repo 面（结构兼容 LogoRepo） */
interface LogoWriterRepo {
  insert(filename: string, displayName: string): LogoRow
}

/** Logo 删除所需的最小 repo 面（结构兼容 LogoRepo） */
interface LogoRemoverRepo {
  getById(id: number): LogoRow | undefined
  remove(id: number): void
}

/**
 * 导入 Logo 到多 Logo 库：复制源 png 到 logosDir/<randomUUID>.png 并
 * INSERT logos 行（display_name 默认原文件名去扩展），返回新行。
 * ★ Logo 不存 DB BLOB（文件系统 + logos 表元数据——计划 MUST NOT）。
 * ★ logosDir 由调用方注入（生产 = userData/logos，运行时取 app.getPath，
 *   不硬编码——E2E 隔离兼容）；randomUUID 保证同名重复上传互不覆盖。
 */
export async function importLogoFile(
  srcPath: string,
  logosDir: string,
  repo: LogoWriterRepo
): Promise<LogoRow> {
  await mkdir(logosDir, { recursive: true })
  const filename = `${randomUUID()}.png`
  await copyFile(srcPath, join(logosDir, filename))
  const base = basename(srcPath)
  const displayName = base.slice(0, base.length - extname(base).length)
  return repo.insert(filename, displayName)
}

/**
 * logos 行 → LogoInfo[]（settings:listLogos 数据源）：逐行读
 * logosDir/<filename> 转 dataURL（MIME 固定 image/png——上传已限定）。
 * 文件缺失/不可读 → 跳过该行（优雅降级：列表少一行，不抛错）。
 */
export async function rowsToLogoInfos(
  rows: LogoRow[],
  logosDir: string,
  readFileFn: (path: string) => Promise<Buffer> = readFile
): Promise<LogoInfo[]> {
  const infos: LogoInfo[] = []
  for (const row of rows) {
    try {
      const buf = await readFileFn(join(logosDir, row.filename))
      infos.push({ id: row.id, display_name: row.display_name, data_url: pngBufferToDataUrl(buf) })
    } catch {
      // 文件缺失/不可读：跳过该行（listLogos 优雅降级）
    }
  }
  return infos
}

/**
 * 删除 Logo：删 DB 行 + 尽力删文件（文件已缺失 → 忽略；模板引用残留由
 * 渲染端跳过，不做引用检查）。行不存在抛可诊断错误（renderer 展示）。
 */
export async function removeLogoFile(
  id: number,
  logosDir: string,
  repo: LogoRemoverRepo
): Promise<void> {
  const row = repo.getById(id)
  if (row === undefined) {
    throw new Error(`Logo 不存在（id=${id}，可能已被删除）`)
  }
  repo.remove(id)
  try {
    await unlink(join(logosDir, row.filename))
  } catch {
    // 文件已缺失/占用：DB 行已删，文件残留无害（logos 目录非权威读取面）
  }
}

// ════════════════ IPC 装配（Electron 侧） ════════════════

export function registerSettingsIpc(db: Database.Database): void {
  // 懒 require（T2 模式）：本模块的纯助手可在 vitest 纯 Node 环境导入
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
