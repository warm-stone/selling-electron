import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TEMPLATE_58MM,
  DEFAULT_TEMPLATE_80MM
} from '../../../src/shared/receipt/default-template'
import type { ReceiptTemplate } from '../../../src/shared/receipt/template-schema'
import { interpolateVariables } from '../../../src/shared/receipt/template-schema'
import type { ReceiptVars } from '../../../src/shared/receipt/template-schema'
import { PAPER_COLUMNS } from '../../../src/shared/receipt/char-grid'

// ── 类型合规性（编译期）：默认模板必须满足 ReceiptTemplate ──
const typeCheck80: ReceiptTemplate = DEFAULT_TEMPLATE_80MM
const typeCheck58: ReceiptTemplate = DEFAULT_TEMPLATE_58MM
void typeCheck80
void typeCheck58

const fullVars: ReceiptVars = {
  shopName: '测试店',
  shopPhone: '13800000000',
  receiptNote: '退换货请保留小票',
  saleNo: '20261101-0001',
  datetime: '2026-11-01 12:00:00',
  total: '12.00',
  itemCount: '3',
  companyFooter: 'XX公司'
}

describe('DEFAULT_TEMPLATE_80MM（80mm 默认模板）', () => {
  it('paperWidth=80mm，列数与 char-grid 一致', () => {
    expect(DEFAULT_TEMPLATE_80MM.paperWidth).toBe('80mm')
    expect(PAPER_COLUMNS[DEFAULT_TEMPLATE_80MM.paperWidth]).toBe(48)
  })

  it('头部：shopName 倍高居中 + shopPhone 居中 + divider', () => {
    const { header } = DEFAULT_TEMPLATE_80MM
    expect(header[0]).toMatchObject({
      type: 'text',
      content: '{shopName}',
      align: 'center',
      size: 'doubleHeight'
    })
    expect(header[1]).toMatchObject({ type: 'text', content: '{shopPhone}', align: 'center' })
    expect(header[2]).toMatchObject({ type: 'divider' })
  })

  it('items 段存在且为段落级配置（G14）', () => {
    expect(DEFAULT_TEMPLATE_80MM.items.type).toBe('items')
  })

  it('totals 合计行加粗', () => {
    const totalLine = DEFAULT_TEMPLATE_80MM.totals.find((l) => l.label.includes('合计'))
    expect(totalLine).toBeDefined()
    expect(totalLine?.bold).toBe(true)
  })

  it('footer：datetime + 谢谢惠顾，居中', () => {
    const { footer } = DEFAULT_TEMPLATE_80MM
    const datetime = footer.find((s) => s.content === '{datetime}')
    const thanks = footer.find((s) => s.content === '谢谢惠顾')
    expect(datetime?.align).toBe('center')
    expect(thanks?.align).toBe('center')
  })

  it('cutPaper=true（自动切纸）', () => {
    expect(DEFAULT_TEMPLATE_80MM.cutPaper).toBe(true)
  })
})

describe('DEFAULT_TEMPLATE_58MM（58mm 变体）', () => {
  it('结构存在且 paperWidth=58mm，列数与 char-grid 一致', () => {
    expect(DEFAULT_TEMPLATE_58MM.paperWidth).toBe('58mm')
    expect(PAPER_COLUMNS[DEFAULT_TEMPLATE_58MM.paperWidth]).toBe(32)
  })

  it('与 80mm 变体共享段落结构（头部/明细/合计/页脚语义一致）', () => {
    expect(DEFAULT_TEMPLATE_58MM.header[0]).toMatchObject({
      type: 'text',
      content: '{shopName}',
      align: 'center',
      size: 'doubleHeight'
    })
    expect(DEFAULT_TEMPLATE_58MM.items.type).toBe('items')
    expect(
      DEFAULT_TEMPLATE_58MM.totals.find((l) => l.label.includes('合计'))?.bold
    ).toBe(true)
    expect(DEFAULT_TEMPLATE_58MM.cutPaper).toBe(true)
  })
})

describe('默认模板插槽完整性', () => {
  const collectSlots = (t: ReceiptTemplate): string[] => {
    const texts: string[] = [
      ...t.header.map((s) => s.content ?? ''),
      ...t.totals.map((l) => l.label),
      ...t.footer.map((s) => s.content ?? '')
    ]
    const slots: string[] = []
    for (const text of texts) {
      for (const m of text.matchAll(/\{(\w+)\}/g)) slots.push(m[1])
    }
    return slots
  }

  it('全部 {插槽} 均为 ReceiptVars 已知变量（无未知插槽）', () => {
    for (const template of [DEFAULT_TEMPLATE_80MM, DEFAULT_TEMPLATE_58MM]) {
      for (const slot of collectSlots(template)) {
        expect(fullVars[slot], `模板变量 {${slot}} 未在 ReceiptVars 样例中提供`).toBeDefined()
      }
    }
  })

  it('interpolate 后不再残留 { 花括号', () => {
    for (const template of [DEFAULT_TEMPLATE_80MM, DEFAULT_TEMPLATE_58MM]) {
      const texts = [
        ...template.header.map((s) => s.content ?? ''),
        ...template.totals.map((l) => l.label),
        ...template.footer.map((s) => s.content ?? '')
      ]
      for (const text of texts) {
        expect(interpolateVariables(text, fullVars)).not.toContain('{')
      }
    }
  })
})
