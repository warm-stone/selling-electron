import { describe, expect, it } from 'vitest'
import { analyzeSnapshot } from '../../../../src/main/printing/diagnostics/analyze'
import {
  createDiagnoseService,
  type DiagnoseServiceDeps
} from '../../../../src/main/printing/diagnostics/diagnose.service'
import type {
  RepairActionContext,
  RepairOutcome
} from '../../../../src/main/printing/diagnostics/repair.runner'
import type {
  DiagnosticReport,
  PrintDiagnosticSnapshot,
  RepairActionId,
  RenderSnapshot
} from '../../../../src/main/printing/diagnostics/schema'
import { FIXTURES } from './fixtures/index'

/**
 * printer-diagnostics T9 编排服务：COLLECT → ANALYZE → L1 先行 → VERIFY 闭环的行为锁。
 *
 * fake deps 全注入（collect/renderCheck/runRepair/exportFn 可编程）+ **真实 analyzeSnapshot**
 * （L1 过滤条件「suggestedActions 含 CANCEL_ERROR_JOBS 且 pending」由真实规则引擎产出，
 * 编排与规则两层同时被锁）；快照底座 = healthy-machine fixture 深拷贝 + 合成错误任务
 * （T5 合成样本策略——零新建 JSON 文件）。
 */

const ERROR_JOB_PRINTER = 'POS-80'

/** fixture 深拷贝（service 会原地挂 renderSnapshot / 写 errors——共享引用会跨用例污染） */
function cloneHealthy(): PrintDiagnosticSnapshot {
  return JSON.parse(JSON.stringify(FIXTURES['healthy-machine'])) as PrintDiagnosticSnapshot
}

/** 合成快照：目标机 1 条本人错误任务（statusMask 位 2 = Error）→ 真实 analyze 命中 jobs-stuck-error */
function snapshotWithErrorJob(): PrintDiagnosticSnapshot {
  const base = cloneHealthy()
  const p = base.printers[0]!
  return {
    ...base,
    app: {
      ...base.app,
      settings: { ...base.app.settings, printerName: ERROR_JOB_PRINTER },
      // hasLogo=true 触发 render-check 合成路径（编排时序断言需要）
      templateFacts: { ...base.app.templateFacts, hasLogo: true }
    },
    printers: [
      {
        ...p,
        name: ERROR_JOB_PRINTER,
        jobs: [{ document: '滞留的错误任务', owner: 'SHOPPC\\shop', statusMask: 2, isOwnedByCurrentUser: true }],
        queue: { ...p.queue, jobCount: 1, errorJobs: 1 }
      },
      ...base.printers.slice(1)
    ]
  }
}

/** 合成快照：错误任务已清除（VERIFY 通过 / busy 场景的「采集照常」底座） */
function healthySnapshot(): PrintDiagnosticSnapshot {
  const base = cloneHealthy()
  return {
    ...base,
    app: { ...base.app, settings: { ...base.app.settings, printerName: ERROR_JOB_PRINTER } }
  }
}

/** render-check 假产物（heightDelta=0——不触发 logo-measurement-race，保持 findings 单一） */
const RENDER_SNAPSHOT: RenderSnapshot = {
  immediatelyMeasured: 800,
  afterImgDecode: 800,
  heightDelta: 0,
  scrollWidth: 307,
  paperWidthPx: 307,
  horizontalOverflow: false,
  dpr: 1
}

interface HarnessOptions {
  /** collect 按调用序弹出的快照队列；耗尽后回落 healthySnapshot */
  snapshots?: PrintDiagnosticSnapshot[]
  /** printQueueBusy 返回值（默认 false） */
  busy?: () => boolean
  /** settingsGetter 的 channel（默认 'spooler'——render-check 条件的另一臂走 hasLogo） */
  channel?: string
  /** runRepair 行为注入（默认 resolve done） */
  repair?: (actionId: RepairActionId, ctx: RepairActionContext) => Promise<RepairOutcome>
  /** renderCheck 行为注入（默认 resolve RENDER_SNAPSHOT） */
  renderCheck?: (html: string, paperWidthPx: number) => Promise<RenderSnapshot>
  /** buildHtml 行为注入（默认 resolve 样本 html） */
  buildHtml?: () => { html: string; paperWidthPx: number } | null
}

function makeHarness(options: HarnessOptions = {}) {
  const calls: string[] = []
  const archived: DiagnosticReport[] = []
  const repairCalls: Array<{ actionId: RepairActionId; targetPrinter?: string }> = []
  const queue = options.snapshots ?? [snapshotWithErrorJob()]

  const deps: DiagnoseServiceDeps = {
    collect: async (opts) => {
      calls.push(`collect${opts?.printerName !== undefined ? `:${opts.printerName}` : ''}`)
      return queue.length > 0 ? queue.shift()! : healthySnapshot()
    },
    analyze: (s) => {
      calls.push('analyze')
      return analyzeSnapshot(s)
    },
    runRepair: async (actionId, ctx) => {
      repairCalls.push({ actionId, targetPrinter: ctx.targetPrinter })
      calls.push(`runRepair:${actionId}`)
      if (options.repair) return options.repair(actionId, ctx)
      return { status: 'done', detail: '已清除' }
    },
    renderCheck: async (html, paperWidthPx) => {
      calls.push(`renderCheck:${paperWidthPx}`)
      if (options.renderCheck) return options.renderCheck(html, paperWidthPx)
      return { ...RENDER_SNAPSHOT }
    },
    buildHtml: () => {
      calls.push('buildHtml')
      if (options.buildHtml) return options.buildHtml()
      return { html: '<!DOCTYPE html><html><body>sample</body></html>', paperWidthPx: 307 }
    },
    settingsGetter: () => ({
      channel: options.channel ?? 'spooler',
      printerName: ERROR_JOB_PRINTER,
      templatePaperWidth: '80mm',
      currentUserName: 'shop'
    }),
    printQueueBusy: () => options.busy?.() ?? false,
    archive: (report) => {
      calls.push('archive')
      archived.push(report)
    },
    exportFn: async (fileName) => {
      calls.push(`export:${fileName}`)
      return `/tmp/diag-out/${fileName}`
    }
  }
  return { deps, calls, archived, repairCalls }
}

describe('编排服务 diagnose（printer-diagnostics T9）', () => {
  it('编排时序：collect → buildHtml → renderCheck → analyze → L1(CANCEL_ERROR_JOBS) → VERIFY(collect+analyze) → archive；finding verify-passed', async () => {
    const h = makeHarness({ snapshots: [snapshotWithErrorJob(), healthySnapshot()] })
    const report = await createDiagnoseService(h.deps).diagnose()

    expect(h.calls).toEqual([
      'collect',
      'buildHtml',
      'renderCheck:307',
      'analyze',
      'runRepair:CANCEL_ERROR_JOBS',
      'collect',
      'analyze',
      'archive'
    ])
    expect(h.repairCalls).toEqual([{ actionId: 'CANCEL_ERROR_JOBS', targetPrinter: ERROR_JOB_PRINTER }])
    const finding = report.findings.find((f) => f.code === 'jobs-stuck-error')
    expect(finding?.printerName).toBe(ERROR_JOB_PRINTER)
    expect(finding?.status).toBe('verify-passed')
    expect(report.schemaVersion).toBe(1)
    expect(Number.isNaN(Date.parse(report.collectedAt))).toBe(false)
    expect(report.renderSnapshot).toEqual(RENDER_SNAPSHOT)
    expect(report.snapshot.renderSnapshot).toBe(report.renderSnapshot)
    expect(h.archived).toHaveLength(1)
    expect(h.archived[0]).toBe(report)
  })

  it('VERIFY 升级：二次采集仍含错误任务 → escalated + 描述追加人工处理建议', async () => {
    const h = makeHarness({ snapshots: [snapshotWithErrorJob(), snapshotWithErrorJob()] })
    const report = await createDiagnoseService(h.deps).diagnose()
    const finding = report.findings.find((f) => f.code === 'jobs-stuck-error')
    expect(finding?.status).toBe('escalated')
    expect(finding?.description).toContain('自动修复未消除问题，建议人工处理')
    // 只重采一轮——第二次 VERIFY 后不再 collect
    expect(h.calls.filter((c) => c === 'collect')).toHaveLength(2)
  })

  it('L1 失败不阻塞：runRepair 抛错 → finding 仍 pending + 描述含失败原因，报告正常归档返回', async () => {
    const h = makeHarness({
      repair: async () => {
        throw new Error('CANCEL_ERROR_JOBS 执行失败：模拟 execFile 故障')
      }
    })
    const report = await createDiagnoseService(h.deps).diagnose()
    const finding = report.findings.find((f) => f.code === 'jobs-stuck-error')
    expect(finding?.status).toBe('pending')
    expect(finding?.description).toContain('自动修复失败：CANCEL_ERROR_JOBS 执行失败：模拟 execFile 故障')
    expect(h.archived).toHaveLength(1)
    // 无 auto-fixed → VERIFY 不触发（collect 仅首次一次）
    expect(h.calls.filter((c) => c === 'collect')).toHaveLength(1)
  })

  it('VERIFY 采集失败：保持 auto-fixed + 描述注明复核未完成，报告正常返回', async () => {
    const h = makeHarness()
    const innerCollect = h.deps.collect
    let collectCount = 0
    h.deps.collect = async (opts) => {
      collectCount++
      if (collectCount === 2) throw new Error('复核采集超时（模拟）')
      return innerCollect(opts)
    }
    const report = await createDiagnoseService(h.deps).diagnose()
    const finding = report.findings.find((f) => f.code === 'jobs-stuck-error')
    expect(finding?.status).toBe('auto-fixed')
    expect(finding?.description).toContain('复核采集失败：复核采集超时（模拟）')
    expect(h.archived).toHaveLength(1)
  })

  it('防重入：诊断挂起期间 diagnose/repair 重入均拒绝（共用 in-flight）；释放后恢复正常', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = makeHarness()
    const innerCollect = h.deps.collect
    h.deps.collect = async (opts) => {
      await gate
      return innerCollect(opts)
    }
    const service = createDiagnoseService(h.deps)

    const first = service.diagnose()
    await expect(service.diagnose()).rejects.toThrow('打印机诊断正在进行中，请稍候')
    await expect(service.repair('CANCEL_ERROR_JOBS', ERROR_JOB_PRINTER)).rejects.toThrow(
      '打印机诊断正在进行中，请稍候'
    )
    release()
    expect((await first).schemaVersion).toBe(1)
    // 锁已释放：可再次完整诊断（队列耗尽 → healthy 底座）
    expect((await service.diagnose()).schemaVersion).toBe(1)
  })

  it('printQueueBusy=true：采集照常、报告正常返回，但 L1 跳过（runRepair 未被调 + 描述注明重跑）', async () => {
    const h = makeHarness({ busy: () => true })
    const report = await createDiagnoseService(h.deps).diagnose()
    expect(h.repairCalls).toHaveLength(0)
    const finding = report.findings.find((f) => f.code === 'jobs-stuck-error')
    expect(finding?.status).toBe('pending')
    expect(finding?.description).toContain('有打印任务进行中，完成后重跑诊断')
    expect(h.archived).toHaveLength(1)
  })

  it('render-check 失败容错：reject 只记 errors.renderCheck，其余链路（analyze/L1/VERIFY）照常', async () => {
    const h = makeHarness({
      renderCheck: async () => {
        throw new Error('render-check 渲染自检超时（15ms，页面加载或测量流程挂死）')
      }
    })
    const report = await createDiagnoseService(h.deps).diagnose()
    expect(report.snapshot.errors['renderCheck']).toContain('渲染自检失败')
    expect(report.snapshot.errors['renderCheck']).toContain('超时')
    expect(report.renderSnapshot).toBeUndefined()
    expect(report.snapshot.renderSnapshot).toBeUndefined()
    expect(report.findings.find((f) => f.code === 'jobs-stuck-error')?.status).toBe('verify-passed')
  })

  it('render-check 条件：spooler 通道 + 模板无 logo → buildHtml/renderCheck 均不调用', async () => {
    const h = makeHarness({ snapshots: [healthySnapshot()] })
    const report = await createDiagnoseService(h.deps).diagnose()
    expect(h.calls).not.toContain('buildHtml')
    expect(h.calls.some((c) => c.startsWith('renderCheck'))).toBe(false)
    expect(report.renderSnapshot).toBeUndefined()
  })

  it('render-check 条件：driver 通道（即使无 logo）→ 合成路径执行；buildHtml 返回 null → 静默跳过', async () => {
    const h = makeHarness({ channel: 'driver', snapshots: [healthySnapshot()], buildHtml: () => null })
    const report = await createDiagnoseService(h.deps).diagnose()
    expect(h.calls).toContain('buildHtml')
    expect(h.calls.some((c) => c.startsWith('renderCheck'))).toBe(false)
    expect(report.renderSnapshot).toBeUndefined()
  })

  it('platform 显式注入非 win32 → diagnose/repair 前置拒绝（不触任何 dep）', async () => {
    const h = makeHarness()
    const service = createDiagnoseService({ ...h.deps, platform: 'linux' })
    await expect(service.diagnose()).rejects.toThrow('打印机诊断仅 Windows 可用（当前平台：linux）')
    await expect(service.repair('CANCEL_ERROR_JOBS', 'X')).rejects.toThrow('打印机诊断仅 Windows 可用（当前平台：linux）')
    expect(h.calls).toHaveLength(0)
  })
})

describe('编排服务 repair（printer-diagnostics T9）', () => {
  it('done：执行后 collect+analyze 复核一次并返回 verify 报告（verify 不做 L1、不归档）', async () => {
    const h = makeHarness({ snapshots: [snapshotWithErrorJob()] })
    const res = await createDiagnoseService(h.deps).repair('CANCEL_ERROR_JOBS', ERROR_JOB_PRINTER)
    expect(res.outcome.status).toBe('done')
    expect(h.repairCalls).toEqual([{ actionId: 'CANCEL_ERROR_JOBS', targetPrinter: ERROR_JOB_PRINTER }])
    expect(res.verify?.schemaVersion).toBe(1)
    // verify 报告按原始 pending 呈现（复核报告不做 L1——那是 diagnose 的职责）
    expect(res.verify?.findings.find((f) => f.code === 'jobs-stuck-error')?.status).toBe('pending')
    expect(h.calls.filter((c) => c === 'collect')).toHaveLength(1)
    expect(h.calls.filter((c) => c === 'analyze')).toHaveLength(1)
    expect(h.archived).toHaveLength(0)
  })

  it('needs-manual：不复核（UAC 拒绝非故障），无 verify 字段、不触 collect', async () => {
    const h = makeHarness({
      repair: async () => ({ status: 'needs-manual', detail: '用户取消了管理员授权' })
    })
    const res = await createDiagnoseService(h.deps).repair('PURGE_QUEUE_RESTART_SPOOLER')
    expect(res.outcome.status).toBe('needs-manual')
    expect(res.verify).toBeUndefined()
    expect(h.calls.filter((c) => c === 'collect')).toHaveLength(0)
  })

  it('busy：直接拒绝（修复会中断在途打印），不触 runRepair/collect', async () => {
    const h = makeHarness({ busy: () => true })
    await expect(createDiagnoseService(h.deps).repair('CANCEL_ERROR_JOBS', 'POS-80')).rejects.toThrow(
      '有打印任务进行中，修复将中断它们——请等待打印完成后再修复'
    )
    expect(h.repairCalls).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })
})

describe('编排服务 exportReport（printer-diagnostics T9）', () => {
  const REPORT: DiagnosticReport = {
    schemaVersion: 1,
    collectedAt: '2026-11-12T10:30:00+08:00',
    snapshot: healthySnapshot(),
    findings: []
  }

  it('exportFn 透传 filePath；文件名带采集时间戳（本地钟 yyyyMMdd-HHmmss）', async () => {
    const h = makeHarness()
    const exportNames: string[] = []
    h.deps.exportFn = async (fileName) => {
      exportNames.push(fileName)
      return `/tmp/out/${fileName}`
    }
    const res = await createDiagnoseService(h.deps).exportReport(REPORT)
    expect(res.ok).toBe(true)
    expect(res.filePath).toMatch(/^\/tmp\/out\/打印机诊断报告-\d{8}-\d{6}\.txt$/)
    expect(exportNames[0]).toMatch(/^打印机诊断报告-\d{8}-\d{6}\.txt$/)
  })

  it('用户取消（exportFn → null）：ok:true 无 filePath（取消不是错误）', async () => {
    const h = makeHarness()
    h.deps.exportFn = async () => null
    const res = await createDiagnoseService(h.deps).exportReport(REPORT)
    expect(res).toEqual({ ok: true })
  })

  it('exportFn 抛错 → { ok:false, error }（不向 ipc 抛）', async () => {
    const h = makeHarness()
    h.deps.exportFn = async () => {
      throw new Error('磁盘写入失败（模拟）')
    }
    const res = await createDiagnoseService(h.deps).exportReport(REPORT)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('磁盘写入失败（模拟）')
  })

  it('collectedAt 非法 → 文件名回落当前时刻（不 NaN）', async () => {
    const h = makeHarness()
    const exportNames: string[] = []
    h.deps.exportFn = async (fileName) => {
      exportNames.push(fileName)
      return `/tmp/out/${fileName}`
    }
    const res = await createDiagnoseService(h.deps).exportReport({
      ...REPORT,
      collectedAt: 'not-a-date'
    })
    expect(res.ok).toBe(true)
    expect(exportNames[0]).toMatch(/^打印机诊断报告-\d{8}-\d{6}\.txt$/)
  })
})
