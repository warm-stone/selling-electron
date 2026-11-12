import { describe, expect, it, vi } from 'vitest'
import {
  runRenderCheck,
  type RenderCheckWindow
} from '../../../../src/main/printing/diagnostics/render-check'

/**
 * 渲染自检单元测试（DI 注入 fake 窗口，**免 Electron、不弹真窗口**——与
 * driver.channel.test 注入 fake 窗口同款模式）。
 * 四路径 + 基础设施失败：
 *  1. logo 测量竞态：立即 1842 → 解码后 2107 → heightDelta 265（fixture
 *     symptom2 数据同源——本模块是该 fixture 的事实来源）；
 *  2. 第二次测量（decode）挂死 → 注入 50ms 超时兜底 reject 中文错误；
 *  3. 无 logo：单次测量，heightDelta=0，第二次 executeJavaScript 不执行；
 *  4. 水平溢出：scrollWidth 超纸宽 +1px 容差 → horizontalOverflow=true；
 *  附：destroy 幂等/抛异常被吞、loadURL/executeJavaScript 基础设施失败
 *  才 reject（测量差异永远是数据不是错误）。
 */

interface FakeCalls {
  loadedUrl: string
  executed: string[]
  destroyed: number
}

/**
 * 可编排假窗口：executeJavaScript 按调用序返回（第 1 次firstJson，第 2 次
 * secondJson / secondHangs 永不 resolve——decode 挂死路径）。
 */
function makeFakeWindow(
  o: {
    firstJson?: string
    secondJson?: string
    secondHangs?: boolean
    loadUrlError?: Error
    execError?: Error
    destroyThrows?: boolean
  } = {}
): { win: RenderCheckWindow; calls: FakeCalls } {
  const calls: FakeCalls = { loadedUrl: '', executed: [], destroyed: 0 }
  const win: RenderCheckWindow = {
    webContents: {
      loadURL: vi.fn(async (url: string) => {
        calls.loadedUrl = url
        if (o.loadUrlError) throw o.loadUrlError
      }),
      executeJavaScript: vi.fn(async (code: string) => {
        calls.executed.push(code)
        if (o.execError) throw o.execError
        if (calls.executed.length === 1) {
          return o.firstJson ?? JSON.stringify({ h: 800, w: 307, dpr: 1, img: false })
        }
        if (o.secondHangs) return new Promise<unknown>(() => {}) // 永不 resolve：decode 挂死
        return o.secondJson ?? JSON.stringify({ h: 900 })
      })
    },
    destroy: vi.fn(() => {
      calls.destroyed += 1
      if (o.destroyThrows) throw new Error('Object has been destroyed')
    })
  }
  return { win, calls }
}

/** 含 logo 的收据 HTML（img.receipt-logo 是第二次测量的触发前提） */
const RECEIPT_HTML_WITH_LOGO = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body data-paper-width="58mm"><div class="receipt-paper"><img class="receipt-logo" src="data:image/png;base64,iVBORw0KGgo="><div>测试便利店</div></div></body></html>`

/** 无 logo 的收据 HTML（第二次测量不应执行） */
const RECEIPT_HTML_NO_LOGO = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body data-paper-width="58mm"><div class="receipt-paper">测试便利店</div></body></html>`

describe('runRenderCheck', () => {
  it('路径 1 logo 测量竞态：立即 1842 → 解码后 2107 → heightDelta 265（fixture symptom2 同源数据），横向不溢出', async () => {
    const { win, calls } = makeFakeWindow({
      firstJson: JSON.stringify({ h: 1842, w: 307, dpr: 1, img: true }),
      secondJson: JSON.stringify({ h: 2107 })
    })

    const snap = await runRenderCheck(RECEIPT_HTML_WITH_LOGO, 307, { createWindowFn: () => win })

    // 全字段快照（★ 1842/2107/265 与 fixtures symptom2 的 renderSnapshot 数据同源）
    expect(snap).toEqual({
      immediatelyMeasured: 1842,
      afterImgDecode: 2107,
      heightDelta: 265,
      scrollWidth: 307,
      paperWidthPx: 307,
      horizontalOverflow: false,
      dpr: 1
    })
    // data: URL 加载（encodeURIComponent 中文安全，round-trip 还原）
    expect(calls.loadedUrl).toBe(
      `data:text/html;charset=utf-8,${encodeURIComponent(RECEIPT_HTML_WITH_LOGO)}`
    )
    // 两次测量脚本：第一次四值一次取齐，第二次等 decode 后复测
    expect(calls.executed).toHaveLength(2)
    expect(calls.executed[0]).toContain('scrollHeight')
    expect(calls.executed[0]).toContain('scrollWidth')
    expect(calls.executed[0]).toContain('devicePixelRatio')
    expect(calls.executed[0]).toContain('img.receipt-logo')
    expect(calls.executed[1]).toContain('decode')
    expect(calls.executed[1]).toContain('scrollHeight')
    // 测量差异是数据不是错误——heightDelta 265 依然 resolve（本用例即证明）
    // 窗口销毁恰一次（成功路径）
    expect(calls.destroyed).toBe(1)
  })

  it('路径 2 decode 挂死：第二次测量永不 resolve → 注入 50ms 超时兜底 reject 中文错误并销毁窗口', async () => {
    vi.useFakeTimers()
    try {
      const { win, calls } = makeFakeWindow({
        firstJson: JSON.stringify({ h: 1842, w: 307, dpr: 1, img: true }),
        secondHangs: true
      })

      const pending = runRenderCheck(RECEIPT_HTML_WITH_LOGO, 307, {
        createWindowFn: () => win,
        timeoutMs: 50
      })
      const assertion = expect(pending).rejects.toThrow(/render-check 渲染自检超时.*50ms/)
      // 推进 50ms 恰触发注入超时（默认 15s 未被采用——否则 fake timers 下永不 reject）
      await vi.advanceTimersByTimeAsync(50)
      await assertion
      expect(calls.destroyed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('路径 3 无 logo：单次测量，heightDelta=0，afterImgDecode===immediatelyMeasured，第二次 executeJavaScript 未被调用', async () => {
    const { win, calls } = makeFakeWindow({
      firstJson: JSON.stringify({ h: 1620, w: 307, dpr: 1.25, img: false })
    })

    const snap = await runRenderCheck(RECEIPT_HTML_NO_LOGO, 307, { createWindowFn: () => win })

    expect(snap.immediatelyMeasured).toBe(1620)
    expect(snap.afterImgDecode).toBe(snap.immediatelyMeasured)
    expect(snap.heightDelta).toBe(0)
    expect(snap.dpr).toBe(1.25)
    expect(snap.horizontalOverflow).toBe(false)
    // ★ 第二次测量不执行（无图则解码竞态不存在）
    expect(calls.executed).toHaveLength(1)
    expect(calls.destroyed).toBe(1)
  })

  it('路径 4 水平溢出：scrollWidth=330 > 纸宽 307+1 容差 → horizontalOverflow=true；+1 恰不溢出', async () => {
    const { win } = makeFakeWindow({
      firstJson: JSON.stringify({ h: 800, w: 330, dpr: 1, img: false })
    })
    const snap = await runRenderCheck(RECEIPT_HTML_NO_LOGO, 307, { createWindowFn: () => win })
    expect(snap.horizontalOverflow).toBe(true)
    expect(snap.scrollWidth).toBe(330)
    expect(snap.paperWidthPx).toBe(307)

    // 1px 容差边界：w=308（恰 +1）不算溢出（舍入/亚像素不误报）
    const { win: winEdge } = makeFakeWindow({
      firstJson: JSON.stringify({ h: 800, w: 308, dpr: 1, img: false })
    })
    const edge = await runRenderCheck(RECEIPT_HTML_NO_LOGO, 307, { createWindowFn: () => winEdge })
    expect(edge.horizontalOverflow).toBe(false)
  })

  it('destroy 抛异常（窗口已销毁类错误）→ settle 吞掉、结果照常上报；destroy 恰调用一次', async () => {
    const { win, calls } = makeFakeWindow({
      firstJson: JSON.stringify({ h: 900, w: 307, dpr: 1, img: false }),
      destroyThrows: true
    })

    const snap = await runRenderCheck(RECEIPT_HTML_NO_LOGO, 307, { createWindowFn: () => win })

    // 结果不受 destroy 失败影响（finally 语义：销毁失败不拖垮测量数据上报）
    expect(snap.immediatelyMeasured).toBe(900)
    expect(calls.destroyed).toBe(1)
    // fake 确实会抛（证明 settle 的 try/catch 真实兜住了，而非未触发）
    expect(() => win.destroy()).toThrow('Object has been destroyed')
  })

  it('页面加载失败 → 拒绝可诊断中文错误，窗口销毁（仅基础设施失败才 reject）', async () => {
    const { win, calls } = makeFakeWindow({ loadUrlError: new Error('ERR_ABORTED') })

    await expect(
      runRenderCheck(RECEIPT_HTML_NO_LOGO, 307, { createWindowFn: () => win })
    ).rejects.toThrow(/render-check 收据页面加载失败.*ERR_ABORTED/)
    expect(calls.destroyed).toBe(1)
  })

  it('测量脚本执行失败 → 拒绝可诊断中文错误', async () => {
    const { win } = makeFakeWindow({ execError: new Error('script timeout') })

    await expect(
      runRenderCheck(RECEIPT_HTML_NO_LOGO, 307, { createWindowFn: () => win })
    ).rejects.toThrow(/第一次测量脚本执行失败.*script timeout/)
  })

  it('测量结果非 JSON / 高度非法 → 拒绝并指明环节', async () => {
    const bad: string[] = [
      'not-json{{',
      JSON.stringify({ h: 'x-large', w: 307, dpr: 1 }),
      JSON.stringify({ h: 0, w: 307, dpr: 1 })
    ]
    for (const firstJson of bad) {
      const { win } = makeFakeWindow({ firstJson })
      await expect(
        runRenderCheck(RECEIPT_HTML_NO_LOGO, 307, { createWindowFn: () => win })
      ).rejects.toThrow(/render-check 第一次测量.*(不可解析|非法)/)
    }
  })
})
