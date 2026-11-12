import type { RenderSnapshot } from './schema'

/**
 * 渲染自检（printer-diagnostics 计划 Wave 3 / T7）——logo-measurement-race 的证据采集器。
 *
 * 为什么存在（症状 2「加 logo 后内容消失」的决定性证据）：driver 通道打印前用
 * executeJavaScript 量一次 scrollHeight 定页高（driver.channel.ts:132-134），但那一刻
 * logo 图片往往尚未解码完成——图片解码是异步的，解码前后布局高度可能不同（fixture
 * symptom2 实测：1842px → 2107px，差 265px）。若打印发生在「早」侧，页高被低估，
 * 驱动分页把下半截内容裁掉——看起来就是「加了 logo 内容消失」。
 * 本模块在隐藏窗口里对同一 HTML 做**两次测量**（立即 vs logo 解码后），heightDelta
 * 即测量竞态的直接证据（T5 规则 12 logo-measurement-race 阈值 >50px 的输入）。
 *
 * 纯只读测量：不 print、不改 driver.channel 生产路径、不干扰打印串行队列——
 * 与生产打印共享同一测量手法（scrollHeight/data: URL/懒 require 工厂），互不影响。
 *
 * DI 模式（同 driver.channel 的 createWindowFn）：fake 窗口注入，单测免 Electron
 * （G11/Linux 可测）。
 */

/** 渲染自检窗口的最小接口（BrowserWindow 的结构子集；测试注入 fake 用） */
export interface RenderCheckWindow {
  webContents: {
    loadURL(url: string): Promise<void>
    executeJavaScript(code: string): Promise<unknown>
  }
  destroy(): void
}

/** 窗口工厂注入点（默认工厂仅开隐藏窗；html 由 runRenderCheck 流程加载） */
export type RenderCreateWindowFn = () => RenderCheckWindow

/** 渲染自检选项 */
export interface RenderCheckOptions {
  /** 窗口工厂注入点（单测 fake 用；生产默认懒 require Electron 的隐藏 BrowserWindow） */
  createWindowFn?: RenderCreateWindowFn
  /** 整体超时（加载/两次测量任一环节挂死都兜底；默认 15000ms） */
  timeoutMs?: number
}

/** 渲染自检整体超时（页面加载 + 两次测量兜底；比 driver 打印 30s 短——纯只读测量无打印回调） */
const RENDER_CHECK_TIMEOUT_MS = 15_000

/**
 * 默认窗口工厂：懒 require('electron')（T2 模式——本模块可在 vitest 纯 Node 环境导入；
 * 仅生产调用路径真正触达 Electron）。BrowserWindow 按RenderCheckWindow 结构适配包装
 * （隐藏窗口 + webContents 两方法 + destroy）——同 driver.channel defaultCreateWindowFn。
 */
const defaultCreateWindowFn = (): RenderCheckWindow => {
  const { BrowserWindow } = require('electron') as typeof import('electron')
  const win = new BrowserWindow({ show: false })
  return {
    webContents: {
      loadURL: (url: string) => win.webContents.loadURL(url),
      executeJavaScript: (code: string) => win.webContents.executeJavaScript(code)
    },
    destroy: () => win.destroy()
  }
}

/** 错误消息细节归一（unknown → string） */
function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 第一次测量脚本（立即——不等待任何图片解码，捕捉测量竞态的「早」侧）。
 * 单次 JS 调用取齐四值（driver.channel 同款「一次取齐」模式）：
 * - h/w：documentElement 的 scrollHeight/scrollWidth（布局值，非 transform 后视觉值）
 * - dpr：devicePixelRatio
 * - img：img.receipt-logo 存在且带 src（决定是否做第二次测量）
 * 返回值必须 JSON.stringify 后由调用方手动 parse（executeJavaScript 结构化传递的
 * 仓库惯例——driver.channel:132-141 同款）。
 */
const FIRST_MEASURE_SCRIPT =
  "JSON.stringify({h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, dpr: window.devicePixelRatio, img: (()=>{const i=document.querySelector('img.receipt-logo'); return i ? i.getAttribute('src') !== null : false})()})"

/**
 * 第二次测量脚本（仅当第一次测得 img 存在时执行）：等 logo decode 完成后复测高度。
 * - decode 成功/失败都 resolve（竞态证据关心的是「解码安定后」的布局，不是图片本身好坏）；
 * - 5s 兜底 setTimeout（decode 永不定局时仍能拿到一个「晚」侧值，resolve(false) 不影响高度读取）；
 * - Promise.then 后才 stringify 高度（保证测量发生在 decode 定局之后）。
 */
const SECOND_MEASURE_SCRIPT =
  "new Promise(resolve => { const i = document.querySelector('img.receipt-logo'); if (i && i.decode) { i.decode().then(() => resolve(true), () => resolve(true)); setTimeout(() => resolve(false), 5000); } else { resolve(false); } }).then(() => JSON.stringify({h: document.documentElement.scrollHeight}))"

/**
 * 收据 HTML → 隐藏窗口两次测量 → RenderSnapshot（核心流程，可注入窗口工厂单测）：
 *  1. data: URL 加载（encodeURIComponent 保证中文/引号在 URL 内安全——driver.channel:121 同款）；
 *  2. 第一次测量（立即）：高/宽/dpr/logo 存在性；
 *  3. 第二次测量（仅当 logo 存在）：等 decode 后复测高度；
 *  4. 组装 RenderSnapshot（heightDelta = afterImgDecode - immediatelyMeasured）；
 *  5. 测量差异是数据不是错误——**永远不因 heightDelta ≠ 0 reject**（那恰是诊断证据）；
 *     仅 loadURL/executeJavaScript 基础设施失败才 reject 中文错误；
 *  6. 任一环节挂死由 timeoutMs（默认 15s）兜底 reject，finally destroy 窗口。
 */
export function runRenderCheck(
  html: string,
  paperWidthPx: number,
  options: RenderCheckOptions = {}
): Promise<RenderSnapshot> {
  const createWindowFn = options.createWindowFn ?? defaultCreateWindowFn
  const timeoutMs = options.timeoutMs ?? RENDER_CHECK_TIMEOUT_MS
  return new Promise<RenderSnapshot>((resolve, reject) => {
    const win = createWindowFn()
    let settled = false
    let timer: NodeJS.Timeout | undefined

    /** 唯一出口：清超时 + 销毁窗口（幂等）+ settle（先到者胜，后续回调 no-op） */
    const settle = (result: RenderSnapshot | Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        win.destroy()
      } catch {
        // destroy 幂等/窗口已销毁 → 忽略（不影响结果上报）
      }
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    timer = setTimeout(() => {
      settle(new Error(`render-check 渲染自检超时（${timeoutMs}ms，页面加载或测量流程挂死）`))
    }, timeoutMs)

    void (async () => {
      // 1. data: URL 加载（不触应用路由）
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
      try {
        await win.webContents.loadURL(dataUrl)
      } catch (err) {
        settle(new Error(`render-check 收据页面加载失败：${errorDetail(err)}`))
        return
      }

      // 2. 第一次测量（立即——与 driver 通道生产测量同一时机，竞态「早」侧）
      let firstRaw: unknown
      try {
        firstRaw = await win.webContents.executeJavaScript(FIRST_MEASURE_SCRIPT)
      } catch (err) {
        settle(new Error(`render-check 第一次测量脚本执行失败：${errorDetail(err)}`))
        return
      }
      let first: { h?: unknown; w?: unknown; dpr?: unknown; img?: unknown }
      try {
        first = JSON.parse(String(firstRaw)) as { h?: unknown; w?: unknown; dpr?: unknown; img?: unknown }
      } catch {
        settle(new Error('render-check 第一次测量结果不可解析（非 JSON）'))
        return
      }
      const { h, w, dpr } = first
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) {
        settle(new Error(`render-check 第一次测量高度非法（scrollHeight=${String(h)}）`))
        return
      }
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
        settle(new Error(`render-check 第一次测量宽度非法（scrollWidth=${String(w)}）`))
        return
      }
      if (typeof dpr !== 'number' || !Number.isFinite(dpr)) {
        settle(new Error(`render-check devicePixelRatio 非法（dpr=${String(dpr)}）`))
        return
      }
      const immediatelyMeasured = h
      const scrollWidth = w
      const hasLogo = first.img === true

      // 3. 第二次测量（仅当 logo 存在——无图则解码竞态不存在，afterImgDecode 即立即值）
      let afterImgDecode = immediatelyMeasured
      if (hasLogo) {
        let secondRaw: unknown
        try {
          secondRaw = await win.webContents.executeJavaScript(SECOND_MEASURE_SCRIPT)
        } catch (err) {
          settle(new Error(`render-check 第二次测量脚本执行失败：${errorDetail(err)}`))
          return
        }
        let second: { h?: unknown }
        try {
          second = JSON.parse(String(secondRaw)) as { h?: unknown }
        } catch {
          settle(new Error('render-check 第二次测量结果不可解析（非 JSON）'))
          return
        }
        if (typeof second.h !== 'number' || !Number.isFinite(second.h) || second.h <= 0) {
          settle(new Error(`render-check 图片解码后高度非法（scrollHeight=${String(second.h)}）`))
          return
        }
        afterImgDecode = second.h
      }

      // 4. 组装快照：heightDelta ≠ 0 是 logo-measurement-race 的证据（数据，非错误）
      settle({
        immediatelyMeasured,
        afterImgDecode,
        heightDelta: afterImgDecode - immediatelyMeasured,
        scrollWidth,
        paperWidthPx,
        // 1px 容差：舍入/边框亚像素不误报水平溢出
        horizontalOverflow: scrollWidth > paperWidthPx + 1,
        dpr
      })
    })()
  })
}
