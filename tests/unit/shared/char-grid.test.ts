import { describe, it, expect } from 'vitest'
import {
  PAPER_COLUMNS,
  stringWidth,
  truncateToGrid,
  padLine,
  wrapToGrid
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

describe('wrapToGrid（按显示宽度折行）', () => {
  it('不超宽原样单行返回', () => {
    expect(wrapToGrid('中文ab', 10)).toEqual(['中文ab'])
    expect(wrapToGrid('可口可乐 330ml', 48)).toEqual(['可口可乐 330ml'])
  })

  it('空字符串返回 [""]', () => {
    expect(wrapToGrid('', 32)).toEqual([''])
  })

  it('纯 ASCII 词折：空格处断行、词不放不下时提前断', () => {
    // 宽 11，cols=5：'aa bb' 放不下 'cc' → 断行
    expect(wrapToGrid('aa bb cc', 5)).toEqual(['aa bb', 'cc'])
    // 恰好占满（5=2+1+2）：同行
    expect(wrapToGrid('aa bb', 5)).toEqual(['aa bb'])
  })

  it('CJK 无空格长文本：逐字硬断、宽字符不拆半、每行不越界', () => {
    const out = wrapToGrid('中中中中', 5) // 每字宽 2：每行最多 2 字（4 列）
    expect(out).toEqual(['中中', '中中'])
    for (const line of out) expect(stringWidth(line)).toBeLessThanOrEqual(5)
  })

  it('混合文本：ASCII 词 + CJK 逐字断共存', () => {
    // token 'ab中中中' 宽 8 > 5 → 硬断：ab(2) 中(4) 中(6>5)断 → 'ab中' / '中中'
    const out = wrapToGrid('ab中中中', 5)
    expect(out).toEqual(['ab中', '中中'])
  })

  it('断行不吞非空格字符：所有非空格字符按序保留', () => {
    const s = 'ab中 cd中 ef中'
    const joined = wrapToGrid(s, 5).join(' ')
    // 非空格字符序列与原文一致（空格为断点可被吞并/折叠）
    expect(joined.replace(/ /g, '')).toBe(s.replace(/ /g, ''))
  })

  it('空格吞并：连续空格折叠为单分隔符、断点处不留尾随/前导空格', () => {
    // 'a  b'（双空格）→ 词间单空格
    expect(wrapToGrid('a  b', 10)).toEqual(['a b'])
    // 断行处空格被吞：'aa bb' 折在 'aa' 后，行尾无空格、次行行首无空格
    const out = wrapToGrid('aa bb', 4)
    expect(out).toEqual(['aa', 'bb'])
    // 前导/尾随空格被吞
    expect(wrapToGrid('  ab  ', 10)).toEqual(['ab'])
  })

  it('单个超宽字符（cols < 字符宽）独占一行，不吞字符', () => {
    expect(wrapToGrid('😀', 1)).toEqual(['😀']) // emoji 宽 2 > cols 1
    expect(wrapToGrid('a😀', 1)).toEqual(['a', '😀'])
  })

  it('cols<=0 防御：原样单行返回', () => {
    expect(wrapToGrid('abc', 0)).toEqual(['abc'])
    expect(wrapToGrid('abc', -1)).toEqual(['abc'])
  })

  it('cols=1 纯半角逐字符断行', () => {
    expect(wrapToGrid('abc', 1)).toEqual(['a', 'b', 'c'])
  })
})
