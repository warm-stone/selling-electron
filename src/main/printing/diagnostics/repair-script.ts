/**
 * 打印诊断修复动作构建器（printer-diagnostics 计划 Wave 3 / T6）。
 *
 * **纯函数模块**：只拼装命令/脚本文本，不执行任何东西（执行归 repair.runner）。
 * 消费方：repair.runner（L1/L2 执行）+ T9 编排（目录展示/确认流/dry-run）。
 *
 * 契约要点：
 * - **L1 本人任务过滤（安全关键）**：CANCEL_ERROR_JOBS 只删 Owner 与当前用户
 *   比对（`$_.Owner -eq $env:USERNAME`）的错误任务——绝不删他人任务。
 * - **PURGE 金标准序列**（PS 5.1，`-File` 落盘执行）：#Requires 自检 → 依赖服务
 *   记录 → 注册表 spool 目录 → Stop-Service + WaitForStatus → 停后重读目录按
 *   年龄过滤删除 → finally 无条件恢复服务与依赖 → 单一 exit 点写 result-file。
 *   5 处 `# guardrail:` 注释标记是测试锚点（改脚本别丢标记）。
 * - **显式 exit code 契约**：成功 0 / 停服务失败 2 / 删文件部分失败 3。
 *   `-Verb RunAs` 提权窗口与 stdout 重定向互斥——exit code + result-file 是
 *   唯一回传通道（`param($ResultPath)` 参数化，写入 `-Encoding UTF8` 带 BOM，
 *   runner 侧读取时 strip）。
 * - **PS 5.1 语法 only**：无 `??` / 无三元 / 无 `&&`/`||`；Start-Process
 *   -ArgumentList 不会给含空格元素自动加引号（已知坑）——psArgumentListElement
 *   双层处理：PS 单引号翻倍 + 空格外再包双引号。
 * - **WSD 迁移不删旧端口**：不含 Remove-PrinterPort——旧 WSD 端口保留作回滚
 *   路径；不使用 Set-PrinterPort（该命令不存在）。
 * - 脚本零中文字面量（编码风险归零，同 collect-script 前例）。
 */

import { escapePowerShellSingleQuoted } from '../channels/spooler.channel'
import type { RepairAction } from './schema'

/** 拼装完成的 PowerShell 调用规格（纯函数产物，可单测、不执行） */
export interface RepairCommandSpec {
  file: 'powershell.exe'
  args: string[]
}

/** 所有 PowerShell 调用统一前缀（与 spooler.channel / collect.runner 一致） */
export const PS_COMMON_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'] as const

/** powershell.exe -Command 内联脚本调用组装 */
function psCommand(script: string): RepairCommandSpec {
  return { file: 'powershell.exe', args: [...PS_COMMON_ARGS, '-Command', script] }
}

// ══════════════ L1：清本人错误任务（无提权，不确认，自动执行） ══════════════

/**
 * L1：构建「清除指定打印机上**当前用户**的错误打印任务」命令（不执行）。
 *
 * 安全关键：Where-Object 过滤器把 Owner 与 $env:USERNAME 比对——只删本人的
 * Error 状态任务，他人任务与本人非错误任务都不受影响。打印机名经
 * escapePowerShellSingleQuoted 转义（复用 spooler.channel 的实现）。
 */
export function buildCancelErrorJobsCommand(printerName: string): RepairCommandSpec {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Get-PrintJob -PrinterName '${escapePowerShellSingleQuoted(printerName)}'`,
    "  | Where-Object { $_.JobStatus -like '*Error*' -and $_.Owner -eq $env:USERNAME }",
    '  | Remove-PrintJob'
  ].join('\n')
  return psCommand(script)
}

// ══════════════ L2：清队列 + 重启 Spooler（提权，破坏半径：全机队列） ══════════════

/**
 * L2：构建清队列金标准脚本（PS 5.1 脚本文本，供 -File 落盘执行；不执行）。
 *
 * @param options.olderThanMinutes 只清「N 分钟前」的残留文件；未定义 = 清空全部
 *   残留（PURGE 语义即全清）。非法值（负数/NaN/Infinity）直接 throw。
 *
 * 结构（5 个 `# guardrail:` 标记是测试锚点）：
 * 1. `#Requires -RunAsAdministrator` 自检 + `param($ResultPath)` 参数化；
 * 2. 依赖服务记录（DependentServices 中 Running 的）——Stop-Service -Force 会
 *    连带停掉它们，finally 要原样恢复；
 * 3. guardrail: registry-spooldir——注册表 DefaultSpoolDirectory 读真实 spool
 *    目录（回退 System32 默认路径）；
 * 4. Stop-Service -Force + guardrail: wait-for-status（WaitForStatus 30s——
 *    服务没真停绝不碰文件）；
 * 5. 停后重读目录 + guardrail: age-filter（年龄过滤）逐文件删除（失败逐个记
 *    入 failedFiles，不拖垮整批）；
 * 6. finally 无条件：guardrail: restart-spooler + guardrail: restore-dependents；
 * 7. **单一 exit 点在 finally 之后**：结果 JSON（deletedCount/failedFiles/
 *    error/failedPhase/…）写 $ResultPath 后 `exit $exitCode`——放 finally 里
 *    会被 exit-through-finally 语义吞掉执行顺序，放 try 里则停服务失败路径
 *    永远写不了结果；0 成功 / 2 停服务失败（含 prepare 阶段，机器原样）/
 *    3 删文件部分失败（服务已恢复）。
 */
export function buildPurgeQueueScript(options: { olderThanMinutes?: number } = {}): string {
  const older = options.olderThanMinutes
  if (older !== undefined && (!Number.isFinite(older) || older < 0)) {
    throw new Error(`buildPurgeQueueScript：olderThanMinutes 必须是非负有限数（收到 ${String(older)}）`)
  }
  // 年龄过滤表达式直接烘进脚本（选项是有限非负数——无注入面）
  const ageFilterExpr = older === undefined ? '$true' : `$_.LastWriteTime -lt (Get-Date).AddMinutes(-${older})`
  const ageFilterRecord = older === undefined ? "'all'" : String(older)

  const lines: string[] = [
    '#Requires -RunAsAdministrator',
    'param($ResultPath)',
    '# Purge all spool queue residue and restart the Print Spooler (PS 5.1, elevated).',
    '# Exit codes: 0 = ok, 2 = stop-service failed, 3 = partial delete failures.',
    "# Outcome JSON is written to $ResultPath (UTF8 with BOM) as the only result channel",
    '# (an elevated -Verb RunAs window cannot redirect stdout back to the caller).',
    "$ErrorActionPreference = 'Stop'",
    '$exitCode = 0',
    "$phase = 'prepare'",
    '$deps = @()',
    '$result = [ordered]@{',
    '  deletedCount = 0',
    '  failedFiles = @()',
    '  failedPhase = $null',
    '  error = $null',
    '  spoolDir = $null',
    '  dependents = @()',
    `  ageFilterMinutes = ${ageFilterRecord}`,
    '  exitCode = 0',
    '}',
    'try {',
    '  $svc = Get-Service -Name Spooler',
    "  $deps = @($svc.DependentServices | Where-Object { $_.Status -eq 'Running' } | ForEach-Object { $_.Name })",
    '  $result.dependents = $deps',
    '',
    '  # guardrail: registry-spooldir -- read the real spool directory from registry, fallback to the System32 default',
    "  $reg = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers' -Name DefaultSpoolDirectory -ErrorAction SilentlyContinue",
    '  $dir = if ($reg -and $reg.DefaultSpoolDirectory) { $reg.DefaultSpoolDirectory } else { "$env:SystemRoot\\System32\\spool\\PRINTERS" }',
    '  $result.spoolDir = $dir',
    '',
    "  $phase = 'stop'",
    '  Stop-Service -Name Spooler -Force',
    '  # guardrail: wait-for-status -- files are only touched after the service is really stopped',
    "  (Get-Service -Name Spooler).WaitForStatus('Stopped', [timespan]::FromSeconds(30))",
    '',
    "  $phase = 'delete'",
    '  # guardrail: age-filter -- no option = purge all residue; N = only files older than N minutes',
    `  $targets = @(Get-ChildItem -LiteralPath $dir -File -Force -ErrorAction SilentlyContinue | Where-Object { ${ageFilterExpr} })`,
    '  foreach ($f in $targets) {',
    '    try {',
    '      Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop',
    '      $result.deletedCount++',
    '    } catch {',
    '      $result.failedFiles += $f.Name',
    '    }',
    '  }',
    '  if ($result.failedFiles.Count -gt 0) { $exitCode = 3 }',
    '} catch {',
    '  $result.error = $_.Exception.Message',
    '  $result.failedPhase = $phase',
    "  if ($phase -eq 'delete') { $exitCode = 3 } else { $exitCode = 2 }",
    '} finally {',
    '  # guardrail: restart-spooler -- unconditional: success, partial failure and stop failure all pass through here',
    '  try { Start-Service -Name Spooler -ErrorAction Stop } catch { }',
    '  # guardrail: restore-dependents -- bring back the dependent services that were running before the purge',
    '  $deps | ForEach-Object { try { Start-Service -Name $_ -ErrorAction SilentlyContinue } catch { } }',
    '}',
    '# single exit point -- the outcome is recorded AFTER the finally block, so an exit here',
    '# cannot be reordered or masked by the finally restart logic',
    '$result.exitCode = $exitCode',
    'try { $result | ConvertTo-Json -Depth 4 | Set-Content -Path $ResultPath -Encoding UTF8 } catch { }',
    'exit $exitCode'
  ]
  return lines.join('\n')
}

// ══════════════ L2：WSD → 标准 TCP 端口迁移（保守归 L2，无提权） ══════════════

/**
 * L2：构建 WSD 端口 → 标准 TCP/IP 端口迁移命令（不执行）。
 *
 * - `Add-PrinterPort -Name 'IP_<host>' -PrinterHostAddress '<host>'`（带存在性
 *   防重护栏——重复执行不报错，幂等）+ `Set-Printer -PortName 'IP_<host>'`；
 * - **不含 Remove-PrinterPort**：旧 WSD 端口保留，打印异常时可在打印机属性里
 *   切回（回滚路径）；不使用 Set-PrinterPort（该命令不存在）；
 * - 两条命令一个 PS 调用（分号连接），打印机名/主机地址均经 PS 单引号转义。
 */
export function buildWsdMigrateCommands(printerName: string, hostAddress: string): RepairCommandSpec {
  const escapedHost = escapePowerShellSingleQuoted(hostAddress)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$portName = 'IP_${escapedHost}'`,
    `if (-not (Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $portName -PrinterHostAddress '${escapedHost}' }`,
    `Set-Printer -Name '${escapePowerShellSingleQuoted(printerName)}' -PortName $portName`
  ].join('; ')
  return psCommand(script)
}

// ══════════════ L2：启用 PrintService/Operational 日志（wevtutil 需管理员→提权） ══════════════

/**
 * L2：构建启用 PrintService/Operational 事件日志命令（不执行）。
 *
 * `wevtutil sl Microsoft-Windows-PrintService/Operational /e:true`——wevtutil
 * 修改日志开关需要管理员权限，实际执行经 UAC 提权包装（本 spec 的 args 即
 * 提权子进程的内层参数）；-WindowStyle Hidden 隐藏提权窗口闪烁（结果透明度
 * 由 exit code 回传保证）。
 */
export function buildEnablePrintLogCommand(): RepairCommandSpec {
  return {
    file: 'powershell.exe',
    args: [
      ...PS_COMMON_ARGS,
      '-WindowStyle',
      'Hidden',
      '-Command',
      'wevtutil sl Microsoft-Windows-PrintService/Operational /e:true'
    ]
  }
}

// ══════════════ UAC 提权包装（外层 -Command 脚本） ══════════════

/**
 * Start-Process -ArgumentList 元素的双层转义：
 * 1. PS 单引号字符串内单引号翻倍（元素外层是 '…' 字面量）；
 * 2. 含空格的元素再包一层双引号——Start-Process 按空格拼接子进程命令行，
 *    不自动加引号（含空格路径会被拆散的已知坑；双引号在 PS 单引号串里是字面量）。
 * 约束：Windows 路径不可能含双引号，故无需（也不可能）转义内嵌双引号。
 */
function psArgumentListElement(arg: string): string {
  const escaped = escapePowerShellSingleQuoted(arg)
  return `'${arg.includes(' ') ? `"${escaped}"` : escaped}'`
}

/**
 * 构建 UAC 提权包装命令（不执行）——把「内层 powershell 参数」经
 * `Start-Process powershell -Verb RunAs -ArgumentList … -Wait -PassThru` 提权执行，
 * 并把子进程 ExitCode 透传为本进程 exit code。
 *
 * **UAC 拒绝路径（安全关键）**：用户在 consent 对话框点「否」时 Start-Process
 * 抛错（消息本地化：'This operation was canceled by the user.' / 中文
 * '操作已被用户取消'）——catch 里三信号映射到 exit 1223（ERROR_CANCELLED）：
 * - 消息含 'cancel' / '取消'；
 * - Exception.HResult = -2147023673（0x800704C7 = HRESULT_FROM_WIN32(1223)，
 *   区域设置无关的防御信号，若该异常未携带此 HResult 则静默无效、不误伤）。
 * 其他启动失败 → exit 4（runner 侧上抛）。runner 侧另有 code 优先 + message
 * 兜底的双信号复核（防御本地化遗漏），两层各尽其职。
 *
 * @param innerArgs 提权子进程的完整参数（如 ['-NoProfile',…,'-File','x.ps1']）
 */
export function buildUacElevationCommand(innerArgs: readonly string[]): RepairCommandSpec {
  if (innerArgs.length === 0) {
    throw new Error('buildUacElevationCommand：innerArgs 不能为空（至少需要一条子进程参数）')
  }
  const argList = innerArgs.map(psArgumentListElement).join(',')
  const wrapper = [
    'try {',
    `  $p = Start-Process powershell -Verb RunAs -ArgumentList ${argList} -Wait -PassThru`,
    '  if ($null -eq $p -or $null -eq $p.ExitCode) { exit 4 }',
    '  exit $p.ExitCode',
    '} catch {',
    "  $cancelled = ($_.Exception.Message -like '*cancel*') -or ($_.Exception.Message -like '*取消*') -or ($_.Exception.HResult -eq -2147023673)",
    '  if ($cancelled) { exit 1223 }',
    '  exit 4',
    '}'
  ].join('\n')
  return psCommand(wrapper)
}

// ══════════════ 修复动作目录（T9 编排消费：确认流/提权标记/dry-run 支持） ══════════════

/**
 * 9 动作目录（id/level/needsElevation/requiresConfirm/description/dryRun）。
 *
 * 关键决策（T1 契约 + 本任务定夺）：
 * - PURGE_QUEUE_RESTART_SPOOLER：needsElevation=true（Stop-Service/提权窗口），
 *   requiresConfirm=true（破坏半径：清空**全机**队列），支持 dryRun；
 * - ENABLE_PRINT_LOG：needsElevation=**true**（wevtutil sl 需管理员——目录里
 *   标注提权，runner 走 UAC 链）；MIGRATE_WSD_TO_TCP 保守归 L2 但不提权；
 * - SWITCH_* 两个通道切换归 L1（应用内改 settings，无提权）但 requiresConfirm=
 *   true（改用户配置应知情）；
 * - 三个 L4 引导动作 inert：不执行任何命令，只出 needs-manual 引导文案。
 */
export function buildRepairActionCatalog(): RepairAction[] {
  return [
    {
      id: 'CANCEL_ERROR_JOBS',
      level: 'L1',
      needsElevation: false,
      requiresConfirm: false,
      description: '清除该打印机队列中属于当前用户的错误任务（不影响他人任务与其他任务）',
      dryRun: false
    },
    {
      id: 'SWITCH_TO_DRIVER_CHANNEL',
      level: 'L1',
      needsElevation: false,
      requiresConfirm: true,
      description: '应用内切换到 driver 渲染兜底通道（绕开 spooler RAW 兼容性问题；修改打印配置需您确认）',
      dryRun: false
    },
    {
      id: 'SWITCH_TO_SPOOLER_CHANNEL',
      level: 'L1',
      needsElevation: false,
      requiresConfirm: true,
      description: '应用内切回 spooler 主通道（ESC/POS 指令直发，速度最快）',
      dryRun: false
    },
    {
      id: 'PURGE_QUEUE_RESTART_SPOOLER',
      level: 'L2',
      needsElevation: true,
      requiresConfirm: true,
      description:
        '停止 Print Spooler 并清空本机打印队列残留文件后重启服务（破坏半径大：影响本机所有打印任务；需管理员授权）',
      dryRun: true
    },
    {
      id: 'MIGRATE_WSD_TO_TCP',
      level: 'L2',
      needsElevation: false,
      requiresConfirm: true,
      description:
        '把打印机的 WSD 端口迁移为标准 TCP/IP 端口（WSD 丢任务/掉线的标准修复；旧 WSD 端口保留可回滚）',
      dryRun: true
    },
    {
      id: 'ENABLE_PRINT_LOG',
      level: 'L2',
      needsElevation: true,
      requiresConfirm: true,
      description:
        '启用 PrintService/Operational 事件日志（后续诊断可看到任务级事件；wevtutil 需管理员授权）',
      dryRun: false
    },
    {
      id: 'DISABLE_SNMP',
      level: 'L4',
      needsElevation: false,
      requiresConfirm: false,
      description: '禁用端口 SNMP 状态监测的引导（SNMP 误报离线的修复；不自动执行，见 detail 引导文案）',
      dryRun: false
    },
    {
      id: 'REINSTALL_DRIVER_GUIDE',
      level: 'L4',
      needsElevation: false,
      requiresConfirm: false,
      description: '重装打印机驱动的人工引导（驱动文件损坏/崩溃环时的处理路径）',
      dryRun: false
    },
    {
      id: 'GENERIC_TEXT_ONLY_GUIDE',
      level: 'L4',
      needsElevation: false,
      requiresConfirm: false,
      description: '切换 Generic / Text Only 兜底驱动的人工引导（最后的兼容方案，仅出引导不执行）',
      dryRun: false
    }
  ]
}
