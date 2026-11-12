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
} from './schema'

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
  /** driver 通道实际打印选项（缺省字段归一为默认值） */
  printOptions?: {
    pageSizeMode?: string | null
    marginsMode?: string | null
    printBackground?: boolean | null
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
  printerStatus: string | null
  shared: boolean
}

interface WmiSectionRecord {
  name: string
  workOffline: boolean
  detectedErrorState: number | null
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
    printerStatus: asString(rec['PrinterStatus']),
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

function normalizeConfigItem(raw: unknown): ConfigSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const printerName = asString(rec['printerName'])
  if (printerName === null || printerName === '') return null
  return {
    printerName,
    paperSize: asString(rec['paperSize']) ?? '',
    widthMicrons: asNumber(rec['widthMicrons']),
    heightMicrons: asNumber(rec['heightMicrons']),
    orientation: asString(rec['orientation']) ?? ''
  }
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
      app1000Events.push({
        time,
        faultingApp: extractFaultingField(message, 'app'),
        faultingModule: extractFaultingField(message, 'module')
      })
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

/** printConfig 段为原生对象数组（PS 侧已把 Width/Length 映射为 width/heightMicrons，直接消费） */
function parsePrintConfigSection(v: unknown): ConfigSectionRecord[] {
  const items = Array.isArray(v) ? v : []
  return items.map(normalizeConfigItem).filter((x): x is ConfigSectionRecord => x !== null)
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

  // 状态判定优先级：WMI WorkOffline 脱机标志（printer-offline-flag 的判定信号）>
  // Get-Printer PrinterStatus 映射；source 标注判定来源
  let state: PrinterDiagnostic['status']['state']
  let source: string
  if (wmi?.workOffline === true) {
    state = 'offline'
    source = 'wmi-workoffline'
  } else if (printer?.printerStatus != null) {
    state = mapPrinterStatus(printer.printerStatus)
    source = 'win32-printer'
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
      detectedError:
        wmi?.detectedErrorState != null && wmi.detectedErrorState !== 0
          ? String(wmi.detectedErrorState)
          : null,
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

/** Get-Printer PrinterStatus → schema state（Normal→online/Paused→paused/Offline→offline/其他→unknown） */
function mapPrinterStatus(s: string): PrinterDiagnostic['status']['state'] {
  switch (s.toLowerCase()) {
    case 'normal':
      return 'online'
    case 'paused':
      return 'paused'
    case 'offline':
      return 'offline'
    default:
      return 'unknown'
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
      printBackground: printOptions?.['printBackground'] === true
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
