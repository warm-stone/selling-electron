/**
 * 扫码枪检测器（keyboard-wedge HID）——纯类，零 Electron/DOM 依赖。
 *
 * 核心判据（扫码枪 vs 人工打字的本质差异）：
 * - 连发：扫码枪逐字符注入，事件时间戳间隔 ≤50ms；人工打字天然达不到
 * - 终结：条码后紧跟 Enter
 * - 最小长度：≥5 字符（数字/字母/常见条码字符）
 *
 * 中文输入法（IME）冲突原理：composition 事件吞掉快速输入——凡 isComposing=true
 * 的按键一律忽略（组态期特征），主进程 before-input-event 的 input.isComposing 字段
 * 由 bridge 透传进来。
 *
 * 判定全部基于事件自身时间戳，无 setTimeout/debounce 全局状态（G13：纯函数可测）。
 */

export interface KeyEvent {
  /** 按键名，单字符为可打印字符；'Enter' 为终结键 */
  key: string
  /** IME 组态期标记：true 时该输入被忽略 */
  isComposing?: boolean
  /** 事件时间戳（ms，epoch 起算）——由 bridge 在事件到达时取 Date.now() */
  timestamp: number
}

/** 相邻按键间隔超过该值视为连发中断（扫码枪典型间隔 1-30ms，人工 >100ms） */
export const BURST_GAP_MS = 50

/** 条码最小长度（EAN-13/UPC-A/Code39 均远大于此，防误触即可） */
export const MIN_BARCODE_LENGTH = 5

/** 修饰键：本身不产生字符，不打断连发序列（部分扫码枪配置大小写转换时会发 Shift） */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock'])

export class BarcodeDetector {
  private buffer: string[] = []
  private lastTimestamp: number | null = null

  /**
   * 喂入一个按键事件；识别出完整条码时返回条码字符串并重置状态，否则返回 null。
   * 输入事件到达时即被消费，不持有任何计时器。
   */
  feed(event: KeyEvent): string | null {
    // IME 组态期输入：忽略，不改变任何状态
    if (event.isComposing) return null

    // 与上一事件间隔超过阈值 → 连发中断，丢弃已有缓冲
    if (
      this.lastTimestamp !== null &&
      event.timestamp - this.lastTimestamp > BURST_GAP_MS
    ) {
      this.buffer = []
    }
    this.lastTimestamp = event.timestamp

    // Enter：终结判定
    if (event.key === 'Enter') {
      if (this.buffer.length >= MIN_BARCODE_LENGTH) {
        const code = this.buffer.join('')
        this.reset()
        return code
      }
      this.reset()
      return null
    }

    // 修饰键：不产生字符、不打断序列
    if (MODIFIER_KEYS.has(event.key)) return null

    // 可打印字符（key.length === 1）→ 累计
    if (event.key.length === 1) {
      this.buffer.push(event.key)
      return null
    }

    // 其他控制键（Tab/Escape/Backspace/方向键…）不属于条码流 → 打断序列
    this.buffer = []
    return null
  }

  /** 手动清空缓冲（窗口失焦、页面切换等场景由 bridge 调用方决定） */
  reset(): void {
    this.buffer = []
    this.lastTimestamp = null
  }
}
