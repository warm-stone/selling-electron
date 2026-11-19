/**
 * 打印诊断采集执行器（printer-diagnostics 计划 Wave 3 / T4）。
 *
 * 职责：把 T3 的静态脚本（buildCollectScript）落盘执行，并把 stdout 双层
 * JSON 归一化为 PrintDiagnosticSnapshot（T1 schema）。
 *
 * 巨型文件治理批次 5：解析/归一/装配实现拆分至 collect/ 子目录——
 * - collect/primitives.ts       防御小工具（asRecord/asString/asNumber/…）
 * - collect/stdout-parser.ts    双层 JSON 防御解析 + 段记录归一 + 原生段解析
 * - collect/status-maps.ts      v2 三套状态映射表（语义不同禁合并）
 * - collect/printer-assembly.ts PrinterDiagnostic 装配 + 端口分类 + Owner 比对
 * - collect/app-section.ts      app 侧合成段（AppInfoSnapshotProvider 归一）
 * 本文件保留：execFile 注入面、常量、runCollect 编排（落盘/看门狗/超时）与
 * stdout → 快照的段级组装（composeSnapshot——「部分失败是数据不是异常」契约）。
 *
 * 三条编码防线（本模块是它们的落地点）：
 * - **BOM**：.ps1 落盘恒带 UTF-8 BOM（EF BB BF）——PS 5.1 对无 BOM 脚本按
 *   ANSI 解析，将来脚本里出现非 ASCII 字面量会静默乱码；每次覆盖写（幂等）。
 * - **maxBuffer**：显式 4MB——Node 默认 1MB 会在 drivers/events 段中途杀进程，
 *   stdout 截断后整体不可解析（采集 10 段一次跑，截断 = 全损）。
 * - **超时**：execFile timeout 选项 + 执行器自有看门狗双保险——fake/被劫持的
 *   execFile 永不回调时看门狗仍能在预算内 reject（timeoutMs 可注入是超时
 *   路径可测性的关键）。
 *
 * 「部分失败是数据不是异常」契约（与 spooler 通道 exit 2 = 失败的镜像差异）：
 * T3 脚本 exit 0 恒定，段级失败落在各段 JSON 的 {error}；本模块只对「整体不可
 * 解析」（空 stdout / 非 JSON / 非 JSON 对象）与执行层失败（非零退出 / 超时 /
 * 落盘失败 / 非 win32）reject，段级失败一律记 snapshot.errors[section] 正常返回。
 *
 * v2 真机缺陷修复（Bug1 位掩码误读 / Bug2 WER 提取易碎 / printConfig 四层
 * fallback 归一 / DetectedErrorState 标签）的实现与查证结论详见 collect/
 * 各子模块头注释。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCollectScript } from './collect-script'
import { composeAppSection, resolveCurrentUserName } from './collect/app-section'
import { buildPrinterDiagnostics } from './collect/printer-assembly'
import { asRecord, errorMessage, isErrorShape, stringifyRaw } from './collect/primitives'
import {
  normalizeDriversItem,
  normalizeJobsItem,
  normalizePortsItem,
  normalizePrintersItem,
  normalizeProbeItem,
  normalizeWmiItem,
  parseEventsSection,
  parseListItems,
  parsePrintConfigSection,
  parseSpoolDirSection,
  parseSpoolerSection,
  type ConfigSectionRecord,
  type DriverSectionRecord,
  type JobSectionRecord,
  type PortSectionRecord,
  type PrinterSectionRecord,
  type ProbeSectionRecord,
  type WmiSectionRecord
} from './collect/stdout-parser'
import type { PrintDiagnosticSnapshot } from '../../../shared/printing/diagnostics-schema'
import type { AppInfoSnapshotProvider } from './collect/app-section'

// AppInfoSnapshotProvider 实现随 app 侧合成段迁至 collect/app-section——
// 本文件 re-export 保持既有公开导入面（diagnostics.ipc / 单测）不变
export type { AppInfoSnapshotProvider }

// ══════════════ execFile 注入 ══════════════

/** execFile 回调错误形状（同 spooler.channel.ExecFileError） */
export type ExecFileError = (Error & { code?: string | number | null }) | null

/**
 * execFile 注入点——与 spooler.channel.ExecFileFn 同构，但 options 多一个
 * maxBuffer：诊断 stdout（drivers/events 段）可达 MB 级，必须显式放大到 4MB。
 * spooler 通道无 stdout 需求故其类型无此字段；两个通道的 options 形状刻意
 * 不同（且不得反向修改 spooler.channel），因此同构定义而非复用 import。
 */
export type CollectExecFileFn = (
  file: string,
  args: readonly string[],
  options: { windowsHide?: boolean; timeout?: number; maxBuffer?: number },
  callback: (error: ExecFileError, stdout: string, stderr: string) => void
) => { stdin?: NodeJS.WritableStream | null }

const defaultExecFile: CollectExecFileFn = (file, args, options, callback) =>
  execFile(file, [...args], { encoding: 'utf8', ...options }, (error, stdout, stderr) =>
    callback(error, stdout, stderr)
  )

// ══════════════ 选项与常量 ══════════════

/** PowerShell 整体超时（毫秒）——10 段采集 + 事件日志查询的保守预算 */
export const COLLECT_TIMEOUT_MS = 30_000
/** stdout 上限 4MB（Node 默认 1MB 会在 drivers/events 段中途截断杀进程） */
export const COLLECT_MAX_BUFFER = 4 * 1024 * 1024

export interface CollectOptions {
  /** execFile 注入点（单测 fake 用；生产默认真实 execFile） */
  execFileFn?: CollectExecFileFn
  /** 平台注入点；默认 process.platform（非 win32 → reject 中文可诊断错误） */
  platform?: NodeJS.Platform
  /** 落盘目录（生产传 app.getPath('userData')；脚本写到 <userDataDir>/diagnostics/collect.ps1） */
  userDataDir: string
  /** 整体超时（毫秒），默认 30000——注入短值用于超时路径的快速测试 */
  timeoutMs?: number
  /** app 侧合成段原料（缺省用默认值：electronVersion 取自 process.versions.electron） */
  appInfo?: AppInfoSnapshotProvider
}

/**
 * 执行诊断采集并归一化为 PrintDiagnosticSnapshot。
 *
 * 流程：平台守卫 → 脚本落盘（BOM + 幂等覆盖）→ execFile 执行（windowsHide /
 * timeout / maxBuffer 4MB）→ stdout 解析（双层 JSON 防御二次解析 + 段级
 * {error} 移入 errors）→ 按 printer-enumerator 的防御归一模式装配快照。
 */
export function runCollect(options: CollectOptions): Promise<PrintDiagnosticSnapshot> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return Promise.reject(
      new Error(`打印机诊断采集仅 Windows 可用（当前平台：${platform}）`)
    )
  }

  const scriptDir = join(options.userDataDir, 'diagnostics')
  const ps1Path = join(scriptDir, 'collect.ps1')
  try {
    mkdirSync(scriptDir, { recursive: true })
    writeFileSync(
      ps1Path,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(buildCollectScript(), 'utf8')])
    )
  } catch (e) {
    return Promise.reject(new Error(`诊断脚本落盘失败（${ps1Path}）：${errorMessage(e)}`))
  }

  const timeoutMs = options.timeoutMs ?? COLLECT_TIMEOUT_MS
  const execFileFn = options.execFileFn ?? defaultExecFile

  return new Promise<PrintDiagnosticSnapshot>((resolve, reject) => {
    let settled = false
    const watchdog = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`打印机诊断采集超时（${timeoutMs}ms 内 PowerShell 未返回；脚本：${ps1Path}）`))
    }, timeoutMs)

    execFileFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: COLLECT_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        if (error) {
          const detail = stderr.trim() !== '' ? ` | stderr 摘要：${stderr.trim().slice(0, 300)}` : ''
          reject(new Error(`打印机诊断采集执行失败：${error.message}${detail}`))
          return
        }
        try {
          resolve(parseStdoutToSnapshot(stdout, options.appInfo))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
    )
  })
}

// ══════════════ stdout → 快照 ══════════════

/** 整体解析失败（空输出 / 非 JSON / 非 JSON 对象）——唯一的 reject 于数据侧的路径 */
function parseStdoutToSnapshot(
  stdout: string,
  appInfo: AppInfoSnapshotProvider | undefined
): PrintDiagnosticSnapshot {
  if (stdout.trim() === '') {
    throw new Error('打印机诊断采集输出为空（PowerShell 未产生 stdout——脚本可能被组策略或安全软件拦截）')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (e) {
    throw new Error(
      `打印机诊断采集输出不是有效 JSON（${errorMessage(e)}；stdout 前 100 字符预览：${stdout.slice(0, 100)}）`
    )
  }
  const root = asRecord(parsed)
  if (root === null) {
    throw new Error(
      `打印机诊断采集输出不是 JSON 对象（stdout 前 100 字符预览：${stdout.slice(0, 100)}）`
    )
  }
  return composeSnapshot(root, appInfo)
}

function composeSnapshot(
  root: Record<string, unknown>,
  appInfo: AppInfoSnapshotProvider | undefined
): PrintDiagnosticSnapshot {
  const errors: Record<string, string> = {}
  const raw: Record<string, string> = {}

  /**
   * 段级提取（部分失败是数据不是异常）：
   * 段缺失 → errors 记档；{error} 形状 → 移入 errors、段数据置空；
   * 段内二次解析抛错 → errors 记档；任何情况都不向上抛。
   */
  const takeSection = <T>(name: string, parse: (v: unknown) => T, empty: T): T => {
    const value = root[name]
    if (value === undefined) {
      errors[name] = '采集段缺失（PowerShell 输出中无此段——脚本版本不匹配或输出被截断）'
      return empty
    }
    raw[name] = stringifyRaw(value)
    if (isErrorShape(value)) {
      errors[name] = value.error
      return empty
    }
    try {
      return parse(value)
    } catch (e) {
      errors[name] = `段解析失败：${errorMessage(e)}`
      return empty
    }
  }

  const printersData = takeSection('printers', (v) => parseListItems(v, normalizePrintersItem), [] as PrinterSectionRecord[])
  const wmiData = takeSection('wmi', (v) => parseListItems(v, normalizeWmiItem), [] as WmiSectionRecord[])
  const jobsData = takeSection('jobs', (v) => parseListItems(v, normalizeJobsItem), [] as JobSectionRecord[])
  const portsData = takeSection('ports', (v) => parseListItems(v, normalizePortsItem), [] as PortSectionRecord[])
  const driversData = takeSection('drivers', (v) => parseListItems(v, normalizeDriversItem), [] as DriverSectionRecord[])
  const spooler = takeSection('spooler', parseSpoolerSection, { status: '', startType: '', dependents: [] })
  const spoolDirCounts = takeSection('spoolDir', parseSpoolDirSection, { spl: 0, shd: 0 })
  const eventLog = takeSection('events', parseEventsSection, {
    adminEvents: [],
    app1000Events: [],
    operationalEnabled: false
  })
  const probesData = takeSection('tcpProbe', (v) => parseListItems(v, normalizeProbeItem), [] as ProbeSectionRecord[])
  const configsData = takeSection('printConfig', parsePrintConfigSection, [] as ConfigSectionRecord[])

  const app = composeAppSection(appInfo)
  const printers = buildPrinterDiagnostics(
    printersData,
    wmiData,
    portsData,
    driversData,
    probesData,
    jobsData,
    spoolDirCounts,
    app.settings.printerName,
    resolveCurrentUserName(appInfo)
  )

  return {
    printers,
    system: { spooler, eventLog, printConfigs: configsData },
    app,
    errors,
    raw
  }
}
