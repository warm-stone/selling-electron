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
import type { PrintDiagnosticSnapshot, PrinterDiagnostic } from '../../../../src/shared/printing/diagnostics-schema'

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

/** Get-Printer 段记录（PS Select-Object 字段名原样；PrinterStatus 经 ConvertTo-Json 是位掩码数字——0=Normal/1=Paused） */
const PRINTERS = [
  { Name: 'POS-80', DriverName: 'POS80 Driver', PortName: 'USB001', PrinterStatus: 0, Type: 'Local', Shared: true, Published: false },
  { Name: 'Microsoft Print to PDF', DriverName: 'Microsoft Print To PDF', PortName: 'PORTPROMPT:', PrinterStatus: 0, Type: 'Local', Shared: false, Published: false },
  { Name: '得力云打印', DriverName: '得力 DL-5801PW', PortName: 'IP_192.168.1.66', PrinterStatus: 0, Type: 'Local', Shared: false, Published: false },
  { Name: 'LPR 老打印机', DriverName: 'Generic / Text Only', PortName: 'IP_192.168.1.99', PrinterStatus: 1, Type: 'Local', Shared: false, Published: false },
  { Name: '前台, 备用机', DriverName: 'Generic / Text Only', PortName: 'COM3', PrinterStatus: 0, Type: 'Local', Shared: true, Published: false }
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

      // PDF 打印机：ExtendedDetectedErrorState 8 → 'jammed' 人类可读标签（v2）；PORTPROMPT: → other
      const pdf = findPrinter(snapshot, 'Microsoft Print to PDF')
      expect(pdf.status.detectedError).toBe('jammed')
      expect(pdf.port.type).toBe('other')
      expect(pdf.driver.rawOnlyBit).toBe(false)

      // 得力云打印：PrinterStatus 0(Normal) 但 WorkOffline=true → offline（wmi 优先）；
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

      // LPR 打印机：IP_ 端口 515 → tcp-lpr；PrinterStatus 位掩码 1(Paused) → paused；探测可达
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
      // printers 段的 shared 丢失 → false；状态落 WMI 兜底链（ExtendedPrinterStatus=3 Idle → online）
      expect(findPrinter(snapshot, 'POS-80').shared).toBe(false)
      expect(findPrinter(snapshot, 'POS-80').status).toEqual({ state: 'online', detectedError: null, source: 'wmi' })
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
            { Name: '串口机', DriverName: 'D', PortName: 'COM3', PrinterStatus: 0, Type: 'Local', Shared: false, Published: false },
            { Name: '并口机', DriverName: 'D', PortName: 'LPT1', PrinterStatus: 0, Type: 'Local', Shared: false, Published: false },
            { Name: 'WSD 机', DriverName: 'D', PortName: 'WSD-1a2b3c4d-5e6f', PrinterStatus: 0, Type: 'Local', Shared: false, Published: false }
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

    it('v2 实验键观测：dpi/usePrinterDefaultPageSize 条件透传（未启用时物理不存在键）', async () => {
      // 启用态：dpi=203 + usePrinterDefaultPageSize=true（pageSizeMode 由装配层如实报 printer-default）
      const on = await collect(
        { kind: 'ok', stdout: buildStdout() },
        {
          appInfo: {
            ...APP_INFO,
            printOptions: {
              pageSizeMode: 'printer-default',
              marginsMode: 'none',
              printBackground: true,
              dpi: 203,
              usePrinterDefaultPageSize: true
            }
          }
        }
      )
      expect(on.snapshot.app.printOptions).toEqual({
        pageSizeMode: 'printer-default',
        marginsMode: 'none',
        printBackground: true,
        dpi: 203,
        usePrinterDefaultPageSize: true
      })

      // 缺省态：null/false/缺省 → 键物理不存在（报告可区分「未设置」；v1 快照形状不变）
      const off = await collect(
        { kind: 'ok', stdout: buildStdout() },
        {
          appInfo: {
            ...APP_INFO,
            printOptions: {
              pageSizeMode: 'custom-microns',
              marginsMode: 'none',
              printBackground: true,
              dpi: null,
              usePrinterDefaultPageSize: false
            }
          }
        }
      )
      expect(off.snapshot.app.printOptions).toEqual({
        pageSizeMode: 'custom-microns',
        marginsMode: 'none',
        printBackground: true
      })
      expect('dpi' in off.snapshot.app.printOptions).toBe(false)
      expect('usePrinterDefaultPageSize' in off.snapshot.app.printOptions).toBe(false)
    })
  })

  // ══════════════ v2：状态映射（Bug1 位掩码 + WMI 兜底链 + 错误标签） ══════════════

  /** 单台打印机最小 stdout（printers/wmi 段可独立覆写；其余段空但齐全） */
  function onePrinterStdout(
    printerRec: Record<string, unknown> | null,
    wmiRec: Record<string, unknown> | null
  ): string {
    return JSON.stringify({
      printers: printerRec !== null ? [JSON.stringify([printerRec])] : [],
      wmi: wmiRec !== null ? [JSON.stringify([wmiRec])] : [],
      jobs: [],
      ports: [],
      drivers: [],
      spooler: { status: 'Running', startType: 'Auto', dependents: [] },
      spoolDir: { spoolDir: 'C:\\spool', files: [] },
      events: { admin: [], app1000: [], operationalEnabled: false },
      tcpProbe: [],
      printConfig: []
    })
  }

  const basePrinterRec = { Name: 'T', DriverName: 'D', PortName: 'USB001', Type: 'Local', Shared: false, Published: false }
  const baseWmiRec = { Name: 'T', WorkOffline: false, Local: true, Network: false, Default: false, PortName: 'USB001', DriverName: 'D', PrintProcessor: 'winprint', Manufacturer: null }

  describe('v2 状态映射：PrinterStatus 位掩码（Bug1）', () => {
    it('位掩码优先级表逐位命中：128 offline > 2 error > 1 paused > 纸类/门位（带标注）', async () => {
      const cases: Array<[number, string, string | null]> = [
        [0, 'online', null], // Normal（真机 4 台全 0——v1 误判 unknown 的修复锚）
        [128, 'offline', null],
        [2, 'error', null],
        [1, 'paused', null],
        [4, 'error', 'pending-deletion'],
        [8, 'error', 'paper-jam'],
        [16, 'error', 'paper-out'],
        [64, 'error', 'paper-problem'],
        [4194304, 'error', 'door-open'],
        [1024, 'online', null], // Printing 运行态位不扰动
        [512, 'online', null], // Busy
        [129, 'offline', null] // 组合位：128 优先于 1
      ]
      for (const [mask, state, detectedError] of cases) {
        const { snapshot } = await collect({
          kind: 'ok',
          stdout: onePrinterStdout({ ...basePrinterRec, PrinterStatus: mask }, null)
        })
        expect(findPrinter(snapshot, 'T').status, `mask=${mask}`).toEqual({
          state,
          detectedError,
          source: 'win32-printer'
        })
      }
    })

    it('位掩码纸类标注优先于 WMI DetectedErrorState 标签', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: onePrinterStdout(
          { ...basePrinterRec, PrinterStatus: 8 },
          { ...baseWmiRec, ExtendedDetectedErrorState: 4 }
        )
      })
      expect(findPrinter(snapshot, 'T').status.detectedError).toBe('paper-jam')
    })
  })

  describe('v2 状态映射：WMI 兜底链（printerStatus 缺失时）', () => {
    it('ExtendedPrinterStatus 1-18 表：3/4/17/18→online、7→offline、8→paused、9→error、2/表外→unknown', async () => {
      const cases: Array<[number, string]> = [
        [2, 'unknown'], // Unknown——无 bidi 状态监视器的低价热敏机常态（非故障）
        [3, 'online'], // Idle（真机 USB 热敏机在线空闲典型值）
        [4, 'online'],
        [7, 'offline'],
        [8, 'paused'],
        [9, 'error'],
        [17, 'online'],
        [18, 'online'],
        [1, 'unknown'], // Other 表外
        [10, 'unknown'] // Busy 表外
      ]
      for (const [ext, state] of cases) {
        const { snapshot } = await collect({
          kind: 'ok',
          stdout: onePrinterStdout(null, { ...baseWmiRec, ExtendedPrinterStatus: ext })
        })
        expect(findPrinter(snapshot, 'T').status, `ext=${ext}`).toEqual({
          state,
          detectedError: null,
          source: 'wmi'
        })
      }
    })

    it('无 ExtendedPrinterStatus 时落 Win32 PrinterStatus 1-7 防御表（3→online、7→offline、2→unknown）', async () => {
      for (const [st, state] of [
        [3, 'online'],
        [7, 'offline'],
        [2, 'unknown']
      ] as Array<[number, string]>) {
        const { snapshot } = await collect({
          kind: 'ok',
          stdout: onePrinterStdout(null, { ...baseWmiRec, PrinterStatus: st })
        })
        expect(findPrinter(snapshot, 'T').status.state, `PrinterStatus=${st}`).toBe(state)
      }
    })

    it('两段状态字段全缺 → unknown（source wmi）', async () => {
      const { snapshot } = await collect({ kind: 'ok', stdout: onePrinterStdout(null, baseWmiRec) })
      expect(findPrinter(snapshot, 'T').status).toEqual({ state: 'unknown', detectedError: null, source: 'wmi' })
    })
  })

  describe('v2 DetectedErrorState 人类可读标签', () => {
    it('0/1/2→null（无错误）、3-9→标签、表外值保留 String(n)', async () => {
      const cases: Array<[number, string | null]> = [
        [0, null],
        [1, null],
        [2, null], // NoError——v1 会误报 '2'
        [3, 'low-paper'],
        [4, 'no-paper'],
        [5, 'low-toner'],
        [6, 'no-toner'],
        [7, 'door-open'],
        [8, 'jammed'],
        [9, 'offline'],
        [99, '99'] // 表外值防御保留原值
      ]
      for (const [n, label] of cases) {
        const { snapshot } = await collect({
          kind: 'ok',
          stdout: onePrinterStdout(null, { ...baseWmiRec, ExtendedDetectedErrorState: n })
        })
        expect(findPrinter(snapshot, 'T').status.detectedError, `state=${n}`).toBe(label)
      }
    })
  })

  // ══════════════ v2：WER props 索引解析（Bug2） ══════════════

  describe('v2 事件 1000：props 索引优先 + message 正则兜底', () => {
    function eventsStdout(app1000: unknown[]): string {
      return JSON.stringify({
        ...defaultSections(),
        events: { admin: [], app1000, operationalEnabled: false }
      })
    }

    /** 完整 WER EventData props（≥13 项；[0]=应用名 [3]=模块名 [10]/[11]=路径） */
    const fullProps = [
      'spoolsv.exe', '10.0.19041.1', '0x5d891b2f', 'dlpproc.dll', '2.0.0.0', '0x1a2b3c4d',
      '0xc0000005', '12', 'ntdll.dll', 'x', 'C:\\Windows\\System32\\spoolsv.exe',
      'C:\\Windows\\System32\\dlpproc.dll', '2030', 'extra', 'more'
    ]

    it('props ≥13 项 → 按索引 [0]/[3] 提取（message 为空也能命中——语言中立）', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: eventsStdout([{ time: '2026-11-15T09:00:00.000+08:00', message: '', props: fullProps }])
      })
      expect(snapshot.system.eventLog.app1000Events).toEqual([
        { time: '2026-11-15T09:00:00.000+08:00', faultingApp: 'spoolsv.exe', faultingModule: 'dlpproc.dll' }
      ])
    })

    it('props 过短（<13，形状漂移不可信）→ 回退 message 正则', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: eventsStdout([
          {
            time: '2026-11-15T09:00:00.000+08:00',
            message: '错误应用程序名称: pos.exe，版本: 1.0\n错误模块名称: ntdll.dll，版本: 10.0',
            props: ['pos.exe', 'x']
          }
        ])
      })
      expect(snapshot.system.eventLog.app1000Events).toEqual([
        { time: '2026-11-15T09:00:00.000+08:00', faultingApp: 'pos.exe', faultingModule: 'ntdll.dll' }
      ])
    })

    it('props 索引值为空串/null/对象 → unknown（与正则失败填值契约对齐）', async () => {
      const props: unknown[] = [...fullProps]
      props[0] = ''
      props[3] = null
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: eventsStdout([{ time: '2026-11-15T09:00:00.000+08:00', message: 'irrelevant', props }])
      })
      expect(snapshot.system.eventLog.app1000Events).toEqual([
        { time: '2026-11-15T09:00:00.000+08:00', faultingApp: 'unknown', faultingModule: 'unknown' }
      ])
    })

    it('无 props 键（v1 形状/旧脚本输出）→ message 正则路径不受影响', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: eventsStdout([
          {
            time: '2026-11-11T08:00:00.000+08:00',
            message: 'Faulting application name: legacy.exe, version: 3.1\nFaulting module name: ntdll.dll, version: 10.0'
          }
        ])
      })
      expect(snapshot.system.eventLog.app1000Events).toEqual([
        { time: '2026-11-11T08:00:00.000+08:00', faultingApp: 'legacy.exe', faultingModule: 'ntdll.dll' }
      ])
    })
  })

  // ══════════════ v2：printConfig 四层 fallback 归一 ══════════════

  describe('v2 printConfig 归一：source 分派（单位换算 / DEVMODE 解析 / v1 兼容）', () => {
    function configStdout(configs: unknown[]): string {
      return JSON.stringify({ ...defaultSections(), printConfig: configs })
    }

    /** 构造 DEVMODEW blob（Base64）：偏移 72/78/80/82 + dmFormName@102 UTF-16LE */
    function devmodeB64(opts: {
      dmFields?: number
      dmPaperSize?: number
      dmPaperLength?: number
      dmPaperWidth?: number
      formName?: string
      length?: number
    }): string {
      const blob = Buffer.alloc(opts.length ?? 220)
      if (blob.length >= 166) {
        blob.writeUInt32LE(opts.dmFields ?? 0, 72)
        blob.writeUInt16LE(opts.dmPaperSize ?? 0, 78)
        blob.writeInt16LE(opts.dmPaperLength ?? 0, 80)
        blob.writeInt16LE(opts.dmPaperWidth ?? 0, 82)
        if (opts.formName !== undefined) blob.write(opts.formName, 102, 64, 'utf16le')
      }
      return blob.toString('base64')
    }

    it('win32printerconfig：0.1mm 原值 ×100 → μm，source 随行（paperSize/orientation 数字枚举归一空串，原值留档 raw 层）', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: configStdout([
          { printerName: 'DL-5801PW', paperSize: 256, widthMicrons: null, heightMicrons: null, paperWidthTenthMm: 580, paperLengthTenthMm: 2000, orientation: 1, source: 'win32printerconfig' }
        ])
      })
      expect(snapshot.system.printConfigs).toEqual([
        { printerName: 'DL-5801PW', paperSize: '', widthMicrons: 58000, heightMicrons: 200000, orientation: '', source: 'win32printerconfig' }
      ])
      expect(snapshot.raw.printConfig).toContain('paperWidthTenthMm')
    })

    it('devmode：dmFields 置 PAPERLENGTH|PAPERWIDTH → 宽高 i16 ×100', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: configStdout([
          { printerName: 'T', devmodeB64: devmodeB64({ dmFields: 0xc, dmPaperSize: 1, dmPaperLength: 2970, dmPaperWidth: 2100 }), source: 'devmode' }
        ])
      })
      expect(snapshot.system.printConfigs).toEqual([
        { printerName: 'T', paperSize: '', widthMicrons: 210000, heightMicrons: 297000, orientation: '', source: 'devmode' }
      ])
    })

    it('devmode：dmPaperSize ≥256（DMPAPER_USER 自定义表单）→ 取 dmFormName，宽高 null', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: configStdout([
          { printerName: 'T', devmodeB64: devmodeB64({ dmFields: 0xc, dmPaperSize: 256, dmPaperLength: 2970, dmPaperWidth: 580, formName: 'DL58 Receipt' }), source: 'devmode' }
        ])
      })
      expect(snapshot.system.printConfigs).toEqual([
        { printerName: 'T', paperSize: 'DL58 Receipt', widthMicrons: null, heightMicrons: null, orientation: '', source: 'devmode' }
      ])
    })

    it('devmode：dmFields 未置宽高位 / blob <166 字节 / b64 缺失 → 全空（缺数据不猜）', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: configStdout([
          { printerName: 'A', devmodeB64: devmodeB64({ dmFields: 0x2, dmPaperSize: 1, dmPaperLength: 2970, dmPaperWidth: 2100 }), source: 'devmode' },
          { printerName: 'B', devmodeB64: devmodeB64({ dmFields: 0xc, dmPaperWidth: 580, length: 100 }), source: 'devmode' },
          { printerName: 'C', source: 'devmode' }
        ])
      })
      expect(snapshot.system.printConfigs).toEqual([
        { printerName: 'A', paperSize: '', widthMicrons: null, heightMicrons: null, orientation: '', source: 'devmode' },
        { printerName: 'B', paperSize: '', widthMicrons: null, heightMicrons: null, orientation: '', source: 'devmode' },
        { printerName: 'C', paperSize: '', widthMicrons: null, heightMicrons: null, orientation: '', source: 'devmode' }
      ])
    })

    it('printconfiguration/printticketxml：μm 直传 + source 随行；v1 形状（无 source）输出亦无键', async () => {
      const { snapshot } = await collect({
        kind: 'ok',
        stdout: configStdout([
          { printerName: 'P1', paperSize: 'A4', widthMicrons: 210000, heightMicrons: 297000, orientation: 'Portrait', source: 'printconfiguration' },
          { printerName: 'P2', paperSize: null, widthMicrons: 58000, heightMicrons: 200000, orientation: null, source: 'printticketxml' },
          { printerName: 'P3', paperSize: 'X', widthMicrons: 80000, heightMicrons: null, orientation: '' }
        ])
      })
      expect(snapshot.system.printConfigs).toEqual([
        { printerName: 'P1', paperSize: 'A4', widthMicrons: 210000, heightMicrons: 297000, orientation: 'Portrait', source: 'printconfiguration' },
        { printerName: 'P2', paperSize: '', widthMicrons: 58000, heightMicrons: 200000, orientation: '', source: 'printticketxml' },
        { printerName: 'P3', paperSize: 'X', widthMicrons: 80000, heightMicrons: null, orientation: '' }
      ])
      // v1 兼容锁：无 source 输入的条目输出不得携带 source 键（历史报告 toEqual 兼容）
      expect('source' in snapshot.system.printConfigs[2]).toBe(false)
    })
  })
})
