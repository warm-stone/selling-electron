import { describe, expect, it } from 'vitest'

import { PAPER_COLUMNS, padLine, stringWidth, truncateToGrid, wrapToGrid } from '../../../src/shared/receipt/char-grid'
import {
  buildItemLines,
  ITEM_COLUMN_WIDTHS,
  resolveColumnWidths,
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
 * items 四列网格契约（G7 双渲染器同源）。
 *
 * ITEM_COLUMN_WIDTHS / resolveColumnWidths（列宽覆盖→回落）与
 * buildItemLines（降级→wrap→pad 组合语义，名称列折行、多行网格行返回）
 * 由 src/shared/receipt/item-columns.ts 唯一提供：ESC/POS 生成器（注入
 * GBK 降级）与 HTML 预览（默认恒等降级）共用——双渲染同源（G7）。
 */

const LONG_NAME = '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'

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

describe('resolveColumnWidths（列宽覆盖采用/回落）', () => {
  it('四键齐全正整数且和 === PAPER_COLUMNS → 采用覆盖值', () => {
    expect(resolveColumnWidths('80mm', { name: 28, qty: 4, price: 8, subtotal: 8 })).toEqual({
      name: 28,
      qty: 4,
      price: 8,
      subtotal: 8
    })
    expect(resolveColumnWidths('58mm', { name: 16, qty: 4, price: 6, subtotal: 6 })).toEqual({
      name: 16,
      qty: 4,
      price: 6,
      subtotal: 6
    })
  })

  it('缺省/undefined → 回落默认冻结值', () => {
    expect(resolveColumnWidths('80mm')).toEqual(ITEM_COLUMN_WIDTHS['80mm'])
    expect(resolveColumnWidths('80mm', {})).toEqual(ITEM_COLUMN_WIDTHS['80mm'])
    expect(resolveColumnWidths('58mm', undefined)).toEqual(ITEM_COLUMN_WIDTHS['58mm'])
  })

  it('四键不全 → 回落（部分键缺失视为无效覆盖）', () => {
    expect(resolveColumnWidths('80mm', { name: 28, qty: 4, price: 8 })).toEqual(
      ITEM_COLUMN_WIDTHS['80mm']
    )
  })

  it('总和 ≠ PAPER_COLUMNS → 回落（列宽之和必须满网格宽）', () => {
    // 20+4+10+10 = 44 ≠ 48 → 回落默认
    expect(resolveColumnWidths('80mm', { name: 20, qty: 4, price: 10, subtotal: 10 })).toEqual(
      ITEM_COLUMN_WIDTHS['80mm']
    )
    // 16+4+6+6 = 32，58mm 有效（=32）；80mm 无效（≠48）→ 回落
    expect(resolveColumnWidths('80mm', { name: 16, qty: 4, price: 6, subtotal: 6 })).toEqual(
      ITEM_COLUMN_WIDTHS['80mm']
    )
  })

  it('非正整数（0/负数/小数/非数字脏值）→ 回落（运行时兜底）', () => {
    expect(resolveColumnWidths('80mm', { name: 0, qty: 4, price: 10, subtotal: 10 })).toEqual(
      ITEM_COLUMN_WIDTHS['80mm']
    )
    expect(
      resolveColumnWidths('80mm', { name: -24, qty: 4, price: 10, subtotal: 10 })
    ).toEqual(ITEM_COLUMN_WIDTHS['80mm'])
    expect(
      resolveColumnWidths('80mm', { name: 24.5, qty: 4, price: 10, subtotal: 9.5 })
    ).toEqual(ITEM_COLUMN_WIDTHS['80mm'])
    expect(
      resolveColumnWidths('80mm', { name: '24' as unknown as number, qty: 4, price: 10, subtotal: 10 })
    ).toEqual(ITEM_COLUMN_WIDTHS['80mm'])
  })
})

describe('buildItemLines（多行网格行组合语义）', () => {
  const CASES = [
    { name: '可口可乐330ml', qty: '2', price: '3.50', subtotal: '7.00' },
    { name: '蓝月亮洗衣液', qty: '1', price: '45.00', subtotal: '45.00' },
    // 超长名（宽 80 > 24/12）：折行必须生效（多行）
    { name: LONG_NAME, qty: '1', price: '1.00', subtotal: '1.00' },
    // 空字段：pad 后仍满宽
    { name: '', qty: '', price: '', subtotal: '' }
  ]

  it.each(['58mm', '80mm'] as const)(
    '%s：任意输入下每行宽度恒等于 PAPER_COLUMNS（含续行）',
    (paper) => {
      for (const c of CASES) {
        const lines = buildItemLines(c.name, c.qty, c.price, c.subtotal, paper)
        expect(lines.length).toBeGreaterThanOrEqual(1)
        for (const line of lines) {
          expect(stringWidth(line)).toBe(PAPER_COLUMNS[paper])
        }
      }
    }
  )

  it('单行名：一行返回，名称左对齐、数量/单价/小计右对齐', () => {
    const lines = buildItemLines('可乐', '2', '3.50', '7.00', '80mm')
    expect(lines).toHaveLength(1)
    const line = lines[0] as string
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

  it('超长名折行：行数 = wrapToGrid(name, w.name).length，首行四列齐备，续行三列为空白列', () => {
    const paper = '80mm'
    const w = ITEM_COLUMN_WIDTHS[paper]
    const lines = buildItemLines(LONG_NAME, '1', '1.00', '1.00', paper)
    const nameLines = wrapToGrid(LONG_NAME, w.name)
    expect(lines).toHaveLength(nameLines.length)
    expect(lines.length).toBeGreaterThan(1)

    // 首行：名称列 = 折行首段 pad；数字三列齐备
    const first = lines[0] as string
    expect(sliceByWidth(first, 0, w.name)).toBe(padLine(nameLines[0] as string, w.name))
    expect(sliceByWidth(first, w.name, w.name + w.qty)).toBe(' '.repeat(w.qty - 1) + '1')
    expect(sliceByWidth(first, w.name + w.qty, w.name + w.qty + w.price)).toBe(
      ' '.repeat(w.price - 4) + '1.00'
    )
    const head = w.name + w.qty + w.price
    expect(sliceByWidth(first, head, head + w.subtotal)).toBe(' '.repeat(w.subtotal - 4) + '1.00')

    // 续行：名称列 = 折行续段 pad；数量/单价/小计三列为空白列（同列宽全空格）
    for (let i = 1; i < lines.length; i++) {
      const cont = lines[i] as string
      expect(sliceByWidth(cont, 0, w.name)).toBe(padLine(nameLines[i] as string, w.name))
      expect(sliceByWidth(cont, w.name, w.name + w.qty)).toBe(' '.repeat(w.qty))
      expect(sliceByWidth(cont, w.name + w.qty, w.name + w.qty + w.price)).toBe(' '.repeat(w.price))
      expect(sliceByWidth(cont, head, head + w.subtotal)).toBe(' '.repeat(w.subtotal))
    }

    // 完整名不出现（已折行分段）
    expect(lines.join('').includes(LONG_NAME)).toBe(false)
  })

  it('组合顺序 = 降级 → wrap → pad：降级改变宽度后仍保证每行满宽（顺序锁定）', () => {
    // degrade 会追加 1 个字符：若降级先于折行，追加字符参与折行；
    // 若顺序颠倒（折行后才降级），行宽会超网格（padLine 不截断超宽输入）。
    const degradeAppends = (s: string): string => s + '!'
    const lines = buildItemLines('A'.repeat(24), '1', '1.00', '1.00', '80mm', degradeAppends)
    for (const line of lines) expect(stringWidth(line)).toBe(PAPER_COLUMNS['80mm'])
    expect((lines[0] as string).startsWith('A'.repeat(23))).toBe(true)
  })

  it('降级注入参与列几何：GBK 外字符（宽 2）替换 ?（宽 1）后按窄宽折行/pad', () => {
    // 模拟 T4 degradeToGbk 的行为形态：'𠀀'（宽 2）→ '?'（宽 1）
    const degrade = (s: string): string => s.replace('𠀀', '?')
    const lines = buildItemLines('𠀀测试品', '1', '2.00', '2.00', '80mm', degrade)
    const w = ITEM_COLUMN_WIDTHS['80mm']
    // 降级后宽 7（1+2×3），单行，左对齐 pad 至 24
    expect(lines).toHaveLength(1)
    expect(sliceByWidth(lines[0] as string, 0, w.name)).toBe(padLine('?测试品', w.name))
  })

  it('默认降级为恒等：GBK 外字符原样保留（renderer 预览无 iconv——差异已文档化）', () => {
    const lines = buildItemLines('𠀀测试品', '1', '2.00', '2.00', '80mm')
    const w = ITEM_COLUMN_WIDTHS['80mm']
    expect(sliceByWidth(lines[0] as string, 0, w.name)).toBe(padLine('𠀀测试品', w.name))
  })

  it('columnWidths 覆盖生效：名称列宽按覆盖值折行，行宽仍满网格', () => {
    const paper = '80mm'
    const override = { name: 28, qty: 4, price: 8, subtotal: 8 }
    const lines = buildItemLines(LONG_NAME, '1', '1.00', '1.00', paper, undefined, override)
    const nameLines = wrapToGrid(LONG_NAME, 28)
    expect(lines).toHaveLength(nameLines.length)
    for (const line of lines) expect(stringWidth(line)).toBe(PAPER_COLUMNS[paper])
    // 首行名称列片段宽恰为覆盖 name 列宽 28
    expect(sliceByWidth(lines[0] as string, 0, 28)).toBe(padLine(nameLines[0] as string, 28))
  })

  it('columnWidths 脏值（和不满网格）→ 回落默认列宽（运行时兜底）', () => {
    const paper = '80mm'
    const bad = { name: 40, qty: 4, price: 10, subtotal: 10 } // 64 ≠ 48
    const lines = buildItemLines('可乐', '2', '3.50', '7.00', paper, undefined, bad)
    const w = ITEM_COLUMN_WIDTHS[paper]
    expect(sliceByWidth(lines[0] as string, 0, w.name)).toBe('可乐' + ' '.repeat(w.name - 4))
  })

  it('与手工逐列组合完全一致（同源数学交叉验证：单行场景）', () => {
    const composeManually = (
      name: string,
      qty: string,
      price: string,
      subtotal: string,
      w: ItemColumnWidths
    ): string[] => {
      const nameLines = wrapToGrid(name, w.name)
      return nameLines.map((nl, i) =>
        i === 0
          ? padLine(nl, w.name) +
            padLine(truncateToGrid(qty, w.qty), w.qty, 'right') +
            padLine(truncateToGrid(price, w.price), w.price, 'right') +
            padLine(truncateToGrid(subtotal, w.subtotal), w.subtotal, 'right')
          : padLine(nl, w.name) + padLine('', w.qty) + padLine('', w.price, 'right') + padLine('', w.subtotal, 'right')
      )
    }
    for (const paper of ['58mm', '80mm'] as const) {
      for (const c of CASES) {
        expect(buildItemLines(c.name, c.qty, c.price, c.subtotal, paper)).toEqual(
          composeManually(c.name, c.qty, c.price, c.subtotal, ITEM_COLUMN_WIDTHS[paper])
        )
      }
    }
  })
})
