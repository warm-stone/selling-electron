import { isPrintChannelKind } from '../printing/channels/print-channel'
import { createPrinterEnumerator } from '../printing/channels/printer-enumerator'
import { getChannel, PrintQueue } from '../printing/print.service'
import type { PrintSettings } from '../printing/print.service'
import type { AppSettings } from '../../shared/types'

/**
 * 打印设置 IPC 薄层（Task 19）。
 *
 * 通道：
 *  - printing:printers  系统打印机枚举（T7 listSystemPrinters 消费面）
 *  - printing:testPrint 最小 ESC/POS 测试字节发送（T7 getChannel + PrintQueue 消费面）
 *
 * ★ 只消费 T7 产物（printer-enumerator / print-channel 守卫 / getChannel / PrintQueue），
 *   不改动 channels/ 任何代码。
 * ★ `require('electron')` 懒加载（T2 模式）：TEST_PRINT_BYTES / toPrintSettings /
 *   PrinterEntry 等纯部分可在 vitest 纯 Node 环境导入。
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

export function registerPrintingIpc(): void {
  // 懒 require（T2 模式）：本模块纯部分可在 vitest 纯 Node 环境导入
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  // G11：惰性取窗口——每次枚举时求值（窗口可能尚未创建/已销毁）；
  // 无窗口 / Linux 无打印子系统 → enumerator 内部已捕获，返回 []（不崩溃）
  const enumerator = createPrinterEnumerator(() => BrowserWindow.getAllWindows()[0])

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
}
