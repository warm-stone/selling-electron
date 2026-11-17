import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { FIT_TO_WIDTH_BODY } from '../../../../src/main/printing/driver/receipt-html'
import {
  DriverChannel,
  printHtmlViaDriver,
  type DriverChannelOptions,
  type DriverPrintWindow
} from '../../../../src/main/printing/channels/driver.channel'

/**
 * driver 兜底通道单元测试（DI 注入 fake 窗口，**免 Electron、不弹真窗口**——
 * 与 spooler.channel.test 注入 fake execFile 同款模式）。
 * 验证：HTML 即字节的载荷契约、data: URL 加载、logo decode 等待（测量前——v2
 * 症状 2 修复）、版面自适应 + 元素级页高/页宽测量 → pageSize 微米换算（v3：页宽
 * 直读 data-page-width-microns = **可打印宽**，58mm 纸→48000 / 80mm 纸→72000；
 * px→μm 向上取整 + 2000μm 安全垫）、silent/printBackground/deviceName/无边距选项、
 * 实验选项条件组装（v2：dpi Record 形状 / useDefaultPageSize 互斥 / 缺省 v1 形状
 * deepEqual 硬锁）、失败/缺属性/超时可诊断中文错误、窗口必被销毁（finally 语义）。
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
 * printResult 'ok' 立即回调成功、'fail' 回调失败、'hang' 永不回调（超时路径）；
 * decodeBehavior 控制 logo decode 等待脚本（按 code 含 receipt-logo 识别）——
 * 'resolve' 立即通过（默认：无 logo/解码完成的 fake 等价）、'reject' 模拟
 * executeJavaScript 基础设施级失败、'pending' 挂起等待 releaseDecode() 放行
 * （验证 decode 等待在测量之前——decode 未定局时测量不得发生）。
 */
function makeFakeWindow(
  o: {
    measureJson?: string
    printResult?: 'ok' | 'fail' | 'hang'
    loadUrlError?: Error
    execError?: Error
    decodeBehavior?: 'resolve' | 'reject' | 'pending'
  } = {}
): { win: DriverPrintWindow; calls: FakeCalls; releaseDecode: () => void } {
  const calls: FakeCalls = { loadedUrl: '', executed: [], printOptions: [], destroyed: 0 }
  let decodeGate: Promise<void> | undefined
  let releaseDecode: () => void = () => {}
  if (o.decodeBehavior === 'pending') {
    decodeGate = new Promise<void>((r) => {
      releaseDecode = r
    })
  }
  const win: DriverPrintWindow = {
    webContents: {
      loadURL: vi.fn(async (url: string) => {
        calls.loadedUrl = url
        if (o.loadUrlError) throw o.loadUrlError
      }),
      executeJavaScript: vi.fn(async (code: string) => {
        calls.executed.push(code)
        if (o.execError) throw o.execError
        if (code.includes('receipt-logo')) {
          if (o.decodeBehavior === 'reject') throw new Error('decode 等待脚本执行失败（fake）')
          if (decodeGate) await decodeGate
          return null
        }
        return o.measureJson ?? JSON.stringify({ h: 800, pageWidthMicrons: '48000' })
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
  return { win, calls, releaseDecode }
}

/** 收据 HTML（含 data-page-width-microns——通道页宽测量契约的载荷前提） */
const RECEIPT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body data-paper-width="58mm" data-page-width-microns="48000"><div class="receipt-paper">测试便利店</div></body></html>`

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
    const { win, calls } = makeFakeWindow({
      measureJson: JSON.stringify({ h: 800, pageWidthMicrons: '48000' })
    })
    const createWindowFn = vi.fn(() => win)
    const ch = new DriverChannel({ printerName: '前台驱动打印机', createWindowFn })

    await ch.send(htmlBytes(RECEIPT_HTML))

    // 工厂收到原始 HTML（载荷以 HTML 文档形态进入通道）
    expect(createWindowFn).toHaveBeenCalledWith(RECEIPT_HTML)
    // data: URL 加载（中文安全编码，round-trip 还原）
    expect(calls.loadedUrl).toBe(`data:text/html;charset=utf-8,${encodeURIComponent(RECEIPT_HTML)}`)
    // 调用序（v2）：logo decode 等待脚本 → 测量脚本（各一次）
    expect(calls.executed).toHaveLength(2)
    expect(calls.executed[0]).toContain('receipt-logo')
    expect(calls.executed[1]).toContain('scrollHeight')
    expect(calls.executed[1]).toContain('pageWidthMicrons')
    // 测量源是元素级（.receipt-paper）+ documentElement 回退：隐藏窗默认 600px 高，
    // documentElement.scrollHeight 是 max(视口,内容)，短小票会被抬到地板值 ≈159mm 走纸
    expect(calls.executed[1]).toContain('.receipt-paper')
    expect(calls.executed[1]).toContain('documentElement')
    expect(calls.executed[1]).toContain('offsetTop')
    // v3：测量前先跑生产同款版面自适应（与 render-check 共用同一段 FIT_TO_WIDTH_BODY）
    expect(calls.executed[1]).toContain(FIT_TO_WIDTH_BODY)
    // 打印选项全要素：静默 + 背景 + 设备名 + 无边距 + 48mm 可打印页宽微米 + 测量页高
    expect(calls.printOptions).toHaveLength(1)
    expect(calls.printOptions[0]).toEqual({
      silent: true,
      printBackground: true,
      deviceName: '前台驱动打印机',
      pageSize: { width: 48_000, height: expectedHeightMicrons(800) },
      margins: { marginType: 'none' }
    })
    // 窗口最终销毁（成功路径）
    expect(calls.destroyed).toBe(1)
  })

  it('80mm 纸 → 页宽 72000μm（可打印宽）；页高按测量值换算（h=1000px）', async () => {
    const { win, calls } = makeFakeWindow({
      measureJson: JSON.stringify({ h: 1000, pageWidthMicrons: '72000' })
    })
    const ch = new DriverChannel({ printerName: 'POS-80', createWindowFn: () => win })

    await ch.send(htmlBytes(RECEIPT_HTML))

    expect(calls.printOptions[0]?.pageSize).toEqual({
      width: 72_000,
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

  it('测量结果非 JSON / 高度非法 / 页宽属性缺失或非法 → 拒绝并提示 data-page-width-microns', async () => {
    const bad: string[] = [
      'not-json{{',
      JSON.stringify({ h: 'x-large', pageWidthMicrons: '48000' }),
      JSON.stringify({ h: 0, pageWidthMicrons: '48000' }),
      JSON.stringify({ h: 800 }), // 页宽键缺失
      JSON.stringify({ h: 800, pageWidthMicrons: '58mm' }), // 非微米数值
      JSON.stringify({ h: 800, pageWidthMicrons: '0' }), // 零宽
      JSON.stringify({ h: 800, pageWidthMicrons: '-48000' }), // 负宽
      JSON.stringify({ h: 800, pageWidthMicrons: 48000 }) // dataset 永远是字符串，数字形状也拒
    ]
    for (const measureJson of bad) {
      const { win } = makeFakeWindow({ measureJson })
      const ch = new DriverChannel({ printerName: 'POS-80', createWindowFn: () => win })
      await expect(ch.send(htmlBytes(RECEIPT_HTML))).rejects.toThrow(
        /driver channel.*(不可解析|非法|data-page-width-microns)/
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

// ═══════════ v2：实验打印选项条件组装（dpi Record 形状 / useDefaultPageSize 互斥） ═══════════

describe('DriverChannel 实验打印选项条件组装（v2 driver 通道实验键）', () => {
  it('两新键缺省/null/false → options 与 v1 形状逐字段 deepEqual（无 dpi/usePrinterDefaultPageSize 键）', async () => {
    // 三种「未启用」形态：闭包缺省（生产缺省路径）/ 闭包返回空对象 / 显式 null+false
    const notEnabled: Array<DriverChannelOptions['getDriverOptions']> = [
      undefined,
      () => ({}),
      () => ({ driverDpi: null, useDefaultPageSize: false })
    ]
    for (const getDriverOptions of notEnabled) {
      const { win, calls } = makeFakeWindow()
      const ch = new DriverChannel({ printerName: 'POS-58', createWindowFn: () => win, getDriverOptions })

      await ch.send(htmlBytes(RECEIPT_HTML))

      expect(calls.printOptions).toHaveLength(1)
      // 硬锁 v1 五键形状：多余键（dpi/usePrinterDefaultPageSize）或缺键都会 fail
      expect(calls.printOptions[0]).toEqual({
        silent: true,
        printBackground: true,
        deviceName: 'POS-58',
        pageSize: { width: 48_000, height: expectedHeightMicrons(800) },
        margins: { marginType: 'none' }
      })
      expect(Object.keys(calls.printOptions[0])).not.toContain('dpi')
      expect(Object.keys(calls.printOptions[0])).not.toContain('usePrinterDefaultPageSize')
    }
  })

  it('useDefaultPageSize=true → 不含 pageSize 键（互斥——Cannot be combined）+ usePrinterDefaultPageSize:true', async () => {
    const { win, calls } = makeFakeWindow()
    const ch = new DriverChannel({
      printerName: 'POS-58',
      createWindowFn: () => win,
      getDriverOptions: () => ({ useDefaultPageSize: true })
    })

    await ch.send(htmlBytes(RECEIPT_HTML))

    const opts = calls.printOptions[0] as unknown as Record<string, unknown>
    expect(Object.keys(opts)).not.toContain('pageSize')
    expect(opts.usePrinterDefaultPageSize).toBe(true)
    // 非实验键零改动（silent/printBackground/deviceName/margins 四键仍在）
    expect(opts.silent).toBe(true)
    expect(opts.printBackground).toBe(true)
    expect(opts.deviceName).toBe('POS-58')
    expect(opts.margins).toEqual({ marginType: 'none' })
  })

  it('driverDpi=203 → dpi Record 形状（horizontal/vertical 同值）；null/0/缺省 → 无 dpi 键', async () => {
    // 203：dpi 深比较（横竖同值——Electron dpi 是 Record 不是标量）
    {
      const { win, calls } = makeFakeWindow()
      const ch = new DriverChannel({
        printerName: 'POS-58',
        createWindowFn: () => win,
        getDriverOptions: () => ({ driverDpi: 203 })
      })
      await ch.send(htmlBytes(RECEIPT_HTML))
      expect(calls.printOptions[0]).toEqual({
        silent: true,
        printBackground: true,
        deviceName: 'POS-58',
        pageSize: { width: 48_000, height: expectedHeightMicrons(800) },
        dpi: { horizontal: 203, vertical: 203 },
        margins: { marginType: 'none' }
      })
    }
    // null / 0（非正整数组装侧防御）/ 缺省 → dpi 键物理不存在
    for (const driverDpi of [null, 0] as Array<number | null>) {
      const { win, calls } = makeFakeWindow()
      const ch = new DriverChannel({
        printerName: 'POS-58',
        createWindowFn: () => win,
        getDriverOptions: () => ({ driverDpi })
      })
      await ch.send(htmlBytes(RECEIPT_HTML))
      expect(Object.keys(calls.printOptions[0])).not.toContain('dpi')
    }
  })

  it('useDefaultPageSize=true + driverDpi=203 组合 → usePrinterDefaultPageSize + dpi 并存，pageSize 仍缺席', async () => {
    const { win, calls } = makeFakeWindow()
    const ch = new DriverChannel({
      printerName: 'POS-58',
      createWindowFn: () => win,
      getDriverOptions: () => ({ driverDpi: 203, useDefaultPageSize: true })
    })

    await ch.send(htmlBytes(RECEIPT_HTML))

    const opts = calls.printOptions[0] as unknown as Record<string, unknown>
    expect(Object.keys(opts)).not.toContain('pageSize')
    expect(opts.usePrinterDefaultPageSize).toBe(true)
    expect(opts.dpi).toEqual({ horizontal: 203, vertical: 203 })
  })
})

// ═══════════ v2 症状 2：logo decode 等待（测量前——「加 logo 后内容消失」竞态修复） ═══════════

describe('DriverChannel logo decode 等待（v2 症状 2——测量竞态修复）', () => {
  it('调用序：decode 等待 JS 在测量 JS 之前——decode 挂起时测量/打印未发生，放行后测量+打印完成', async () => {
    const { win, calls, releaseDecode } = makeFakeWindow({ decodeBehavior: 'pending' })

    const pending = printHtmlViaDriver(RECEIPT_HTML, 'POS-58', () => win)
    // 排空微任务：decode gate 挂起期间 executeJavaScript 只收到 decode 等待脚本
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.executed).toHaveLength(1)
    expect(calls.executed[0]).toContain('receipt-logo')
    expect(calls.printOptions).toHaveLength(0)
    expect(calls.destroyed).toBe(0)

    releaseDecode()
    await pending

    // 放行后：测量 → 打印 → 销毁，全链路照常完成
    expect(calls.executed).toHaveLength(2)
    expect(calls.executed[1]).toContain('scrollHeight')
    expect(calls.printOptions).toHaveLength(1)
    expect(calls.destroyed).toBe(1)
  })

  it('decode 等待执行失败（基础设施级 reject）→ 照常测量+打印（等待失败≠打印失败）', async () => {
    const { win, calls } = makeFakeWindow({ decodeBehavior: 'reject' })

    await printHtmlViaDriver(RECEIPT_HTML, 'POS-58', () => win)

    expect(calls.executed).toHaveLength(2)
    expect(calls.printOptions).toHaveLength(1)
    expect(calls.destroyed).toBe(1)
  })

  it('decode 等待脚本 JS 语义（vm 沙箱直跑）：无 logo 立即 resolve / decode 成功 resolve / decode 失败仍 resolve', async () => {
    // fake 窗口不执行真实 JS——脚本语义在 Node vm 沙箱硬锁（坏图 reject 若未被
    // 脚本吞掉，此 await 会 throw——这正是症状 2 修复的失败模式）
    const { win, calls } = makeFakeWindow()
    await printHtmlViaDriver(RECEIPT_HTML, 'POS-58', () => win)
    const script = calls.executed.find((code) => code.includes('receipt-logo'))
    expect(script).toBeDefined()

    const runScript = (document: unknown): Promise<unknown> =>
      runInNewContext(script as string, { document })

    // 无 logo（querySelector → null）：else 分支立即 resolve
    await runScript({ querySelector: () => null })
    // 有 logo、decode 成功
    await runScript({ querySelector: () => ({ decode: () => Promise.resolve() }) })
    // 有 logo、decode reject → 脚本仍 resolve（() => r() 吞 reject——render-check 惯用式）
    await runScript({
      querySelector: () => ({ decode: () => Promise.reject(new Error('坏图')) })
    })
    // 无 decode API 的老元素（i.decode 缺席）：立即 resolve
    await runScript({ querySelector: () => ({}) })
  })
})

// ═════════ v3 症状 1：版面自适应（右截断修复）+ 元素级测量脚本语义 ═════════

describe('DriverChannel 版面自适应与测量脚本（v3 右截断修复）', () => {
  /** 取测量脚本（区分于 decode 等待脚本：后者含 receipt-logo） */
  async function measureScript(): Promise<string> {
    const { win, calls } = makeFakeWindow()
    await printHtmlViaDriver(RECEIPT_HTML, 'POS-58', () => win)
    const script = calls.executed.find((code) => code.includes('pageWidthMicrons'))
    expect(script).toBeDefined()
    return script as string
  }

  it('vm 沙箱直跑：字体回退导致每行超宽时按实测比例回缩字号直到不溢出，再返回元素级页高 + 页宽微米', async () => {
    const script = await measureScript()

    // 真机 20261117 现场：容器 clientWidth=192px（32 列网格），字体逐字回退到
    // monospace → 每字 0.594em（应 0.5em），32 字一行实测 216px 超宽 24px。
    // scrollWidth 做成 getter：每轮回缩后重新按当前字号算，模拟真实重排。
    const BASE_FS = 11.34
    let fs = BASE_FS
    const style: Record<string, string> = {}
    const fitEl = {
      clientWidth: 192,
      scrollHeight: 538,
      offsetTop: 0,
      get scrollWidth(): number {
        return Math.round(32 * fs * 0.594)
      },
      style
    }
    Object.defineProperty(style, 'fontSize', {
      get: () => `${fs}px`,
      set: (v: string) => {
        fs = parseFloat(v)
      }
    })
    const document = {
      querySelector: (sel: string) => (sel === '.receipt-paper' ? fitEl : null),
      // 地板值故意与元素级不同：若脚本回退到 documentElement，h 会是 999 而不是 538
      documentElement: { scrollHeight: 999 },
      body: { dataset: { pageWidthMicrons: '48000' } }
    }

    const raw = runInNewContext(script, {
      document,
      getComputedStyle: () => ({ fontSize: `${fs}px` })
    }) as string

    expect(JSON.parse(raw)).toEqual({ h: 538, pageWidthMicrons: '48000' })
    // 回缩到不再溢出，且是**按实测比例**回缩（216→92 → 11.34→10.08），不是一刀切常数
    expect(fitEl.scrollWidth).toBeLessThanOrEqual(fitEl.clientWidth + 1)
    expect(fs).toBeLessThan(BASE_FS)
    expect(fs).toBeCloseTo((BASE_FS * 192) / 216, 3)
  })

  it('vm 沙箱直跑：网格不超宽时字号原封不动（自适应不无故缩小版面）', async () => {
    const script = await measureScript()

    const BASE_FS = 11.34
    let fs = BASE_FS
    let writes = 0
    const style: Record<string, string> = {}
    const fitEl = { clientWidth: 192, scrollWidth: 192, scrollHeight: 400, offsetTop: 0, style }
    Object.defineProperty(style, 'fontSize', {
      get: () => `${fs}px`,
      set: (v: string) => {
        writes += 1
        fs = parseFloat(v)
      }
    })
    const document = {
      querySelector: (sel: string) => (sel === '.receipt-paper' ? fitEl : null),
      documentElement: { scrollHeight: 999 },
      body: { dataset: { pageWidthMicrons: '48000' } }
    }

    const raw = runInNewContext(script, {
      document,
      getComputedStyle: () => ({ fontSize: `${fs}px` })
    }) as string

    expect(JSON.parse(raw)).toEqual({ h: 400, pageWidthMicrons: '48000' })
    expect(fs).toBe(BASE_FS)
    expect(writes).toBe(0) // 不超宽 → 一行内联样式都不写（不无故缩小版面）
  })

  it('vm 沙箱直跑：非收据 HTML（无 .receipt-paper）→ 回退 documentElement 页高，不 crash', async () => {
    const script = await measureScript()

    const document = {
      querySelector: () => null,
      documentElement: { scrollHeight: 700 },
      body: { dataset: { pageWidthMicrons: '72000' } }
    }
    const raw = runInNewContext(script, {
      document,
      getComputedStyle: () => ({ fontSize: '11.34px' })
    }) as string

    expect(JSON.parse(raw)).toEqual({ h: 700, pageWidthMicrons: '72000' })
  })
})
