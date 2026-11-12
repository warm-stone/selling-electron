import { readFileSync } from 'node:fs'
import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { createLogoRepo } from '../db/repositories/logo.repo'
import { createSettingsRepo } from '../db/repositories/settings.repo'
import { createTemplateRepo } from '../db/repositories/template.repo'
import { analyzeSnapshot } from '../printing/diagnostics/analyze'
import { runCollect } from '../printing/diagnostics/collect.runner'
import {
  createDiagnoseService,
  type DiagnoseService,
  type DiagnoseServiceDeps
} from '../printing/diagnostics/diagnose.service'
import { archiveHistory } from '../printing/diagnostics/report.exporter'
import { buildRepairActionCatalog } from '../printing/diagnostics/repair-script'
import { runRepairAction } from '../printing/diagnostics/repair.runner'
import { runRenderCheck } from '../printing/diagnostics/render-check'
import type { DiagnosticReport, RepairActionId } from '../printing/diagnostics/schema'
import { generateReceiptHtml } from '../printing/driver/receipt-html'
import { collectSectionLogoIds, parseTemplateRow } from '../printing/print.service'
import type { SaleReceiptData } from '../../shared/receipt/item-columns'
import type { ReceiptVars } from '../../shared/receipt/template-schema'

/**
 * 打印诊断 IPC 薄层（printer-diagnostics 计划 Wave 4 / T9）——IPC 五处联动的第五处。
 *
 * 三通道（T1 契约已锁，preload typed 引用就位）：
 *  - printing:diagnose       采集 → 规则 → L1 先行 → VERIFY → 报告
 *  - printing:repair         执行修复动作（done 时附 verify 复核报告）
 *  - printing:diagnoseExport 报告 → txt（BOM+CRLF）→ 保存对话框 → 写文件
 *
 * ★ 薄层三件事（对齐 printing.ipc 惯例）：参数校验（纯函数可单测）→ 调 service →
 *   { ok, error } 中文信封（首段含动作名）。service 全 DI（diagnose.service.ts 零
 *   electron）；本文件承担**生产装配**（createDefaultDeps：repo → runCollect/
 *   analyzeSnapshot/runRepairAction 包装）与 electron 懒 require（registerDiagnosticsIpc
 *   内 require('electron')——T2 模式，纯部分可在 vitest 纯 Node 环境导入）。
 */

/** 合法修复动作编码（事实源：repair-script 目录——新增动作自动跟随） */
const VALID_ACTION_IDS: readonly RepairActionId[] = buildRepairActionCatalog().map((a) => a.id)

/** 未知错误 → 中文消息 */
function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ══════════════ 参数校验（纯函数，可单测） ══════════════

/**
 * printing:diagnose 请求 → { printerName? }（printerName 可选 string；空串视为未指定）。
 * @throws 请求非对象 / printerName 非 string
 */
export function parseDiagnoseRequest(raw: unknown): { printerName?: string } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object') throw new Error(`请求必须是对象（收到 ${typeof raw}）`)
  const { printerName } = raw as { printerName?: unknown }
  if (printerName === undefined || printerName === null) return {}
  if (typeof printerName !== 'string') {
    throw new Error(`printerName 必须是字符串（收到 ${typeof printerName}）`)
  }
  if (printerName.trim() === '') return {}
  return { printerName }
}

/**
 * printing:repair 请求 → { actionId, targetPrinter? }（actionId 枚举校验）。
 * @throws 请求非对象 / actionId 非法 / targetPrinter 非 string
 */
export function parseRepairRequest(raw: unknown): {
  actionId: RepairActionId
  targetPrinter?: string
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`请求必须是对象（收到 ${typeof raw}）`)
  }
  const { actionId, targetPrinter } = raw as { actionId?: unknown; targetPrinter?: unknown }
  if (typeof actionId !== 'string' || !VALID_ACTION_IDS.includes(actionId as RepairActionId)) {
    throw new Error(
      `非法修复动作编码 actionId=${JSON.stringify(actionId)}（须为 ${VALID_ACTION_IDS.join(' / ')} 之一）`
    )
  }
  if (targetPrinter !== undefined && typeof targetPrinter !== 'string') {
    throw new Error(`targetPrinter 必须是字符串（收到 ${typeof targetPrinter}）`)
  }
  const req: { actionId: RepairActionId; targetPrinter?: string } = {
    actionId: actionId as RepairActionId
  }
  if (typeof targetPrinter === 'string' && targetPrinter.trim() !== '') {
    req.targetPrinter = targetPrinter
  }
  return req
}

/** DiagnosticReport 形状守卫（IPC 运行时边界防御：renderer 回传的报告最低可解析形状） */
function isDiagnosticReportShape(v: unknown): v is DiagnosticReport {
  if (typeof v !== 'object' || v === null) return false
  const rec = v as { schemaVersion?: unknown; snapshot?: unknown; findings?: unknown }
  return (
    rec.schemaVersion === 1 &&
    typeof rec.snapshot === 'object' &&
    rec.snapshot !== null &&
    Array.isArray((rec.snapshot as { printers?: unknown }).printers) &&
    Array.isArray(rec.findings)
  )
}

/**
 * printing:diagnoseExport 请求 → DiagnosticReport（形状校验）。
 * @throws 请求非对象 / report 缺失或形状非法
 */
export function parseExportRequest(raw: unknown): DiagnosticReport {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`请求必须是对象（收到 ${typeof raw}）`)
  }
  const { report } = raw as { report?: unknown }
  if (!isDiagnosticReportShape(report)) {
    throw new Error(
      'report 形状非法（须为 schemaVersion=1 且含 snapshot.printers 与 findings 数组的诊断报告）'
    )
  }
  return report
}

// ══════════════ 生产装配（createDefaultDeps） ══════════════

/** 纸宽 → px（96dpi 圆整；与 receipt-html / ReceiptPreview 几何同源——PAPER_WIDTH_PX 未导出，本地同值） */
const PAPER_WIDTH_PX: Record<string, number> = { '58mm': 221, '80mm': 307 }

/** render-check 样本数据（1 个样例商品行——内容只服务布局测量，不落任何业务数据） */
const SAMPLE_RECEIPT_DATA: SaleReceiptData = {
  items: [{ name: '诊断样本商品', quantity: '1', unitPrice: '1.00', subtotal: '1.00' }]
}

/** 样本变量时间戳（本地钟 yyyy-MM-dd HH:mm:ss） */
function sampleDatetime(): string {
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(
    d.getMinutes()
  )}:${p2(d.getSeconds())}`
}

/**
 * 生产 deps 装配（db + userDataDir → 全 DI 服务）：
 *  - collect：runCollect + 真实 appInfo（settings repo / 默认模板事实 / OS 用户名——T4 交接）；
 *  - runRepair：runRepairAction + setChannel（SWITCH_* 落 settings 表——打印链路每次
 *    send 按当前 settings 解析通道，写 key 即生效）；
 *  - buildHtml：默认模板 + 样本数据 + logos → generateReceiptHtml（拿不到 → null 跳过）；
 *  - archive：archiveHistory（<userDataDir>/diagnostics/history，封顶 20）；
 *  - printQueueBusy：打印串行队列 busy 查询（main/index.ts 从 registerPrintingIpc
 *    返回的编排器接线——PrintQueue.busy 只读转发；缺省恒 false 供测试/旁路装配）；
 *  - exportFn：export.service 同款链（E2E 钩子 → showSaveDialog → 写文件 → 打开所在
 *    文件夹；用户取消 → null）。dialog/shell 懒 require——仅生产调用路径触达。
 */
export function createDefaultDeps(
  db: Database.Database,
  userDataDir: string,
  printQueueBusy: () => boolean = () => false
): DiagnoseServiceDeps {
  const settingsRepo = createSettingsRepo(db)
  const templateRepo = createTemplateRepo(db)
  const logoRepo = createLogoRepo(db)

  /** 当前打印设置视图（settingsGetter dep 与 collect appInfo 的共同原料，每次现读） */
  const currentSettingsView = () => {
    const kv = settingsRepo.getAll()
    return {
      channel: kv['printer_channel'] ?? '',
      printerName: kv['printer_name'] ?? '',
      templatePaperWidth: templateRepo.getDefault().paper_width,
      currentUserName: process.env['USERNAME'] ?? process.env['USER'] ?? ''
    }
  }

  /** 默认模板（config_json 解析 + 坏配置回落内置默认——print.service.parseTemplateRow） */
  const defaultTemplate = () => parseTemplateRow(templateRepo.getDefault())

  return {
    platform: process.platform,

    settingsGetter: currentSettingsView,

    /**
     * 打印串行队列 busy 查询：main/index.ts 从 registerPrintingIpc 返回的编排器
     * 接线（orchestrator.isBusy → PrintQueue.busy 只读转发）。busy 门禁语义：
     * 诊断时只挡 L1 修复（采集只读放行），repair 时整体拒绝。缺省恒 false——
     * 仅测试/旁路装配会走到缺省。
     */
    printQueueBusy,

    /**
     * 采集（printerName 为预留聚焦参数——当前 PS 脚本一次跑全机，全量返回；
     * collect.runner 自带平台守卫，非 win32 以中文错误 reject）。
     */
    collect: async () => {
      const view = currentSettingsView()
      const template = defaultTemplate()
      return runCollect({
        userDataDir,
        appInfo: {
          settings: {
            printer_channel: view.channel !== '' ? view.channel : null,
            printer_name: view.printerName !== '' ? view.printerName : null
          },
          templatePaperWidth: view.templatePaperWidth,
          // driver 通道实际打印选项（driver.channel print 调用的事实快照：自定义
          // 微米页宽 + 无边距 + 打印背景——R10/R11 语义输入）
          printOptions: { pageSizeMode: 'custom-microns', marginsMode: 'none', printBackground: true },
          templateFacts: {
            hasLogo: collectSectionLogoIds(template).length > 0,
            // 实际像素需解码 PNG 方可知——无规则消费（R12 只用 renderSnapshot.heightDelta），
            // 诚实置 null（真机报告由 render-check 提供实测布局）
            logoPx: null,
            // receipt-html RECEIPT_CSS .receipt-paper 的 padding（同源未导出，本地同值）
            cssPadding: '12px 9px'
          },
          currentUserName: view.currentUserName
        }
      })
    },

    analyze: analyzeSnapshot,

    /** 修复执行器 + setChannel 注入（SWITCH_* 的应用内通道切换：改 settings 即下次打印生效） */
    runRepair: (actionId, ctx, repairDeps) =>
      runRepairAction(actionId, ctx, {
        ...repairDeps,
        setChannel: async (channel) => {
          settingsRepo.set('printer_channel', channel)
        }
      }),

    /** 渲染自检（runRenderCheck 内部默认窗口工厂懒 require electron——仅生产触达） */
    renderCheck: (html, paperWidthPx) => runRenderCheck(html, paperWidthPx),

    /** 收据 HTML 合成：默认模板 + 样本数据 + logos；任何异常 → null（跳过 render-check） */
    buildHtml: (): { html: string; paperWidthPx: number } | null => {
      try {
        const template = defaultTemplate()
        // logoBuffers：模板 image 段落引用逐 id 读取（行/文件缺失静默跳过——同测试打印链路）
        const logoBuffers = new Map<number, Buffer>()
        for (const logoId of collectSectionLogoIds(template)) {
          const row = logoRepo.getById(logoId)
          if (row === undefined) continue
          try {
            logoBuffers.set(logoId, readFileSync(join(userDataDir, 'logos', row.filename)))
          } catch {
            /* 文件缺失跳过——渲染时该 image 段落自然为空 */
          }
        }
        const kv = settingsRepo.getAll()
        const vars: ReceiptVars = {
          shopName: kv['shop_name'] ?? '（未设置店名）',
          shopPhone: kv['shop_phone'] ?? '',
          receiptNote: kv['receipt_note'] ?? '',
          saleNo: 'DIAG-SAMPLE',
          datetime: sampleDatetime(),
          total: '1.00',
          itemCount: '1'
        }
        return {
          html: generateReceiptHtml(template, SAMPLE_RECEIPT_DATA, vars, logoBuffers),
          paperWidthPx: PAPER_WIDTH_PX[template.paperWidth] ?? PAPER_WIDTH_PX['80mm']
        }
      } catch {
        return null
      }
    },

    /** 历史归档（<userDataDir>/diagnostics/history/diagnose-<stamp>.json，封顶 20） */
    archive: (report) => {
      archiveHistory(report, userDataDir)
    },

    /**
     * 报告导出链（export.service 的 exportReport 同款语义：E2E 钩子 → 保存对话框 →
     * 写文件 → 打开所在文件夹；取消 → null）。exportReport 本体只接受日报/月报的
     * ReportExportInput（Buffer 由它内部渲染），诊断报告 Buffer 无法经它传递，故按
     * 同款链路在此实现。dialog/shell 懒 require（本层即 ipc 装配层）。
     */
    exportFn: async (fileName: string, data: Buffer): Promise<string | null> => {
      // E2E 测试钩子（对齐 export.service：跳过 dialog 直写并返回路径）
      const e2eDir = process.env['E2E_EXPORT_DIR']
      if (e2eDir) {
        const target = join(e2eDir, fileName)
        await mkdir(dirname(target), { recursive: true })
        await fsWriteFile(target, data)
        return target
      }
      const electron = require('electron') as {
        dialog: {
          showSaveDialog(o: {
            defaultPath?: string
            filters?: { name: string; extensions: string[] }[]
          }): Promise<{ canceled: boolean; filePath?: string }>
        }
        shell: { showItemInFolder(p: string): void }
      }
      const result = await electron.dialog.showSaveDialog({
        defaultPath: fileName,
        filters: [{ name: '文本文件', extensions: ['txt'] }]
      })
      if (result.canceled || !result.filePath) return null
      await mkdir(dirname(result.filePath), { recursive: true })
      await fsWriteFile(result.filePath, data)
      electron.shell.showItemInFolder(result.filePath)
      return result.filePath
    }
  }
}

// ══════════════ IPC 注册 ══════════════

/** electron 结构子集（ipcMain.handle + app.getPath——测试注入 fake 免依赖 electron） */
export interface DiagnosticsIpcElectron {
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown) => void
  }
  app: { getPath: (name: 'userData') => string }
}

/** 注册选项（测试注入 fake electron / fake service；生产缺省全走真实链路） */
export interface DiagnosticsIpcOptions {
  /** electron 获取器（默认懒 require——vitest 下 require('electron') 返回二进制路径字符串，测试须注入） */
  getElectron?: () => DiagnosticsIpcElectron
  /** 服务工厂（默认 createDiagnoseService(createDefaultDeps(db, userDataDir, printQueueBusy))） */
  createService?: (db: Database.Database, userDataDir: string) => DiagnoseService
  /** 打印串行队列 busy 查询（生产由 main/index.ts 从 registerPrintingIpc 的编排器接线） */
  printQueueBusy?: () => boolean
}

export function registerDiagnosticsIpc(db: Database.Database, options: DiagnosticsIpcOptions = {}): void {
  // 懒 require（T2 模式）：本模块纯部分（parse* / createDefaultDeps）可在 vitest 纯 Node 环境导入
  const getElectron =
    options.getElectron ?? ((): DiagnosticsIpcElectron => require('electron') as DiagnosticsIpcElectron)
  const { ipcMain, app } = getElectron()
  const userDataDir = app.getPath('userData')
  const service = options.createService
    ? options.createService(db, userDataDir)
    : createDiagnoseService(createDefaultDeps(db, userDataDir, options.printQueueBusy))

  ipcMain.handle('printing:diagnose', async (_event, raw: unknown) => {
    try {
      const { printerName } = parseDiagnoseRequest(raw)
      const report = await service.diagnose(printerName)
      return { ok: true, report }
    } catch (err) {
      return { ok: false, error: `诊断失败（printing:diagnose）：${errorDetail(err)}` }
    }
  })

  ipcMain.handle('printing:repair', async (_event, raw: unknown) => {
    try {
      const { actionId, targetPrinter } = parseRepairRequest(raw)
      const { outcome, verify } = await service.repair(actionId, targetPrinter)
      // outcome 为 res 契约的运行时结构超集（preview 载荷同款先例）——T10 UI 消费
      return { ok: true, outcome, verify }
    } catch (err) {
      return { ok: false, error: `修复失败（printing:repair）：${errorDetail(err)}` }
    }
  })

  ipcMain.handle('printing:diagnoseExport', async (_event, raw: unknown) => {
    try {
      const report = parseExportRequest(raw)
      return await service.exportReport(report)
    } catch (err) {
      return { ok: false, error: `导出失败（printing:diagnoseExport）：${errorDetail(err)}` }
    }
  })
}
