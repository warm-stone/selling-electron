/**
 * 打印诊断修复动作执行器（printer-diagnostics 计划 Wave 3 / T6）。
 *
 * 职责：按 RepairActionId 分派执行 repair-script.ts 拼装的命令/脚本：
 * - L1（CANCEL_ERROR_JOBS）与 L2（MIGRATE_WSD_TO_TCP）直执行——execFile，
 *   失败原样上抛（exit code / stderr 诊断）；
 * - SWITCH_*（L1）：调 deps.setChannel（DI——应用内改 settings，不碰系统）；
 * - L2 提权链（PURGE_QUEUE_RESTART_SPOOLER / ENABLE_PRINT_LOG）：经
 *   `Start-Process -Verb RunAs` UAC 包装执行。**提权窗口与 stdout/stderr 重定向
 *   互斥**——exit code + result-file 是唯一回传通道：
 *   - PURGE：buildPurgeQueueScript() 落盘（UTF-8 BOM 同 T4 防线）→ UAC 包装
 *     `powershell -File <script> -ResultPath <result>` → 按 exit code 映射
 *     （0 done / 2、3 needs-manual + result-file 明细 / 其余上抛）；
 *   - **UAC 拒绝（exit 1223 = ERROR_CANCELLED）→ needs-manual 安全返回不抛**：
 *     这是安全关键路径——用户点了「否」不等于故障，绝不能当错误炸给用户。
 *     双信号识别：error.code 优先，message 含 '1223'/'取消' 兜底（中文
 *     Windows 的 UAC 拒绝消息是本地化的）；
 * - L4 三个引导动作：不执行任何命令，返回 needs-manual 引导文案；
 * - dryRun（RepairDeps.dryRun）：PURGE / MIGRATE 返回命令/脚本文本，不落盘
 *   不执行（T9 预览流）。
 *
 * 平台守卫：非 win32 直接 reject（同 T4 collect.runner 模式）——修复动作全部
 * 面向 Windows 打印子系统，Linux/macOS 上没有 PowerShell 执行语义。
 */

import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFileError, ExecFileFn } from '../channels/spooler.channel'
import {
  PS_COMMON_ARGS,
  buildCancelErrorJobsCommand,
  buildEnablePrintLogCommand,
  buildPurgeQueueScript,
  buildUacElevationCommand,
  buildWsdMigrateCommands,
  type RepairCommandSpec
} from './repair-script'
import type { RepairActionId } from './schema'

// ══════════════ 常量与依赖注入 ══════════════

const defaultExecFile: ExecFileFn = (file, args, options, callback) =>
  execFile(file, [...args], { encoding: 'utf8', ...options }, (error, stdout, stderr) =>
    callback(error, stdout, stderr)
  )

/** 直执行（L1/L2 无提权）超时——对齐 spooler.channel 的 PowerShell 预算 */
export const REPAIR_DIRECT_TIMEOUT_MS = 30_000
/**
 * UAC 链超时——预算覆盖：用户在 consent 对话框前的停留（无操作即挂起）+
 * 提权脚本内部 WaitForStatus 30s + 文件删除 + 服务恢复 + result 写入。
 */
export const REPAIR_UAC_TIMEOUT_MS = 180_000

/** purge 脚本/结果文件名（T9 串行编排下固定名 + 幂等覆盖够用；结果文件执行前先清防串读） */
const PURGE_SCRIPT_FILENAME = 'selling-electron-purge-queue.ps1'
const PURGE_RESULT_FILENAME = 'selling-electron-purge-result.json'

/** UTF-8 BOM（PS 5.1 对无 BOM 脚本按 ANSI 解析——T4 同款防线） */
const UTF8_BOM = '\uFEFF'

/** runRepairAction 可注入项（单测 fake 用；生产缺省走默认实现） */
export interface RepairDeps {
  /** execFile 注入点（复用 spooler.channel 的 ExecFileFn 形状） */
  execFileFn?: ExecFileFn
  /** 平台注入点；默认 process.platform（非 win32 → reject 中文可诊断错误） */
  platform?: NodeJS.Platform
  /** 脚本落盘函数（PURGE 用）。默认 writeFileSync；**内容恒带 UTF-8 BOM 前缀**（调用方注入的 writer 收到的即含 BOM 的完整内容） */
  writeScriptFile?: (path: string, content: string) => void
  /** 应用内通道切换（SWITCH_* 用；由宿主注入——改 settings + 重建打印链路） */
  setChannel?: (channel: 'spooler' | 'driver') => Promise<void>
  /** purge 结果文件路径（提权脚本回传通道）；缺省 os.tmpdir() 下固定名 */
  resultFilePath?: string
  /** 只预览不执行（PURGE/MIGRATE 支持）——返回 { status:'dry-run', commands }，不落盘不 exec */
  dryRun?: boolean
}

/** 修复动作执行上下文（目标打印机/WSD 主机地址——来自诊断快照） */
export interface RepairActionContext {
  targetPrinter?: string
  hostAddress?: string
}

/** 修复结果：done 已完成 / needs-manual 需人工（含 UAC 拒绝与 L4 引导）/ dry-run 仅预览 */
export type RepairOutcome = {
  status: 'done' | 'needs-manual' | 'dry-run'
  detail?: string
  commands?: string[]
}

/** purge 结果文件（提权脚本 ConvertTo-Json 写出；字段宽松解析） */
interface PurgeScriptResult {
  deletedCount?: number
  failedFiles?: string[]
  failedPhase?: string | null
  error?: string | null
  spoolDir?: string | null
  dependents?: string[]
  ageFilterMinutes?: number | string
  exitCode?: number
}

/** UAC 拒绝的 needs-manual 返回（安全关键：不抛、不改系统、可重试） */
function uacDeclinedOutcome(): RepairOutcome {
  return {
    status: 'needs-manual',
    detail:
      '用户取消了管理员授权（UAC），未执行任何系统改动——可稍后重试；若不便授权，请按报告引导人工处理'
  }
}

// ══════════════ 执行小工具 ══════════════

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * UAC 拒绝双信号（runner 侧复核；wrapper 侧已尽力把本地化取消映射为 exit 1223）：
 * 1. error.code === 1223（优先——数字/字符串两形态都认）；
 * 2. message 含 '1223' 或 '取消'（兜底——防御 wrapper 侧本地化遗漏时 stderr 带出的取消字样）。
 */
function isUacDecline(error: NonNullable<ExecFileError>): boolean {
  if (error.code === 1223 || error.code === '1223') return true
  const message = error.message ?? ''
  return message.includes('1223') || message.includes('取消')
}

/** execFile 错误 → 退出码（exit-code 失败才有；spawn 失败（code 非 数字）返回 null） */
function exitCodeFrom(error: NonNullable<ExecFileError>): number | null {
  const code = error.code
  if (typeof code === 'number') return code
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
  return null
}

/** 直执行（L1 / L2 无提权）：失败原样上抛（含 stderr 摘要） */
function execRepairSpec(
  spec: RepairCommandSpec,
  actionLabel: string,
  deps: RepairDeps,
  timeoutMs: number
): Promise<void> {
  const execFileFn = deps.execFileFn ?? defaultExecFile
  return new Promise<void>((resolve, reject) => {
    execFileFn(spec.file, spec.args, { windowsHide: true, timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() !== '' ? ` | stderr：${stderr.trim().slice(0, 300)}` : ''
        reject(new Error(`${actionLabel} 执行失败：${error.message}${detail}`))
        return
      }
      resolve()
    })
  })
}

/** UAC 链执行结果：declined = 用户拒绝；exit = 提权子进程退出码 */
type UacRunOutcome = { kind: 'declined' } | { kind: 'exit'; code: number; stderr: string }

/**
 * 执行 UAC 提权包装命令。exit code + （purge 的）result-file 是唯一回传——
 * stdout 不承载信息。declined 单列（needs-manual 路径）；spawn 层失败上抛。
 */
function execUac(
  spec: RepairCommandSpec,
  actionLabel: string,
  deps: RepairDeps,
  timeoutMs: number
): Promise<UacRunOutcome> {
  const execFileFn = deps.execFileFn ?? defaultExecFile
  return new Promise<UacRunOutcome>((resolve, reject) => {
    execFileFn(spec.file, spec.args, { windowsHide: true, timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) {
        if (isUacDecline(error)) {
          resolve({ kind: 'declined' })
          return
        }
        const code = exitCodeFrom(error)
        if (code !== null) {
          resolve({ kind: 'exit', code, stderr })
          return
        }
        const detail = stderr.trim() !== '' ? ` | stderr：${stderr.trim().slice(0, 300)}` : ''
        reject(new Error(`${actionLabel} 提权执行失败：${error.message}${detail}`))
        return
      }
      resolve({ kind: 'exit', code: 0, stderr })
    })
  })
}

/** 读 purge result-file（提权脚本 Set-Content UTF8 自带 BOM → strip 后宽松解析；读不了/解析不了 → null） */
function readPurgeResult(resultPath: string): PurgeScriptResult | null {
  let raw: string
  try {
    raw = readFileSync(resultPath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as PurgeScriptResult) : null
  } catch {
    return null
  }
}

/** purge exit 0 的 done 文案（结果文件可读时带删除计数） */
function purgeDoneDetail(result: PurgeScriptResult | null): string {
  if (result !== null && typeof result.deletedCount === 'number') {
    return `已清空打印队列残留并重启 Print Spooler（本次删除 ${result.deletedCount} 个 spool 文件）`
  }
  return '已清空打印队列残留并重启 Print Spooler'
}

/** purge exit 2/3 的 needs-manual 明细（detail 优先携带 result-file 内容——测试按此断言契约） */
function purgeFailureDetail(code: number, result: PurgeScriptResult | null, resultPath: string): string {
  if (result === null) {
    return `清队列未完全成功（exit ${code}），且结果文件不可读（${resultPath}）——服务已在 finally 中尝试自动恢复，请人工检查服务状态与队列残留`
  }
  if (code === 2) {
    return `停止 Print Spooler 失败（exit 2），队列未清理${result.error ? `：${result.error}` : ''}——已尝试自动恢复服务，请关闭占用打印机的程序后重试，或人工停止服务清理`
  }
  const failed = Array.isArray(result.failedFiles) ? result.failedFiles : []
  const deleted = typeof result.deletedCount === 'number' ? result.deletedCount : 0
  return `清队列部分失败（exit 3）：已删除 ${deleted} 个文件，失败 ${failed.length} 个${failed.length > 0 ? `（${failed.join('、')}）` : ''}——服务已恢复，请人工清理残留文件后重试打印`
}

// ══════════════ L4 引导文案（不执行，只引导） ══════════════

const L4_GUIDANCE: Record<'DISABLE_SNMP' | 'REINSTALL_DRIVER_GUIDE' | 'GENERIC_TEXT_ONLY_GUIDE', string> = {
  DISABLE_SNMP:
    '禁用端口 SNMP 状态监测需在系统设置中操作：设置 → 蓝牙和其他设备 → 打印机和扫描仪 → 选中打印机 → 打印机属性 → 端口 → 配置端口 → 取消勾选「SNMP 状态启用」。SNMP 误报消除后打印机将不再显示虚假的离线状态；若打印恢复正常即无需其他操作。',
  REINSTALL_DRIVER_GUIDE:
    '请到打印机制造商官网下载对应型号的最新驱动，在「打印机和扫描仪」中先移除该打印机（端口会保留），再运行驱动安装包重新添加。完成后重启本应用并再次运行诊断，确认驱动名称匹配且打印正常。',
  GENERIC_TEXT_ONLY_GUIDE:
    'Generic / Text Only 是 Windows 自带的兜底驱动（仅支持文本，不支持图形/切刀等指令，小票格式会退化）：在「打印机和扫描仪」→ 添加打印机 → 选「手动添加」→ 使用 Generic / Text Only 驱动。此方案仅作为驱动崩溃环的临时逃生通道，确认业务可接受格式退化后再使用。'
}

// ══════════════ 主入口 ══════════════

/**
 * 执行一个修复动作。
 *
 * @param actionId 修复动作编码（schema.RepairActionId 九值之一）
 * @param ctx 目标打印机 / WSD 主机地址（CANCEL/MIGRATE 必填，缺省 reject）
 * @param deps 可注入项（execFile / 平台 / 落盘 / setChannel / result 路径 / dryRun）
 * @returns done=已完成 / needs-manual=需人工（UAC 拒绝、purge 2/3、L4 引导）/ dry-run=仅预览
 * @throws 非 win32 平台、必填 ctx 缺失、DI 缺失（setChannel）、直执行失败、提权窗口启动失败（非拒绝）等执行层故障
 */
export async function runRepairAction(
  actionId: RepairActionId,
  ctx: RepairActionContext,
  deps: RepairDeps = {}
): Promise<RepairOutcome> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    throw new Error(`打印诊断修复动作仅 Windows 可执行（当前平台：${platform}）`)
  }

  switch (actionId) {
    // ── L1：直执行（无提权）──
    case 'CANCEL_ERROR_JOBS': {
      const printer = ctx.targetPrinter ?? ''
      if (printer === '') {
        throw new Error('CANCEL_ERROR_JOBS 需要 targetPrinter（目标打印机不能为空）')
      }
      const spec = buildCancelErrorJobsCommand(printer)
      await execRepairSpec(spec, 'CANCEL_ERROR_JOBS', deps, REPAIR_DIRECT_TIMEOUT_MS)
      return {
        status: 'done',
        detail: `已清除「${printer}」队列中属于当前用户的错误任务（他人任务不受影响）`
      }
    }

    // ── L1：应用内通道切换（DI：不碰系统，改 settings 由宿主负责）──
    case 'SWITCH_TO_DRIVER_CHANNEL':
    case 'SWITCH_TO_SPOOLER_CHANNEL': {
      if (!deps.setChannel) {
        throw new Error('SWITCH_*_CHANNEL 需要 deps.setChannel 注入（应用内通道切换由宿主提供）')
      }
      const channel = actionId === 'SWITCH_TO_DRIVER_CHANNEL' ? 'driver' : 'spooler'
      await deps.setChannel(channel)
      return {
        status: 'done',
        detail:
          channel === 'driver'
            ? '已切换打印通道为 driver（驱动渲染兜底，兼容「云」打印机；RAW 指令不再直发）'
            : '已切换打印通道为 spooler（ESC/POS 指令直发主通道）'
      }
    }

    // ── L2：清队列 + 重启 Spooler（UAC 提权 + result-file 契约）──
    case 'PURGE_QUEUE_RESTART_SPOOLER': {
      const script = buildPurgeQueueScript()
      if (deps.dryRun) {
        return { status: 'dry-run', commands: [script] }
      }
      const scriptPath = join(tmpdir(), PURGE_SCRIPT_FILENAME)
      const resultPath = deps.resultFilePath ?? join(tmpdir(), PURGE_RESULT_FILENAME)
      const writer = deps.writeScriptFile ?? ((path, content) => writeFileSync(path, content, 'utf8'))
      try {
        writer(scriptPath, UTF8_BOM + script)
      } catch (e) {
        throw new Error(`PURGE_QUEUE_RESTART_SPOOLER 脚本落盘失败（${scriptPath}）：${errorMessage(e)}`)
      }
      // 结果文件先清再跑——防上一次运行的结果被误读（exit code 是主契约，此为防御）
      try {
        rmSync(resultPath, { force: true })
      } catch {
        /* 清不掉不阻塞——读不到时 detail 会如实标注 */
      }
      const uac = buildUacElevationCommand([
        ...PS_COMMON_ARGS,
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
        '-ResultPath',
        resultPath
      ])
      const outcome = await execUac(uac, 'PURGE_QUEUE_RESTART_SPOOLER', deps, REPAIR_UAC_TIMEOUT_MS)
      if (outcome.kind === 'declined') {
        return uacDeclinedOutcome()
      }
      if (outcome.code === 0) {
        return { status: 'done', detail: purgeDoneDetail(readPurgeResult(resultPath)) }
      }
      if (outcome.code === 2 || outcome.code === 3) {
        return {
          status: 'needs-manual',
          detail: purgeFailureDetail(outcome.code, readPurgeResult(resultPath), resultPath)
        }
      }
      const detail = outcome.stderr.trim() !== '' ? ` | stderr：${outcome.stderr.trim().slice(0, 300)}` : ''
      throw new Error(
        `PURGE_QUEUE_RESTART_SPOOLER 提权执行异常退出（exit ${outcome.code}）${detail}`
      )
    }

    // ── L2：WSD → 标准 TCP 迁移（直执行，无提权；支持 dryRun）──
    case 'MIGRATE_WSD_TO_TCP': {
      const printer = ctx.targetPrinter ?? ''
      const host = ctx.hostAddress ?? ''
      if (printer === '' || host === '') {
        throw new Error('MIGRATE_WSD_TO_TCP 需要 targetPrinter 与 hostAddress（来自诊断快照 port 段）')
      }
      const spec = buildWsdMigrateCommands(printer, host)
      if (deps.dryRun) {
        return { status: 'dry-run', commands: [spec.args[spec.args.length - 1]] }
      }
      await execRepairSpec(spec, 'MIGRATE_WSD_TO_TCP', deps, REPAIR_DIRECT_TIMEOUT_MS)
      return {
        status: 'done',
        detail: `已将「${printer}」迁移到标准 TCP/IP 端口（IP_${host}）；旧 WSD 端口已保留，异常时可在打印机属性中切回`
      }
    }

    // ── L2：启用 Operational 日志（wevtutil 需管理员 → 经 UAC 链）──
    case 'ENABLE_PRINT_LOG': {
      const spec = buildEnablePrintLogCommand()
      const uac = buildUacElevationCommand(spec.args)
      const outcome = await execUac(uac, 'ENABLE_PRINT_LOG', deps, REPAIR_UAC_TIMEOUT_MS)
      if (outcome.kind === 'declined') {
        return uacDeclinedOutcome()
      }
      if (outcome.code === 0) {
        return {
          status: 'done',
          detail: '已启用 PrintService/Operational 事件日志——重启打印链路后，再次诊断即可看到任务级事件记录'
        }
      }
      const detail = outcome.stderr.trim() !== '' ? ` | stderr：${outcome.stderr.trim().slice(0, 300)}` : ''
      throw new Error(`ENABLE_PRINT_LOG 提权执行异常退出（exit ${outcome.code}）${detail}`)
    }

    // ── L4：引导（不执行任何命令）──
    default: {
      return { status: 'needs-manual', detail: L4_GUIDANCE[actionId] }
    }
  }
}
