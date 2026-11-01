import type { PrinterInfo } from './print-channel'

/**
 * Task 7 — 系统打印机枚举（printer-enumerator.ts）。
 *
 * 封装 Electron `webContents.getPrintersAsync()`。
 * 关键设计（G11）：
 *  - 通过最小结构接口 PrintersCapableWindow 引用窗口（不 import electron 运行时，
 *    BrowserWindow 天然结构兼容），vitest node 环境可直接 fake；
 *  - 无窗口 / 窗口已销毁 / 平台不支持（Linux 无打印子系统）/ getPrintersAsync 抛错
 *    —— 一律返回空数组，绝不抛错（Linux CI 与无窗口装配安全）；
 *  - 装配（T15）时传入 `() => BrowserWindow.getAllWindows()[0]`。
 */

/** BrowserWindow 的最小结构（仅枚举所需；结构兼容真实 BrowserWindow） */
export interface PrintersCapableWindow {
  isDestroyed(): boolean
  webContents: { getPrintersAsync(): Promise<unknown[]> }
}

/** 窗口提供者：惰性获取（每次枚举时求值，窗口可能中途关闭） */
export type WindowProvider = () => PrintersCapableWindow | null | undefined

/** 防御性归一：Electron PrinterInfo → 本模块 PrinterInfo（脏数据丢弃） */
function normalizePrinter(raw: unknown): PrinterInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec['name'] !== 'string' || rec['name'] === '') return null
  const info: PrinterInfo = { name: rec['name'] }
  if (typeof rec['displayName'] === 'string') info.displayName = rec['displayName']
  if (typeof rec['description'] === 'string') info.description = rec['description']
  if (typeof rec['status'] === 'number') info.status = rec['status']
  if (typeof rec['isDefault'] === 'boolean') info.isDefault = rec['isDefault']
  return info
}

export interface PrinterEnumerator {
  /** 列出系统打印机；任何不可用场景返回 []（不抛错，G11） */
  listSystemPrinters(): Promise<PrinterInfo[]>
}

export function createPrinterEnumerator(getWindow?: WindowProvider): PrinterEnumerator {
  return {
    async listSystemPrinters(): Promise<PrinterInfo[]> {
      try {
        const win = getWindow?.()
        if (!win) return []
        if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return []
        const printers = await win.webContents.getPrintersAsync()
        if (!Array.isArray(printers)) return []
        return printers
          .map(normalizePrinter)
          .filter((p): p is PrinterInfo => p !== null)
      } catch {
        // Linux 无打印子系统 / webContents 不可用 / 平台差异 → 空数组（G11）
        return []
      }
    }
  }
}
