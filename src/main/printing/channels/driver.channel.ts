import type { WebContentsPrintOptions } from 'electron'
import { FIT_TO_WIDTH_BODY } from '../driver/receipt-html'
import type { PrintChannel } from './print-channel'

/**
 * driver 兜底通道（Windows 打印机驱动 GDI 渲染——「云」热敏机兼容方案）。
 *
 * 为什么存在：得力 DL-5801PW 等 58mm 云外卖打印机能收到 spooler RAW 字节，
 * 但其固件**没有中文字模**（20261118 F1 编码探针实证）：S1 ASCII 与 S4 光栅
 * 黑块都正常 → 传输层与 ESC/POS 指令层（含 `GS v 0`）完好；S2 UTF-8 与
 * S3 GBK+FS & 的中文一律不出，且 `A1` 前的空白格数 ≈ 该段高位字节数
 * （S2 18 格 / S3 12 格，差值恰为 6 字 ×(3−2) 字节）→ 固件对每个 ≥0x80
 * 字节「吃掉 + 推进一个半角空位 + 不画点」，与编码、与汉字模式均无关。
 * 所以文本中文在 RAW 通道无解（编码类修法全部无望），只能靠位图；而同一台
 * 机器走 Windows 打印机驱动渲染（Word 打印的同一条路径，由驱动光栅化）
 * 中文与图片都完美（真机已验证）。
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

/** px → 微米换算（Chromium 96dpi：1px = 25400/96 μm） */
const PX_TO_MICRONS = 25_400 / 96

/** 页高安全垫（μm）：倍高 transform 不占布局高度 + 驱动分页舍入，防末行裁切 */
const HEIGHT_SAFETY_PAD_MICRONS = 2_000

/** 打印整体超时（加载/测量/打印回调任一环节挂死都兜底；同 spooler PowerShell 30s 基准） */
const DRIVER_PRINT_TIMEOUT_MS = 30_000

/**
 * logo decode 等待脚本（测量前执行一次——v2 症状 2「加 logo 后内容消失」修复）：
 * 根因是测量竞态——scrollHeight 在 img.receipt-logo 解码完成前偏小，页高被低估
 * → 驱动按矮页打印裁掉内容。测量前等 decode 安定即消除竞态（render-check 的
 * 两次测量正是该竞态的证据采集器，真机 fixture symptom2 Δ265px）。
 * - decode 成功/失败都 resolve（坏图不阻塞打印——render-check SECOND_MEASURE_SCRIPT
 *   同款惯用式 `i.decode().then(() => r(), () => r())`）；
 * - 无 logo / 无 decode API 立即 resolve（零成本通过）；
 * - decode 永不定局由外层 30s settle 兜底（不加 decode 专属超时）。
 */
const LOGO_DECODE_WAIT_SCRIPT =
  "new Promise(r => { const i = document.querySelector('img.receipt-logo'); if (i && i.decode) { i.decode().then(() => r(), () => r()); } else { r(); } })"

/**
 * 版面自适应 + 测量（单次 JS 往返，在 logo decode 安定之后执行）：
 *  1. FIT_TO_WIDTH_BODY 按实测 scrollWidth/clientWidth 比例回缩字号，直到网格不溢出
 *     容器（真机 20261117：该机 ASCII 逐字回退到 0.594em 的 monospace，每行比设计
 *     宽 18.75%，右对齐的合计行金额尾数被 overflow:hidden 吃掉）；
 *  2. 再量页高（必须在回缩**之后**——字号变了行高就变了，先量会高估页高），
 *     且取 **`.receipt-paper` 元素级** scrollHeight（+offsetTop 补容器顶偏移），
 *     不用 documentElement：后者是 max(视口,内容)，隐藏窗默认 600px 高会把短
 *     小票的页高抬到地板值（≈159mm 走纸）——render-check v2 Bug3 同源修复，非收据
 *     HTML（无该元素）回退 documentElement 语义；
 *  3. 页宽改读 data-page-width-microns（= 可打印宽，与驱动 DEVMODE 同基准），不再由
 *     data-paper-width 查表换算成纸张物理宽。
 */
const FIT_AND_MEASURE_SCRIPT = `JSON.stringify((() => { ${FIT_TO_WIDTH_BODY} const el = document.querySelector('.receipt-paper'); return { h: el ? el.scrollHeight + el.offsetTop : document.documentElement.scrollHeight, pageWidthMicrons: document.body.dataset.pageWidthMicrons }; })())`

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
 * driver 通道实验打印选项（v2——消费 AppSettings 两实验键 driver_dpi /
 * driver_use_default_page_size，Electron GDI 静默打印已知问题群（#31705/
 * #50481/#39179）的 workaround 开关；生产由 print.service 装配 settings 闭包
 * 注入，vitest 直传免依赖）。
 */
export interface DriverPrintOptions {
  /** 显式 DPI（null/缺省 = 不设置走驱动缺省）；正整数才进 print options */
  driverDpi?: number | null
  /** 使用驱动默认页尺寸（Electron 44：usePrinterDefaultPageSize 与 pageSize 互斥） */
  useDefaultPageSize?: boolean
}

/**
 * 收据 HTML → 隐藏窗口 → webContents.print（核心流程，可注入窗口工厂单测）：
 *  1. UTF-8 解码载荷（HTML 文档）→ data: URL 加载（不触应用路由）；
 *  1.5 logo decode 等待（测量竞态修复——见 LOGO_DECODE_WAIT_SCRIPT；best-effort，
 *      基础设施级执行失败不阻塞，照常进入测量）；
 *  2. executeJavaScript 版面自适应（FIT_TO_WIDTH_BODY）+ 量元素级页高 + 读
 *     data-page-width-microns（页宽微米 = 可打印宽）；
 *  3. print(silent + deviceName + 按内容高度定页高 + 无边距 + 实验选项条件组装)；
 *  4. 任一环节失败/30s 超时 → reject 可诊断中文错误，finally destroy 窗口。
 */
export function printHtmlViaDriver(
  html: string,
  printerName: string,
  createWindowFn: DriverCreateWindowFn = defaultCreateWindowFn,
  options: DriverPrintOptions = {}
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

      // 1.5 logo decode 等待（测量前——症状 2 修复）：best-effort，执行失败不阻塞
      // （decode 的坏图 reject 已被脚本内吞掉；此处仅覆盖 executeJavaScript 基础
      // 设施级失败——窗口已死时后续测量自会给出可诊断错误，30s settle 仍兜底）
      try {
        await win.webContents.executeJavaScript(LOGO_DECODE_WAIT_SCRIPT)
      } catch {
        // 等待失败 ≠ 打印失败——照常进入测量
      }

      // 2. 版面自适应 + 测量：元素级页高（px）+ data-page-width-microns（页宽）——单次 JS 调用取齐
      let measured: unknown
      try {
        measured = await win.webContents.executeJavaScript(FIT_AND_MEASURE_SCRIPT)
      } catch (err) {
        settle(new Error(`driver channel 收据页面测量失败：${errorDetail(err)}`))
        return
      }
      let parsed: { h?: unknown; pageWidthMicrons?: unknown }
      try {
        parsed = JSON.parse(String(measured)) as { h?: unknown; pageWidthMicrons?: unknown }
      } catch {
        settle(new Error('driver channel 收据页面测量结果不可解析（非 JSON）'))
        return
      }
      const pxHeight = parsed.h
      const rawMicrons = parsed.pageWidthMicrons
      if (typeof pxHeight !== 'number' || !Number.isFinite(pxHeight) || pxHeight <= 0) {
        settle(new Error(`driver channel 收据页面高度非法（scrollHeight=${String(pxHeight)}）`))
        return
      }
      const pageMicrons =
        typeof rawMicrons === 'string' && /^\d+$/.test(rawMicrons)
          ? Number.parseInt(rawMicrons, 10)
          : 0
      if (pageMicrons <= 0) {
        settle(
          new Error(
            `driver channel 页宽属性缺失或非法（data-page-width-microns=${String(
              rawMicrons
            )}，应为正整数微米）`
          )
        )
        return
      }
      // px → μm 向上取整 + 安全垫（倍高 transform 不占布局高度的补偿）
      const heightMicrons = Math.ceil(pxHeight * PX_TO_MICRONS) + HEIGHT_SAFETY_PAD_MICRONS

      // 3. 静默打印选项条件组装（v2 实验键——Electron 44 文档实证）：
      //  - useDefaultPageSize=true → 无 pageSize 键（与自定义页尺寸互斥——
      //    Cannot be combined）+ usePrinterDefaultPageSize:true；
      //  - 否则维持 v1 自定义 pageSize（测量数学零改动）；
      //  - driverDpi 正整数 → dpi Record 形状（标量同值填横竖）；
      //  条件 spread 保证未启用的实验键物理不存在（deepEqual/键集断言的前提）。
      const dpi =
        typeof options.driverDpi === 'number' &&
        Number.isInteger(options.driverDpi) &&
        options.driverDpi > 0
          ? { dpi: { horizontal: options.driverDpi, vertical: options.driverDpi } }
          : {}
      const printOptions: Record<string, unknown> = {
        silent: true,
        printBackground: true,
        deviceName: printerName,
        ...(options.useDefaultPageSize === true
          ? { usePrinterDefaultPageSize: true }
          : { pageSize: { width: pageMicrons, height: heightMicrons } }),
        ...dpi,
        margins: { marginType: 'none' }
      }

      // 静默打印：设备名 + 上述条件组装选项 + 无边距（页宽即可打印宽，内容恰好铺满）
      win.webContents.print(printOptions, (success, reason) => {
        if (success) settle()
        else
          settle(
            new Error(
              `driver channel 驱动打印失败（打印机：${printerName || '未指定'}）：${reason}`
            )
          )
      })
    })()
  })
}

/** driver 通道配置 */
export interface DriverChannelOptions {
  /** 系统打印机名（settings.printer_name） */
  printerName: string
  /** 窗口工厂注入点（单测 fake 用；生产默认懒 require Electron 的隐藏 BrowserWindow） */
  createWindowFn?: DriverCreateWindowFn
  /** 实验打印选项注入（每次 send 时调用——生产由 print.service 装配 settings 闭包，测试 fake 注入免依赖） */
  getDriverOptions?: () => DriverPrintOptions
}

/** driver 兜底通道（PrintChannel 实现）：收据 HTML（UTF-8 字节）→ 驱动渲染打印 */
export class DriverChannel implements PrintChannel {
  readonly name = 'driver' as const
  readonly printerName: string
  private readonly createWindowFn: DriverCreateWindowFn
  private readonly getDriverOptions: () => DriverPrintOptions

  constructor(options: DriverChannelOptions) {
    this.printerName = options.printerName
    this.createWindowFn = options.createWindowFn ?? defaultCreateWindowFn
    this.getDriverOptions = options.getDriverOptions ?? (() => ({}))
  }

  send(bytes: Uint8Array): Promise<void> {
    if (!this.printerName) {
      return Promise.reject(
        new Error('driver channel 需要打印机名（settings.printer_name 不能为空）')
      )
    }
    // 载荷语义：bytes = 收据 HTML 的 UTF-8 编码（不是 ESC/POS 指令）
    const html = Buffer.from(bytes).toString('utf8')
    return printHtmlViaDriver(html, this.printerName, this.createWindowFn, this.getDriverOptions())
  }
}
