import { describe, expect, it } from 'vitest'

import { PAPER_COLUMNS, padLine, stringWidth, truncateToGrid } from '../../../src/shared/receipt/char-grid'
import {
  buildItemLine,
  ITEM_COLUMN_WIDTHS,
  type ItemColumnWidths
} from '../../../src/shared/receipt/item-columns'

/**
 * 按显示宽度切片：String.slice 是 UTF-16 码元语义，中文网格行取列片段
 * 必须按显示宽度（全角 2/半角 1）累计截取——与 char-grid 同一宽度语义。
 */
function sliceByWidth(s: string, from: number, to: number): string {
  let width = 0
  let result = ''
  for (const ch of s) {
    const w = stringWidth(ch)
    if (width >= from && width + w <= to) result += ch
    width += w
    if (width >= to) break
  }
  return result
}

/**
 * Task 12 — items 四列网格契约上提（G7 契约缺口闭合）。
 *
 * ITEM_COLUMN_WIDTHS 与 buildItemLine（降级→truncate→pad 组合语义）自此由
 * src/shared/receipt/item-columns.ts 唯一提供：ESC/POS 生成器（注入 GBK 降级）
 * 与 HTML 预览（默认恒等降级）共用同一函数——双渲染同源（G7）。
 */

describe('ITEM_COLUMN_WIDTHS（列宽契约）', () => {
  it('两纸宽下列宽数值为 T4 冻结值：58mm 12/4/8/8、80mm 24/4/10/10', () => {
    expect(ITEM_COLUMN_WIDTHS['58mm']).toEqual({ name: 12, qty: 4, price: 8, subtotal: 8 })
    expect(ITEM_COLUMN_WIDTHS['80mm']).toEqual({ name: 24, qty: 4, price: 10, subtotal: 10 })
  })

  it('每纸宽四列之和 === PAPER_COLUMNS（网格满宽自洽）', () => {
    for (const paper of ['58mm', '80mm'] as const) {
      const w: ItemColumnWidths = ITEM_COLUMN_WIDTHS[paper]
      expect(w.name + w.qty + w.price + w.subtotal).toBe(PAPER_COLUMNS[paper])
    }
  })
})

describe('buildItemLine（同源组合语义）', () => {
  const CASES = [
    { name: '可口可乐330ml', qty: '2', price: '3.50', subtotal: '7.00' },
    { name: '蓝月亮洗衣液', qty: '1', price: '45.00', subtotal: '45.00' },
    // 超长名（宽 80 > 24/12）：截断必须生效
    { name: '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸', qty: '1', price: '1.00', subtotal: '1.00' },
    // 空字段：pad 后仍满宽
    { name: '', qty: '', price: '', subtotal: '' }
  ]

  it.each(['58mm', '80mm'] as const)(
    '%s：任意输入（含超长名/空字段）下行宽恒等于 PAPER_COLUMNS',
    (paper) => {
      for (const c of CASES) {
        const line = buildItemLine(c.name, c.qty, c.price, c.subtotal, paper)
        expect(stringWidth(line)).toBe(PAPER_COLUMNS[paper])
      }
    }
  )

  it('名称左对齐（右侧补空格），数量/单价/小计右对齐（左侧补空格）', () => {
    const line = buildItemLine('可乐', '2', '3.50', '7.00', '80mm')
    const w = ITEM_COLUMN_WIDTHS['80mm']
    // 名称列：'可乐'(宽4) + 20 空格
    expect(sliceByWidth(line, 0, w.name)).toBe('可乐' + ' '.repeat(w.name - 4))
    // 数量列：3 空格 + '2'
    expect(sliceByWidth(line, w.name, w.name + w.qty)).toBe(' '.repeat(w.qty - 1) + '2')
    // 单价列：6 空格 + '3.50'
    expect(sliceByWidth(line, w.name + w.qty, w.name + w.qty + w.price)).toBe(
      ' '.repeat(w.price - 4) + '3.50'
    )
    // 小计列：3 空格 + '7.00'
    const head = w.name + w.qty + w.price
    expect(sliceByWidth(line, head, head + w.subtotal)).toBe(' '.repeat(w.subtotal - 4) + '7.00')
  })

  it('超长名截断到名称列宽：完整名不得出现，截断后参与 pad', () => {
    const long = '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
    const line = buildItemLine(long, '1', '1.00', '1.00', '80mm')
    const w = ITEM_COLUMN_WIDTHS['80mm']
    expect(sliceByWidth(line, 0, w.name)).toBe(padLine(truncateToGrid(long, w.name), w.name))
    expect(line.includes(long)).toBe(false)
  })

  it('组合顺序 = 降级 → truncate → pad：降级改变宽度后仍保证满宽（顺序锁定）', () => {
    // degrade 会追加 1 个字符：若降级先于截断，追加字符被 truncate 裁掉 → 行仍满宽；
    // 若顺序颠倒（truncate → pad 后才降级），行宽会超网格（padLine 不截断超宽输入）。
    const degradeAppends = (s: string): string => s + '!'
    const line = buildItemLine('A'.repeat(24), '1', '1.00', '1.00', '80mm', degradeAppends)
    expect(stringWidth(line)).toBe(PAPER_COLUMNS['80mm'])
    expect(line.startsWith('A'.repeat(24))).toBe(true)
  })

  it("降级注入参与列几何：GBK 外字符（宽 2）替换 ?（宽 1）后按窄宽截断/pad", () => {
    // 模拟 T4 degradeToGbk 的行为形态：'𠀀'（宽 2）→ '?'（宽 1）
    const degrade = (s: string): string => s.replace('𠀀', '?')
    const name = '𠀀测试品'
    const line = buildItemLine(name, '1', '2.00', '2.00', '80mm', degrade)
    const w = ITEM_COLUMN_WIDTHS['80mm']
    // 降级后宽 7（1+2×3），截断 24 不触发，左对齐 pad 至 24
    expect(sliceByWidth(line, 0, w.name)).toBe(padLine('?测试品', w.name))
  })

  it('默认降级为恒等：GBK 外字符原样保留（renderer 预览无 iconv——差异已文档化）', () => {
    const line = buildItemLine('𠀀测试品', '1', '2.00', '2.00', '80mm')
    const w = ITEM_COLUMN_WIDTHS['80mm']
    expect(sliceByWidth(line, 0, w.name)).toBe(padLine('𠀀测试品', w.name))
  })

  it('与生成器逐列组合完全一致（同源数学交叉验证，等价 T4 composeItemRow）', () => {
    const composeManually = (
      name: string,
      qty: string,
      price: string,
      subtotal: string,
      w: ItemColumnWidths
    ): string =>
      padLine(truncateToGrid(name, w.name), w.name) +
      padLine(truncateToGrid(qty, w.qty), w.qty, 'right') +
      padLine(truncateToGrid(price, w.price), w.price, 'right') +
      padLine(truncateToGrid(subtotal, w.subtotal), w.subtotal, 'right')
    for (const paper of ['58mm', '80mm'] as const) {
      for (const c of CASES) {
        expect(buildItemLine(c.name, c.qty, c.price, c.subtotal, paper)).toBe(
          composeManually(c.name, c.qty, c.price, c.subtotal, ITEM_COLUMN_WIDTHS[paper])
        )
      }
    }
  })
})
