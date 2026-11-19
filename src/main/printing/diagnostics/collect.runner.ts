/**
 * 打印诊断采集执行器（printer-diagnostics 计划 Wave 3 / T4）。
 *
 * 职责：把 T3 的静态脚本（buildCollectScript）落盘执行，并把 stdout 双层
 * JSON 归一化为 PrintDiagnosticSnapshot（T1 schema）。
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
 * v2 真机缺陷修复（printer-diagnostics v2 / T3，报告 20261115-170820 驱动）：
 * - **Bug1（PrinterStatus 位掩码误读）**：Get-Printer 的 PrinterStatus 经
 *   ConvertTo-Json 是**数字**位掩码（0=Normal/1=Paused/2=Error/128=Offline/…，
 *   控制台显示 Normal 只是 CDXML 标签映射）——v1 按字符串 'normal' 匹配恒落
 *   unknown（真机 4 台全 unknown 的根因）。v2 改 asNumber 读取 + 优先级位表
 *   mapPrinterStatusBitmask；数字缺失时走 WMI 兜底链（ExtendedPrinterStatus
 *   1-18 表 → PrinterStatus 1-7 防御表 → unknown）。三套枚举语义不同，
 *   映射表独立维护禁合并（learnings v2 查证结论）。
 * - **Bug2（WER 提取易碎）**：事件 1000 的 message 措辞随语言/版本漂移，v2
 *   优先从 T3 透传的 props 数组按 EventData 固定索引提取（props[0]=应用名 /
 *   props[3]=模块名，语言中立），守卫 props.length ≥ 13；缺失/过短回退既有
 *   中英文正则（正则路径不动，作 Message 兜底）。
 * - **printConfig 四层 fallback 归一**：按 entry.source 分派——
 *   win32printerconfig 0.1mm→μm（×100）、devmode Base64 blob DEVMODEW 偏移
 *   解析（dmFields@72 u32 / dmPaperSize@78 u16 / dmPaperLength@80 i16 /
 *   dmPaperWidth@82 i16 / dmFormName@102-165 UTF-16LE，blob ≥166 字节守卫）、
 *   printconfiguration/printticketxml/无 source（v1 兼容形状）μm 直传；
 *   输出条目条件携带 source 键（v1 形状输入无此键 → 输出亦无，toEqual 兼容）。
 * - **DetectedErrorState 人类可读标签**：0/1/2=无错误(null)、3=low-paper、
 *   4=no-paper、8=jammed、9=offline；表外值保留 String(n) 原值（防御不丢数据）。
 *
 * 双层 JSON（T3 交接的关键坑）：printers/wmi/jobs/ports/drivers 五个列表段在
 * PS 侧已被段内 ConvertTo-Json 字符串化，再经外层 ConvertTo-Json 序列化——
 * stdout 里呈「段级 JSON 字符串（或其数组）」，必须防御性二次解析：
 * typeof v === 'string' → parse；数组元素是 string → 逐个 parse。
 * @() 包裹使实测形状在 [] / ['<json 数组文本>'] / ['<json 对象文本>'] 间漂移，
 * 归一化统一消化（见 parseListSection）。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCollectScript } from './collect-script'
import type {
  App1000Entry,
  EventEntry,
  PrintDiagnosticSnapshot,
  PrinterDiagnostic
} from '../../../shared/printing/diagnostics-schema'

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

/**
 * app 侧合成段原料（T9 编排注入；测试用 fake 注入）。
 * 「provider」= 数据提供者：字段全部可空，本模块负责防御归一（printer_name
 * 为 null → '' 等——T1 learnings「AppSettings null 陷阱」的归一责任在本任务）。
 */
export interface AppInfoSnapshotProvider {
  /** 打印设置（结构兼容 AppSettings 打印子集；printer_name 可为 null → 归一为 ''） */
  settings?: { printer_channel?: string | null; printer_name?: string | null } | null
  /** 默认模板纸宽（'58mm' / '80mm'；取不到为 null → ''） */
  templatePaperWidth?: string | null
  /** driver 通道实际打印选项（缺省字段归一为默认值；v2 实验键条件透传） */
  printOptions?: {
    pageSizeMode?: string | null
    marginsMode?: string | null
    printBackground?: boolean | null
    /** v2 driver 实验：显式 DPI（null/缺省 = 未设置——输出不携带 dpi 键） */
    dpi?: number | null
    /** v2 driver 实验：使用驱动默认页尺寸（true 时才携带键） */
    usePrinterDefaultPageSize?: boolean | null
  } | null
  /** 默认模板事实（logo-measurement-race 等规则的比对输入） */
  templateFacts?: {
    hasLogo?: boolean | null
    logoPx?: number | null
    cssPadding?: string | null
  } | null
  /** 当前 OS 用户名（WMI Owner 的 'DOMAIN\user' 与裸 'user' 均可命中） */
  currentUserName?: string | null
  /** Electron 版本；缺省取 process.versions.electron（纯 node 环境下为 'unknown'） */
  electronVersion?: string
}

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

// ══════════════ 双层 JSON 防御解析 ══════════════

/**
 * 列表段（printers/wmi/jobs/ports/drivers）防御性二次解析——T3 交接关键坑的
 * 唯一消化点。实测形状谱系（@() 包裹 + 段内 ConvertTo-Json 的组合结果）：
 * - 空列表 → []（内层 cmd 无输出，@() 收成空数组）
 * - N≥2 项 → ['<JSON 数组文本>']（内层输出单字符串，@() 包成单元素数组）
 * - 恰 1 项 → ['<JSON 对象文本>']（内层单对象不裹数组——PS 经典陷阱）
 * 防御分支额外覆盖：裸字符串、对象数组直通、意外单对象。
 */
function parseListSection(v: unknown): unknown[] {
  let items: unknown
  if (typeof v === 'string') {
    items = JSON.parse(v)
  } else if (Array.isArray(v)) {
    items = v.map((x) => (typeof x === 'string' ? JSON.parse(x) : x))
  } else {
    items = v
  }
  if (Array.isArray(items)) {
    // ['[a,b]'] 解析后呈 [[a,b]]——解包一层（段级 JSON 数组文本被 @() 包成单元素）
    if (items.length === 1 && Array.isArray(items[0])) return items[0]
    return items
  }
  if (asRecord(items) !== null) return [items]
  return []
}

function parseListItems<T>(v: unknown, normalize: (raw: unknown) => T | null): T[] {
  return parseListSection(v)
    .map(normalize)
    .filter((x): x is T => x !== null)
}

// ══════════════ 段级记录归一（printer-enumerator 的防御模式） ══════════════

interface PrinterSectionRecord {
  name: string
  driverName: string | null
  portName: string | null
  /**
   * Get-Printer PrinterStatus——真机经 ConvertTo-Json 是位掩码**数字**
   * （0=Normal/128=Offline/…；Bug1 修复：v1 当字符串读恒 null → unknown）。
   * 缺失/非数字 → null → 落 WMI 兜底链。
   */
  printerStatus: number | null
  shared: boolean
}

interface WmiSectionRecord {
  name: string
  workOffline: boolean
  detectedErrorState: number | null
  /** Win32_Printer.ExtendedPrinterStatus（1-18 枚举；3=Idle 等健在值——WMI 兜底链首选信号） */
  extendedPrinterStatus: number | null
  /** 防御字段：Win32_Printer.PrinterStatus（1-7 枚举；当前脚本未采集，记录带了就读） */
  printerStatus: number | null
  attributes: number | null
  local: boolean
  network: boolean
  isDefault: boolean
  portName: string | null
  driverName: string | null
  printProcessor: string | null
  manufacturer: string | null
}

interface JobSectionRecord {
  /** 从 Win32_PrintJob.Name "printerName, jobID" 解出（按最后一个逗号切，容忍含逗号打印机名） */
  printerName: string
  document: string
  owner: string
  statusMask: number
}

interface PortSectionRecord {
  name: string
  hostAddress: string | null
  portNumber: number | null
  snmpEnabled: boolean | null
}

interface DriverSectionRecord {
  name: string
}

interface ProbeSectionRecord {
  name: string
  reachable: boolean
}

interface ConfigSectionRecord {
  printerName: string
  paperSize: string
  widthMicrons: number | null
  heightMicrons: number | null
  orientation: string
  /** T3 v2 四层 fallback 的来源标注（v1 形状输入无此键 → 输出亦无，toEqual 兼容） */
  source?: string
}

function normalizePrintersItem(raw: unknown): PrinterSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const name = asString(rec['Name'])
  if (name === null || name === '') return null
  return {
    name,
    driverName: asString(rec['DriverName']),
    portName: asString(rec['PortName']),
    printerStatus: asNumber(rec['PrinterStatus']),
    shared: rec['Shared'] === true
  }
}

function normalizeWmiItem(raw: unknown): WmiSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const name = asString(rec['Name'])
  if (name === null || name === '') return null
  return {
    name,
    workOffline: rec['WorkOffline'] === true,
    detectedErrorState: asNumber(rec['ExtendedDetectedErrorState']),
    extendedPrinterStatus: asNumber(rec['ExtendedPrinterStatus']),
    printerStatus: asNumber(rec['PrinterStatus']),
    attributes: asNumber(rec['Attributes']),
    local: rec['Local'] === true,
    network: rec['Network'] === true,
    isDefault: rec['Default'] === true,
    portName: asString(rec['PortName']),
    driverName: asString(rec['DriverName']),
    printProcessor: asString(rec['PrintProcessor']),
    manufacturer: asString(rec['Manufacturer'])
  }
}

function normalizeJobsItem(raw: unknown): JobSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const name = asString(rec['Name'])
  if (name === null || name === '') return null
  const idx = name.lastIndexOf(',')
  const printerName = (idx >= 0 ? name.slice(0, idx) : name).trim()
  if (printerName === '') return null
  return {
    printerName,
    document: asString(rec['Document']) ?? '',
    owner: asString(rec['Owner']) ?? '',
    statusMask: asNumber(rec['StatusMask']) ?? 0
  }
}

function normalizePortsItem(raw: unknown): PortSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const name = asString(rec['Name'])
  if (name === null || name === '') return null
  return {
    name,
    hostAddress: asString(rec['PrinterHostAddress']),
    portNumber: asNumber(rec['PortNumber']),
    snmpEnabled: typeof rec['SNMPEnabled'] === 'boolean' ? rec['SNMPEnabled'] : null
  }
}

function normalizeDriversItem(raw: unknown): DriverSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const name = asString(rec['Name'])
  if (name === null || name === '') return null
  return { name }
}

function normalizeProbeItem(raw: unknown): ProbeSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const name = asString(rec['name'])
  if (name === null || name === '') return null
  return { name, reachable: rec['reachable'] === true }
}

/**
 * printConfig 条目归一（v2：按 entry.source 分派 T3 四层 fallback 的单位/编码差异）：
 * - printconfiguration / printticketxml / 无 source（v1 兼容形状）：μm 直传；
 * - win32printerconfig：PaperWidth/PaperLength 0.1mm 原值（T3 不换算）→ μm（×100）；
 * - devmode：Base64 blob 的 DEVMODEW 偏移解析（见 parseDevmodeB64）。
 * 输出条目条件携带 source 键——v1 形状输入（无 source）输出亦无此键（toEqual 兼容）。
 */
function normalizeConfigItem(raw: unknown): ConfigSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const printerName = asString(rec['printerName'])
  if (printerName === null || printerName === '') return null
  const source = asString(rec['source'])
  const orientation = asString(rec['orientation']) ?? ''

  if (source === 'win32printerconfig') {
    const widthTenthMm = asNumber(rec['paperWidthTenthMm'])
    const lengthTenthMm = asNumber(rec['paperLengthTenthMm'])
    return {
      printerName,
      paperSize: asString(rec['paperSize']) ?? '',
      widthMicrons: widthTenthMm != null ? widthTenthMm * 100 : null,
      heightMicrons: lengthTenthMm != null ? lengthTenthMm * 100 : null,
      orientation,
      source
    }
  }
  if (source === 'devmode') {
    const devmode = parseDevmodeB64(asString(rec['devmodeB64']))
    return {
      printerName,
      paperSize: devmode.paperSize,
      widthMicrons: devmode.widthMicrons,
      heightMicrons: devmode.heightMicrons,
      orientation,
      source
    }
  }
  return {
    printerName,
    paperSize: asString(rec['paperSize']) ?? '',
    widthMicrons: asNumber(rec['widthMicrons']),
    heightMicrons: asNumber(rec['heightMicrons']),
    orientation,
    ...(source != null ? { source } : {})
  }
}

/**
 * DEVMODE Base64 blob 偏移解析（v2 盲区 4 的注册表兜底层——PS 只编码，TS 侧解析）。
 * DEVMODEW 偏移（librarian 查证已纠正，learnings v2 查证结论★1）：
 * dmFields@72 u32 小端（有效位 DM_PAPERSIZE=0x2 / DM_PAPERLENGTH=0x4 /
 * DM_PAPERWIDTH=0x8）、dmPaperSize@78 u16、dmPaperLength@80 i16、dmPaperWidth@82
 * i16（0.1mm 单位 → ×100 得 μm）、dmFormName@102-165 UTF-16LE。
 * - blob <166 字节 → 全空（短 blob 越界读不可信，规则层按缺数据降级）；
 * - dmPaperSize ≥ 256（DMPAPER_USER 自定义表单）：宽高在 Forms 定义不在
 *   DEVMODE——取 dmFormName（截零）作 paperSize，宽高 null；
 * - dmFields 同置 DM_PAPERLENGTH|DM_PAPERWIDTH 才有可读宽高，否则 null/null。
 */
function parseDevmodeB64(
  b64: string | null
): { paperSize: string; widthMicrons: number | null; heightMicrons: number | null } {
  if (b64 === null) return { paperSize: '', widthMicrons: null, heightMicrons: null }
  const blob = Buffer.from(b64, 'base64')
  if (blob.length < 166) return { paperSize: '', widthMicrons: null, heightMicrons: null }
  const dmFields = blob.readUInt32LE(72)
  const dmPaperSize = blob.readUInt16LE(78)
  if (dmPaperSize >= 256) {
    const formName = blob.toString('utf16le', 102, 166).split('\0')[0].trim()
    return { paperSize: formName, widthMicrons: null, heightMicrons: null }
  }
  if ((dmFields & 0x4) !== 0 && (dmFields & 0x8) !== 0) {
    return {
      paperSize: '',
      widthMicrons: blob.readInt16LE(82) * 100,
      heightMicrons: blob.readInt16LE(80) * 100
    }
  }
  return { paperSize: '', widthMicrons: null, heightMicrons: null }
}

// ══════════════ 原生段解析 ══════════════

function parseSpoolerSection(v: unknown): PrintDiagnosticSnapshot['system']['spooler'] {
  const rec = asRecord(v)
  const dependentsRaw = rec?.['dependents']
  return {
    status: asString(rec?.['status']) ?? '',
    startType: asString(rec?.['startType']) ?? '',
    dependents: Array.isArray(dependentsRaw)
      ? dependentsRaw.filter((d): d is string => typeof d === 'string')
      : []
  }
}

/** spoolDir 段只消费 .spl/.shd 计数；目录路径本身留在 raw.spoolDir 留档 */
function parseSpoolDirSection(v: unknown): { spl: number; shd: number } {
  const rec = asRecord(v)
  const filesRaw = rec?.['files']
  const files = Array.isArray(filesRaw) ? filesRaw : []
  let spl = 0
  let shd = 0
  for (const f of files) {
    const fr = asRecord(f)
    if (fr === null) continue
    const ext = asString(fr['ext'])?.toLowerCase() ?? ''
    const count = asNumber(fr['count']) ?? 0
    if (ext === '.spl') spl = count
    else if (ext === '.shd') shd = count
  }
  return { spl, shd }
}

function parseEventsSection(v: unknown): PrintDiagnosticSnapshot['system']['eventLog'] {
  const rec = asRecord(v)
  const adminRaw = rec?.['admin']
  const adminEvents: EventEntry[] = []
  if (Array.isArray(adminRaw)) {
    for (const item of adminRaw) {
      const er = asRecord(item)
      const time = asString(er?.['time'])
      if (er === null || time === null || time === '') continue
      adminEvents.push({ time, id: asNumber(er['id']) ?? 0 })
    }
  }
  const appRaw = rec?.['app1000']
  const app1000Events: App1000Entry[] = []
  if (Array.isArray(appRaw)) {
    for (const item of appRaw) {
      const er = asRecord(item)
      const time = asString(er?.['time'])
      if (er === null || time === null || time === '') continue
      const message = asString(er['message']) ?? ''
      // Bug2 修复：T3 透传的 WER props 数组（事件 1000 EventData 固定字段序：
      // [0]=应用名 [3]=模块名，语言中立不随措辞漂移）优先；守卫 length ≥ 13
      //（完整 EventData 20 项，[11]=模块路径是第 12 项——短数组说明形状漂移，
      // 索引不可信）；缺失/过短回退 message 正则（中英文两套模式兜底）。
      const props = er['props']
      if (Array.isArray(props) && props.length >= 13) {
        app1000Events.push({
          time,
          faultingApp: propStr(props[0]) || 'unknown',
          faultingModule: propStr(props[3]) || 'unknown'
        })
      } else {
        app1000Events.push({
          time,
          faultingApp: extractFaultingField(message, 'app'),
          faultingModule: extractFaultingField(message, 'module')
        })
      }
    }
  }
  return {
    adminEvents,
    app1000Events,
    operationalEnabled: rec?.['operationalEnabled'] === true
  }
}

/**
 * 事件 1000 message 的 faultingApp/faultingModule 防御提取（中英文两套模式）。
 * 在规格给定模式（/faulting application name:\s*([^,]+)/i 与
 * /应用程序名[:：]\s*([^\r\n,]+)/）之上做两处超集扩展：
 * - 中文事件实际措辞是「错误应用程序名称:」「故障模块名称:」——补 (?:错误|故障)?
 *   前缀与 (?:称)? 后缀才能命中真实数据；
 * - 中文全角逗号 '，' 同为分隔符——stop 类补上，否则捕获会吞到行尾。
 * 两处扩展均不改变规格给定模式的命中集；提取失败填 'unknown'。
 */
const FAULTING_PATTERNS: Record<'app' | 'module', RegExp[]> = {
  app: [/faulting application name:\s*([^,，\r\n]+)/i, /(?:错误|故障)?应用程序名(?:称)?[:：]\s*([^,，\r\n]+)/],
  module: [/faulting module name:\s*([^,，\r\n]+)/i, /(?:错误|故障)?模块名(?:称)?[:：]\s*([^,，\r\n]+)/]
}

function extractFaultingField(message: string, kind: 'app' | 'module'): string {
  for (const re of FAULTING_PATTERNS[kind]) {
    const m = re.exec(message)
    if (m !== null && m[1] !== undefined) {
      const value = m[1].trim()
      if (value !== '') return value
    }
  }
  return 'unknown'
}

/**
 * WER props 元素防御归一（Bug2）：null/undefined/对象 → ''（无可提取值）；
 * 标量 → String().trim()。空串由调用方归一为 'unknown'（与正则路径
 * extractFaultingField 的失败填值契约对齐）。
 */
function propStr(v: unknown): string {
  if (v === null || v === undefined || typeof v === 'object') return ''
  return String(v).trim()
}

/** printConfig 段为原生对象数组（T3 v2 按层标注 source；条目归一按 source 分派，见 normalizeConfigItem） */
function parsePrintConfigSection(v: unknown): ConfigSectionRecord[] {
  const items = Array.isArray(v) ? v : []
  return items.map(normalizeConfigItem).filter((x): x is ConfigSectionRecord => x !== null)
}

// ══════════════ v2 状态映射表（三套枚举语义不同——独立维护，禁合并） ══════════════

/**
 * Get-Printer PrinterStatus 位掩码优先级表（Bug1 修复核心）——**有序**数组，
 * 遍历首个命中的位决定。真机实测 PrinterStatus 是位掩码数字而非 'Normal'
 * 字符串：OFFLINE=128 / ERROR=2 / PAUSED=1 / PENDING_DELETION=4 /
 * PAPER_JAM=8 / PAPER_OUT=16 / PAPER_PROBLEM=64 / DOOR_OPEN=4194304；
 * 运行态位（256 IOActive 起）与 0（Normal）不扰动判定 → online。
 */
const PRINTER_STATUS_BITMASK: ReadonlyArray<{
  bit: number
  state: PrinterDiagnostic['status']['state']
  detectedError: string | null
}> = [
  { bit: 128, state: 'offline', detectedError: null },
  { bit: 2, state: 'error', detectedError: null },
  { bit: 1, state: 'paused', detectedError: null },
  { bit: 4, state: 'error', detectedError: 'pending-deletion' },
  { bit: 8, state: 'error', detectedError: 'paper-jam' },
  { bit: 16, state: 'error', detectedError: 'paper-out' },
  { bit: 64, state: 'error', detectedError: 'paper-problem' },
  { bit: 4194304, state: 'error', detectedError: 'door-open' }
]

/**
 * Get-Printer PrinterStatus 位掩码 → {state, detectedError}：遍历优先级表首个
 * 命中位决定；其余（含 0=Normal 与全部运行态位）→ online。
 */
function mapPrinterStatusBitmask(mask: number): {
  state: PrinterDiagnostic['status']['state']
  detectedError: string | null
} {
  for (const entry of PRINTER_STATUS_BITMASK) {
    if ((mask & entry.bit) !== 0) return { state: entry.state, detectedError: entry.detectedError }
  }
  return { state: 'online', detectedError: null }
}

/**
 * Win32_Printer.PrinterStatus 1-7 表（防御字段：当前脚本未采集，wmi 记录带了
 * 就读）。1=Other/2=Unknown/6=StoppedPrinting → unknown；3=Idle/4=Printing/
 * 5=Warmup → online；7=Offline → offline。表外值 → unknown。
 */
const WIN32_PRINTER_STATUS_1_7: Readonly<Record<number, PrinterDiagnostic['status']['state']>> = {
  1: 'unknown',
  2: 'unknown',
  3: 'online',
  4: 'online',
  5: 'online',
  6: 'unknown',
  7: 'offline'
}

/**
 * Win32_Printer.ExtendedPrinterStatus 1-18 表（wmi 兜底链首选信号）：
 * 3=Idle/4=Printing/17=IOActive/18=ManualFeed → online；7=Offline → offline；
 * 8=Paused → paused；9=Error → error；2=Unknown（无 bidi 状态监视器的低价
 * 热敏机常态——「拿不到状态」非故障）与表外值（1/5/6/10-16）→ unknown。
 */
const EXTENDED_PRINTER_STATUS_1_18: Readonly<Record<number, PrinterDiagnostic['status']['state']>> =
  {
    2: 'unknown',
    3: 'online',
    4: 'online',
    7: 'offline',
    8: 'paused',
    9: 'error',
    17: 'online',
    18: 'online'
  }

/**
 * Win32_Printer.ExtendedDetectedErrorState 人类可读标签表（v1 裸 String(n) 的
 * 替代）：0=Unknown/1=Other/2=NoError → null（无错误）；3=LowPaper/4=NoPaper/
 * 5=LowToner/6=NoToner/7=DoorOpen/8=Jammed/9=Offline → 标签。表外值保留
 * String(n) 原值（防御不丢真机数据）。
 */
const DETECTED_ERROR_STATE_LABELS: Readonly<Record<number, string | null>> = {
  0: null,
  1: null,
  2: null,
  3: 'low-paper',
  4: 'no-paper',
  5: 'low-toner',
  6: 'no-toner',
  7: 'door-open',
  8: 'jammed',
  9: 'offline'
}

/**
 * ExtendedDetectedErrorState → 人类可读标签：表内 0/1/2 = 无错误（null），
 * 3-9 = 错误标签；表外值保留 String(n) 原值。注意不能用 `表[n] ?? String(n)`
 * ——表内显式 null 会被 ?? 当键缺失吞成 String(n)，故用 in 判定。
 */
function wmiDetectedErrorLabel(n: number): string | null {
  return n in DETECTED_ERROR_STATE_LABELS ? DETECTED_ERROR_STATE_LABELS[n] : String(n)
}

// ══════════════ PrinterDiagnostic 装配 ══════════════

function buildPrinterDiagnostics(
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

// ══════════════ app 侧合成 ══════════════

function resolveCurrentUserName(appInfo: AppInfoSnapshotProvider | undefined): string {
  const name = appInfo?.currentUserName
  if (typeof name === 'string' && name !== '') return name
  // 默认 provider：Windows 为 USERNAME，类 Unix 为 USER（生产 T9 可显式注入覆盖）
  return process.env['USERNAME'] ?? process.env['USER'] ?? ''
}

function composeAppSection(appInfo: AppInfoSnapshotProvider | undefined): PrintDiagnosticSnapshot['app'] {
  const settings = asRecord(appInfo?.settings)
  const printOptions = asRecord(appInfo?.printOptions)
  const templateFacts = asRecord(appInfo?.templateFacts)
  // v2 实验键观测（条件携带——未启用时物理不存在，报告可区分「未设置」与「设为缺省值」）
  const dpi = asNumber(printOptions?.['dpi'])
  const useDefaultPageSize = printOptions?.['usePrinterDefaultPageSize'] === true
  return {
    // settings 的 nullable 归一为 string（T1 learnings：归一责任在本任务）
    settings: {
      channel: asString(settings?.['printer_channel']) ?? '',
      printerName: asString(settings?.['printer_name']) ?? '',
      templatePaperWidth: asString(appInfo?.templatePaperWidth) ?? ''
    },
    electronVersion: asString(appInfo?.electronVersion) ?? process.versions.electron ?? 'unknown',
    printOptions: {
      pageSizeMode: asString(printOptions?.['pageSizeMode']) ?? '',
      marginsMode: asString(printOptions?.['marginsMode']) ?? '',
      printBackground: printOptions?.['printBackground'] === true,
      ...(dpi !== null ? { dpi } : {}),
      ...(useDefaultPageSize ? { usePrinterDefaultPageSize: true } : {})
    },
    templateFacts: {
      hasLogo: templateFacts?.['hasLogo'] === true,
      logoPx: asNumber(templateFacts?.['logoPx']),
      cssPadding: asString(templateFacts?.['cssPadding']) ?? ''
    }
  }
}

// ══════════════ 小工具 ══════════════

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** T3 段级失败形状：@{ error = $_.Exception.Message } → { error: string } */
function isErrorShape(v: unknown): v is { error: string } {
  const rec = asRecord(v)
  return rec !== null && typeof rec['error'] === 'string'
}

function stringifyRaw(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null'
  } catch {
    return String(v)
  }
}
