import { describe, it, expect, beforeEach } from 'vitest'
import { BarcodeDetector } from '../../../src/main/scanner/barcode-detector'

/**
 * BarcodeDetector 测试矩阵（合成事件流，时间戳完全可控）：
 * 1. 快速连发 13 字符 + Enter（20ms 间隔）→ 识别
 * 2. 慢速输入（200ms 间隔）→ 不触发
 * 3. <5 字符 + Enter → 不触发
 * 4. 两次独立扫码（中间 >50ms 空隙）→ 互不拼接
 * 5. 长度 5 边界 → 触发；长度 4 → 不触发
 * 6. isComposing=true 的输入忽略（IME 组态期特征）
 * 附加边界：间隔恰 50ms（连发）/ 51ms（重置）/ Enter 迟到超 50ms / reset()
 */

/** 模拟扫码枪快速打字：逐字符 feed，返回下一次可用时间戳 */
function typeChars(detector: BarcodeDetector, text: string, startTs: number, gapMs: number): number {
  let ts = startTs
  for (const ch of text) {
    expect(detector.feed({ key: ch, timestamp: ts })).toBeNull()
    ts += gapMs
  }
  return ts
}

describe('BarcodeDetector 扫码枪状态机', () => {
  let detector: BarcodeDetector

  beforeEach(() => {
    detector = new BarcodeDetector()
  })

  it('快速连发 13 字符（20ms 间隔）+ Enter → 返回完整条码', () => {
    const next = typeChars(detector, '6901234567890', 1000, 20)
    expect(detector.feed({ key: 'Enter', timestamp: next })).toBe('6901234567890')
  })

  it('慢速人工输入（200ms 间隔）→ Enter 不触发', () => {
    const next = typeChars(detector, '6901234567890', 1000, 200)
    expect(detector.feed({ key: 'Enter', timestamp: next })).toBeNull()
  })

  it('短于 5 字符 + Enter → 不触发，且缓冲被清空', () => {
    const next = typeChars(detector, '1234', 1000, 20)
    expect(detector.feed({ key: 'Enter', timestamp: next })).toBeNull()
    // 缓冲已清空：紧接着的完整连发仍可正常识别（不被上次残留污染）
    const ts = next + 200
    const after = typeChars(detector, '6901234567890', ts, 20)
    expect(detector.feed({ key: 'Enter', timestamp: after })).toBe('6901234567890')
  })

  it('两次独立扫码（间隔 >50ms）→ 各自完整识别，互不拼接', () => {
    const t1 = typeChars(detector, '6901234567890', 1000, 20)
    expect(detector.feed({ key: 'Enter', timestamp: t1 })).toBe('6901234567890')

    // 空闲 3 秒后再扫第二枪
    const t2 = typeChars(detector, '4006381333931', t1 + 3000, 20)
    expect(detector.feed({ key: 'Enter', timestamp: t2 })).toBe('4006381333931')
  })

  it('长度边界：5 字符触发，4 字符不触发', () => {
    const t5 = typeChars(detector, '12345', 1000, 20)
    expect(detector.feed({ key: 'Enter', timestamp: t5 })).toBe('12345')

    const t4 = typeChars(detector, '6789', t5 + 100, 20)
    expect(detector.feed({ key: 'Enter', timestamp: t4 })).toBeNull()
  })

  it('isComposing=true 的输入被忽略（IME 组态期特征）', () => {
    // 组态期按键全部忽略
    let ts = 1000
    for (const ch of 'nihao') {
      expect(detector.feed({ key: ch, timestamp: ts, isComposing: true })).toBeNull()
      ts += 20
    }
    // 组态期 Enter 也忽略
    expect(detector.feed({ key: 'Enter', timestamp: ts, isComposing: true })).toBeNull()

    // 正常条码 4 字符 + 1 个组态期字符 → 组态字符不计入，长度不足 5
    const t = typeChars(detector, '1234', ts + 100, 20)
    expect(detector.feed({ key: 'X', timestamp: t, isComposing: true })).toBeNull()
    expect(detector.feed({ key: 'Enter', timestamp: t + 20 })).toBeNull()

    // 无组态标记时 5 字符正常识别
    const t2 = typeChars(detector, '12345', t + 200, 20)
    expect(detector.feed({ key: 'Enter', timestamp: t2 })).toBe('12345')
  })

  it('间隔恰 50ms 仍视为连发；51ms 触发重置', () => {
    // 恰 50ms → 连发保持
    const t50 = typeChars(detector, '12345', 1000, 50)
    expect(detector.feed({ key: 'Enter', timestamp: t50 })).toBe('12345')

    // 51ms → 每次到达都重置缓冲，累计永远只有 1 字符
    const t51 = typeChars(detector, '12345', t50 + 100, 51)
    expect(detector.feed({ key: 'Enter', timestamp: t51 })).toBeNull()
  })

  it('Enter 迟到超过 50ms → 缓冲已被重置，不识别', () => {
    const t = typeChars(detector, '6901234567890', 1000, 20)
    expect(detector.feed({ key: 'Enter', timestamp: t + 200 })).toBeNull()
  })

  it('reset() 手动清空缓冲', () => {
    const t = typeChars(detector, '690123456789', 1000, 20)
    detector.reset()
    expect(detector.feed({ key: 'Enter', timestamp: t + 20 })).toBeNull()
  })

  it('修饰键（Shift 等）不打断连发序列；其他控制键（Tab）打断', () => {
    // 模拟配置了大小写转换的扫码枪：Shift + 字母序列
    let ts = 1000
    const seq: Array<[string, number]> = [
      ['Shift', 0],
      ['A', 1],
      ['B', 2],
      ['Shift', 3],
      ['C', 4],
      ['D', 5],
      ['E', 6]
    ]
    for (const [key, step] of seq) {
      expect(detector.feed({ key, timestamp: ts + step * 20 })).toBeNull()
    }
    expect(detector.feed({ key: 'Enter', timestamp: ts + 7 * 20 })).toBe('ABCDE')

    // Tab 等控制键打断序列：前 5 字符作废
    const t2 = typeChars(detector, '12345', ts + 1000, 20)
    expect(detector.feed({ key: 'Tab', timestamp: t2 })).toBeNull()
    expect(detector.feed({ key: 'Enter', timestamp: t2 + 20 })).toBeNull()
  })
})
