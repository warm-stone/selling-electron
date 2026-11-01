import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { attachScannerBridge } from '../../../src/main/scanner/scanner-bridge'

/**
 * scanner-bridge 薄壳接线测试：只验证三件事——
 * keyDown 透传、命中后 onBarcode 回调 + webContents.send('scanner:barcode')。
 * 检测逻辑（时间戳/阈值/IME）已在 barcode-detector.test.ts 覆盖。
 * 用 fake webContents 整体 mock（bridge 可整体 mock 的设计目标）。
 */

interface FakeInput {
  type: string
  key: string
  isComposing?: boolean
}

type BeforeInputHandler = (event: unknown, input: FakeInput) => void

function createFakeWindow(): {
  win: BrowserWindow
  emit: (input: FakeInput) => void
  sent: Array<{ channel: string; args: unknown[] }>
} {
  const handlers: BeforeInputHandler[] = []
  const sent: Array<{ channel: string; args: unknown[] }> = []
  const webContents = {
    on: (_channel: string, handler: BeforeInputHandler) => {
      handlers.push(handler)
    },
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args })
    }
  }
  return {
    win: { webContents } as unknown as BrowserWindow,
    emit: (input: FakeInput) => {
      handlers.forEach((h) => h({}, input))
    },
    sent
  }
}

function burst(emit: (input: FakeInput) => void, code: string): void {
  for (const ch of code) emit({ type: 'keyDown', key: ch })
  emit({ type: 'keyDown', key: 'Enter' })
}

describe('attachScannerBridge 薄壳', () => {
  it('快速连发 + Enter → onBarcode 回调一次 + webContents.send(scanner:barcode)', () => {
    const { win, emit, sent } = createFakeWindow()
    const onBarcode = vi.fn()
    attachScannerBridge(win, onBarcode)

    burst(emit, '6901234567890')

    expect(onBarcode).toHaveBeenCalledTimes(1)
    expect(onBarcode).toHaveBeenCalledWith('6901234567890')
    expect(sent).toEqual([{ channel: 'scanner:barcode', args: ['6901234567890'] }])
  })

  it("type!=='keyDown' 的事件不进入检测器", () => {
    const { win, emit, sent } = createFakeWindow()
    const onBarcode = vi.fn()
    attachScannerBridge(win, onBarcode)

    // 连发字符与 Enter 均以 keyUp 到达 → 完全忽略
    for (const ch of '6901234567890') emit({ type: 'keyUp', key: ch })
    emit({ type: 'keyUp', key: 'Enter' })

    expect(onBarcode).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('isComposing 输入被透传给检测器并忽略', () => {
    const { win, emit, sent } = createFakeWindow()
    const onBarcode = vi.fn()
    attachScannerBridge(win, onBarcode)

    for (const ch of '6901234567890') emit({ type: 'keyDown', key: ch, isComposing: true })
    emit({ type: 'keyDown', key: 'Enter', isComposing: true })

    expect(onBarcode).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})
