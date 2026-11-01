import type Database from 'better-sqlite3'
import { isPrintChannelKind } from '../printing/channels/print-channel'
import { createPrinterEnumerator } from '../printing/channels/printer-enumerator'
import {
  createPrintOrchestrator,
  getChannel,
  PrintQueue,
  readLogoFileBuffer,
  type PreviewPayload
} from '../printing/print.service'
import type { PrintSettings } from '../printing/print.service'
import { createSaleRepo } from '../db/repositories/sale.repo'
import { createSettingsRepo } from '../db/repositories/settings.repo'
import { createTemplateRepo } from '../db/repositories/template.repo'
import type { AppSettings } from '../../shared/types'
import { rowsToAppSettings } from './settings.ipc'

/**
 * 打印 IPC 薄层（Task 19 打印设置 + Task 15 打印编排）。
 *
 * 通道：
 *  - printing:printers  系统打印机枚举（T7 listSystemPrinters 消费面）
 *  - printing:testPrint 最小 ESC/POS 测试字节发送（T7 getChannel + PrintQueue 消费面）
 *  - printing:preview   小票预览（T15：预览与打印同源组装——G7）
 *  - printing:print     小票打印（T15：串行队列 best-effort，失败不影响已保存销售——G3）
 *
 * ★ 只消费上游产物（printer-enumerator / print-channel 守卫 / getChannel /
 *   PrintQueue / generateReceiptBytes / 各 repo），不改动 channels/ 与
 *   escpos-generator 内部任何代码。
 * ★ `require('electron')` 懒加载（T2 模式）：TEST_PRINT_BYTES / toPrintSettings /
 *   parseSaleId 等纯部分可在 vitest 纯 Node 环境导入。
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
 * 测试打印的最小 ESC/POS 字节流（与 T4 契约字节逐字对齐）：
 *   ESC @（初始化）→ ESC a 1（居中）→ 'test' → LF×2（走纸）→ GS V 66 0（全切）
 */
export const TEST_PRINT_BYTES: Uint8Array = new Uint8Array([
  0x1b, 0x40, // ESC @  初始化
  0x1b, 0x61, 0x01, // ESC a 1  居中
  0x74, 0x65, 0x73, 0x74, // 'test'（ASCII）
  0x0a, 0x0a, // LF ×2  走纸
  0x1d, 0x56, 0x42, 0x00 // GS V 66 0  全切
])

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

export function registerPrintingIpc(db: Database.Database): void {
  // 懒 require（T2 模式）：本模块纯部分可在 vitest 纯 Node 环境导入
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  // G11：惰性取窗口——每次枚举时求值（窗口可能尚未创建/已销毁）；
  // 无窗口 / Linux 无打印子系统 → enumerator 内部已捕获，返回 []（不崩溃）
  const enumerator = createPrinterEnumerator(() => BrowserWindow.getAllWindows()[0])

  // ── Task 15：打印编排装配（repo → 编排器；队列随编排器实例级单例串行） ──
  const saleRepo = createSaleRepo(db)
  const templateRepo = createTemplateRepo(db)
  const settingsRepo = createSettingsRepo(db)
  const currentSettings = (): AppSettings => rowsToAppSettings(settingsRepo.getAll())
  const orchestrator = createPrintOrchestrator({
    getSaleDetail: (saleId) => saleRepo.getDetail(saleId),
    getDefaultTemplate: () => templateRepo.getDefault(),
    getSettings: currentSettings,
    readLogoFile: readLogoFileBuffer
  })

  ipcMain.handle('printing:printers', async (): Promise<PrinterEntry[]> => {
    const printers = await enumerator.listSystemPrinters()
    return printers.map((p) => ({ name: p.name, is_default: p.isDefault ?? false }))
  })

  /**
   * 测试打印：走 T7 的 getChannel + PrintQueue（不绕过串行队列）。
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
        await new PrintQueue(channel).enqueuePrintJob(TEST_PRINT_BYTES)
        return { ok: true }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `测试打印失败（${settings.printer_channel} 通道）：${detail}` }
      }
    }
  )

  /**
   * 小票预览（T15）：saleId → PreviewPayload（模板/明细/vars/logoUrl）——
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
}
