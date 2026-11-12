/**
 * 打印诊断编排服务（printer-diagnostics 计划 Wave 4 / T9）——全子系统的行为核心。
 *
 * COLLECT → ANALYZE → L1 先行 → VERIFY 闭环在此收口：
 *  1. 防重入：service 实例闭包内 in-flight 标记（diagnose 与 repair 共用一把锁——
 *     修复期间不能再诊断，反之亦然）；
 *  2. busy 门禁：printQueueBusy() 为 true 时采集仍可进行（只读），但 L1 修复动作
 *     跳过执行（记 pending + 描述注明）；repair 则整体拒绝（修复会中断在途任务）；
 *  3. collect → render-check 合成（channel=driver 或模板含 logo 时；T7 超时 reject
 *     由本层 try/catch 消化，只记 snapshot.errors.renderCheck，不阻塞诊断）；
 *  4. analyze → L1 先行（仅 CANCEL_ERROR_JOBS，无提权；失败不阻塞报告）；
 *  5. VERIFY（仅一轮重采）：L1 实际执行过时再 collect 一次 + 重跑 analyze，比对
 *     该 code 是否仍命中——不命中 → verify-passed；仍命中 → escalated；
 *  6. 组装 DiagnosticReport → archive → 返回。
 *
 * 红线（计划 MUST NOT）：
 *  - 本模块**零 electron 依赖**（全 DI——vitest 纯 Node 可测）；生产装配
 *    （createDefaultDeps）在 ipc 薄层（diagnostics.ipc.ts）；
 *  - diagnose 返回前不得执行任何提权动作（L1 仅 CANCEL_ERROR_JOBS）；
 *  - VERIFY 只重采一轮（不循环）；L1/VERIFY 失败不阻塞报告返回；
 *  - 只读消费 T1-T8 产物（schema/analyze/repair.runner/report.exporter），不改它们。
 */

import { toTxtBuffer } from './report.exporter'
import { runRepairAction } from './repair.runner'
import type { RepairOutcome } from './repair.runner'
import type {
  DiagnosticReport,
  Finding,
  PrintDiagnosticSnapshot,
  RepairActionId,
  RenderSnapshot
} from './schema'

// ══════════════ 依赖契约（全 DI） ══════════════

/**
 * 编排服务依赖（vitest 全 fake 注入；生产默认见 diagnostics.ipc.createDefaultDeps）。
 * runRepair 类型即 repair.runner.runRepairAction（SWITCH_* 需要 setChannel 时由
 * 生产装配包装注入）。
 */
export interface DiagnoseServiceDeps {
  /** 采集（默认 runCollect 包装；printerName 为预留聚焦参数） */
  collect: (opts?: { printerName?: string }) => Promise<PrintDiagnosticSnapshot>
  /** 规则引擎（默认 analyzeSnapshot） */
  analyze: (s: PrintDiagnosticSnapshot) => Finding[]
  /** 修复动作执行器（默认 repair.runner 包装——setChannel 由装配层注入） */
  runRepair: typeof runRepairAction
  /** 渲染自检（默认 runRenderCheck 包装；失败由本层 try/catch 消化） */
  renderCheck: (html: string, paperWidthPx: number) => Promise<RenderSnapshot>
  /** 收据 HTML 合成（默认：默认模板 + 样本数据 + logos → generateReceiptHtml；拿不到 → null 跳过） */
  buildHtml: () => { html: string; paperWidthPx: number } | null
  /** 当前打印设置视图（render-check 触发条件 + 生产 collect appInfo 原料） */
  settingsGetter: () => {
    channel: string
    printerName: string
    templatePaperWidth: string
    currentUserName: string
  }
  /** 打印串行队列 busy 查询（true 时 L1 跳过 / repair 拒绝） */
  printQueueBusy: () => boolean
  /** 报告归档（默认 archiveHistory 包装） */
  archive: (report: DiagnosticReport) => void
  /** 报告导出链（默认 export.service 同款 dialog→write→reveal；null = 用户取消） */
  exportFn: (fileName: string, data: Buffer) => Promise<string | null>
  /**
   * 平台前置守卫（可选）：**显式注入且非 win32 时** diagnose/repair 直接 reject；
   * 缺省不拦截——平台守卫的主责在底层 runner（runCollect/runRepairAction 自带
   * process.platform 检查），此为生产装配（注入 process.platform）的提前出口。
   */
  platform?: NodeJS.Platform
}

/** 编排服务（diagnose / repair / exportReport 三入口） */
export interface DiagnoseService {
  diagnose(printerName?: string): Promise<DiagnosticReport>
  repair(
    actionId: RepairActionId,
    targetPrinter?: string
  ): Promise<{ outcome: RepairOutcome; verify?: DiagnosticReport }>
  exportReport(report: DiagnosticReport): Promise<{ ok: boolean; filePath?: string; error?: string }>
}

// ══════════════ 小工具 ══════════════

function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** collectedAt（ISO）→ 本地时间戳 yyyyMMdd-HHmmss（导出文件名；无效输入回落当前时刻） */
function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return formatStamp(new Date().toISOString())
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(
    d.getMinutes()
  )}${p2(d.getSeconds())}`
}

// ══════════════ 编排实现 ══════════════

export function createDiagnoseService(deps: DiagnoseServiceDeps): DiagnoseService {
  // 防重入标记：diagnose 与 repair 共用（service 实例级——ipc 装配一次即全进程一把锁）
  let inFlight = false

  /** 平台前置守卫：仅显式注入 platform 且非 win32 时拦截（见 DiagnoseServiceDeps.platform 注释） */
  const guardPlatform = (): void => {
    if (deps.platform !== undefined && deps.platform !== 'win32') {
      throw new Error(`打印机诊断仅 Windows 可用（当前平台：${deps.platform}）`)
    }
  }

  /** 进入排他区（重入 → 中文可诊断错误） */
  const beginRun = (): void => {
    if (inFlight) throw new Error('打印机诊断正在进行中，请稍候')
    inFlight = true
  }

  /** report 组装（renderSnapshot 提顶层——与 snapshot.renderSnapshot 同源） */
  const assembleReport = (
    collectedAt: string,
    snapshot: PrintDiagnosticSnapshot,
    findings: Finding[]
  ): DiagnosticReport => {
    const report: DiagnosticReport = { schemaVersion: 1, collectedAt, snapshot, findings }
    if (snapshot.renderSnapshot !== undefined) report.renderSnapshot = snapshot.renderSnapshot
    return report
  }

  async function diagnose(printerName?: string): Promise<DiagnosticReport> {
    guardPlatform()
    beginRun()
    try {
      // busy 只挡修复不挡采集（采集是只读的，信息仍有价值）——读一次，供 L1 门禁用
      const busy = deps.printQueueBusy()

      // ── COLLECT ──
      const snapshot = await deps.collect(printerName !== undefined ? { printerName } : undefined)
      const collectedAt = new Date().toISOString()

      // ── render-check 合成（T7：超时/基础设施失败 reject → 只记 errors，不阻塞）──
      try {
        const settings = deps.settingsGetter()
        if (settings.channel === 'driver' || snapshot.app.templateFacts.hasLogo) {
          const built = deps.buildHtml()
          if (built !== null) {
            snapshot.renderSnapshot = await deps.renderCheck(built.html, built.paperWidthPx)
          }
        }
      } catch (e) {
        snapshot.errors['renderCheck'] = `渲染自检失败（不阻塞诊断）：${errorDetail(e)}`
      }

      // ── ANALYZE ──
      const findings = deps.analyze(snapshot)

      // ── L1 先行（仅 CANCEL_ERROR_JOBS——无提权；needs-dev 等终态不参与）──
      const l1Candidates = findings.filter(
        (f) => f.status === 'pending' && f.suggestedActions.includes('CANCEL_ERROR_JOBS')
      )
      let anyAutoFixed = false
      for (const finding of l1Candidates) {
        if (busy) {
          finding.description += '（有打印任务进行中，完成后重跑诊断）'
          continue
        }
        try {
          await deps.runRepair('CANCEL_ERROR_JOBS', { targetPrinter: finding.printerName })
          finding.status = 'auto-fixed'
          anyAutoFixed = true
        } catch (e) {
          // L1 失败不阻塞报告：保持 pending，描述追加失败原因
          finding.description += `（自动修复失败：${errorDetail(e)}）`
        }
      }

      // ── VERIFY（仅一轮重采；从简判定 = 重 collect + 重 analyze 后该 code 是否仍命中）──
      if (anyAutoFixed) {
        try {
          const verifySnapshot =
            await deps.collect(printerName !== undefined ? { printerName } : undefined)
          const verifyFindings = deps.analyze(verifySnapshot)
          for (const finding of findings) {
            if (finding.status !== 'auto-fixed') continue
            const stillHit = verifyFindings.some(
              (vf) =>
                vf.code === finding.code && (vf.printerName ?? '') === (finding.printerName ?? '')
            )
            if (stillHit) {
              finding.status = 'escalated'
              finding.description += '（自动修复未消除问题，建议人工处理）'
            } else {
              finding.status = 'verify-passed'
            }
          }
        } catch (e) {
          // 复核失败不阻塞报告：保持 auto-fixed，描述注明复核未完成
          for (const finding of findings) {
            if (finding.status === 'auto-fixed') {
              finding.description += `（复核采集失败：${errorDetail(e)}）`
            }
          }
        }
      }

      // ── 组装 + 归档 + 返回 ──
      const report = assembleReport(collectedAt, snapshot, findings)
      deps.archive(report)
      return report
    } finally {
      inFlight = false
    }
  }

  async function repair(
    actionId: RepairActionId,
    targetPrinter?: string
  ): Promise<{ outcome: RepairOutcome; verify?: DiagnosticReport }> {
    guardPlatform()
    beginRun() // 与 diagnose 共用 in-flight——修复期间不能再诊断
    try {
      if (deps.printQueueBusy()) {
        throw new Error('有打印任务进行中，修复将中断它们——请等待打印完成后再修复')
      }
      const outcome = await deps.runRepair(actionId, { targetPrinter })
      // needs-manual / dry-run 不复核（UAC 拒绝非故障；预览无系统改动）
      if (outcome.status !== 'done') return { outcome }
      // VERIFY：重新 collect + analyze 一次 → 新报告（不归档——历史由完整诊断负责）
      const snapshot = await deps.collect()
      const findings = deps.analyze(snapshot)
      return { outcome, verify: assembleReport(new Date().toISOString(), snapshot, findings) }
    } finally {
      inFlight = false
    }
  }

  async function exportReport(
    report: DiagnosticReport
  ): Promise<{ ok: boolean; filePath?: string; error?: string }> {
    try {
      const data = toTxtBuffer(report) // 内部 buildReportTxt → \n→\r\n + BOM（T8 契约）
      const fileName = `打印机诊断报告-${formatStamp(report.collectedAt)}.txt`
      const filePath = await deps.exportFn(fileName, data)
      // 用户取消 = ok:true 无 filePath（从简：取消不是错误，不弹报错）
      if (filePath === null) return { ok: true }
      return { ok: true, filePath }
    } catch (e) {
      return { ok: false, error: errorDetail(e) }
    }
  }

  return { diagnose, repair, exportReport }
}
