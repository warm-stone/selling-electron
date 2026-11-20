import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 极简主进程文件日志（P2-3；零依赖，方案 B——项目体量不引入 electron-log）。
 *
 * 两条硬要求（omo 评估裁决 3）：
 *  - **同步写**（appendFileSync）：崩溃时异步 append 恰好丢掉最后几行，
 *    而那正是最需要的取证材料；
 *  - **体积上限 + 轮转**：POS 机常年不重启，无界日志会吃满磁盘。
 *    单文件到顶改名 .1（保留 1 份备份，旧备份直接覆盖），约 30 行实现。
 *
 * 定位：只承接进程级异常兜底与 error/warn 级留痕（uncaughtException /
 * unhandledRejection / render-process-gone / child-process-gone），不做
 * 全量 info 流水——业务失败本就有 IPC 错误回传给 renderer 展示。
 *
 * 自身永不成为新崩溃点：所有 fs 操作吞错（磁盘满/权限/未初始化 → 静默降级）。
 */

/** 轮转阈值默认 ~1MB（测试注入小值驱动轮转分支） */
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024

let logFile: string | null = null
let maxBytes = DEFAULT_MAX_BYTES

/** 初始化（main/index.ts 启动即调；logsDir = userData/logs）。重复调用以最后一次为准。 */
export function initLogger(logsDir: string, maxBytesOverride?: number): void {
  try {
    mkdirSync(logsDir, { recursive: true })
    logFile = join(logsDir, 'main.log')
    if (maxBytesOverride !== undefined && maxBytesOverride > 0) maxBytes = maxBytesOverride
  } catch {
    logFile = null // 目录建不出来 → 日志静默降级，不阻塞启动
  }
}

/** 当前日志文件路径（测试断言用；未初始化 → null） */
export function getLogFilePath(): string | null {
  return logFile
}

export function logError(scope: string, error: unknown): void {
  write('ERROR', scope, formatError(error))
}

export function logWarn(scope: string, message: string): void {
  write('WARN', scope, message)
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }
  return String(error)
}

function write(level: 'ERROR' | 'WARN', scope: string, detail: string): void {
  if (!logFile) return // 未初始化：静默跳过（日志绝不反过来弄崩主流程）
  const line = `${new Date().toISOString()} [${level}] ${scope}: ${detail}\n`
  try {
    rotateIfNeeded(logFile)
    appendFileSync(logFile, line) // 同步写（write-through）：崩溃现场不丢尾部
  } catch {
    // 磁盘满/权限/占用：吞掉——日志自身不得成为新崩溃点
  }
}

/** 到顶轮转：main.log → main.log.1（仅保留 1 份备份，旧备份覆盖即弃） */
function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size >= maxBytes) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    // 文件尚不存在（首写）或 stat/rename 失败 → 不轮转，append 自会建文件
  }
}
