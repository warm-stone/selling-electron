import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFileError, ExecFileFn } from '../../../../src/main/printing/channels/spooler.channel'
import {
  buildCancelErrorJobsCommand,
  buildEnablePrintLogCommand,
  buildPurgeQueueScript,
  buildRepairActionCatalog,
  buildUacElevationCommand,
  buildWsdMigrateCommands
} from '../../../../src/main/printing/diagnostics/repair-script'
import { runRepairAction } from '../../../../src/main/printing/diagnostics/repair.runner'
import type { RepairActionId, RepairLevel } from '../../../../src/main/printing/diagnostics/schema'

/**
 * printer-diagnostics T6 —— 修复动作构建器 + 执行器测试。
 * 纯函数部分做结构/契约断言（不执行 PowerShell）；runRepairAction 用 fake
 * execFile / fake setChannel / fake writeScriptFile 走全编排（win32 注入平台）。
 */

/** 子串计数（split 技巧：出现 n 次 → 分割成 n+1 段） */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// ══════════════ fake execFile（行为可配置；记录调用供断言） ══════════════

interface FakeExecBehavior {
  /** 回调错误（code/message 形状对齐 ExecFileError） */
  error?: { code?: number | string | null; message?: string }
  stdout?: string
  stderr?: string
  /** 回调前副作用（模拟提权脚本写 result-file） */
  before?: () => void
}

function makeFakeExec(behavior: FakeExecBehavior) {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const fake = ((
    file: string,
    args: readonly string[],
    _options: { windowsHide?: boolean; timeout?: number },
    callback: (error: ExecFileError, stdout: string, stderr: string) => void
  ) => {
    calls.push({ file, args })
    behavior.before?.()
    if (behavior.error !== undefined) {
      const err = Object.assign(new Error(behavior.error.message ?? `Command failed: ${file}`), {
        code: behavior.error.code ?? null
      }) as Error & { code: number | string | null }
      callback(err, behavior.stdout ?? '', behavior.stderr ?? '')
    } else {
      callback(null, behavior.stdout ?? '', behavior.stderr ?? '')
    }
    return { stdin: null }
  }) as ExecFileFn
  return { fake, calls }
}

/** 结果文件目录（result-file 契约测试用真实临时文件——runner 内部用真 fs 读） */
const tmpDir = mkdtempSync(join(tmpdir(), 'repair-t6-'))
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ══════════════ buildCancelErrorJobsCommand（L1 本人任务过滤） ══════════════

describe('buildCancelErrorJobsCommand（L1 本人任务过滤——不删他人任务）', () => {
  const spec = buildCancelErrorJobsCommand('POS-80')

  it('L1 本人过滤：命令文本含 Owner -eq $env:USERNAME（安全关键——只清自己的任务）', () => {
    const text = spec.args[spec.args.length - 1]
    expect(text).toContain('Owner -eq $env:USERNAME')
  })

  it('结构：powershell.exe + 统一前缀 + -Command 单条脚本', () => {
    expect(spec.file).toBe('powershell.exe')
    expect(spec.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command'
    ])
    expect(spec.args).toHaveLength(6)
  })

  it('错误任务过滤 + 删除链：Get-PrintJob → JobStatus -like *Error* → Remove-PrintJob', () => {
    const text = spec.args[spec.args.length - 1]
    expect(text).toContain("Get-PrintJob -PrinterName 'POS-80'")
    expect(text).toContain("JobStatus -like '*Error*'")
    expect(text).toContain('Remove-PrintJob')
  })

  it('打印机名单引号转义（PS 单引号翻倍，复用 spooler.channel 实现）', () => {
    const text = buildCancelErrorJobsCommand("O'Brien's 打印机").args[5]
    expect(text).toContain("'O''Brien''s 打印机'")
  })
})

// ══════════════ buildPurgeQueueScript（L2 清队列金标准序列） ══════════════

describe('buildPurgeQueueScript（L2 清队列金标准序列 + 5 护栏）', () => {
  const script = buildPurgeQueueScript()

  it('纯函数确定性：同参数两次调用 === 全等', () => {
    expect(buildPurgeQueueScript()).toBe(script)
    expect(buildPurgeQueueScript() === buildPurgeQueueScript()).toBe(true)
  })

  it('首行 #Requires -RunAsAdministrator 自检 + 次行 param($ResultPath) 参数化', () => {
    const lines = script.split('\n')
    expect(lines[0]).toBe('#Requires -RunAsAdministrator')
    expect(lines[1]).toBe('param($ResultPath)')
  })

  it('purge 脚本 5 护栏标记各 ≥1（测试锚点——改脚本别丢标记）', () => {
    const guardrails = [
      '# guardrail: registry-spooldir',
      '# guardrail: wait-for-status',
      '# guardrail: restart-spooler',
      '# guardrail: restore-dependents',
      '# guardrail: age-filter'
    ]
    for (const g of guardrails) {
      expect(count(script, g)).toBeGreaterThanOrEqual(1)
    }
  })

  it('护栏实质：注册表 DefaultSpoolDirectory + System32 回退路径', () => {
    expect(script).toContain(String.raw`Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers' -Name DefaultSpoolDirectory`)
    expect(script).toContain(String.raw`"$env:SystemRoot\System32\spool\PRINTERS"`)
  })

  it('护栏实质：Stop-Service -Force + WaitForStatus 30 秒（服务没真停不碰文件）', () => {
    expect(script).toContain('Stop-Service -Name Spooler -Force')
    expect(script).toContain("WaitForStatus('Stopped', [timespan]::FromSeconds(30))")
  })

  it('护栏实质：finally 无条件 Start-Service（restart 位置在 finally 块之内）', () => {
    expect(count(script, '} finally {')).toBe(1)
    const finallyPos = script.indexOf('} finally {')
    const restartPos = script.indexOf('Start-Service -Name Spooler')
    expect(restartPos).toBeGreaterThan(finallyPos)
    expect(restartPos).toBeGreaterThan(script.indexOf('Stop-Service -Name Spooler'))
  })

  it('护栏实质：依赖服务先记录（DependentServices/Running）后恢复（Start-Service -Name $_）', () => {
    expect(script).toContain('$svc.DependentServices')
    expect(script).toContain("Where-Object { $_.Status -eq 'Running' }")
    expect(script).toContain('Start-Service -Name $_ -ErrorAction SilentlyContinue')
  })

  it('护栏实质：年龄过滤——默认全清 Where-Object { $true }；olderThanMinutes=30 → LastWriteTime -lt -30 分钟', () => {
    expect(script).toContain('Where-Object { $true }')
    expect(script).not.toContain('LastWriteTime')
    const withAge = buildPurgeQueueScript({ olderThanMinutes: 30 })
    expect(withAge).toContain('Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-30) }')
    expect(withAge).not.toContain('Where-Object { $true }')
  })

  it('显式 exit 契约：0 成功 / 2 停服务失败 / 3 删文件部分失败；唯一 exit 点在 finally 之后', () => {
    const lines = script.split('\n')
    const exitLines = lines.filter((l) => l.startsWith('exit '))
    expect(exitLines).toEqual(['exit $exitCode'])
    expect(script).toContain("if ($phase -eq 'delete') { $exitCode = 3 } else { $exitCode = 2 }")
    expect(script).toContain('if ($result.failedFiles.Count -gt 0) { $exitCode = 3 }')
    // 顺序锁：finally 块 → 结果文件写入 → 唯一 exit 点（exit 不能被 finally 语义重排）
    const finallyIdx = lines.indexOf('} finally {')
    const resultWriteIdx = lines.findIndex((l) => l.startsWith('try { $result | ConvertTo-Json'))
    const exitIdx = lines.indexOf('exit $exitCode')
    expect(resultWriteIdx).toBeGreaterThan(finallyIdx)
    expect(exitIdx).toBeGreaterThan(resultWriteIdx)
  })

  it('PS 5.1 语法 + 零中文字面量（编码风险归零）', () => {
    for (const banned of ['??', '&&', '||']) {
      expect(script, `purge 脚本不应包含禁词 ${banned}`).not.toContain(banned)
    }
    expect(/[\u4e00-\u9fff]/.test(script)).toBe(false)
  })

  it('olderThanMinutes 非法值（负数/NaN/Infinity）→ throw', () => {
    expect(() => buildPurgeQueueScript({ olderThanMinutes: -1 })).toThrow()
    expect(() => buildPurgeQueueScript({ olderThanMinutes: Number.NaN })).toThrow()
    expect(() => buildPurgeQueueScript({ olderThanMinutes: Number.POSITIVE_INFINITY })).toThrow()
  })
})

// ══════════════ buildWsdMigrateCommands（L2 WSD → 标准 TCP） ══════════════

describe('buildWsdMigrateCommands（L2 WSD → 标准 TCP 迁移）', () => {
  const spec = buildWsdMigrateCommands('前台小票', '192.168.1.66')

  it('含 Add-PrinterPort（带存在性防重护栏）+ Set-Printer -PortName', () => {
    const text = spec.args[spec.args.length - 1]
    expect(text).toContain('Add-PrinterPort -Name $portName -PrinterHostAddress')
    expect(text).toContain("Set-Printer -Name '前台小票' -PortName $portName")
    expect(text).toContain("$portName = 'IP_192.168.1.66'")
    expect(text).toContain('Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue')
  })

  it('不含 Remove-PrinterPort（旧 WSD 端口保留作回滚路径），也不含不存在的 Set-PrinterPort', () => {
    const text = spec.args[spec.args.length - 1]
    expect(text).not.toContain('Remove-Printer')
    expect(text).not.toContain('Set-PrinterPort')
  })

  it('分号连接单条命令 + 打印机名/主机地址 PS 单引号转义', () => {
    const text = buildWsdMigrateCommands("O'Neil", "10.0.0'1").args[5]
    expect(text).toContain("; ")
    expect(text).toContain("'O''Neil'")
    expect(text).toContain("IP_10.0.0''1")
  })
})

// ══════════════ buildEnablePrintLogCommand（L2 启用 Operational 日志） ══════════════

describe('buildEnablePrintLogCommand（L2 启用 Operational 日志）', () => {
  it('wevtutil sl Microsoft-Windows-PrintService/Operational /e:true（args 即 UAC 内层参数）', () => {
    const spec = buildEnablePrintLogCommand()
    expect(spec.file).toBe('powershell.exe')
    expect(spec.args).toContain('-Command')
    expect(spec.args[spec.args.length - 1]).toBe(
      'wevtutil sl Microsoft-Windows-PrintService/Operational /e:true'
    )
  })
})

// ══════════════ buildUacElevationCommand（UAC 提权包装） ══════════════

describe('buildUacElevationCommand（UAC 提权包装）', () => {
  const spec = buildUacElevationCommand(['-NoProfile', '-File', 'C:\\a b\\x.ps1', '-ResultPath', 'C:\\r.json'])
  const wrapper = spec.args[spec.args.length - 1]

  it('Start-Process -Verb RunAs -Wait -PassThru + exit $p.ExitCode 透传', () => {
    expect(spec.file).toBe('powershell.exe')
    expect(spec.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
    expect(wrapper).toContain('Start-Process powershell -Verb RunAs')
    expect(wrapper).toContain('-Wait -PassThru')
    expect(wrapper).toContain('exit $p.ExitCode')
  })

  it('UAC 拒绝映射：cancel/取消 消息 → exit 1223；其他启动失败 → exit 4', () => {
    expect(wrapper).toContain("-like '*cancel*'")
    expect(wrapper).toContain("-like '*取消*'")
    expect(wrapper).toContain('exit 1223')
    expect(wrapper).toContain('exit 4')
  })

  it('含空格参数双引号包裹、单引号翻倍（Start-Process ArgumentList 不自动加引号的已知坑）', () => {
    expect(wrapper).toContain(String.raw`'-File','"C:\a b\x.ps1"'`)
    const withQuote = buildUacElevationCommand(["O'brien"]).args[5]
    expect(withQuote).toContain("'O''brien'")
  })

  it('空 innerArgs → throw', () => {
    expect(() => buildUacElevationCommand([])).toThrow()
  })
})

// ══════════════ buildRepairActionCatalog（9 动作目录） ══════════════

describe('buildRepairActionCatalog（9 动作目录全字段锁）', () => {
  // [id, level, needsElevation, requiresConfirm, dryRun]——表驱动硬编码，改目录必须双侧同步
  const EXPECTED: Array<[RepairActionId, RepairLevel, boolean, boolean, boolean]> = [
    ['CANCEL_ERROR_JOBS', 'L1', false, false, false],
    ['SWITCH_TO_DRIVER_CHANNEL', 'L1', false, true, false],
    ['SWITCH_TO_SPOOLER_CHANNEL', 'L1', false, true, false],
    ['PURGE_QUEUE_RESTART_SPOOLER', 'L2', true, true, true],
    ['MIGRATE_WSD_TO_TCP', 'L2', false, true, true],
    ['ENABLE_PRINT_LOG', 'L2', true, true, false],
    ['DISABLE_SNMP', 'L4', false, false, false],
    ['REINSTALL_DRIVER_GUIDE', 'L4', false, false, false],
    ['GENERIC_TEXT_ONLY_GUIDE', 'L4', false, false, false]
  ]

  it('9 动作齐全、无重复、全字段与表一致（目录即契约）', () => {
    const catalog = buildRepairActionCatalog()
    expect(catalog).toHaveLength(9)
    expect(new Set(catalog.map((a) => a.id)).size).toBe(9)
    for (const [id, level, needsElevation, requiresConfirm, dryRun] of EXPECTED) {
      const entry = catalog.find((a) => a.id === id)
      expect(entry, `目录应含 ${id}`).toBeDefined()
      expect(entry).toMatchObject({ id, level, needsElevation, requiresConfirm, dryRun })
    }
  })

  it('提权矩阵：PURGE_QUEUE_RESTART_SPOOLER 与 ENABLE_PRINT_LOG needsElevation=true，其余 7 个 false', () => {
    const catalog = buildRepairActionCatalog()
    const elevated = catalog.filter((a) => a.needsElevation).map((a) => a.id)
    expect(elevated).toEqual(['PURGE_QUEUE_RESTART_SPOOLER', 'ENABLE_PRINT_LOG'])
  })

  it('SWITCH_* 归 L1；三个引导动作归 L4', () => {
    const byId = new Map(buildRepairActionCatalog().map((a) => [a.id, a]))
    expect(byId.get('SWITCH_TO_DRIVER_CHANNEL')?.level).toBe('L1')
    expect(byId.get('SWITCH_TO_SPOOLER_CHANNEL')?.level).toBe('L1')
    for (const id of ['DISABLE_SNMP', 'REINSTALL_DRIVER_GUIDE', 'GENERIC_TEXT_ONLY_GUIDE'] as const) {
      expect(byId.get(id)?.level).toBe('L4')
    }
  })

  it('描述为非空中文文案（T9 确认流直接展示）', () => {
    for (const a of buildRepairActionCatalog()) {
      expect(a.description.length).toBeGreaterThan(6)
      expect(/[\u4e00-\u9fff]/.test(a.description)).toBe(true)
    }
  })
})

// ══════════════ runRepairAction（执行器编排，全 fake） ══════════════

describe('runRepairAction（执行器编排，全 fake）', () => {
  it('平台守卫：非 win32 → reject 明确中文错误（同 T4 模式，且先于一切编排）', async () => {
    const { fake } = makeFakeExec({})
    await expect(
      runRepairAction('SWITCH_TO_SPOOLER_CHANNEL', {}, { platform: 'linux', execFileFn: fake, setChannel: async () => {} })
    ).rejects.toThrow('仅 Windows')
    await expect(
      runRepairAction('PURGE_QUEUE_RESTART_SPOOLER', {}, { platform: 'darwin', execFileFn: fake, dryRun: true })
    ).rejects.toThrow('仅 Windows')
  })

  it('CANCEL_ERROR_JOBS：直执行 L1 命令 → done；execFile 收到本人过滤命令', async () => {
    const { fake, calls } = makeFakeExec({})
    const outcome = await runRepairAction(
      'CANCEL_ERROR_JOBS',
      { targetPrinter: 'POS-80' },
      { platform: 'win32', execFileFn: fake }
    )
    expect(outcome.status).toBe('done')
    expect(outcome.detail).toContain('POS-80')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('powershell.exe')
    expect(calls[0].args[calls[0].args.length - 1]).toContain('Owner -eq $env:USERNAME')
  })

  it('CANCEL_ERROR_JOBS：执行失败（exit 1 + stderr）→ 原样上抛', async () => {
    const { fake } = makeFakeExec({ error: { code: 1, message: 'Command failed: powershell.exe' }, stderr: 'Get-PrintJob: 打印机不存在' })
    await expect(
      runRepairAction('CANCEL_ERROR_JOBS', { targetPrinter: 'X' }, { platform: 'win32', execFileFn: fake })
    ).rejects.toThrow('CANCEL_ERROR_JOBS')
  })

  it('CANCEL_ERROR_JOBS：缺 targetPrinter → reject', async () => {
    const { fake } = makeFakeExec({})
    await expect(
      runRepairAction('CANCEL_ERROR_JOBS', {}, { platform: 'win32', execFileFn: fake })
    ).rejects.toThrow('targetPrinter')
  })

  it('SWITCH_TO_DRIVER_CHANNEL：fake setChannel 以 driver 被调 → done', async () => {
    const switched: string[] = []
    const outcome = await runRepairAction(
      'SWITCH_TO_DRIVER_CHANNEL',
      {},
      { platform: 'win32', setChannel: async (c) => { switched.push(c) } }
    )
    expect(switched).toEqual(['driver'])
    expect(outcome.status).toBe('done')
  })

  it('SWITCH_TO_SPOOLER_CHANNEL：fake setChannel 以 spooler 被调 → done', async () => {
    const switched: string[] = []
    const outcome = await runRepairAction(
      'SWITCH_TO_SPOOLER_CHANNEL',
      {},
      { platform: 'win32', setChannel: async (c) => { switched.push(c) } }
    )
    expect(switched).toEqual(['spooler'])
    expect(outcome.status).toBe('done')
  })

  it('SWITCH_*：未注入 setChannel → reject（DI 缺失是接线错误）', async () => {
    await expect(
      runRepairAction('SWITCH_TO_DRIVER_CHANNEL', {}, { platform: 'win32' })
    ).rejects.toThrow('setChannel')
  })

  it('PURGE dry-run：返回 { status:"dry-run" } + 脚本文本，writeScriptFile 与 execFile 均不调用', async () => {
    const { fake, calls } = makeFakeExec({})
    let wrote = false
    const outcome = await runRepairAction(
      'PURGE_QUEUE_RESTART_SPOOLER',
      {},
      {
        platform: 'win32',
        execFileFn: fake,
        dryRun: true,
        writeScriptFile: () => { wrote = true }
      }
    )
    expect(outcome.status).toBe('dry-run')
    expect(outcome.commands).toHaveLength(1)
    expect(outcome.commands?.[0]).toBe(buildPurgeQueueScript())
    expect(outcome.commands?.[0]).toContain('guardrail: restart-spooler')
    expect(wrote).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('PURGE 正式：脚本带 BOM 落盘 + UAC 包装单次执行（-Verb RunAs/-Wait -PassThru/-File/-ResultPath）→ exit 0 → done（含删除计数）', async () => {
    const resultPath = join(tmpDir, 'purge-ok.json')
    const { fake, calls } = makeFakeExec({
      before: () => {
        writeFileSync(resultPath, JSON.stringify({ deletedCount: 5, failedFiles: [], error: null, exitCode: 0 }))
      }
    })
    const writes: Array<{ path: string; content: string }> = []
    const outcome = await runRepairAction(
      'PURGE_QUEUE_RESTART_SPOOLER',
      {},
      {
        platform: 'win32',
        execFileFn: fake,
        resultFilePath: resultPath,
        writeScriptFile: (path, content) => { writes.push({ path, content }) }
      }
    )
    expect(outcome.status).toBe('done')
    expect(outcome.detail).toContain('5')
    // 落盘契约：单次 + BOM 前缀（PS 5.1 无 BOM 按 ANSI 解析）+ 真实脚本内容
    expect(writes).toHaveLength(1)
    expect(writes[0].path.endsWith('.ps1')).toBe(true)
    expect(writes[0].content.startsWith('\uFEFF')).toBe(true)
    expect(writes[0].content.slice(1)).toBe(buildPurgeQueueScript())
    // UAC 包装契约：单次 exec + -File 脚本路径 + -ResultPath 结果路径
    expect(calls).toHaveLength(1)
    const wrapper = calls[0].args[calls[0].args.length - 1]
    expect(wrapper).toContain('-Verb RunAs')
    expect(wrapper).toContain('-Wait -PassThru')
    expect(wrapper).toContain("'-File'")
    expect(wrapper).toContain("'-ResultPath'")
    expect(wrapper).toContain(writes[0].path.includes(' ') ? `"${writes[0].path}"` : writes[0].path)
    expect(wrapper).toContain(resultPath.includes(' ') ? `"${resultPath}"` : resultPath)
  })

  it('PURGE result-file 契约：exit 2 + 结果文件写入 → needs-manual，detail 含结果文件内容', async () => {
    const resultPath = join(tmpDir, 'purge-stop-fail.json')
    const { fake } = makeFakeExec({
      error: { code: 2, message: 'Command failed: powershell.exe' },
      before: () => {
        writeFileSync(resultPath, JSON.stringify({ deletedCount: 0, failedFiles: [], error: 'mock 拒绝访问（模拟停止服务失败）', failedPhase: 'stop', exitCode: 2 }))
      }
    })
    const outcome = await runRepairAction(
      'PURGE_QUEUE_RESTART_SPOOLER',
      {},
      { platform: 'win32', execFileFn: fake, resultFilePath: resultPath, writeScriptFile: () => {} }
    )
    expect(outcome.status).toBe('needs-manual')
    expect(outcome.detail).toContain('mock 拒绝访问（模拟停止服务失败）')
    expect(outcome.detail).toContain('exit 2')
  })

  it('PURGE exit 3 → needs-manual 带失败文件明细（结果文件内容进 detail）', async () => {
    const resultPath = join(tmpDir, 'purge-partial.json')
    const { fake } = makeFakeExec({
      error: { code: 3, message: 'Command failed: powershell.exe' },
      before: () => {
        writeFileSync(resultPath, JSON.stringify({ deletedCount: 7, failedFiles: ['a.shd', 'b.spl'], error: null, exitCode: 3 }))
      }
    })
    const outcome = await runRepairAction(
      'PURGE_QUEUE_RESTART_SPOOLER',
      {},
      { platform: 'win32', execFileFn: fake, resultFilePath: resultPath, writeScriptFile: () => {} }
    )
    expect(outcome.status).toBe('needs-manual')
    expect(outcome.detail).toContain('a.shd')
    expect(outcome.detail).toContain('b.spl')
    expect(outcome.detail).toContain('7')
  })

  it('PURGE 陈旧结果文件防串读：执行前被清空，本次未写 → detail 不含陈旧内容', async () => {
    const resultPath = join(tmpDir, 'purge-stale.json')
    writeFileSync(resultPath, JSON.stringify({ deletedCount: 99, error: 'STALE-RESULT' }))
    const { fake } = makeFakeExec({ error: { code: 2, message: 'Command failed: powershell.exe' } })
    const outcome = await runRepairAction(
      'PURGE_QUEUE_RESTART_SPOOLER',
      {},
      { platform: 'win32', execFileFn: fake, resultFilePath: resultPath, writeScriptFile: () => {} }
    )
    expect(outcome.status).toBe('needs-manual')
    expect(outcome.detail).not.toContain('STALE-RESULT')
    expect(outcome.detail).toContain('结果文件不可读')
  })

  it('PURGE UAC 拒绝（code 1223）→ needs-manual 安全返回不抛（安全关键路径）', async () => {
    const { fake, calls } = makeFakeExec({
      error: { code: 1223, message: 'Command failed: powershell.exe -NoProfile -NonInteractive' }
    })
    const outcome = await runRepairAction(
      'PURGE_QUEUE_RESTART_SPOOLER',
      {},
      { platform: 'win32', execFileFn: fake, writeScriptFile: () => {} }
    )
    expect(outcome.status).toBe('needs-manual')
    expect(outcome.detail).toContain('用户取消了管理员授权')
    expect(calls).toHaveLength(1) // 提权尝试确实发出（脚本已落盘）
  })

  it('PURGE UAC 拒绝双信号兜底：code 非数字但 message 含「取消」→ needs-manual', async () => {
    const { fake } = makeFakeExec({
      error: { code: null, message: 'Command failed: powershell.exe … 操作已被用户取消。' }
    })
    const outcome = await runRepairAction(
      'PURGE_QUEUE_RESTART_SPOOLER',
      {},
      { platform: 'win32', execFileFn: fake, writeScriptFile: () => {} }
    )
    expect(outcome.status).toBe('needs-manual')
    expect(outcome.detail).toContain('用户取消了管理员授权')
  })

  it('PURGE 提权窗口启动失败（exit 4，非拒绝）→ 上抛', async () => {
    const { fake } = makeFakeExec({ error: { code: 4, message: 'Command failed: powershell.exe' }, stderr: 'Start-Process : 拒绝访问' })
    await expect(
      runRepairAction(
        'PURGE_QUEUE_RESTART_SPOOLER',
        {},
        { platform: 'win32', execFileFn: fake, writeScriptFile: () => {} }
      )
    ).rejects.toThrow('exit 4')
  })

  it('ENABLE_PRINT_LOG：经 UAC 执行 wevtutil → done；UAC 拒绝 → needs-manual', async () => {
    const ok = makeFakeExec({})
    const done = await runRepairAction('ENABLE_PRINT_LOG', {}, { platform: 'win32', execFileFn: ok.fake })
    expect(done.status).toBe('done')
    const wrapper = ok.calls[0].args[ok.calls[0].args.length - 1]
    expect(wrapper).toContain('-Verb RunAs')
    expect(wrapper).toContain('wevtutil sl Microsoft-Windows-PrintService/Operational /e:true')

    const declined = makeFakeExec({ error: { code: 1223, message: 'Command failed' } })
    const outcome = await runRepairAction('ENABLE_PRINT_LOG', {}, { platform: 'win32', execFileFn: declined.fake })
    expect(outcome.status).toBe('needs-manual')
    expect(outcome.detail).toContain('用户取消了管理员授权')
  })

  it('MIGRATE_WSD_TO_TCP：直执行（无提权）→ done；dryRun 返回命令文本', async () => {
    const { fake, calls } = makeFakeExec({})
    const outcome = await runRepairAction(
      'MIGRATE_WSD_TO_TCP',
      { targetPrinter: '前台小票', hostAddress: '192.168.1.66' },
      { platform: 'win32', execFileFn: fake }
    )
    expect(outcome.status).toBe('done')
    expect(outcome.detail).toContain('IP_192.168.1.66')
    expect(calls).toHaveLength(1)
    expect(calls[0].args[calls[0].args.length - 1]).toContain('Add-PrinterPort')

    const dry = makeFakeExec({})
    const preview = await runRepairAction(
      'MIGRATE_WSD_TO_TCP',
      { targetPrinter: '前台小票', hostAddress: '192.168.1.66' },
      { platform: 'win32', execFileFn: dry.fake, dryRun: true }
    )
    expect(preview.status).toBe('dry-run')
    expect(preview.commands?.[0]).toContain('Add-PrinterPort')
    expect(dry.calls).toHaveLength(0)
  })

  it('MIGRATE_WSD_TO_TCP：缺 targetPrinter / hostAddress → reject', async () => {
    const { fake } = makeFakeExec({})
    await expect(
      runRepairAction('MIGRATE_WSD_TO_TCP', { targetPrinter: 'X' }, { platform: 'win32', execFileFn: fake })
    ).rejects.toThrow('hostAddress')
    await expect(
      runRepairAction('MIGRATE_WSD_TO_TCP', { hostAddress: '1.2.3.4' }, { platform: 'win32', execFileFn: fake })
    ).rejects.toThrow('targetPrinter')
  })

  it('L4 三个引导：needs-manual + 非空引导文案，不执行任何命令', async () => {
    const { fake, calls } = makeFakeExec({})
    for (const id of ['DISABLE_SNMP', 'REINSTALL_DRIVER_GUIDE', 'GENERIC_TEXT_ONLY_GUIDE'] as const) {
      const outcome = await runRepairAction(id, {}, { platform: 'win32', execFileFn: fake })
      expect(outcome.status).toBe('needs-manual')
      expect(outcome.detail?.length ?? 0).toBeGreaterThan(20)
    }
    expect(calls).toHaveLength(0)
  })
})
