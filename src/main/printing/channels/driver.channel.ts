import type { WebContentsPrintOptions } from 'electron'
import type { PrintChannel } from './print-channel'

/**
 * driver 兜底通道（Windows 打印机驱动 GDI 渲染——「云」热敏机兼容方案）。
 *
 * 为什么存在：得力 DL-5801PW 等 58mm 云外卖打印机能收到 spooler RAW 字节，
 * 但其云固件把原始载荷当 UTF-8 文本渲染——GBK 中文双字节是非法 UTF-8 被
 * 静默丢弃，ESC/POS 光栅指令（GS v 0）也不被支持；而同一台机器走 Windows
 * 打印机驱动渲染（Word 打印的同一条路径）中文与图片都完美（真机已验证）。
 * 因此本通道不发原始字节，而是把收据渲染成完整 HTML（driver/receipt-html.ts，
 * G7 同源第三渲染器），加载进隐藏 BrowserWindow 后走
 * webContents.print(silent + deviceName)——由系统驱动完成光栅化，
 * 与原始字节通道互为补充的 100% 兼容兜底。
 *
 * 字节契约：send(bytes) 的 bytes 是收据 HTML 文档的 UTF-8 编码——
 * PrintChannel 接口形态不变（send(bytes)），队列/重试/G3 错误处理全复用，
 * 仅载荷语义在 driver 通道下从「ESC/POS 字节」切换为「HTML 即字节」。
 *
 * DI 模式（同 spooler 的 execFileFn）：createWindowFn 可注入假窗口，
 * 单测免 Electron、不弹真窗口（G11/Linux 可测）。
 *
 * 平台语义（与 spooler 相反）：**非 win32 不拒绝**——webContents.print 走
 * 系统打印子系统，macOS/Linux 同样可用（错误由驱动链路自然上抛）。
 */

/** 驱动渲染打印窗口的最小接口（BrowserWindow 的结构子集；测试注入 fake 用） */
export interface DriverPrintWindow {
  webContents: {
    loadURL(url: string): Promise<void>
    executeJavaScript(code: string): Promise<unknown>
    print(options: unknown, callback: (success: boolean, reason: string) => void): void
  }
  destroy(): void
}

/** 窗口工厂注入点（html 参数供自定义工厂消费；默认工厂仅开隐藏窗、稍后由 send 流程加载） */
export type DriverCreateWindowFn = (html: string) => DriverPrintWindow

/** 纸宽 → 页宽微米（body[data-paper-width] 读取值；1mm = 1000μm） */
const PAPER_WIDTH_MICRONS: Record<string, number> = {
  '58mm': 58_000,
  '80mm': 80_000
}

/** px → 微米换算（Chromium 96dpi：1px = 25400/96 μm） */
const PX_TO_MICRONS = 25_400 / 96

/** 页高安全垫（μm）：倍高 transform 不占布局高度 + 驱动分页舍入，防末行裁切 */
const HEIGHT_SAFETY_PAD_MICRONS = 2_000

/** 打印整体超时（加载/测量/打印回调任一环节挂死都兜底；同 spooler PowerShell 30s 基准） */
const DRIVER_PRINT_TIMEOUT_MS = 30_000

/**
 * 默认窗口工厂：懒 require('electron')（T2 模式——本模块可在 vitest 纯
 * Node 环境导入；仅生产 send 路径真正触达 Electron）。BrowserWindow 按
 * DriverPrintWindow 结构适配包装（隐藏窗口 + webContents 三方法 + destroy）。
 */
const defaultCreateWindowFn = (_html: string): DriverPrintWindow => {
  const { BrowserWindow } = require('electron') as typeof import('electron')
  const win = new BrowserWindow({ show: false })
  return {
    webContents: {
      loadURL: (url: string) => win.webContents.loadURL(url),
      executeJavaScript: (code: string) => win.webContents.executeJavaScript(code),
      print: (options: unknown, callback: (success: boolean, reason: string) => void) =>
        // 接口层 options 为 unknown（测试可注入任意形状）；适配真实 Electron 签名
        win.webContents.print(options as WebContentsPrintOptions, callback)
    },
    destroy: () => win.destroy()
  }
}

/** 错误消息细节归一（unknown → string） */
function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 收据 HTML → 隐藏窗口 → webContents.print（核心流程，可注入窗口工厂单测）：
 *  1. UTF-8 解码载荷（HTML 文档）→ data: URL 加载（不触应用路由）；
 *  2. executeJavaScript 测量内容高度 + 读 data-paper-width（页宽微米）；
 *  3. print(silent + deviceName + 按内容高度定页高 + 无边距)；
 *  4. 任一环节失败/30s 超时 → reject 可诊断中文错误，finally destroy 窗口。
 */
export function printHtmlViaDriver(
  html: string,
  printerName: string,
  createWindowFn: DriverCreateWindowFn = defaultCreateWindowFn
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const win = createWindowFn(html)
    let settled = false
    let timer: NodeJS.Timeout | undefined

    /** 唯一出口：清超时 + 销毁窗口（幂等）+ settle（先到者胜，后续回调 no-op） */
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        win.destroy()
      } catch {
        // destroy 幂等/窗口已销毁 → 忽略（不影响结果上报）
      }
      if (err) reject(err)
      else resolve()
    }

    timer = setTimeout(() => {
      settle(
        new Error(
          `driver channel 打印超时（${DRIVER_PRINT_TIMEOUT_MS / 1000}s，打印机：${printerName || '未指定'}）`
        )
      )
    }, DRIVER_PRINT_TIMEOUT_MS)

    void (async () => {
      // 1. data: URL 加载（encodeURIComponent 保证中文/引号在 URL 内安全）
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
      try {
        await win.webContents.loadURL(dataUrl)
      } catch (err) {
        settle(new Error(`driver channel 收据页面加载失败：${errorDetail(err)}`))
        return
      }

      // 2. 测量：scrollHeight（px）+ data-paper-width（页宽）——单次 JS 调用取齐
      let measured: unknown
      try {
        measured = await win.webContents.executeJavaScript(
          'JSON.stringify({h: document.documentElement.scrollHeight, paper: document.body.dataset.paperWidth})'
        )
      } catch (err) {
        settle(new Error(`driver channel 收据页面测量失败：${errorDetail(err)}`))
        return
      }
      let parsed: { h?: unknown; paper?: unknown }
      try {
        parsed = JSON.parse(String(measured)) as { h?: unknown; paper?: unknown }
      } catch {
        settle(new Error('driver channel 收据页面测量结果不可解析（非 JSON）'))
        return
      }
      const pxHeight = parsed.h
      const paper = parsed.paper
      if (typeof pxHeight !== 'number' || !Number.isFinite(pxHeight) || pxHeight <= 0) {
        settle(new Error(`driver channel 收据页面高度非法（scrollHeight=${String(pxHeight)}）`))
        return
      }
      const paperMicrons = typeof paper === 'string' ? PAPER_WIDTH_MICRONS[paper] : undefined
      if (paperMicrons === undefined) {
        settle(
          new Error(
            `driver channel 页宽属性缺失或非法（data-paper-width=${String(paper)}，应为 58mm/80mm）`
          )
        )
        return
      }
      // px → μm 向上取整 + 安全垫（倍高 transform 不占布局高度的补偿）
      const heightMicrons = Math.ceil(pxHeight * PX_TO_MICRONS) + HEIGHT_SAFETY_PAD_MICRONS

      // 3. 静默打印：设备名 + 按内容高度定页高（连续纸不自分页）+ 无边距（纸宽即内容宽）
      win.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: printerName,
          pageSize: { width: paperMicrons, height: heightMicrons },
          margins: { marginType: 'none' }
        },
        (success, reason) => {
          if (success) settle()
          else
            settle(
              new Error(
                `driver channel 驱动打印失败（打印机：${printerName || '未指定'}）：${reason}`
              )
            )
        }
      )
    })()
  })
}

/** driver 通道配置 */
export interface DriverChannelOptions {
  /** 系统打印机名（settings.printer_name） */
  printerName: string
  /** 窗口工厂注入点（单测 fake 用；生产默认懒 require Electron 的隐藏 BrowserWindow） */
  createWindowFn?: DriverCreateWindowFn
}

/** driver 兜底通道（PrintChannel 实现）：收据 HTML（UTF-8 字节）→ 驱动渲染打印 */
export class DriverChannel implements PrintChannel {
  readonly name = 'driver' as const
  readonly printerName: string
  private readonly createWindowFn: DriverCreateWindowFn

  constructor(options: DriverChannelOptions) {
    this.printerName = options.printerName
    this.createWindowFn = options.createWindowFn ?? defaultCreateWindowFn
  }

  send(bytes: Uint8Array): Promise<void> {
    if (!this.printerName) {
      return Promise.reject(
        new Error('driver channel 需要打印机名（settings.printer_name 不能为空）')
      )
    }
    // 载荷语义：bytes = 收据 HTML 的 UTF-8 编码（不是 ESC/POS 指令）
    const html = Buffer.from(bytes).toString('utf8')
    return printHtmlViaDriver(html, this.printerName, this.createWindowFn)
  }
}
