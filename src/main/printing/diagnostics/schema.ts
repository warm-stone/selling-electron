/**
 * 打印诊断子系统 —— 唯一类型契约源（printer-diagnostics 计划 Wave 1 / T1）。
 *
 * 本模块是后续 9 个任务的共同契约地基，字段名一次定准、三方按名消费：
 * - T3（PowerShell 采集脚本）的 stdout 解析目标 = PrintDiagnosticSnapshot；
 * - T4（快照合成）产出 PrintDiagnosticSnapshot（app 段在此合入）；
 * - T5（规则引擎）按 FindingCode 枚举产出 Finding，依赖采集段由
 *   RULE_DEPENDS_ON 声明（编译期保证键集与值域）；
 * - T6（修复动作）按 RepairActionId 执行；
 * - T8（报告导出）序列化 DiagnosticReport。
 * 任何字段改名/增删都直接破坏上述消费方——改动契约必须同步升级 schemaVersion。
 *
 * 纯类型 + 纯数据模块：**零 Node/Electron 依赖**（shared/types/ipc.ts 以
 * import type 反向引用本模块，type-only 在编译期擦除，node/web 两侧
 * tsconfig 均可编译，不把 main 代码拉进 preload/renderer bundle）。
 */

// ══════════════ 采集快照 ══════════════

/** 管理通道事件行（events 浭：time + 事件 id） */
export interface EventEntry {
  time: string
  id: number
}

/** 应用错误事件 1000（崩溃环证据——faultingModule 锁定驱动 DLL） */
export interface App1000Entry {
  time: string
  faultingApp: string
  faultingModule: string
}

/** 渲染测量快照（T7 render-check 在隐藏窗口内测得，挂在快照上随报告流转） */
export interface RenderSnapshot {
  /** 图片解码完成前立即测得的内容高度（px） */
  immediatelyMeasured: number
  /** 图片解码完成后再测的内容高度（px） */
  afterImgDecode: number
  /** 两次测量差（≠0 即 logo-measurement-race 的测量竞态证据） */
  heightDelta: number
  scrollWidth: number
  paperWidthPx: number
  horizontalOverflow: boolean
  dpr: number
}

/**
 * 单台打印机诊断信息（printers / wmi / jobs / ports / drivers / spoolDir
 * 段合成，T3 输出 + T4 装配）。
 */
export interface PrinterDiagnostic {
  name: string
  isDefault: boolean
  local: boolean
  network: boolean
  shared: boolean
  /** 工作状态（offline 标志 / 队列错误字 / WMI 综合判定；source 标注判定来源） */
  status: {
    state: 'online' | 'offline' | 'paused' | 'error' | 'unknown'
    detectedError: string | null
    source: string
  }
  /** 驱动信息（driver-missing / raw-garbled-risk / cloud-printer-raw-utf8 证据源） */
  driver: {
    name: string
    matchesInstalled: boolean
    printProcessor: string | null
    manufacturer: string | null
    /** 「仅 RAW 模式」位（print processor / 驱动属性特征） */
    rawOnlyBit: boolean
  }
  /** 端口信息（port-wsd-instability / snmp-false-offline 证据源） */
  port: {
    name: string
    type: 'lpt' | 'com' | 'usb' | 'tcp-raw' | 'tcp-lpr' | 'wsd' | 'other'
    hostAddress: string | null
    portNumber: number | null
    snmpEnabled: boolean | null
    /** tcpProbe 段回填（探测失败/非 TCP 口为 null） */
    reachable: boolean | null
  }
  /** 队列概览（jobs 段 + spoolDir 残留计数） */
  queue: {
    jobCount: number
    errorJobs: number
    deletingJobs: number
    spoolFiles: { spl: number; shd: number }
  }
  /** 队列任务明细（owner 与当前用户比对 → isOwnedByCurrentUser） */
  jobs: Array<{
    document: string
    owner: string
    statusMask: number
    isOwnedByCurrentUser: boolean
  }>
}

/**
 * 诊断采集快照（T3 PowerShell 输出 + T4 app 侧合成的目标形状）。
 * 部分段采集失败不拖垮整体：失败段记入 errors，原始 stdout 留档 raw。
 */
export interface PrintDiagnosticSnapshot {
  /** 每台打印机一条 */
  printers: PrinterDiagnostic[]
  /** 系统侧采集 */
  system: {
    /** Print Spooler 服务状态（spooler 段） */
    spooler: {
      status: string
      startType: string
      dependents: string[]
    }
    /** 事件日志（events 段） */
    eventLog: {
      /** 管理通道近期错误事件 */
      adminEvents: EventEntry[]
      /** 应用错误 1000（崩溃环证据） */
      app1000Events: App1000Entry[]
      /** Microsoft-Windows-PrintService/Operational 日志是否启用 */
      operationalEnabled: boolean
    }
    /** 每台打印机 DEVMODE 打印配置（printConfig 段） */
    printConfigs: Array<{
      printerName: string
      paperSize: string
      widthMicrons: number | null
      heightMicrons: number | null
      orientation: string
    }>
  }
  /** app 侧合成段（T4：设置 + Electron 版本 + driver 通道实际选项 + 模板事实） */
  app: {
    /**
     * 当前打印设置快照（AppSettings 打印子集；printer_name 等 nullable 字段
     * 在此归一为 string——见 pos-electron-app learnings「AppSettings null 陷阱」）。
     */
    settings: {
      channel: string
      printerName: string
      templatePaperWidth: string
    }
    electronVersion: string
    /** driver 通道实际使用的打印选项快照（页宽微米 / 零边距 / 打印背景） */
    printOptions: {
      pageSizeMode: string
      marginsMode: string
      printBackground: boolean
    }
    /** 默认模板事实（logo-measurement-race 等规则的比对输入） */
    templateFacts: {
      hasLogo: boolean
      logoPx: number | null
      cssPadding: string
    }
  }
  /** T7 render-check 产出（logo-measurement-race 消费源；symptom2 fixture 携带） */
  renderSnapshot?: RenderSnapshot
  /** section 名 → 错误消息（部分失败不拖垮整体） */
  errors: Record<string, string>
  /** section 名 → 原始 stdout 留档 */
  raw: Record<string, string>
}

// ══════════════ 发现（规则引擎输出） ══════════════

/** 发现编码（15 个——一次定准，T5 按名实现规则） */
export type FindingCode =
  | 'spooler-stopped' // spooler 服务停止
  | 'jobs-stuck-error' // 队列错误任务滞留
  | 'jobs-stuck-deleting' // 删除中任务卡死（伴 .spl/.shd 残留）
  | 'port-wsd-instability' // WSD 端口不稳定（丢任务/掉线）
  | 'snmp-false-offline' // SNMP 状态误报离线（端口实际可达）
  | 'driver-missing' // 驱动未安装/名称不匹配
  | 'driver-crash-loop' // 驱动崩溃环（事件 1000 faultingModule 指向驱动 DLL）
  | 'raw-garbled-risk' // RAW 字节被驱动当文本渲染（乱码风险）
  | 'cloud-printer-raw-utf8' // 云打印机固件把 RAW 当 UTF-8（丢 GBK 与光栅）
  | 'driver-page-size-ignored' // 驱动忽略页宽设置（DEVMODE 与实际不符）
  | 'printable-area-clip' // 内容超可打印区域被裁切
  | 'logo-measurement-race' // Logo 尺寸测量竞态（heightDelta ≠ 0）
  | 'printer-offline-flag' // 打印机脱机标志被置位
  | 'queue-paused' // 队列暂停
  | 'printer-name-mismatch' // 设置的打印机名与系统实际不符

/** 严重度（critical 阻断打印 / high 高概率根因 / medium 辅助证据 / info 提示） */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'info'

/** 影响域（整机 / 单台打印机 / app 配置） */
export type FindingScope = 'machine' | 'printer' | 'appConfig'

/** 发现处置状态（pass 未命中规则时不产出；auto-fixed L1 已自动修复；verify-* 复核结果；needs-manual/needs-dev/escalated 升级路径） */
export type FindingStatus =
  | 'pass'
  | 'auto-fixed'
  | 'pending'
  | 'verify-passed'
  | 'verify-failed'
  | 'needs-manual'
  | 'needs-dev'
  | 'escalated'

/** 单条发现（规则引擎输出；evidence 为结构化字段路径引用） */
export interface Finding {
  code: FindingCode
  severity: FindingSeverity
  scope: FindingScope
  /** printer scope 时的归属打印机名 */
  printerName?: string
  /** 结构化字段路径引用，如 "system.spooler.status='Stopped'" */
  evidence: string
  suggestedActions: RepairActionId[]
  status: FindingStatus
  /** 中文人话描述（报告/T8 导出直接展示） */
  description: string
}

// ══════════════ 修复动作 ══════════════

/**
 * 修复动作编码（9 个）。
 * 前 7 个为可执行动作；REINSTALL_DRIVER_GUIDE / GENERIC_TEXT_ONLY_GUIDE
 * 为 L4 引导占位（只出指引目录，不自动执行）。
 */
export type RepairActionId =
  | 'CANCEL_ERROR_JOBS' // L1：清错误任务
  | 'SWITCH_TO_DRIVER_CHANNEL' // L1：切 driver 渲染兜底通道（应用内改 settings，无提权）
  | 'SWITCH_TO_SPOOLER_CHANNEL' // L1：切回 spooler 主通道（症状 2 反向 workaround，应用内改 settings）
  | 'PURGE_QUEUE_RESTART_SPOOLER' // L2：清队列 + 重启 spooler（需提权）
  | 'MIGRATE_WSD_TO_TCP' // L2：WSD 端口迁移标准 TCP（保守默认）
  | 'ENABLE_PRINT_LOG' // L2：启用 Operational 日志
  | 'DISABLE_SNMP' // L4：禁用端口 SNMP（已重分级——误报副作用大）
  | 'REINSTALL_DRIVER_GUIDE' // L4：重装驱动引导
  | 'GENERIC_TEXT_ONLY_GUIDE' // L4：Generic / Text Only 驱动引导

/** 修复级别（L1 自动 / L2 需用户确认 / L4 人工引导） */
export type RepairLevel = 'L1' | 'L2' | 'L4'

/** 修复动作定义（T6 注册表条目） */
export interface RepairAction {
  id: RepairActionId
  level: RepairLevel
  needsElevation: boolean
  requiresConfirm: boolean
  description: string
  dryRun: boolean
}

// ══════════════ 报告 ══════════════

/** 诊断报告（diagnose 响应体 / T8 导出载荷） */
export interface DiagnosticReport {
  /** 契约版本（const 1——报告格式演进时递增） */
  schemaVersion: 1
  /** 采集时刻（ISO 8601） */
  collectedAt: string
  snapshot: PrintDiagnosticSnapshot
  findings: Finding[]
  /** 顶层便捷访问（与 snapshot.renderSnapshot 同源；未执行 render-check 时缺省） */
  renderSnapshot?: RenderSnapshot
}

// ══════════════ VERIFY 依赖映射 ══════════════

/** 采集段名（T3 PowerShell 脚本分段；errors/raw 的 key 值域同此） */
export type DiagnosticSectionName =
  | 'printers' // Get-Printer 枚举
  | 'wmi' // Win32_Printer / WMI 详情
  | 'jobs' // 打印队列任务
  | 'ports' // Get-PrinterPort
  | 'drivers' // 已安装驱动匹配
  | 'spooler' // spooler 服务状态
  | 'spoolDir' // spool 目录 .spl/.shd 残留
  | 'events' // 事件日志
  | 'tcpProbe' // TCP 端口连通探测
  | 'printConfig' // DEVMODE 打印配置

/**
 * VERIFY 依赖映射（编译期保证——每条规则依赖的采集段）。
 * Record<FindingCode, ...> 强制 15 键齐全；DiagnosticSectionName[] 锁段名值域。
 * T5 规则执行前按此校验快照段完备性；T3 某段采集失败时按此决定哪些规则降级。
 */
export const RULE_DEPENDS_ON: Record<FindingCode, DiagnosticSectionName[]> = {
  'spooler-stopped': ['spooler'],
  'jobs-stuck-error': ['jobs'],
  'jobs-stuck-deleting': ['jobs', 'spoolDir'],
  'port-wsd-instability': ['ports'],
  'snmp-false-offline': ['printers', 'ports', 'tcpProbe'],
  'driver-missing': ['wmi', 'drivers'],
  'driver-crash-loop': ['events', 'drivers'],
  'raw-garbled-risk': ['wmi', 'drivers'],
  'cloud-printer-raw-utf8': ['wmi', 'drivers'],
  'driver-page-size-ignored': ['printConfig'],
  'printable-area-clip': ['printConfig'],
  // 依赖 T7 renderSnapshot（renderer 侧注入，非 PS 采集段——空依赖合法）
  'logo-measurement-race': [],
  'printer-offline-flag': ['printers'],
  'queue-paused': ['printers'],
  'printer-name-mismatch': ['printers']
}
