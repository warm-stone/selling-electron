import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCollectScript } from '../../../../src/main/printing/diagnostics/collect-script'
import {
  COLLECT_MAX_BUFFER,
  COLLECT_TIMEOUT_MS,
  runCollect,
  type AppInfoSnapshotProvider,
  type CollectExecFileFn,
  type CollectOptions
} from '../../../../src/main/printing/diagnostics/collect.runner'
import type { PrintDiagnosticSnapshot, PrinterDiagnostic } from '../../../../src/main/printing/diagnostics/schema'

/**
 * Task 4 — collect.runner 单元测试（fake execFile，不实际执行 PowerShell）。
 * 五路径覆盖：成功 / 部分失败 / 超时 / 非 win32 / 非 JSON stdout；
 * 归一化断言：双层 JSON 防御解析、rawOnlyBit 推导、status.state 映射、
 * port.type 分类、matchesInstalled、jobs 计数与归属、可达性回填、appInfo 合成、
 * BOM 落盘（读回文件字节验证）。
 */

// ══════════════ fake execFile（捕获传参 + 可控行为） ══════════════

interface CapturedCall {
  file: string
  args: readonly string[]
  options: { windowsHide?: boolean; timeout?: number; maxBuffer?: number }
}

type FakeBehavior =
  | { kind: 'ok'; stdout: string }
  | { kind: 'error'; error: Error & { code?: number }; stderr?: string }
  | { kind: 'hang' }

function makeFakeExecFile(behavior: FakeBehavior, calls: CapturedCall[]): CollectExecFileFn {
  if (behavior.kind === 'hang') {
    // 永不回调——考察执行器自有看门狗（真实 execFile 的 timeout 选项之外的唯一保障）
    return (file, args, options, _callback) => {
      calls.push({ file, args: [...args], options: { ...options } })
      return { stdin: null }
    }
  }
  const stdout = behavior.kind === 'ok' ? behavior.stdout : ''
  const stderr = behavior.kind === 'error' ? (behavior.stderr ?? '') : ''
  const error = behavior.kind === 'error' ? behavior.error : null
  return (file, args, options, callback) => {
    calls.push({ file, args: [...args], options: { ...options } })
    queueMicrotask(() => callback(error, stdout, stderr))
    return { stdin: null }
  }
}

// ══════════════ 测试数据（真实双层 JSON 形状） ══════════════

/** Get-Printer 段记录（PS Select-Object 字段名原样） */
const PRINTERS = [
  { Name: 'POS-80', DriverName: 'POS80 Driver', PortName: 'USB001', PrinterStatus: 'Normal', Type: 'Local', Shared: true, Published: false },
  { Name: 'Microsoft Print to PDF', DriverName: 'Microsoft Print To PDF', PortName: 'PORTPROMPT:', PrinterStatus: 'Normal', Type: 'Local', Shared: false, Published: false },
  { Name: '得力云打印', DriverName: '得力 DL-5801PW', PortName: 'IP_192.168.1.66', PrinterStatus: 'Normal', Type: 'Local', Shared: false, Published: false },
  { Name: 'LPR 老打印机', DriverName: 'Generic / Text Only', PortName: 'IP_192.168.1.99', PrinterStatus: 'Paused', Type: 'Local', Shared: false, Published: false },
  { Name: '前台, 备用机', DriverName: 'Generic / Text Only', PortName: 'COM3', PrinterStatus: 'Normal', Type: 'Local', Shared: true, Published: false }
]

/** Win32_Printer 段记录；Attributes 位 4096 = RAW_ONLY */
const WMI = [
  { Name: 'POS-80', WorkOffline: false, ExtendedDetectedErrorState: 0, ExtendedPrinterStatus: 3, Attributes: 6144, Local: true, Network: false, Default: true, PortName: 'USB001', DriverName: 'POS80 Driver', PrintProcessor: 'WINPRINT', Manufacturer: 'Generic' },
  { Name: 'Microsoft Print to PDF', WorkOffline: false, ExtendedDetectedErrorState: 8, ExtendedPrinterStatus: 3, Attributes: 2176, Local: true, Network: false, Default: false, PortName: 'PORTPROMPT:', DriverName: 'Microsoft Print To PDF', PrintProcessor: 'Microsoft Print To PDF', Manufacturer: 'Microsoft' },
  { Name: '得力云打印', WorkOffline: true, ExtendedDetectedErrorState: 0, ExtendedPrinterStatus: 7, Attributes: 2176, Local: true, Network: false, Default: false, PortName: 'IP_192.168.1.66', DriverName: '得力 DL-5801PW', PrintProcessor: 'dlpproc', Manufacturer: '得力 Deli' },
  { Name: 'LPR 老打印机', WorkOffline: false, ExtendedDetectedErrorState: 0, ExtendedPrinterStatus: 3, Attributes: 4096, Local: true, Network: false, Default: false, PortName: 'IP_192.168.1.99', DriverName: 'Generic / Text Only', PrintProcessor: 'WINPRINT', Manufacturer: 'Microsoft' }
]
// ↑ 无「前台, 备用机」——覆盖 printers 单段撑起打印机的路径

/** Win32_PrintJob 段记录；Name 格式 "printerName, jobID"；StatusMask 位 2=Error 位 4=Deleting */
const JOBS = [
  { Name: 'POS-80, 42', Document: '销售小票 #1001', JobStatus: 'Error', Owner: 'DESKTOP-ABC\\wenshi', JobId: 42, Size: 2048, TimeSubmitted: '20261112091501.500000+480', StatusMask: 2 },
  { Name: 'POS-80, 43', Document: '销售小票 #1002', JobStatus: 'Deleting', Owner: 'DESKTOP-ABC\\wenshi', JobId: 43, Size: 1024, TimeSubmitted: '20261112091601.500000+480', StatusMask: 4 },
  { Name: 'POS-80, 44', Document: '测试页', JobStatus: 'Printing', Owner: 'SYSTEM', JobId: 44, Size: 4096, TimeSubmitted: '20261112091701.500000+480', StatusMask: 16 },
  { Name: '前台, 备用机, 7', Document: '交接班报表', JobStatus: 'Paused', Owner: 'wenshi', JobId: 7, Size: 512, TimeSubmitted: '20261112091801.500000+480', StatusMask: 1 }
]

const PORTS = [
  { Name: 'USB001', Description: 'USB001', PrinterHostAddress: null, PortNumber: null, Protocol: 1, SNMPEnabled: null },
  { Name: 'PORTPROMPT:', Description: 'Port Prompt', PrinterHostAddress: null, PortNumber: null, Protocol: 0, SNMPEnabled: null },
  { Name: 'IP_192.168.1.66', Description: 'Standard TCP/IP Port', PrinterHostAddress: '192.168.1.66', PortNumber: 9100, Protocol: 1, SNMPEnabled: true },
  { Name: 'IP_192.168.1.99', Description: 'Standard TCP/IP Port', PrinterHostAddress: '192.168.1.99', PortNumber: 515, Protocol: 2, SNMPEnabled: false }
]

const DRIVERS = [
  { Name: 'POS80 Driver', Manufacturer: 'Generic', DriverVersion: '1.0.0.0', DriverDate: '2024-01-01', ConfigFile: 'C:\\Windows\\system32\\drv1.dll' },
  { Name: 'Microsoft Print To PDF', Manufacturer: 'Microsoft', DriverVersion: '1.0.0.0', DriverDate: '2024-01-01', ConfigFile: 'C:\\Windows\\system32\\drv2.dll' },
  { Name: 'Generic / Text Only', Manufacturer: 'Microsoft', DriverVersion: '1.0.0.0', DriverDate: '2024-01-01', ConfigFile: 'C:\\Windows\\system32\\drv3.dll' }
]
// ↑ 故意缺「得力 DL-5801PW」——matchesInstalled: false 路径

const APP_INFO: AppInfoSnapshotProvider = {
  settings: { printer_channel: 'spooler', printer_name: '得力云打印' },
  templatePaperWidth: '80mm',
  printOptions: { pageSizeMode: 'custom-microns', marginsMode: 'none', printBackground: true },
  templateFacts: { hasLogo: true, logoPx: 180, cssPadding: '12px 9px' },
  currentUserName: 'wenshi',
  electronVersion: '44.10.1-test'
}

/**
 * 构造真实双层 JSON：五个列表段中 printers/wmi/ports/drivers 呈
 * @() 包裹形状（['<json 文本>']），jobs 呈裸字符串形状（防御分支）；
 * 五个原生段直接是对象/数组。
 */
function defaultSections(): Record<string, unknown> {
  return {
    printers: [JSON.stringify(PRINTERS)],
    wmi: [JSON.stringify(WMI)],
    jobs: JSON.stringify(JOBS),
    ports: [JSON.stringify(PORTS)],
    drivers: [JSON.stringify(DRIVERS)],
    spooler: { status: 'Running', startType: 'Auto', dependents: ['Fax'] },
    spoolDir: {
      spoolDir: 'C:\\Windows\\System32\\spool\\PRINTERS',
      files: [
        { ext: '.spl', count: 3 },
        { ext: '.shd', count: 2 }
      ]
    },
    events: {
      admin: [
        { time: '2026-11-12T09:14:32.123+08:00', id: 307 },
        { time: '2026-11-12T09:15:01.500+08:00', id: 842 }
      ],
      app1000: [
        {
          time: '2026-11-12T10:00:00.000+08:00',
          message:
            '错误应用程序名称: pos.exe，版本: 1.0.0.0，时间戳: 0x5d891b2f\n错误模块名称: dlpproc.dll，版本: 2.0.0.0，时间戳: 0x1a2b3c4d'
        },
        {
          time: '2026-11-11T08:00:00.000+08:00',
          message:
            'Faulting application name: legacy.exe, version: 3.1.0.0, time stamp: 0xdeadbeef\nFaulting module name: ntdll.dll, version: 10.0.19041.1, time stamp: 0x12345678'
        },
        { time: '2026-11-10T07:00:00.000+08:00', message: '' }
      ],
      operationalEnabled: true
    },
    tcpProbe: [
      { name: 'IP_192.168.1.66', host: '192.168.1.66', port: 9100, reachable: false },
      { name: 'IP_192.168.1.99', host: '192.168.1.99', port: 515, reachable: true }
    ],
    printConfig: [
      { printerName: 'POS-80', paperSize: 'Custom 80 x 297mm', widthMicrons: 80000, heightMicrons: null, orientation: 'Portrait' },
      { printerName: '得力云打印', paperSize: 'DL58Paper', widthMicrons: 58000, heightMicrons: null, orientation: 'Portrait' }
    ]
  }
}

function buildStdout(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...defaultSections(), ...overrides })
}

// ══════════════ 测试骨架 ══════════════

let userDataDir: string
let ps1Path: string

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'collect-runner-'))
  ps1Path = join(userDataDir, 'diagnostics', 'collect.ps1')
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function findPrinter(snapshot: PrintDiagnosticSnapshot, name: string): PrinterDiagnostic {
  const p = snapshot.printers.find((x) => x.name === name)
  if (p === undefined) throw new Error(`测试辅助：快照中未找到打印机 ${name}`)
  return p
}

async function collect(
  behavior: FakeBehavior,
  options: Partial<CollectOptions> = {}
): Promise<{ snapshot: PrintDiagnosticSnapshot; calls: CapturedCall[] }> {
  const calls: CapturedCall[] = []
  const snapshot = await runCollect({
    platform: 'win32',
    userDataDir,
    execFileFn: makeFakeExecFile(behavior, calls),
    appInfo: APP_INFO,
    ...options
  })
  return { snapshot, calls }
}

// ══════════════ 成功路径 ══════════════

describe('runCollect（打印诊断采集执行器）', () => {
  describe('成功路径：双层 JSON 归一化', () => {
    it('printers/wmi 按 name 合成：rawOnlyBit/状态映射/端口分类/驱动匹配/任务计数全链路正确', async () => {
      const { snapshot } = await collect({ kind: 'ok', stdout: buildStdout() })

      expect(snapshot.errors).toEqual({})
      expect(snapshot.printers.map((p) => p.name)).toEqual([
        'POS-80',
        'Microsoft Print to PDF',
        '得力云打印',
        'LPR 老打印机',
        '前台, 备用机'
      ])

      // POS-80：wmi 补全（Attributes 位 4096 → rawOnlyBit；Default → isDefault）
      expect(findPrinter(snapshot, 'POS-80')).toEqual({
        name: 'POS-80',
        isDefault: true,
        local: true,
        network: false,
        shared: true,
        status: { state: 'online', detectedError: null, source: 'win32-printer' },
        driver: {
          name: 'POS80 Driver',
          matchesInstalled: true,
          printProcessor: 'WINPRINT',
          manufacturer: 'Generic',
          rawOnlyBit: true
        },
        port: { name: 'USB001', type: 'usb', hostAddress: null, portNumber: null, snmpEnabled: null, reachable: null },
        queue: { jobCount: 3, errorJobs: 1, deletingJobs: 1, spoolFiles: { spl: 0, shd: 0 } },
        jobs: [
          { document: '销售小票 #1001', owner: 'DESKTOP-ABC\\wenshi', statusMask: 2, isOwnedByCurrentUser: true },
          { document: '销售小票 #1002', owner: 'DESKTOP-ABC\\wenshi', statusMask: 4, isOwnedByCurrentUser: true },
          { document: '测试页', owner: 'SYSTEM', statusMask: 16, isOwnedByCurrentUser: false }
        ]
      })

      // PDF 打印机：ExtendedDetectedErrorState 8 → '8'；PORTPROMPT: → other
      const pdf = findPrinter(snapshot, 'Microsoft Print to PDF')
      expect(pdf.status.detectedError).toBe('8')
      expect(pdf.port.type).toBe('other')
      expect(pdf.driver.rawOnlyBit).toBe(false)

      // 得力云打印：PrinterStatus Normal 但 WorkOffline=true → offline（wmi 优先）；
      // IP_ 端口 9100 → tcp-raw + SNMP true + 探测不可达回填；驱动不在清单 → false
      expect(findPrinter(snapshot, '得力云打印')).toEqual({
        name: '得力云打印',
        isDefault: false,
        local: true,
        network: false,
        shared: false,
        status: { state: 'offline', detectedError: null, source: 'wmi-workoffline' },
        driver: { name: '得力 DL-5801PW', matchesInstalled: false, printProcessor: 'dlpproc', manufacturer: '得力 Deli', rawOnlyBit: false },
        port: { name: 'IP_192.168.1.66', type: 'tcp-raw', hostAddress: '192.168.1.66', portNumber: 9100, snmpEnabled: true, reachable: false },
        queue: { jobCount: 0, errorJobs: 0, deletingJobs: 0, spoolFiles: { spl: 3, shd: 2 } },
        jobs: []
      })

      // LPR 打印机：IP_ 端口 515 → tcp-lpr；PrinterStatus Paused → paused；探测可达
      const lpr = findPrinter(snapshot, 'LPR 老打印机')
      expect(lpr.status).toEqual({ state: 'paused', detectedError: null, source: 'win32-printer' })
      expect(lpr.port).toEqual({ name: 'IP_192.168.1.99', type: 'tcp-lpr', hostAddress: '192.168.1.99', portNumber: 515, snmpEnabled: false, reachable: true })
      expect(lpr.driver.rawOnlyBit).toBe(true)

      // 前台, 备用机（名字含逗号）：wmi 段无此机 → printers 单段撑起；COM3 → com；
      // 任务 Name "前台, 备用机, 7" 按最后一个逗号正确归组；owner 裸用户名精确命中
      const backup = findPrinter(snapshot, '前台, 备用机')
      expect(backup.local).toBe(false)
      expect(backup.port.type).toBe('com')
      expect(backup.jobs).toEqual([{ document: '交接班报表', owner: 'wenshi', statusMask: 1, isOwnedByCurrentUser: true }])

      // spool 残留归属：settings.printerName='得力云打印' → 挂它（其余 0/0）
      expect(findPrinter(snapshot, 'POS-80').queue.spoolFiles).toEqual({ spl: 0, shd: 0 })
    })

    it('system 段：spooler/事件日志（中英文 faulting 提取）/打印配置直传', async () => {
      const { snapshot } = await collect({ kind: 'ok', stdout: buildStdout() })

      expect(snapshot.system.spooler).toEqual({ status: 'Running', startType: 'Auto', dependents: ['Fax'] })
      expect(snapshot.system.eventLog.adminEvents).toEqual([
        { time: '2026-11-12T09:14:32.123+08:00', id: 307 },
        { time: '2026-11-12T09:15:01.500+08:00', id: 842 }
      ])
      expect(snapshot.system.eventLog.app1000Events).toEqual([
        { time: '2026-11-12T10:00:00.000+08:00', faultingApp: 'pos.exe', faultingModule: 'dlpproc.dll' },
        { time: '2026-11-11T08:00:00.000+08:00', faultingApp: 'legacy.exe', faultingModule: 'ntdll.dll' },
        { time: '2026-11-10T07:00:00.000+08:00', faultingApp: 'unknown', faultingModule: 'unknown' }
      ])
      expect(snapshot.system.eventLog.operationalEnabled).toBe(true)
      expect(snapshot.system.printConfigs).toEqual([
        { printerName: 'POS-80', paperSize: 'Custom 80 x 297mm', widthMicrons: 80000, heightMicrons: null, orientation: 'Portrait' },
        { printerName: '得力云打印', paperSize: 'DL58Paper', widthMicrons: 58000, heightMicrons: null, orientation: 'Portrait' }
      ])
    })

    it('app 段：appInfo 注入全字段合成', async () => {
      const { snapshot } = await collect({ kind: 'ok', stdout: buildStdout() })
      expect(snapshot.app).toEqual({
        settings: { channel: 'spooler', printerName: '得力云打印', templatePaperWidth: '80mm' },
        electronVersion: '44.10.1-test',
        printOptions: { pageSizeMode: 'custom-microns', marginsMode: 'none', printBackground: true },
        templateFacts: { hasLogo: true, logoPx: 180, cssPadding: '12px 9px' }
      })
    })

    it('raw 层：10 段原始输出全部留档（归一化前）', async () => {
      const { snapshot } = await collect({ kind: 'ok', stdout: buildStdout() })
      expect(Object.keys(snapshot.raw).sort()).toEqual(
        ['printers', 'wmi', 'jobs', 'ports', 'drivers', 'spooler', 'spoolDir', 'events', 'tcpProbe', 'printConfig'].sort()
      )
      // jobs 段值是裸 JSON 字符串 → raw 存其 JSON.stringify（锁定「归一化前」语义）
      expect(snapshot.raw.jobs).toBe(JSON.stringify(JSON.stringify(JOBS)))
      expect(snapshot.raw.spooler).toContain('Running')
    })
  })

  describe('落盘与命令行契约', () => {
    it('collect.ps1 带 UTF-8 BOM（前 3 字节 EF BB BF）+ 首行 OutputEncoding + 幂等覆盖写', async () => {
      // 预写垃圾——验证覆盖写（幂等），不残留旧内容
      mkdirSync(join(userDataDir, 'diagnostics'), { recursive: true })
      writeFileSync(ps1Path, 'OLD GARBAGE 内容')

      await collect({ kind: 'ok', stdout: buildStdout() })

      const bytes = readFileSync(ps1Path)
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      const text = bytes.subarray(3).toString('utf8')
      expect(text).toBe(buildCollectScript())
      expect(text.split('\n')[0]).toBe('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')
    })

    it('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File + windowsHide/timeout/maxBuffer 传参', async () => {
      const { calls } = await collect({ kind: 'ok', stdout: buildStdout() })
      expect(calls).toHaveLength(1)
      expect(calls[0].file).toBe('powershell.exe')
      expect(calls[0].args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path])
      expect(calls[0].options).toEqual({ windowsHide: true, timeout: COLLECT_TIMEOUT_MS, maxBuffer: COLLECT_MAX_BUFFER })
    })
  })

  describe('部分失败是数据不是异常', () => {
    it('jobs/drivers 段 {error} → errors 记录 + 其余段正常 + 不 throw', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: buildStdout({
          jobs: { error: 'RPC 服务器不可用' },
          drivers: { error: '驱动枚举失败: 拒绝访问' }
        })
      })

      expect(snapshot.errors).toEqual({ jobs: 'RPC 服务器不可用', drivers: '驱动枚举失败: 拒绝访问' })
      // 其余段正常
      expect(snapshot.printers).toHaveLength(5)
      expect(snapshot.system.spooler.status).toBe('Running')
      // 失败段数据置空：jobs → 计数 0；drivers → matchesInstalled false
      expect(findPrinter(snapshot, 'POS-80').queue).toMatchObject({ jobCount: 0, errorJobs: 0, deletingJobs: 0 })
      expect(findPrinter(snapshot, 'POS-80').driver.matchesInstalled).toBe(false)
      // raw 留档 {error} 原文
      expect(snapshot.raw.jobs).toBe(JSON.stringify({ error: 'RPC 服务器不可用' }))
    })

    it('printers+wmi 双段失败 → printers 空 + spoolFiles 丢弃（raw 留档）+ 不 throw', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: buildStdout({
          printers: { error: 'RPC 服务器不可用' },
          wmi: { error: 'RPC 服务器不可用' }
        })
      })

      expect(snapshot.printers).toEqual([])
      expect(snapshot.errors.printers).toBe('RPC 服务器不可用')
      expect(snapshot.errors.wmi).toBe('RPC 服务器不可用')
      expect(snapshot.raw.spoolDir).toContain('.spl')
      expect(snapshot.system.spooler.status).toBe('Running')
    })

    it('嵌套字符串 JSON 损坏 → 段级 errors + wmi 单段撑起打印机列表', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: buildStdout({ printers: ['{broken json'] })
      })

      expect(snapshot.errors.printers).toMatch(/段解析失败/)
      expect(snapshot.printers.map((p) => p.name)).toEqual([
        'POS-80',
        'Microsoft Print to PDF',
        '得力云打印',
        'LPR 老打印机'
      ])
      // printers 段的 shared 丢失 → false；状态无 PrinterStatus 来源 → unknown（wmi 兜底）
      expect(findPrinter(snapshot, 'POS-80').shared).toBe(false)
      expect(findPrinter(snapshot, 'POS-80').status).toEqual({ state: 'unknown', detectedError: null, source: 'wmi' })
    })

    it('段缺失 → 缺失段记 errors + 在场段正常', async () => {
      const stdout = JSON.stringify({ spooler: { status: 'Running', startType: 'Auto', dependents: [] } })
      const { snapshot } = await collect({ kind: 'ok', stdout })

      expect(snapshot.system.spooler.status).toBe('Running')
      expect(Object.keys(snapshot.errors)).toHaveLength(9)
      expect(snapshot.errors.printers).toMatch(/段缺失/)
      expect(Object.keys(snapshot.raw)).toEqual(['spooler'])
    })
  })

  describe('超时与执行失败', () => {
    it('fake 永不回调 + timeoutMs 50ms → 看门狗快速 reject', async () => {
      const calls: CapturedCall[] = []
      const start = Date.now()
      await expect(
        runCollect({
          platform: 'win32',
          userDataDir,
          execFileFn: makeFakeExecFile({ kind: 'hang' }, calls),
          timeoutMs: 50
        })
      ).rejects.toThrow('打印机诊断采集超时（50ms 内 PowerShell 未返回')
      // 50ms 预算内 reject（防退化成默认 30s）
      expect(Date.now() - start).toBeLessThan(5000)
      // timeout 选项同步下传给 execFile
      expect(calls[0].options.timeout).toBe(50)
    })

    it('execFile error（非零退出）→ reject 中文错误含 stderr 摘要', async () => {
      const error = Object.assign(new Error('Command failed: powershell.exe -File collect.ps1'), { code: 1 })
      await expect(
        collect({ kind: 'error', error, stderr: 'collect.ps1 : 拒绝访问\r\n' })
      ).rejects.toThrow('打印机诊断采集执行失败：Command failed: powershell.exe -File collect.ps1 | stderr 摘要：collect.ps1 : 拒绝访问')
    })
  })

  describe('平台守卫', () => {
    it('非 win32 → reject 中文错误 + 零副作用（不执行不落盘）', async () => {
      const calls: CapturedCall[] = []
      await expect(
        runCollect({ platform: 'linux', userDataDir, execFileFn: makeFakeExecFile({ kind: 'ok', stdout: '{}' }, calls) })
      ).rejects.toThrow('打印机诊断采集仅 Windows 可用（当前平台：linux）')
      expect(calls).toHaveLength(0)
      expect(existsSync(join(userDataDir, 'diagnostics'))).toBe(false)
    })
  })

  describe('stdout 整体不可解析（reject 路径）', () => {
    it('非 JSON → reject 含前 100 字符预览', async () => {
      await expect(collect({ kind: 'ok', stdout: 'not-json-{{{' })).rejects.toThrow(/不是有效 JSON.*not-json/s)
    })

    it('有效 JSON 但非对象 → reject', async () => {
      await expect(collect({ kind: 'ok', stdout: '42' })).rejects.toThrow(/不是 JSON 对象/)
    })

    it('空 stdout → reject（可区分于解析失败）', async () => {
      await expect(collect({ kind: 'ok', stdout: '  \n' })).rejects.toThrow(/输出为空/)
    })
  })

  describe('双层 JSON 防御解析形状谱系', () => {
    it('段级裸字符串（typeof string → 直接 parse）', async () => {
      const { snapshot } = await collect({ kind: 'ok', stdout: buildStdout({ printers: JSON.stringify(PRINTERS) }) })
      expect(snapshot.printers).toHaveLength(5)
      expect(findPrinter(snapshot, 'POS-80').driver.name).toBe('POS80 Driver')
    })

    it('单对象文本（PS 单项不裹数组陷阱 → parse 后包成单元素）', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: buildStdout({ drivers: [JSON.stringify({ Name: 'POS80 Driver', Manufacturer: 'Generic' })] })
      })
      expect(findPrinter(snapshot, 'POS-80').driver.matchesInstalled).toBe(true)
      expect(findPrinter(snapshot, '得力云打印').driver.matchesInstalled).toBe(false)
    })

    it('原生对象数组直通（数组元素非 string 原样通过）', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: buildStdout({ drivers: [{ Name: 'POS80 Driver' }, { Name: '得力 DL-5801PW' }] })
      })
      expect(findPrinter(snapshot, '得力云打印').driver.matchesInstalled).toBe(true)
    })

    it('空列表段 + 端口分类补全（com/lpt/wsd）', async () => {
      const stdout = JSON.stringify({
        printers: [
          JSON.stringify([
            { Name: '串口机', DriverName: 'D', PortName: 'COM3', PrinterStatus: 'Normal', Type: 'Local', Shared: false, Published: false },
            { Name: '并口机', DriverName: 'D', PortName: 'LPT1', PrinterStatus: 'Normal', Type: 'Local', Shared: false, Published: false },
            { Name: 'WSD 机', DriverName: 'D', PortName: 'WSD-1a2b3c4d-5e6f', PrinterStatus: 'Normal', Type: 'Local', Shared: false, Published: false }
          ])
        ],
        wmi: [],
        jobs: [],
        ports: [],
        drivers: [],
        spooler: { status: 'Running', startType: 'Auto', dependents: [] },
        spoolDir: { spoolDir: 'C:\\spool', files: [] },
        events: { admin: [], app1000: [], operationalEnabled: false },
        tcpProbe: [],
        printConfig: []
      })
      const { snapshot } = await collect({ kind: 'ok', stdout })
      expect(snapshot.errors).toEqual({})
      expect(snapshot.printers.map((p) => p.port.type)).toEqual(['com', 'lpt', 'wsd'])
    })
  })

  describe('app 侧合成与归一', () => {
    it('settings 的 null printer_name 归一为 "" + spoolFiles 挂第一台兜底', async () => {
      const { snapshot } = await collect(
        { kind: 'ok', stdout: buildStdout() },
        { appInfo: { ...APP_INFO, settings: { printer_channel: 'spooler', printer_name: null } } }
      )
      expect(snapshot.app.settings.printerName).toBe('')
      // 匹配不到设置打印机 → 挂第一台（POS-80）
      expect(findPrinter(snapshot, 'POS-80').queue.spoolFiles).toEqual({ spl: 3, shd: 2 })
      expect(findPrinter(snapshot, '得力云打印').queue.spoolFiles).toEqual({ spl: 0, shd: 0 })
    })

    it('默认 provider：electronVersion 取 process.versions.electron，settings 全空归一', async () => {
      const { snapshot } = await collect({ kind: 'ok', stdout: buildStdout() }, { appInfo: undefined })
      expect(snapshot.app.electronVersion).toBe(process.versions.electron ?? 'unknown')
      expect(snapshot.app.settings).toEqual({ channel: '', printerName: '', templatePaperWidth: '' })
      expect(snapshot.app.printOptions).toEqual({ pageSizeMode: '', marginsMode: '', printBackground: false })
      expect(snapshot.app.templateFacts).toEqual({ hasLogo: false, logoPx: null, cssPadding: '' })
    })
  })
})
