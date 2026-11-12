import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { isPrintChannelKind } from '../printing/channels/print-channel'
import { createPrinterEnumerator } from '../printing/channels/printer-enumerator'
import {
  collectSectionLogoIds,
  createPrintOrchestrator,
  getChannel,
  parseTemplateRow,
  PrintQueue,
  type PrintOrchestrator,
  type PreviewPayload
} from '../printing/print.service'
import type { PrintSettings } from '../printing/print.service'
import { generateReceiptBytes } from '../printing/escpos/escpos-generator'
import { generateReceiptHtml } from '../printing/driver/receipt-html'
import type { SaleReceiptData } from '../../shared/receipt/item-columns'
import type { ReceiptTemplate, ReceiptVars } from '../../shared/receipt/template-schema'
import { createSaleRepo } from '../db/repositories/sale.repo'
import { createSaleExtraRepo } from '../db/repositories/sale-extra.repo'
import { createSettingsRepo } from '../db/repositories/settings.repo'
import { createTemplateRepo } from '../db/repositories/template.repo'
import { createLogoRepo } from '../db/repositories/logo.repo'
import type { AppSettings, PrintTemplate } from '../../shared/types'
import { rowsToAppSettings } from './settings.ipc'

/**
 * 打印 IPC 薄层（Task 19 打印设置 + Task 15 打印编排）。
 *
 * 通道：
 *  - printing:printers  系统打印机枚举（T7 listSystemPrinters 消费面）
 *  - printing:testPrint 测试打印（真实生成链路：样例数据 + 当前默认模板
 *                       → 通道对应载荷——spooler/tcp/serial 走
 *                       generateReceiptBytes 字节、driver 走 generateReceiptHtml
 *                       的 HTML 字节——后发送；中文/折行/光栅全链路覆盖，
 *                       纯 ASCII 假字节无法暴露真机问题）
 *  - printing:preview   小票预览（T15：预览与打印同源组装——G7）
 *  - printing:print     小票打印（T15：串行队列 best-effort，失败不影响已保存销售——G3）
 *
 * ★ 只消费上游产物（printer-enumerator / print-channel 守卫 / getChannel /
 *   PrintQueue / generateReceiptBytes / generateReceiptHtml / 各 repo），
 *   不改动 channels/ 与 escpos-generator / receipt-html 内部任何代码。
 * ★ `require('electron')` 懒加载（T2 模式）：TEST_PRINT_SALE / TEST_PRINT_VARS /
 *   buildTestPrintPayload / buildTestPrintBytes / buildTestPrintHtml /
 *   toPrintSettings / parseSaleId 等纯部分可在 vitest 纯 Node 环境导入。
 */

/** 打印机下拉项（设置页消费；is_default 用于默认标记展示） */
export interface PrinterEntry {
  name: string
  is_default: boolean
}

/** 测试打印请求：AppSettings 的打印子集（设置页「打印设置」卡片当前表单值） */
export type PrintTestRequest = Pick<
  AppSettings,
  'printer_channel' | 'printer_name' | 'tcp_host' | 'tcp_port' | 'com_port'
>

/**
 * 测试打印样例数据（模块级可测常量）：中文店名 + 中文商品名 + 超长商品名
 * （触发 wrapToGrid 折行）——真机中文/图片链路能否走通由测试打印先行暴露。
 */
export const TEST_PRINT_SALE: SaleReceiptData = {
  items: [
    { name: '可口可乐330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' },
    {
      name: '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸',
      quantity: '1',
      unitPrice: '45.00',
      subtotal: '45.00'
    }
  ]
}

/** 测试打印变量插槽（中文店名/电话/备注——GBK 双字节链路覆盖） */
export const TEST_PRINT_VARS: ReceiptVars = {
  shopName: '测试商店',
  shopPhone: '13800001111',
  receiptNote: '谢谢惠顾',
  saleNo: '20261101-0001',
  datetime: '2026-11-01 21:00:00',
  total: '52.00',
  itemCount: '3'
}

/** 测试打印依赖（与编排器同构：默认模板 + 多 Logo 读取） */
export interface TestPrintDeps {
  /** 默认模板行（template.repo.getDefault） */
  getDefaultTemplate(): PrintTemplate
  /** 按 logo id 读 Logo 文件 → PNG Buffer（行/文件不存在 → null） */
  readLogoById(logoId: number): Promise<Buffer | null>
}

/** 测试打印载荷（字节/HTML 两种渲染的共同源头，G7）：模板 + 变量 + logoBuffers */
export interface TestPrintPayload {
  /** 默认模板（config_json 解析 + 坏配置回落） */
  template: ReceiptTemplate
  /** 变量插槽（纯字符串——字节/HTML 两侧同值） */
  vars: ReceiptVars
  /** 模板 image 段落引用的 Logo Buffer 集合（无引用/读不到 → 空 Map） */
  logoBuffers: Map<number, Buffer>
}

/**
 * 组装测试打印载荷（真实生成链路的共同源头）：当前默认模板 + 样例变量 +
 * logoBuffers（与 buildReceiptPayload 同规则：image 段落逐 id 读取，读不到
 * 静默跳过）。字节（generateReceiptBytes）与 driver HTML（generateReceiptHtml）
 * 两侧消费者共用——两套渲染不得两套组装。
 */
export async function buildTestPrintPayload(deps: TestPrintDeps): Promise<TestPrintPayload> {
  const template = parseTemplateRow(deps.getDefaultTemplate())
  const logoBuffers = new Map<number, Buffer>()
  for (const logoId of collectSectionLogoIds(template)) {
    const buf = await deps.readLogoById(logoId)
    if (buf) logoBuffers.set(logoId, buf)
  }
  return { template, vars: { ...TEST_PRINT_VARS }, logoBuffers }
}

/**
 * 组装测试打印字节（真实生成链路）：默认模板 + 样例数据 → generateReceiptBytes
 * （spooler/tcp/serial 通道载荷）。模板含 image 段落时按 logoBuffers 链路
 * 注入；没有 logo 时自然跳过（不因缺 logo 报错）。
 */
export async function buildTestPrintBytes(deps: TestPrintDeps): Promise<Uint8Array> {
  const { template, vars, logoBuffers } = await buildTestPrintPayload(deps)
  return generateReceiptBytes(template, TEST_PRINT_SALE, { ...vars, logoBuffers })
}

/**
 * 组装测试打印 HTML 字节（driver 通道载荷）：默认模板 + 样例数据 →
 * generateReceiptHtml → UTF-8 编码（HTML 即字节——同 printSale driver 分支）。
 */
export async function buildTestPrintHtml(deps: TestPrintDeps): Promise<Uint8Array> {
  const { template, vars, logoBuffers } = await buildTestPrintPayload(deps)
  return Buffer.from(generateReceiptHtml(template, TEST_PRINT_SALE, vars, logoBuffers), 'utf8')
}

/**
 * 请求 → PrintSettings（T7 getChannel 参数，key 与 settings 表逐字一致）。
 * 入参放宽为 Partial（invoke 运行时边界防御：脏/缺字段走通道默认值）；
 * printer_channel 脏值回落 spooler（getChannel 自身也守卫，双保险）。
 */
export function toPrintSettings(req: Partial<PrintTestRequest> | undefined): PrintSettings {
  const channel = isPrintChannelKind(req?.printer_channel) ? req.printer_channel : 'spooler'
  return {
    printer_channel: channel,
    printer_name: req?.printer_name ?? '',
    tcp_host: req?.tcp_host ?? '',
    tcp_port: req?.tcp_port ?? undefined,
    com_port: req?.com_port ?? undefined
  }
}

/**
 * preview/print 请求 → sale_id（运行时边界防御：非正整数 → NaN，
 * 走编排器「未找到销售单」的可诊断路径，不静默成功）。
 */
export function parseSaleId(req: unknown): number {
  if (typeof req === 'object' && req !== null && 'sale_id' in req) {
    const v = (req as { sale_id?: unknown }).sale_id
    if (typeof v === 'number' && Number.isInteger(v)) return v
  }
  return Number.NaN
}

/**
 * 返回编排器（含 isBusy）——main/index.ts 据此把打印队列 busy 接线给
 * registerDiagnosticsIpc（printer-diagnostics T9 的 busy 门禁数据源）。
 * 行为零变化：仅多一个返回值，调用方不消费时与原 void 等价。
 */
export function registerPrintingIpc(db: Database.Database): PrintOrchestrator {
  // 懒 require（T2 模式）：本模块纯部分可在 vitest 纯 Node 环境导入
  const { ipcMain, BrowserWindow, app } = require('electron') as typeof import('electron')

  // G11：惰性取窗口——每次枚举时求值（窗口可能尚未创建/已销毁）；
  // 无窗口 / Linux 无打印子系统 → enumerator 内部已捕获，返回 []（不崩溃）
  const enumerator = createPrinterEnumerator(() => BrowserWindow.getAllWindows()[0])

  // ── Task 15：打印编排装配（repo → 编排器；队列随编排器实例级单例串行） ──
  const saleRepo = createSaleRepo(db)
  const saleExtraRepo = createSaleExtraRepo(db)
  const templateRepo = createTemplateRepo(db)
  const settingsRepo = createSettingsRepo(db)
  const logoRepo = createLogoRepo(db)
  const currentSettings = (): AppSettings => rowsToAppSettings(settingsRepo.getAll())

  /** 生产 readLogoById：logo repo 查行 → 读 userData/logos/<filename>（行/文件缺失 → null） */
  const readLogoById = async (logoId: number): Promise<Buffer | null> => {
    const row = logoRepo.getById(logoId)
    if (row === undefined) return null
    try {
      return await readFile(join(app.getPath('userData'), 'logos', row.filename))
    } catch {
      return null
    }
  }

  const orchestrator = createPrintOrchestrator({
    // extras 真装配（T8 接线）：repo.getDetail 不含 sale_extras，此层补齐
    // SaleDetail.extras（printing:preview 消费——T2 契约既定）
    getSaleDetail: (saleId) => {
      const core = saleRepo.getDetail(saleId)
      return core === undefined
        ? undefined
        : { ...core, extras: saleExtraRepo.getWithCustomer(saleId) }
    },
    getDefaultTemplate: () => templateRepo.getDefault(),
    getSettings: currentSettings,
    readLogoById
  })

  ipcMain.handle('printing:printers', async (): Promise<PrinterEntry[]> => {
    const printers = await enumerator.listSystemPrinters()
    return printers.map((p) => ({ name: p.name, is_default: p.isDefault ?? false }))
  })

  /**
   * 测试打印（真实生成链路）：样例数据 + 当前默认模板 → 通道对应载荷
   * （spooler/tcp/serial → ESC/POS 字节；driver → 收据 HTML 字节——云热敏
   * 机驱动渲染兜底，同 printSale 分支规则）→ 走 T7 的 getChannel +
   * PrintQueue（不绕过串行队列）。
   * 失败不抛给 renderer —— 返回 { ok:false, error } 且 error 首段含通道名
   * （设置页直接 ElMessage.error 展示）。
   */
  ipcMain.handle(
    'printing:testPrint',
    async (
      _event,
      req: Partial<PrintTestRequest> | undefined
    ): Promise<{ ok: boolean; error?: string }> => {
      const settings = toPrintSettings(req)
      try {
        const channel = getChannel(settings)
        const testDeps = {
          getDefaultTemplate: () => templateRepo.getDefault(),
          readLogoById
        }
        const bytes =
          settings.printer_channel === 'driver'
            ? await buildTestPrintHtml(testDeps)
            : await buildTestPrintBytes(testDeps)
        await new PrintQueue(channel).enqueuePrintJob(bytes)
        return { ok: true }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `测试打印失败（${settings.printer_channel} 通道）：${detail}` }
      }
    }
  )

  /**
   * 小票预览（T15）：saleId → PreviewPayload（模板/明细/vars/logoUrls）——
   * 与 printing:print 的字节组装同一份 buildReceiptPayload（G7 同源）。
   * 错误（如销售单不存在）原样 reject，renderer 展示可诊断消息。
   */
  ipcMain.handle('printing:preview', async (_event, req: unknown): Promise<PreviewPayload> => {
    return orchestrator.previewSale(parseSaleId(req))
  })

  /**
   * 小票打印（T15）：组装 → generateReceiptBytes → 串行队列入队。
   * 失败**不抛**（G3：销售已落库，打印失败绝不影响销售）——返回
   * { ok:false, error }，error 含通道名 + 重打引导文案。
   */
  ipcMain.handle(
    'printing:print',
    async (_event, req: unknown): Promise<{ ok: boolean; error?: string }> => {
      try {
        await orchestrator.printSale(parseSaleId(req))
        return { ok: true }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        const channel = currentSettings().printer_channel
        return {
          ok: false,
          error: `打印失败（${channel} 通道）：${detail}。销售已保存，可稍后在销售记录中重打`
        }
      }
    }
  )

  return orchestrator
}
