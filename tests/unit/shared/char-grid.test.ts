import { describe, it, expect } from 'vitest'
import {
  PAPER_COLUMNS,
  stringWidth,
  truncateToGrid,
  padLine
} from '../../../src/shared/receipt/char-grid'

describe('PAPER_COLUMNS', () => {
  it('58mm=32 列，80mm=48 列', () => {
    expect(PAPER_COLUMNS['58mm']).toBe(32)
    expect(PAPER_COLUMNS['80mm']).toBe(48)
  })
})

describe('stringWidth（全角=2 半角=1）', () => {
  it('中文ab = 6', () => {
    expect(stringWidth('中文ab')).toBe(6)
  })

  it('空字符串宽 0', () => {
    expect(stringWidth('')).toBe(0)
  })

  it('纯 ASCII 半角', () => {
    expect(stringWidth('12345')).toBe(5)
  })

  it('纯全角中文：谢谢惠顾 = 8', () => {
    expect(stringWidth('谢谢惠顾')).toBe(8)
  })

  it('全角形式与全角符号宽 2', () => {
    expect(stringWidth('ＡＢ')).toBe(4) // U+FF21/U+FF22 全角形式
    expect(stringWidth('：')).toBe(2) // U+FF1A 全角冒号
    expect(stringWidth('￥')).toBe(2) // U+FFE5 全角人民币符号
  })

  it('emoji（UTF-16 代理对）按宽 2 计，不产生半个代理对', () => {
    expect(stringWidth('😀')).toBe(2) // U+1F600
    expect(stringWidth('a😀b')).toBe(4)
    expect(stringWidth('😀😀')).toBe(4)
  })

  it('CJK 扩展 B 区代理对字符宽 2', () => {
    expect(stringWidth('𠀀')).toBe(2) // U+20000
  })

  it('变体选择符（U+FE0F）宽 0：加与不加 VS16 宽度不变', () => {
    expect(stringWidth('✌️')).toBe(stringWidth('✌')) // U+270C + U+FE0F vs U+270C
    expect(stringWidth('✌️')).toBe(1) // U+270C 半角 + VS16 零宽
  })
})

describe('truncateToGrid（超长截断不越界）', () => {
  it('不超宽原样返回', () => {
    expect(truncateToGrid('中文ab', 6)).toBe('中文ab')
  })

  it('ASCII 超长截断到精确列数', () => {
    const out = truncateToGrid('a'.repeat(60), 48)
    expect(out).toBe('a'.repeat(48))
    expect(stringWidth(out)).toBe(48)
  })

  it('宽字符截断不产生半个字符、宽度不越界', () => {
    const out = truncateToGrid('中中中', 5) // 宽 6 > 5
    expect(out).toBe('中中')
    expect(stringWidth(out)).toBeLessThanOrEqual(5)
  })

  it('emoji 截断不产生孤立代理对（半个代理对）', () => {
    const out = truncateToGrid('😀😀😀', 5) // 宽 6 > 5 → 保留 2 个完整 emoji
    expect(out).toBe('😀😀')
    expect([...out].length).toBe(2) // 按 code point 计数完整
    // 末尾 code unit 必须是低代理（>=0xDC00）；若是高代理则说明截断了半个代理对
    expect(out.charCodeAt(out.length - 1)).toBeGreaterThanOrEqual(0xdc00)
  })

  it('cols=0 返回空串', () => {
    expect(truncateToGrid('abc', 0)).toBe('')
  })

  it('空字符串安全', () => {
    expect(truncateToGrid('', 32)).toBe('')
  })
})

describe('padLine（补齐到网格宽度）', () => {
  it('left 对齐右侧补空格', () => {
    expect(padLine('ab', 5, 'left')).toBe('ab   ')
  })

  it('right 对齐左侧补空格', () => {
    expect(padLine('ab', 5, 'right')).toBe('   ab')
  })

  it('center 对齐：48 列下左右空格数正确', () => {
    const out = padLine('中文ab', 48, 'center') // 宽 6，补 42 → 左 21 右 21
    expect(out).toBe(' '.repeat(21) + '中文ab' + ' '.repeat(21))
    expect(stringWidth(out)).toBe(48)
  })

  it('center 奇数余量左少右多', () => {
    expect(padLine('ab', 5, 'center')).toBe(' ab  ')
  })

  it('恰好占满时不加空格', () => {
    expect(padLine('中文ab', 6, 'center')).toBe('中文ab')
  })

  it('超宽输入原文返回（pad 语义不截断）', () => {
    expect(padLine('a'.repeat(60), 48, 'left')).toBe('a'.repeat(60))
  })

  it('对全角文本补齐后宽度精确', () => {
    const out = padLine('中', 5, 'left')
    expect(out).toBe('中   ')
    expect(stringWidth(out)).toBe(5)
  })

  it('align 缺省为 left', () => {
    expect(padLine('ab', 4)).toBe('ab  ')
  })
})
