/**
 * 打印诊断规则引擎（printer-diagnostics 计划 Wave 3 / T5）。
 *
 * analyzeSnapshot(snapshot) → Finding[]：15 条规则按 RULE_DEPENDS_ON 声明的
 * 依赖段做前置守卫——任一依赖段采集失败（记入 snapshot.errors）即跳过该规则
 * （缺数据不产结论）；spooler-stopped 命中时抑制 jobs-stuck-error /
 * jobs-stuck-deleting（服务停机下的队列状态无意义，重启后自然失效）。
 *
 * 设计红线（T5 规格锁定）：
 * - 零 I/O / 零副作用 / 不解析本地化消息文本——纯 Node 环境全测；
 * - 只产 schema 的 15 个 FindingCode、只引用 9 个 RepairActionId；
 * - evidence 为结构化字段路径引用（如 `printers['X'].driver.rawOnlyBit=false`），
 *   报告导出（T8）与人审按 evidence 直接定位数据源；
 * - 未命中的规则不产出（不产 pass 占位 Finding——status:'pass' 契约上不出现）。
 */
import { RULE_DEPENDS_ON } from './schema'
import type {
  Finding,
  FindingCode,
  PrintDiagnosticSnapshot,
  PrinterDiagnostic,
  RepairActionId
} from './schema'

/** 云打印机固件名单（RAW 被固件按 UTF-8 文本解释的机型；子串匹配，大小写不敏感） */
export const CLOUD_PRINTER_MODELS: readonly string[] = ['DL-5801PW']

/** 崩溃环关注的打印子系统进程名（faultingApp 小写前缀匹配，如 spoolsv.exe） */
const CRASHING_PRINT_APPS: readonly string[] = ['spoolsv', 'printisolationhost', 'splwow64']

/** 模板纸宽规格 → 微米（app.settings.templatePaperWidth 的比对基准） */
const TEMPLATE_WIDTH_MICRONS: Readonly<Record<string, number>> = {
  '80mm': 80000,
  '58mm': 58000
}

/** 打印任务 statusMask 位定义（Windows JOB_STATUS：2=Error，4=Deleting） */
const JOB_ERROR_BIT = 2
const JOB_DELETING_BIT = 4

/** 阈值常量（T5 规格锁定） */
const LOGO_RACE_DELTA_PX = 50 // logo-measurement-race：解码前后高度差(px)
const NEAR_NAME_PREFIX_MIN = 3 // printer-name-mismatch：近似名最小公共前缀(字符)
const WIDTH_TOLERANCE = 1000 // driver-page-size-ignored：页宽偏差容差(μm)
const CLIP_DEFICIT = 4000 // printable-area-clip：纸宽缺口阈值(μm)

// ══════════════ 内部小工具（纯函数） ══════════════

/** evidence 用的结构化字段路径前缀：printers['<name>'] */
function ref(p: PrinterDiagnostic): string {
  return `printers['${p.name}']`
}

/** 目标打印机（settings.printerName 精确匹配；无匹配返回 undefined） */
function findTarget(s: PrintDiagnosticSnapshot): PrinterDiagnostic | undefined {
  return s.printers.find((p) => p.name === s.app.settings.printerName)
}

/** 按打印机名查 DEVMODE 打印配置（printConfig 段） */
function findPrintConfig(s: PrintDiagnosticSnapshot, printerName: string) {
  return s.system.printConfigs.find((c) => c.printerName === printerName)
}

/** 模板宽（μm）；规格外纸宽（如 'A4'）返回 undefined——调用方按缺数据跳过 */
function templateWidthMicrons(s: PrintDiagnosticSnapshot): number | undefined {
  return TEMPLATE_WIDTH_MICRONS[s.app.settings.templatePaperWidth]
}

/** 两字符串最长公共前缀长度（大小写不敏感——Windows 打印机名不区分大小写） */
function commonPrefixLen(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i
}

/** snmp-false-offline 的命中条件（printer-offline-flag 借它做排除项） */
function isSnmpFalseOffline(p: PrinterDiagnostic): boolean {
  return (
    (p.port.type === 'tcp-raw' || p.port.type === 'tcp-lpr') &&
    p.port.reachable === true &&
    p.status.state === 'offline' &&
    p.port.snmpEnabled === true
  )
}

/** 目标机命中云打印机名单（name / driver.name / manufacturer 任一子串匹配） */
function matchCloudModel(p: PrinterDiagnostic): string | null {
  for (const model of CLOUD_PRINTER_MODELS) {
    const needle = model.toLowerCase()
    const haystacks = [p.name, p.driver.name, p.driver.manufacturer ?? '']
    if (haystacks.some((h) => h.toLowerCase().includes(needle))) return model
  }
  return null
}

// ══════════════ 规则引擎入口 ══════════════

/**
 * 快照 → findings（15 条规则，按固定顺序产出；纯函数）。
 * 命中产 Finding，未命中不产出；status 默认 'pending'（needs-dev 规则除外）。
 */
export function analyzeSnapshot(s: PrintDiagnosticSnapshot): Finding[] {
  const findings: Finding[] = []

  /** 段可用性守卫：规则的任一依赖段 ∈ snapshot.errors → 跳过该规则 */
  const depsFailed = (code: FindingCode): boolean =>
    RULE_DEPENDS_ON[code].some((sec) => Object.prototype.hasOwnProperty.call(s.errors, sec))

  // ── R1 spooler-stopped（critical 阻断层；命中后抑制 R2/R3） ──
  const spoolerStopped = !depsFailed('spooler-stopped') && s.system.spooler.status !== 'Running'
  if (spoolerStopped) {
    findings.push({
      code: 'spooler-stopped',
      severity: 'critical',
      scope: 'machine',
      evidence: `system.spooler.status='${s.system.spooler.status}'`,
      suggestedActions: ['PURGE_QUEUE_RESTART_SPOOLER'],
      status: 'pending',
      description: `打印后台处理服务（Print Spooler）未运行（当前状态「${s.system.spooler.status}」）——所有打印任务都无法提交，队列操作也会报错。需重启打印服务并清空队列后重试。`
    })
  }

  // ── R2/R3 队列滞留（抑制：spooler-stopped 命中时队列状态无意义） ──
  if (!spoolerStopped) {
    for (const p of s.printers) {
      // R2 jobs-stuck-error：本人错误任务滞留（他人任务仅追加提权清理动作）
      if (!depsFailed('jobs-stuck-error')) {
        const ownErrorIdx = p.jobs.findIndex(
          (j) => (j.statusMask & JOB_ERROR_BIT) !== 0 && j.isOwnedByCurrentUser
        )
        if (ownErrorIdx >= 0) {
          const othersError = p.jobs.filter(
            (j) => (j.statusMask & JOB_ERROR_BIT) !== 0 && !j.isOwnedByCurrentUser
          )
          const actions: RepairActionId[] = ['CANCEL_ERROR_JOBS']
          if (othersError.length > 0) actions.push('PURGE_QUEUE_RESTART_SPOOLER')
          findings.push({
            code: 'jobs-stuck-error',
            severity: 'high',
            scope: 'printer',
            printerName: p.name,
            evidence: `${ref(p)}.jobs[${ownErrorIdx}].statusMask & 0x2（owner='${p.jobs[ownErrorIdx].owner}'）`,
            suggestedActions: actions,
            status: 'pending',
            description: `「${p.name}」的打印队列中有错误状态的任务滞留（属于当前用户），后续任务可能被阻塞。可先取消本人的错误任务${
              othersError.length > 0 ? '；队列中另有他人的错误任务，彻底恢复需提权清空队列并重启打印服务' : ''
            }。`
          })
        }
      }

      // R3 jobs-stuck-deleting：删除中任务卡死，或残留 .shd 临时文件
      if (!depsFailed('jobs-stuck-deleting')) {
        const deletingIdx = p.jobs.findIndex((j) => (j.statusMask & JOB_DELETING_BIT) !== 0)
        const shdLeft = p.queue.spoolFiles.shd > 0
        if (deletingIdx >= 0 || shdLeft) {
          findings.push({
            code: 'jobs-stuck-deleting',
            severity: 'high',
            scope: 'printer',
            printerName: p.name,
            evidence:
              deletingIdx >= 0
                ? `${ref(p)}.jobs[${deletingIdx}].statusMask & 0x4`
                : `${ref(p)}.queue.spoolFiles.shd=${p.queue.spoolFiles.shd}`,
            suggestedActions: ['PURGE_QUEUE_RESTART_SPOOLER'],
            status: 'pending',
            description: `「${p.name}」的队列中有任务卡在「正在删除」状态${
              shdLeft ? `，且 spool 目录残留 ${p.queue.spoolFiles.shd} 个 .shd 临时文件` : ''
            }——队列可能被卡死，普通取消无效。需停止打印服务、清空队列残留文件后重启服务。`
          })
        }
      }
    }
  }

  // ── R4-R6 逐台打印机的端口/状态/驱动规则 ──
  for (const p of s.printers) {
    // R4 port-wsd-instability：WSD 端口 + 离线（WSD 不稳定是既定背景结论）
    if (!depsFailed('port-wsd-instability')) {
      if (p.port.type === 'wsd' && p.status.state === 'offline') {
        findings.push({
          code: 'port-wsd-instability',
          severity: 'medium',
          scope: 'printer',
          printerName: p.name,
          evidence: `${ref(p)}.port.type='wsd', ${ref(p)}.status.state='offline'`,
          suggestedActions: ['MIGRATE_WSD_TO_TCP'],
          status: 'pending',
          description: `「${p.name}」使用 WSD 端口且当前离线——WSD 端口在 Windows 上以不稳定著称（任务丢失/随机掉线）。建议迁移为标准 TCP/IP 端口（厂商固定 IP + 9100 端口）。`
        })
      }
    }

    // R5 snmp-false-offline：TCP 口实际可达 + SNMP 开启 → 状态误报
    if (!depsFailed('snmp-false-offline')) {
      if (isSnmpFalseOffline(p)) {
        findings.push({
          code: 'snmp-false-offline',
          severity: 'medium',
          scope: 'printer',
          printerName: p.name,
          evidence: `${ref(p)}.port.reachable=true, ${ref(p)}.port.snmpEnabled=true, ${ref(p)}.status.state='offline'`,
          suggestedActions: ['DISABLE_SNMP'],
          status: 'pending',
          description: `「${p.name}」显示脱机，但网络探测其端口（${p.port.hostAddress ?? ''}${
            p.port.portNumber ? `:${p.port.portNumber}` : ''
          }）实际可达且 SNMP 状态监测已启用——高度疑似 SNMP 误报离线。禁用该端口的 SNMP 状态监测后即可恢复在线。`
        })
      }
    }

    // R6 driver-missing：驱动与已安装驱动不匹配
    if (!depsFailed('driver-missing')) {
      if (p.driver.matchesInstalled === false) {
        findings.push({
          code: 'driver-missing',
          severity: 'high',
          scope: 'printer',
          printerName: p.name,
          evidence: `${ref(p)}.driver.matchesInstalled=false`,
          suggestedActions: ['REINSTALL_DRIVER_GUIDE'],
          status: 'pending',
          description: `「${p.name}」的驱动（${p.driver.name}）与系统已安装的驱动不匹配或已丢失——任务会被静默丢弃或报错。需按引导重装打印机驱动。`
        })
      }
    }
  }

  // ── R7 driver-crash-loop（machine 级；空遥测守卫：无 1000 事件不产结论） ──
  if (!depsFailed('driver-crash-loop')) {
    const crashIdx = s.system.eventLog.app1000Events.findIndex(
      (e) =>
        CRASHING_PRINT_APPS.some((app) => e.faultingApp.toLowerCase().startsWith(app)) &&
        e.faultingModule !== '' &&
        e.faultingModule.toLowerCase() !== 'unknown'
    )
    if (s.system.eventLog.app1000Events.length > 0 && crashIdx >= 0) {
      const entry = s.system.eventLog.app1000Events[crashIdx]
      findings.push({
        code: 'driver-crash-loop',
        severity: 'high',
        scope: 'machine',
        evidence: `system.eventLog.app1000Events[${crashIdx}].faultingApp='${entry.faultingApp}', faultingModule='${entry.faultingModule}'`,
        suggestedActions: ['REINSTALL_DRIVER_GUIDE'],
        status: 'pending',
        description: `事件日志中存在打印子系统进程崩溃记录（${entry.faultingApp}，故障模块 ${entry.faultingModule}）——驱动 DLL 反复崩溃会形成「一打印就崩」的循环，需按引导重装驱动。`
      })
    }
  }

  // ── R8-R11 仅目标打印机（settings.printerName 精确匹配；无匹配不产结论） ──
  const target = findTarget(s)
  if (target) {
    const settings = s.app.settings

    // R8 raw-garbled-risk：spooler RAW 通道 + 驱动会解释 RAW 字节（乱码风险）
    if (!depsFailed('raw-garbled-risk')) {
      if (
        settings.channel === 'spooler' &&
        target.driver.rawOnlyBit === false &&
        target.driver.printProcessor?.toLowerCase() === 'winprint' &&
        !target.driver.name.toLowerCase().includes('generic')
      ) {
        findings.push({
          code: 'raw-garbled-risk',
          severity: 'medium',
          scope: 'printer',
          printerName: target.name,
          evidence: `${ref(target)}.driver.rawOnlyBit=false, ${ref(target)}.driver.printProcessor='${target.driver.printProcessor}'`,
          suggestedActions: ['GENERIC_TEXT_ONLY_GUIDE'],
          status: 'pending',
          description: `当前使用 spooler RAW 通道，但目标打印机「${target.name}」的驱动（${target.driver.name}，WINPRINT 处理器）会尝试解释 RAW 字节而非原样透传——小票可能出现乱码或版面异常。按引导改装 Generic / Text Only 驱动可恢复纯透传。`
        })
      }
    }

    // R9 cloud-printer-raw-utf8：云固件把 RAW 当 UTF-8（GBK 中文与光栅全丢）
    if (!depsFailed('cloud-printer-raw-utf8')) {
      const cloudModel = matchCloudModel(target)
      const processorPath =
        target.driver.printProcessor !== null &&
        target.driver.printProcessor.toLowerCase() !== 'winprint' &&
        target.driver.rawOnlyBit === false &&
        target.port.type === 'tcp-raw'
      if (settings.channel === 'spooler' && (cloudModel !== null || processorPath)) {
        findings.push({
          code: 'cloud-printer-raw-utf8',
          severity: 'high',
          scope: 'printer',
          printerName: target.name,
          evidence:
            cloudModel !== null
              ? `${ref(target)} 命中云固件名单 '${cloudModel}'（name/driver/manufacturer 子串匹配）`
              : `${ref(target)}.driver.printProcessor='${target.driver.printProcessor}', ${ref(target)}.port.type='tcp-raw'`,
          suggestedActions: ['SWITCH_TO_DRIVER_CHANNEL'],
          status: 'pending',
          description: `目标打印机「${target.name}」疑似云固件机型${
            cloudModel !== null ? `（命中名单 ${cloudModel}）` : ''
          }：RAW 字节流会被固件按 UTF-8 文本解释，GBK 中文与 ESC/POS 光栅指令全部丢失或乱码。请切换到 driver 渲染通道（由应用渲染完整版面后交驱动输出）。`
        })
      }
    }

    // R10/R11 driver 通道页宽比对（前提：printConfig 存在 + 模板宽已知）
    if (!depsFailed('driver-page-size-ignored') || !depsFailed('printable-area-clip')) {
      const config = findPrintConfig(s, target.name)
      const templateWidth = templateWidthMicrons(s)
      if (settings.channel === 'driver' && config && config.widthMicrons !== null && templateWidth !== undefined) {
        const diff = Math.abs(config.widthMicrons - templateWidth)
        // R10 driver-page-size-ignored：DEVMODE 纸宽 ≠ 模板宽（驱动忽略页宽设置）
        if (!depsFailed('driver-page-size-ignored') && diff > WIDTH_TOLERANCE) {
          findings.push({
            code: 'driver-page-size-ignored',
            severity: 'high',
            scope: 'printer',
            printerName: target.name,
            evidence: `system.printConfigs['${target.name}'].widthMicrons=${config.widthMicrons}（模板 '${settings.templatePaperWidth}'=${templateWidth}）`,
            suggestedActions: ['SWITCH_TO_SPOOLER_CHANNEL', 'REINSTALL_DRIVER_GUIDE'],
            status: 'needs-dev',
            description: `driver 通道下「${target.name}」的实际纸张宽度为 ${config.widthMicrons}μm，与模板 ${settings.templatePaperWidth}（${templateWidth}μm）偏差 ${diff}μm——驱动忽略了应用下发的自定义页宽，版面按错误纸宽排布。可切回 spooler 通道规避，根治需排查驱动页宽协商（需开发介入）。`
          })
          // R11 printable-area-clip：实际纸宽比模板窄超 4mm → 内容被裁切
          if (!depsFailed('printable-area-clip') && config.widthMicrons < templateWidth - CLIP_DEFICIT) {
            findings.push({
              code: 'printable-area-clip',
              severity: 'medium',
              scope: 'printer',
              printerName: target.name,
              evidence: `system.printConfigs['${target.name}'].widthMicrons=${config.widthMicrons} < 模板宽 ${templateWidth} - ${CLIP_DEFICIT}`,
              suggestedActions: [],
              status: 'needs-dev',
              description: `「${target.name}」的实际纸宽（${config.widthMicrons}μm）比模板（${templateWidth}μm）窄超过 4mm——内容超出可打印区域会被裁切（右侧缺失）。需按实际纸宽调整模板（需开发介入）。`
            })
          }
        }
      }
    }
  }

  // ── R12 logo-measurement-race（appConfig 级；依赖 renderSnapshot，无 PS 段依赖） ──
  if (s.renderSnapshot && s.renderSnapshot.heightDelta > LOGO_RACE_DELTA_PX) {
    findings.push({
      code: 'logo-measurement-race',
      severity: 'high',
      scope: 'appConfig',
      evidence: `renderSnapshot.heightDelta=${s.renderSnapshot.heightDelta}`,
      suggestedActions: [],
      status: 'needs-dev',
      description: `渲染自检发现 Logo 尺寸测量竞态：图片解码完成前后内容高度相差 ${s.renderSnapshot.heightDelta}px（阈值 ${LOGO_RACE_DELTA_PX}px）——小票高度在 Logo 加载完成前计算，分页与切纸位置会错位（需开发介入）。`
    })
  }

  // ── R13/R14 逐台状态规则 ──
  for (const p of s.printers) {
    // R13 printer-offline-flag：脱机标志置位（排除 WSD/SNMP 误报/驱动缺失等已归因项）
    if (!depsFailed('printer-offline-flag')) {
      if (
        p.status.state === 'offline' &&
        p.driver.matchesInstalled !== false &&
        p.port.type !== 'wsd' &&
        !isSnmpFalseOffline(p)
      ) {
        findings.push({
          code: 'printer-offline-flag',
          severity: 'medium',
          scope: 'printer',
          printerName: p.name,
          evidence: `${ref(p)}.status.state='offline'`,
          suggestedActions: [],
          status: 'pending',
          description: `「${p.name}」被标记为脱机。请检查打印机电源/联机/USB 连接与「脱机使用打印机」复选框。`
        })
      }
    }

    // R14 queue-paused：队列暂停
    if (!depsFailed('queue-paused')) {
      if (p.status.state === 'paused') {
        findings.push({
          code: 'queue-paused',
          severity: 'medium',
          scope: 'printer',
          printerName: p.name,
          evidence: `${ref(p)}.status.state='paused'`,
          suggestedActions: [],
          status: 'pending',
          description: `「${p.name}」的打印队列被暂停，任务会持续积压不打印。恢复步骤：控制面板 → 设备和打印机 → 右键该打印机 → 取消勾选「暂停打印」。`
        })
      }
    }
  }

  // ── R15 printer-name-mismatch：设置的打印机名在系统中不存在（appConfig 级） ──
  if (!depsFailed('printer-name-mismatch')) {
    const wanted = s.app.settings.printerName
    if (wanted !== '' && !s.printers.some((p) => p.name === wanted)) {
      const nearNames = s.printers
        .filter((p) => commonPrefixLen(wanted, p.name) >= NEAR_NAME_PREFIX_MIN)
        .map((p) => p.name)
      findings.push({
        code: 'printer-name-mismatch',
        severity: 'high',
        scope: 'appConfig',
        evidence: `app.settings.printerName='${wanted}' ∉ printers[].name`,
        suggestedActions: [],
        status: 'pending',
        description:
          `设置的打印机「${wanted}」在系统中不存在` +
          (nearNames.length > 0
            ? `。系统中有近似名称的打印机：「${nearNames.join('」「')}」——可能是驱动重装或系统迁移后名称变化，请在设置中重新选择打印机。`
            : '，且未找到近似名称——打印机可能已被删除或未安装，请在设置中重新选择。')
      })
    }
  }

  return findings
}
