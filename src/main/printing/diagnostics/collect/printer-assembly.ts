/**
 * PrinterDiagnostic 装配（collect.runner 拆分批次 5）。
 *
 * printers/wmi 两段按 name 大小写不敏感合并（单段失败时另一段仍能撑起列表），
 * 再挂接端口/驱动/探针/队列数据，状态判定走 v2 归一链（status-maps）。
 */

import type { PrinterDiagnostic } from '../../../../shared/printing/diagnostics-schema'
import type {
  DriverSectionRecord,
  JobSectionRecord,
  PortSectionRecord,
  PrinterSectionRecord,
  ProbeSectionRecord,
  WmiSectionRecord
} from './stdout-parser'
import {
  EXTENDED_PRINTER_STATUS_1_18,
  WIN32_PRINTER_STATUS_1_7,
  mapPrinterStatusBitmask,
  wmiDetectedErrorLabel
} from './status-maps'

export function buildPrinterDiagnostics(
  printersData: PrinterSectionRecord[],
  wmiData: WmiSectionRecord[],
  portsData: PortSectionRecord[],
  driversData: DriverSectionRecord[],
  probesData: ProbeSectionRecord[],
  jobsData: JobSectionRecord[],
  spoolDirCounts: { spl: number; shd: number },
  settingsPrinterName: string,
  currentUserName: string
): PrinterDiagnostic[] {
  const portByName = new Map(portsData.map((p) => [p.name.toLowerCase(), p]))
  const driverNames = new Set(driversData.map((d) => d.name.toLowerCase()))
  const probeByName = new Map(probesData.map((p) => [p.name.toLowerCase(), p]))
  const jobsByPrinter = new Map<string, JobSectionRecord[]>()
  for (const job of jobsData) {
    const key = job.printerName.toLowerCase()
    const list = jobsByPrinter.get(key)
    if (list) list.push(job)
    else jobsByPrinter.set(key, [job])
  }

  // printers 段打底 + wmi 段补充/新增（按 name 大小写不敏感合并——单段失败时另一段仍能撑起列表）
  const combined = new Map<string, { name: string; printer: PrinterSectionRecord | null; wmi: WmiSectionRecord | null }>()
  for (const p of printersData) {
    combined.set(p.name.toLowerCase(), { name: p.name, printer: p, wmi: null })
  }
  for (const w of wmiData) {
    const key = w.name.toLowerCase()
    const entry = combined.get(key)
    if (entry) entry.wmi = w
    else combined.set(key, { name: w.name, printer: null, wmi: w })
  }

  const printers: PrinterDiagnostic[] = []
  for (const [key, entry] of combined) {
    printers.push(
      assemblePrinterDiagnostic(
        entry,
        portByName,
        driverNames,
        probeByName,
        jobsByPrinter.get(key) ?? [],
        currentUserName
      )
    )
  }

  // spool 残留计数归属（从简决策）：残留文件无法精确归属到打印机——挂「当前设置
  // 打印机」，匹配不到挂第一台，无打印机则丢弃（数据仍在 raw.spoolDir 留档）
  const spoolTarget =
    settingsPrinterName !== ''
      ? printers.find((p) => p.name.toLowerCase() === settingsPrinterName.toLowerCase())
      : undefined
  const target = spoolTarget ?? printers[0]
  if (target) target.queue.spoolFiles = { spl: spoolDirCounts.spl, shd: spoolDirCounts.shd }

  return printers
}

function assemblePrinterDiagnostic(
  entry: { name: string; printer: PrinterSectionRecord | null; wmi: WmiSectionRecord | null },
  portByName: Map<string, PortSectionRecord>,
  driverNames: Set<string>,
  probeByName: Map<string, ProbeSectionRecord>,
  jobs: JobSectionRecord[],
  currentUserName: string
): PrinterDiagnostic {
  const { name, printer, wmi } = entry
  const portName = printer?.portName ?? wmi?.portName ?? null
  const port = portName !== null ? portByName.get(portName.toLowerCase()) : undefined
  const probe = portName !== null ? probeByName.get(portName.toLowerCase()) : undefined
  const driverName = printer?.driverName ?? wmi?.driverName ?? null

  // 状态判定优先级（v2 归一链）：WMI WorkOffline 脱机标志（printer-offline-flag
  // 的判定信号）> Get-Printer PrinterStatus 位掩码表（Bug1 修复）> WMI
  // ExtendedPrinterStatus 1-18 表 > WMI PrinterStatus 1-7 防御表 > unknown；
  // source 标注判定来源
  const wmiLabel =
    wmi?.detectedErrorState != null ? wmiDetectedErrorLabel(wmi.detectedErrorState) : null
  let state: PrinterDiagnostic['status']['state']
  let source: string
  let bitAnnotation: string | null = null
  if (wmi?.workOffline === true) {
    state = 'offline'
    source = 'wmi-workoffline'
  } else if (printer?.printerStatus != null) {
    const mapped = mapPrinterStatusBitmask(printer.printerStatus)
    state = mapped.state
    bitAnnotation = mapped.detectedError
    source = 'win32-printer'
  } else if (wmi?.extendedPrinterStatus != null) {
    state = EXTENDED_PRINTER_STATUS_1_18[wmi.extendedPrinterStatus] ?? 'unknown'
    source = 'wmi'
  } else if (wmi?.printerStatus != null) {
    state = WIN32_PRINTER_STATUS_1_7[wmi.printerStatus] ?? 'unknown'
    source = 'wmi'
  } else {
    state = 'unknown'
    source = 'wmi'
  }

  return {
    name,
    isDefault: wmi?.isDefault ?? false,
    local: wmi?.local ?? false,
    network: wmi?.network ?? false,
    shared: printer?.shared ?? false,
    status: {
      state,
      // 位掩码纸类标注（paper-jam 等）优先；无标注时 WMI DetectedErrorState
      // 人类可读标签（0/1/2 → null；表外值 String(n) 防御保留）
      detectedError: bitAnnotation ?? wmiLabel,
      source
    },
    driver: {
      name: driverName ?? '',
      matchesInstalled:
        driverName !== null && driverName !== '' && driverNames.has(driverName.toLowerCase()),
      printProcessor: wmi?.printProcessor ?? null,
      manufacturer: wmi?.manufacturer ?? null,
      // Win32_Printer.Attributes 位 4096（0x1000）= RAW_ONLY
      rawOnlyBit: wmi?.attributes != null ? (wmi.attributes & 4096) !== 0 : false
    },
    port: {
      name: portName ?? '',
      type: classifyPortType(portName, port?.portNumber ?? null),
      hostAddress: port?.hostAddress ?? null,
      portNumber: port?.portNumber ?? null,
      snmpEnabled: port?.snmpEnabled ?? null,
      reachable: probe !== undefined ? probe.reachable : null
    },
    queue: {
      jobCount: jobs.length,
      // Win32_PrintJob.StatusMask：位 2 = Error，位 4 = Deleting
      errorJobs: jobs.filter((j) => (j.statusMask & 2) !== 0).length,
      deletingJobs: jobs.filter((j) => (j.statusMask & 4) !== 0).length,
      spoolFiles: { spl: 0, shd: 0 }
    },
    jobs: jobs.map((j) => ({
      document: j.document,
      owner: j.owner,
      statusMask: j.statusMask,
      isOwnedByCurrentUser: isOwnedByCurrentUser(j.owner, currentUserName)
    }))
  }
}

/** 端口名分类：USB*→usb / IP_*→tcp-raw（PortNumber 515→tcp-lpr）/ LPT*→lpt / COM*→com / WSD*→wsd / 其他→other */
function classifyPortType(
  portName: string | null,
  portNumber: number | null
): PrinterDiagnostic['port']['type'] {
  const n = (portName ?? '').toLowerCase()
  if (n.startsWith('usb')) return 'usb'
  if (n.startsWith('ip_')) return portNumber === 515 ? 'tcp-lpr' : 'tcp-raw'
  if (n.startsWith('lpt')) return 'lpt'
  if (n.startsWith('com')) return 'com'
  if (n.startsWith('wsd')) return 'wsd'
  return 'other'
}

/** WMI Owner 比对：'DOMAIN\user' 与裸 'user' 均视为当前用户（大小写不敏感） */
function isOwnedByCurrentUser(owner: string, currentUser: string): boolean {
  if (currentUser === '') return false
  const o = owner.toLowerCase()
  const u = currentUser.toLowerCase()
  return o === u || o.endsWith('\\' + u)
}
