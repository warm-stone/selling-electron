import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { createLogoRepo } from '../../../src/main/db/repositories/logo.repo'
import { createSettingsRepo } from '../../../src/main/db/repositories/settings.repo'
import { createTemplateRepo } from '../../../src/main/db/repositories/template.repo'
import {
  createDefaultDeps,
  parseDiagnoseRequest,
  parseExportRequest,
  parseRepairRequest,
  registerDiagnosticsIpc,
  type DiagnosticsIpcElectron
} from '../../../src/main/ipc/diagnostics.ipc'
import { analyzeSnapshot } from '../../../src/main/printing/diagnostics/analyze'
import { createDiagnoseService, type DiagnoseService } from '../../../src/main/printing/diagnostics/diagnose.service'
import type { DiagnosticReport, PrintDiagnosticSnapshot, RepairActionId } from '../../../src/main/printing/diagnostics/schema'
import type { RepairOutcome } from '../../../src/main/printing/diagnostics/repair.runner'
import { PrintQueue } from '../../../src/main/printing/print.service'
import { DEFAULT_TEMPLATES } from '../../../src/shared/receipt/default-template'
import { FIXTURES } from '../printing/diagnostics/fixtures/index'
import { rmTempDirSync } from '../../helpers/cleanup'

/**
 * printer-diagnostics T9 IPC 薄层：参数校验纯函数 + 三 handler 注册/信封/透传 +
 * 生产装配（createDefaultDeps）。
 *
 * 可测性关键：registerDiagnosticsIpc 的 electron 与 service 均为注入点
 * （DiagnoseIpcOptions）——vitest 纯 Node 下 require('electron') 返回二进制路径
 * 字符串（vi.mock 拦不住运行时 require），注入 fake ipcMain（记录通道名 + 捕获
 * listener）即可免 electron 直测注册与信封行为。
 */

const REPORT: DiagnosticReport = {
  schemaVersion: 1,
  collectedAt: '2026-11-12T10:30:00+08:00',
  snapshot: FIXTURES['healthy-machine'],
  findings: []
}

/** 1×1 透明 PNG（logo 装配测试用——同 settings.ipc.test.ts） */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let dir: string
const openDbs: Database.Database[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-diagnostics-ipc-'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
  rmTempDirSync(dir)
})

function openDb(): Database.Database {
  const db = new Database(join(dir, 'pos.db'))
  openDbs.push(db)
  migrate(db)
  return db
}

/** 可控完成时机的 deferred（busy 门禁用例：挂起打印 send 直到测试放行） */
function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// ══════════════ 参数校验纯函数 ══════════════

describe('parseDiagnoseRequest', () => {
  it('缺省/空对象/空串/undefined printerName → 未指定', () => {
    expect(parseDiagnoseRequest(undefined)).toEqual({})
    expect(parseDiagnoseRequest(null)).toEqual({})
    expect(parseDiagnoseRequest({})).toEqual({})
    expect(parseDiagnoseRequest({ printerName: undefined })).toEqual({})
    expect(parseDiagnoseRequest({ printerName: '' })).toEqual({})
  })

  it('合法 printerName 透传', () => {
    expect(parseDiagnoseRequest({ printerName: 'POS-80' })).toEqual({ printerName: 'POS-80' })
  })

  it('非对象 / printerName 非 string → 抛中文可诊断错误', () => {
    expect(() => parseDiagnoseRequest('oops')).toThrow('请求必须是对象')
    expect(() => parseDiagnoseRequest({ printerName: 123 })).toThrow('printerName 必须是字符串')
  })
})

describe('parseRepairRequest', () => {
  it('合法请求透传（targetPrinter 空串视为未指定）', () => {
    expect(parseRepairRequest({ actionId: 'CANCEL_ERROR_JOBS', targetPrinter: 'POS-80' })).toEqual({
      actionId: 'CANCEL_ERROR_JOBS',
      targetPrinter: 'POS-80'
    })
    expect(parseRepairRequest({ actionId: 'ENABLE_PRINT_LOG' })).toEqual({
      actionId: 'ENABLE_PRINT_LOG'
    })
    expect(parseRepairRequest({ actionId: 'ENABLE_PRINT_LOG', targetPrinter: '' })).toEqual({
      actionId: 'ENABLE_PRINT_LOG'
    })
  })

  it('actionId 非法（未知字符串/非字符串）→ 抛错并列出合法编码', () => {
    expect(() => parseRepairRequest({ actionId: 'REBOOT_UNIVERSE' })).toThrow(/actionId.*REBOOT_UNIVERSE/)
    expect(() => parseRepairRequest({ actionId: 'REBOOT_UNIVERSE' })).toThrow(/CANCEL_ERROR_JOBS/)
    expect(() => parseRepairRequest({})).toThrow('actionId')
    expect(() => parseRepairRequest(null)).toThrow('请求必须是对象')
  })

  it('targetPrinter 非 string → 抛错', () => {
    expect(() => parseRepairRequest({ actionId: 'CANCEL_ERROR_JOBS', targetPrinter: 9 })).toThrow(
      'targetPrinter 必须是字符串'
    )
  })

  it('九个动作编码全量合法（与 repair-script 目录同源）', () => {
    const ids: RepairActionId[] = [
      'CANCEL_ERROR_JOBS',
      'SWITCH_TO_DRIVER_CHANNEL',
      'SWITCH_TO_SPOOLER_CHANNEL',
      'PURGE_QUEUE_RESTART_SPOOLER',
      'MIGRATE_WSD_TO_TCP',
      'ENABLE_PRINT_LOG',
      'DISABLE_SNMP',
      'REINSTALL_DRIVER_GUIDE',
      'GENERIC_TEXT_ONLY_GUIDE'
    ]
    for (const id of ids) {
      expect(parseRepairRequest({ actionId: id })).toEqual({ actionId: id })
    }
  })
})

describe('parseExportRequest', () => {
  it('合法报告原引用透传', () => {
    expect(parseExportRequest({ report: REPORT })).toBe(REPORT)
  })

  it('形状非法（非对象 / 缺 report / schemaVersion≠1 / findings 非数组 / snapshot 缺 printers）→ 抛错', () => {
    expect(() => parseExportRequest('oops')).toThrow('请求必须是对象')
    expect(() => parseExportRequest({})).toThrow('report 形状非法')
    expect(() => parseExportRequest({ report: null })).toThrow('report 形状非法')
    expect(() => parseExportRequest({ report: { ...REPORT, schemaVersion: 2 } })).toThrow('report 形状非法')
    expect(() => parseExportRequest({ report: { ...REPORT, findings: 'x' } })).toThrow('report 形状非法')
    expect(() =>
      parseExportRequest({ report: { ...REPORT, snapshot: { ...REPORT.snapshot, printers: {} } } })
    ).toThrow('report 形状非法')
  })
})

// ══════════════ handler 注册 / 信封 / 透传（fake electron + fake service） ══════════════

type Handler = (event: unknown, raw: unknown) => unknown

function makeFakeService(impl?: {
  diagnose?: (printerName?: string) => Promise<DiagnosticReport>
  repair?: (
    actionId: RepairActionId,
    targetPrinter?: string
  ) => Promise<{ outcome: RepairOutcome; verify?: DiagnosticReport }>
  exportReport?: (report: DiagnosticReport) => Promise<{ ok: boolean; filePath?: string; error?: string }>
}) {
  const diagnoseArgs: Array<string | undefined> = []
  const repairArgs: Array<{ actionId: RepairActionId; targetPrinter?: string }> = []
  const exportArgs: DiagnosticReport[] = []
  const service: DiagnoseService = {
    diagnose: async (printerName) => {
      diagnoseArgs.push(printerName)
      return impl?.diagnose ? impl.diagnose(printerName) : REPORT
    },
    repair: async (actionId, targetPrinter) => {
      repairArgs.push({ actionId, targetPrinter })
      return impl?.repair ? impl.repair(actionId, targetPrinter) : { outcome: { status: 'done', detail: '已清除' }, verify: REPORT }
    },
    exportReport: async (report) => {
      exportArgs.push(report)
      return impl?.exportReport ? impl.exportReport(report) : { ok: true, filePath: '/tmp/导出/打印机诊断报告.txt' }
    }
  }
  return { service, diagnoseArgs, repairArgs, exportArgs }
}

/** 注入 fake electron + fake service 注册三通道，返回记录的通道名与捕获的 listener */
function registerWithFakeService(db: Database.Database, service: DiagnoseService) {
  const channels: string[] = []
  const handlers = new Map<string, Handler>()
  const electron: DiagnosticsIpcElectron = {
    ipcMain: {
      handle: (channel, listener) => {
        channels.push(channel)
        handlers.set(channel, listener)
      }
    },
    app: { getPath: () => dir }
  }
  registerDiagnosticsIpc(db, { getElectron: () => electron, createService: () => service })
  return { channels, handlers }
}

describe('registerDiagnosticsIpc（fake electron / fake service）', () => {
  it('三 handler 按序注册（printing:diagnose / printing:repair / printing:diagnoseExport）', () => {
    const db = openDb()
    const { channels, handlers } = registerWithFakeService(db, makeFakeService().service)
    expect(channels).toEqual(['printing:diagnose', 'printing:repair', 'printing:diagnoseExport'])
    expect(handlers.size).toBe(3)
  })

  it('printing:diagnose：合法请求 → {ok:true, report} 透传；printerName 解析后传给 service', async () => {
    const db = openDb()
    const fake = makeFakeService()
    const { handlers } = registerWithFakeService(db, fake.service)
    const handler = handlers.get('printing:diagnose')!

    expect(await handler(undefined, { printerName: 'POS-80' })).toEqual({ ok: true, report: REPORT })
    expect(await handler(undefined, {})).toEqual({ ok: true, report: REPORT })
    expect(await handler(undefined, undefined)).toEqual({ ok: true, report: REPORT })
    expect(fake.diagnoseArgs).toEqual(['POS-80', undefined, undefined])
  })

  it('printing:diagnose：参数非法 / service 抛错 → {ok:false} 信封（首段含动作名）', async () => {
    const db = openDb()
    const fake = makeFakeService({
      diagnose: async () => {
        throw new Error('打印机诊断正在进行中，请稍候')
      }
    })
    const { handlers } = registerWithFakeService(db, fake.service)
    const handler = handlers.get('printing:diagnose')!

    const badParam = (await handler(undefined, { printerName: 42 })) as { ok: boolean; error?: string }
    expect(badParam.ok).toBe(false)
    expect(badParam.error).toContain('诊断失败（printing:diagnose）')
    expect(badParam.error).toContain('printerName 必须是字符串')

    const svcError = (await handler(undefined, {})) as { ok: boolean; error?: string }
    expect(svcError.ok).toBe(false)
    expect(svcError.error).toBe('诊断失败（printing:diagnose）：打印机诊断正在进行中，请稍候')
  })

  it('printing:repair：合法请求 → {ok:true, outcome, verify}；actionId/targetPrinter 透传 service', async () => {
    const db = openDb()
    const fake = makeFakeService()
    const { handlers } = registerWithFakeService(db, fake.service)
    const handler = handlers.get('printing:repair')!

    const res = (await handler(undefined, { actionId: 'CANCEL_ERROR_JOBS', targetPrinter: 'POS-80' })) as {
      ok: boolean
      outcome: RepairOutcome
      verify?: DiagnosticReport
    }
    expect(res.ok).toBe(true)
    expect(res.outcome.status).toBe('done')
    expect(res.verify).toBe(REPORT)
    expect(fake.repairArgs).toEqual([{ actionId: 'CANCEL_ERROR_JOBS', targetPrinter: 'POS-80' }])
  })

  it('printing:repair：actionId 非法 → {ok:false}（service 未被调）；service 抛错 → 修复信封', async () => {
    const db = openDb()
    const fake = makeFakeService({
      repair: async () => {
        throw new Error('有打印任务进行中，修复将中断它们——请等待打印完成后再修复')
      }
    })
    const { handlers } = registerWithFakeService(db, fake.service)
    const handler = handlers.get('printing:repair')!

    const badAction = (await handler(undefined, { actionId: 'DESTROY_SPOOLER' })) as {
      ok: boolean
      error?: string
    }
    expect(badAction.ok).toBe(false)
    expect(badAction.error).toContain('修复失败（printing:repair）')
    expect(badAction.error).toContain('actionId')
    expect(fake.repairArgs).toHaveLength(0)

    const svcError = (await handler(undefined, { actionId: 'CANCEL_ERROR_JOBS' })) as {
      ok: boolean
      error?: string
    }
    expect(svcError.error).toBe(
      '修复失败（printing:repair）：有打印任务进行中，修复将中断它们——请等待打印完成后再修复'
    )
  })

  it('printing:diagnoseExport：形状校验 + service 结果透传', async () => {
    const db = openDb()
    const fake = makeFakeService()
    const { handlers } = registerWithFakeService(db, fake.service)
    const handler = handlers.get('printing:diagnoseExport')!

    const ok = (await handler(undefined, { report: REPORT })) as { ok: boolean; filePath?: string }
    expect(ok).toEqual({ ok: true, filePath: '/tmp/导出/打印机诊断报告.txt' })
    expect(fake.exportArgs).toEqual([REPORT])

    const bad = (await handler(undefined, { report: { schemaVersion: 3 } })) as {
      ok: boolean
      error?: string
    }
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('导出失败（printing:diagnoseExport）')
    expect(bad.error).toContain('report 形状非法')
    expect(fake.exportArgs).toHaveLength(1)
  })
})

// ══════════════ 生产装配 createDefaultDeps（真实 db + tmpdir） ══════════════

describe('createDefaultDeps（生产装配）', () => {
  it('settingsGetter：settings KV + 默认模板纸宽 + OS 用户名', () => {
    const db = openDb()
    const settingsRepo = createSettingsRepo(db)
    settingsRepo.setMany({ printer_channel: 'driver', printer_name: 'POS-80' })

    const deps = createDefaultDeps(db, dir)
    const view = deps.settingsGetter()
    expect(view.channel).toBe('driver')
    expect(view.printerName).toBe('POS-80')
    expect(view.templatePaperWidth).toBe('80mm') // getDefault 惰性 seed（默认 80mm）
    expect(typeof view.currentUserName).toBe('string')
  })

  it('printQueueBusy：第三参接线透传（生产由 main/index.ts 接 printing ipc 编排器），缺省恒 false + platform 为真实平台', () => {
    const db = openDb()
    // 未接线（测试/旁路装配）：缺省 false
    expect(createDefaultDeps(db, dir).printQueueBusy()).toBe(false)
    // 接线透传：外部 busy 查询原样进入 deps（busy 门禁自此读到真实队列状态）
    expect(createDefaultDeps(db, dir, () => true).printQueueBusy()).toBe(true)
    let called = false
    createDefaultDeps(db, dir, () => {
      called = true
      return false
    })
      .printQueueBusy()
    expect(called).toBe(true)
    expect(createDefaultDeps(db, dir).platform).toBe(process.platform)
  })

  it('busy 门禁端到端（真实 PrintQueue）：打印在途 → 诊断 L1 跳过；队列清空 → L1 恢复执行', async () => {
    const db = openDb()
    // 真实打印队列 + 挂起通道（job 不定界则 busy 恒 true）
    const gate = createDeferred<void>()
    const printQueue = new PrintQueue({ name: 'spooler', send: () => gate.promise })
    const printJob = printQueue.enqueuePrintJob(new Uint8Array([0x1b]))

    // 快照工厂：目标机 1 条本人错误任务（真实 analyzeSnapshot 命中 jobs-stuck-error）
    const errorJobSnapshot = (): PrintDiagnosticSnapshot => {
      const base = FIXTURES['healthy-machine']
      const p = base.printers[0]!
      return {
        ...base,
        app: { ...base.app, settings: { ...base.app.settings, printerName: 'POS-80' } },
        printers: [
          {
            ...p,
            name: 'POS-80',
            jobs: [{ document: '滞留任务', owner: 'SHOPPC\\shop', statusMask: 2, isOwnedByCurrentUser: true }],
            queue: { ...p.queue, jobCount: 1, errorJobs: 1 }
          },
          ...base.printers.slice(1)
        ]
      }
    }

    const repairCalls: RepairActionId[] = []
    // 生产 deps 为底 + 覆写 I/O 触点（collect/renderCheck/buildHtml/runRepair 用 fake，
    // 不触真实 PowerShell/Electron）；printQueueBusy 接真实队列——本用例的被测对象
    const service = createDiagnoseService({
      ...createDefaultDeps(db, dir, () => printQueue.busy),
      platform: 'win32',
      collect: async () => errorJobSnapshot(),
      analyze: analyzeSnapshot,
      renderCheck: async () => {
        throw new Error('不应触达（无 logo + 非 driver 通道）')
      },
      buildHtml: () => null,
      runRepair: async (actionId) => {
        repairCalls.push(actionId)
        return { status: 'done', detail: '已清除' }
      }
    })

    // 打印在途：诊断照常返回，但 L1 被真实 busy 挡下
    const duringPrint = await service.diagnose()
    expect(duringPrint.findings.find((f) => f.code === 'jobs-stuck-error')?.status).toBe('pending')
    expect(duringPrint.findings.find((f) => f.code === 'jobs-stuck-error')?.description).toContain(
      '有打印任务进行中，完成后重跑诊断'
    )
    expect(repairCalls).toHaveLength(0)

    // 队列清空（吞链递减一个微任务后 busy 归零）：L1 恢复执行
    gate.resolve()
    await printJob
    await Promise.resolve()
    expect(printQueue.busy).toBe(false)

    await service.diagnose()
    expect(repairCalls).toEqual(['CANCEL_ERROR_JOBS'])
  })

  it('buildHtml：默认模板（seed 80mm）+ 样本数据 → 完整收据 HTML + paperWidthPx=307', () => {
    const db = openDb()
    const deps = createDefaultDeps(db, dir)
    const built = deps.buildHtml()
    expect(built).not.toBeNull()
    expect(built!.paperWidthPx).toBe(307)
    expect(built!.html).toContain('<!DOCTYPE html>')
    expect(built!.html).toContain('data-paper-width="80mm"')
    expect(built!.html).toContain('诊断样本商品')
    expect(built!.html).not.toContain('base64,') // 无 logo → 无 dataURL 图片（CSS 类定义本身不算）
  })

  it('buildHtml：模板含 image 段落且 logo 文件可读 → HTML 注入 receipt-logo', () => {
    const db = openDb()
    const templateRepo = createTemplateRepo(db)
    const logoRepo = createLogoRepo(db)

    const logoRow = logoRepo.insert('logo-a.png', '店招')
    mkdirSync(join(dir, 'logos'), { recursive: true })
    writeFileSync(join(dir, 'logos', logoRow.filename), Buffer.from(PNG_1PX_BASE64, 'base64'))

    const withLogo = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES['80mm'])) as typeof DEFAULT_TEMPLATES['80mm']
    withLogo.header.push({ type: 'image', logoId: logoRow.id })
    const created = templateRepo.create({ name: '带 Logo', template: withLogo })
    templateRepo.setDefault(created.id)

    const deps = createDefaultDeps(db, dir)
    const built = deps.buildHtml()
    expect(built).not.toBeNull()
    expect(built!.html).toContain('receipt-logo')
    expect(built!.html).toContain(`base64,${PNG_1PX_BASE64}`)
  })

  it('archive：归档到 <userDataDir>/diagnostics/history/（脱敏 JSON，文件名取 collectedAt）', () => {
    const db = openDb()
    const deps = createDefaultDeps(db, dir)
    deps.archive(REPORT)
    const historyDir = join(dir, 'diagnostics', 'history')
    const files = readdirSync(historyDir).filter((f) => /^diagnose-\d{8}-\d{6}\.json$/.test(f))
    expect(files).toHaveLength(1)
    const parsed = JSON.parse(readFileSync(join(historyDir, files[0]!), 'utf8')) as DiagnosticReport
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.collectedAt).toBe(REPORT.collectedAt)
  })

  it('runRepair 包装：SWITCH_* 经 setChannel 落 settings 表（无提权；platform 注入 win32 免平台差异）', async () => {
    const db = openDb()
    const deps = createDefaultDeps(db, dir)
    const outcome = await deps.runRepair('SWITCH_TO_DRIVER_CHANNEL', {}, { platform: 'win32' })
    expect(outcome.status).toBe('done')
    const channel = (
      db.prepare('SELECT value FROM settings WHERE key = ?').get('printer_channel') as { value: string }
    ).value
    expect(channel).toBe('driver')
  })
})
