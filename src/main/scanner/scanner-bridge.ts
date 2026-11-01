/**
 * 扫码枪桥：Electron before-input-event → BarcodeDetector 的薄壳。
 *
 * 职责（且仅此三件事，检测逻辑全在 detector，G13）：
 * 1. 订阅 win.webContents 的 before-input-event，只透传 type==='keyDown' 的事件
 * 2. 把事件喂给 BarcodeDetector.feed（时间戳取到达时刻 Date.now()）
 * 3. 命中条码 → 调用 onBarcode 回调 + webContents.send('scanner:barcode', code)
 *    （preload 侧 onBarcode 暴露与 main 装配由收银台任务 T11 完成）
 *
 * before-input-event 在输入到达页面之前拦截，绕过渲染层 IME composition——
 * 这是中文环境扫码枪可靠性的关键机制。
 */
import type { BrowserWindow } from 'electron'
import { BarcodeDetector } from './barcode-detector'

export function attachScannerBridge(
  win: BrowserWindow,
  onBarcode: (code: string) => void
): void {
  const detector = new BarcodeDetector()

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return

    const code = detector.feed({
      key: input.key,
      isComposing: input.isComposing,
      timestamp: Date.now()
    })

    if (code !== null) {
      onBarcode(code)
      win.webContents.send('scanner:barcode', code)
    }
  })
}
