import { describe, expect, it, vi } from 'vitest'
import {
  DriverChannel,
  printHtmlViaDriver,
  type DriverPrintWindow
} from '../../../../src/main/printing/channels/driver.channel'

/**
 * driver 兜底通道单元测试（DI 注入 fake 窗口，**免 Electron、不弹真窗口**——
 * 与 spooler.channel.test 注入 fake execFile 同款模式）。
 * 验证：HTML 即字节的载荷契约、data: URL 加载、高度/纸宽测量 → pageSize 微米
 * 换算（58mm→58000 / 80mm→80000，px→μm 向上取整 + 2000μm 安全垫）、
 * silent/printBackground/deviceName/无边距选项、失败/缺属性/超时可诊断中文错误、
 * 窗口必被销毁（finally 语义）。
 */

/** webContents.print 捕获选项（DriverPrintWindow.options 为 unknown，此处结构化断言用） */
interface CapturedPrintOptions {
  silent: boolean
  printBackground: boolean
  deviceName: string
  pageSize: { width: number; height: number }
  margins: { marginType: string }
}

/** px → μm（96dpi）+ 安全垫——与通道内换算一致的期望值助手 */
const expectedHeightMicrons = (pxHeight: number): number =>
  Math.ceil(pxHeight * (25_400 / 96)) + 2_000

interface FakeCalls {
  loadedUrl: string
  executed: string[]
  printOptions: CapturedPrintOptions[]
  destroyed: number
}

/**
 * 可编排假窗口：measureJson 控制 executeJavaScript 返回（默认 800px/58mm）；
 * printResult 'ok' 立即回调成功、'fail' 回调失败、'hang' 永不回调（超时路径）。
 */
function makeFakeWindow(
  o: {
    measureJson?: string
    printResult?: 'ok' | 'fail' | 'hang'
    loadUrlError?: Error
    execError?: Error
  } = {}
): { win: DriverPrintWindow; calls: FakeCalls } {
  const calls: FakeCalls = { loadedUrl: '', executed: [], printOptions: [], destroyed: 0 }
  const win: DriverPrintWindow = {
    webContents: {
      loadURL: vi.fn(async (url: string) => {
        calls.loadedUrl = url
        if (o.loadUrlError) throw o.loadUrlError
      }),
      executeJavaScript: vi.fn(async (code: string) => {
        calls.executed.push(code)
        if (o.execError) throw o.execError
        return o.measureJson ?? JSON.stringify({ h: 800, paper: '58mm' })
      }),
      print: vi.fn((options: unknown, callback: (success: boolean, reason: string) => void) => {
        calls.printOptions.push(options as CapturedPrintOptions)
        if (o.printResult === 'fail') callback(false, '打印机不存在（win32=1801）')
        else if (o.printResult === 'hang') return // 永不回调：驱动挂死 → 超时兜底
        else callback(true, '')
      })
    },
    destroy: vi.fn(() => {
      calls.destroyed += 1
    })
  }
  return { win, calls }
}

/** 收据 HTML（含 data-paper-width——通道测量契约的载荷前提） */
const RECEIPT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body data-paper-width="58mm"><div class="receipt-paper">测试便利店</div></body></html>`

const htmlBytes = (html: string): Uint8Array => Buffer.from(html, 'utf8')

describe('DriverChannel', () => {
  it('name 为 driver，printerName 参数化', () => {
    const ch = new DriverChannel({ printerName: '前台驱动打印机' })
    expect(ch.name).toBe('driver')
    expect(ch.printerName).toBe('前台驱动打印机')
  })

  it('缺打印机名 → 拒绝并提示配置 printer_name（同 spooler 守卫语义）', async () => {
    const ch = new DriverChannel({ printerName: '' })
    await expect(ch.send(htmlBytes(RECEIPT_HTML))).rejects.toThrow('printer_name 不能为空')
  })

  it('send 成功链路：data: URL 加载（encodeURIComponent）→ 测量 → 静默打印 → 销毁窗口', async () => {
    const { win, calls } = makeFakeWindow({ measureJson: JSON.stringify({ h: 800, paper: '58mm' }) })
    const createWindowFn = vi.fn(() => win)
    const ch = new DriverChannel({ printerName: '前台驱动打印机', createWindowFn })

    await ch.send(htmlBytes(RECEIPT_HTML))

    // 工厂收到原始 HTML（载荷以 HTML 文档形态进入通道）
    expect(createWindowFn).toHaveBeenCalledWith(RECEIPT_HTML)
    // data: URL 加载（中文安全编码，round-trip 还原）
    expect(calls.loadedUrl).toBe(`data:text/html;charset=utf-8,${encodeURIComponent(RECEIPT_HTML)}`)
    // 测量脚本：scrollHeight + data-paper-width 一次取齐
    expect(calls.executed).toHaveLength(1)
    expect(calls.executed[0]).toContain('scrollHeight')
    expect(calls.executed[0]).toContain('paperWidth')
    // 打印选项全要素：静默 + 背景 + 设备名 + 无边距 + 58mm 页宽微米 + 测量页高
    expect(calls.printOptions).toHaveLength(1)
    expect(calls.printOptions[0]).toEqual({
      silent: true,
      printBackground: true,
      deviceName: '前台驱动打印机',
      pageSize: { width: 58_000, height: expectedHeightMicrons(800) },
      margins: { marginType: 'none' }
    })
    // 窗口最终销毁（成功路径）
    expect(calls.destroyed).toBe(1)
  })

  it('80mm 纸宽 → 页宽 80000μm；页高按测量值换算（h=1000px）', async () => {
    const { win, calls } = makeFakeWindow({
      measureJson: JSON.stringify({ h: 1000, paper: '80mm' })
    })
    const ch = new DriverChannel({ printerName: 'POS-80', createWindowFn: () => win })

    await ch.send(htmlBytes(RECEIPT_HTML))

    expect(calls.printOptions[0]?.pageSize).toEqual({
      width: 80_000,
      height: expectedHeightMicrons(1000)
    })
    expect(calls.destroyed).toBe(1)
  })

  it('驱动回调 success=false → 拒绝并携带 reason 详情，窗口销毁', async () => {
    const { win, calls } = makeFakeWindow({ printResult: 'fail' })
    const ch = new DriverChannel({ printerName: 'POS-80', createWindowFn: () => win })

    await expect(ch.send(htmlBytes(RECEIPT_HTML))).rejects.toThrow(
      /驱动打印失败.*POS-80.*打印机不存在/
    )
    expect(calls.destroyed).toBe(1)
  })

  it('页面加载失败 → 拒绝可诊断中文错误，窗口销毁', async () => {
    const { win, calls } = makeFakeWindow({ loadUrlError: new Error('ERR_ABORTED') })
    const ch = new DriverChannel({ printerName: 'POS-80', createWindowFn: () => win })

    await expect(ch.send(htmlBytes(RECEIPT_HTML))).rejects.toThrow(/页面加载失败.*ERR_ABORTED/)
    expect(calls.destroyed).toBe(1)
  })

  it('测量脚本失败 → 拒绝可诊断中文错误', async () => {
    const { win } = makeFakeWindow({ execError: new Error('script timeout') })
    const ch = new DriverChannel({ printerName: 'POS-80', createWindowFn: () => win })

    await expect(ch.send(htmlBytes(RECEIPT_HTML))).rejects.toThrow(/测量失败.*script timeout/)
  })

  it('测量结果非 JSON / 高度非法 / 纸宽属性缺失或非法 → 拒绝并提示 data-paper-width', async () => {
    const bad: string[] = [
      'not-json{{',
      JSON.stringify({ h: 'x-large', paper: '58mm' }),
      JSON.stringify({ h: 0 }),
      JSON.stringify({ h: 800 }),
      JSON.stringify({ h: 800, paper: '88mm' })
    ]
    for (const measureJson of bad) {
      const { win } = makeFakeWindow({ measureJson })
      const ch = new DriverChannel({ printerName: 'POS-80', createWindowFn: () => win })
      await expect(ch.send(htmlBytes(RECEIPT_HTML))).rejects.toThrow(
        /driver channel.*(不可解析|非法|data-paper-width)/
      )
    }
  })

  it('驱动回调挂死 → 30s 超时兜底拒绝并销毁窗口', async () => {
    vi.useFakeTimers()
    try {
      const { win, calls } = makeFakeWindow({ printResult: 'hang' })
      const ch = new DriverChannel({ printerName: 'POS-80', createWindowFn: () => win })

      const pending = ch.send(htmlBytes(RECEIPT_HTML))
      const assertion = expect(pending).rejects.toThrow(/打印超时.*30s/)
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
      expect(calls.destroyed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('printHtmlViaDriver：注入窗口工厂直调（html 透传工厂；无 printer_name 守卫——直调层由调用方保证）', async () => {
    const { win, calls } = makeFakeWindow()
    await printHtmlViaDriver(RECEIPT_HTML, 'POS-58', () => win)
    expect(calls.printOptions[0]?.deviceName).toBe('POS-58')
    expect(calls.destroyed).toBe(1)
  })
})
