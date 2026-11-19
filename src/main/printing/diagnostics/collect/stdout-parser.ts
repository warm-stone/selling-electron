/**
 * stdout 段解析与归一（collect.runner 拆分批次 5）。
 *
 * 双层 JSON（T3 交接的关键坑）：printers/wmi/jobs/ports/drivers 五个列表段在
 * PS 侧已被段内 ConvertTo-Json 字符串化，再经外层 ConvertTo-Json 序列化——
 * stdout 里呈「段级 JSON 字符串（或其数组）」，必须防御性二次解析：
 * typeof v === 'string' → parse；数组元素是 string → 逐个 parse。
 * @() 包裹使实测形状在 [] / ['<json 数组文本>'] / ['<json 对象文本>'] 间漂移，
 * 归一化统一消化（见 parseListSection）。
 *
 * v2 真机缺陷修复随段解析落地（printer-diagnostics v2 / T3）：
 * - Bug2（WER 提取易碎）：事件 1000 优先从 T3 透传的 props 数组按 EventData
 *   固定索引提取（语言中立），守卫 props.length ≥ 13；缺失/过短回退中英文正则；
 * - printConfig 四层 fallback 归一：按 entry.source 分派单位/编码差异；
 * - DetectedErrorState 人类可读标签在 status-maps（装配侧消费）。
 */

import type {
  App1000Entry,
  EventEntry,
  PrintDiagnosticSnapshot
} from '../../../../shared/printing/diagnostics-schema'
import { asNumber, asRecord, asString } from './primitives'

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

export function parseListItems<T>(v: unknown, normalize: (raw: unknown) => T | null): T[] {
  return parseListSection(v)
    .map(normalize)
    .filter((x): x is T => x !== null)
}

// ══════════════ 段级记录归一（printer-enumerator 的防御模式） ══════════════

export interface PrinterSectionRecord {
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

export interface WmiSectionRecord {
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

export interface JobSectionRecord {
  /** 从 Win32_PrintJob.Name "printerName, jobID" 解出（按最后一个逗号切，容忍含逗号打印机名） */
  printerName: string
  document: string
  owner: string
  statusMask: number
}

export interface PortSectionRecord {
  name: string
  hostAddress: string | null
  portNumber: number | null
  snmpEnabled: boolean | null
}

export interface DriverSectionRecord {
  name: string
}

export interface ProbeSectionRecord {
  name: string
  reachable: boolean
}

export interface ConfigSectionRecord {
  printerName: string
  paperSize: string
  widthMicrons: number | null
  heightMicrons: number | null
  orientation: string
  /** T3 v2 四层 fallback 的来源标注（v1 形状输入无此键 → 输出亦无，toEqual 兼容） */
  source?: string
}

export function normalizePrintersItem(raw: unknown): PrinterSectionRecord | null {
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

export function normalizeWmiItem(raw: unknown): WmiSectionRecord | null {
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

export function normalizeJobsItem(raw: unknown): JobSectionRecord | null {
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

export function normalizePortsItem(raw: unknown): PortSectionRecord | null {
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

export function normalizeDriversItem(raw: unknown): DriverSectionRecord | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const name = asString(rec['Name'])
  if (name === null || name === '') return null
  return { name }
}

export function normalizeProbeItem(raw: unknown): ProbeSectionRecord | null {
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
export function normalizeConfigItem(raw: unknown): ConfigSectionRecord | null {
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

export function parseSpoolerSection(v: unknown): PrintDiagnosticSnapshot['system']['spooler'] {
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
export function parseSpoolDirSection(v: unknown): { spl: number; shd: number } {
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

export function parseEventsSection(v: unknown): PrintDiagnosticSnapshot['system']['eventLog'] {
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
export function parsePrintConfigSection(v: unknown): ConfigSectionRecord[] {
  const items = Array.isArray(v) ? v : []
  return items.map(normalizeConfigItem).filter((x): x is ConfigSectionRecord => x !== null)
}
