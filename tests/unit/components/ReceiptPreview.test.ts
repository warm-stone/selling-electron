// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'

import ReceiptPreview from '../../../src/renderer/src/components/receipt/ReceiptPreview.vue'
import { PAPER_COLUMNS, padLine, stringWidth, truncateToGrid } from '../../../src/shared/receipt/char-grid'
import {
  DEFAULT_TEMPLATE_58MM,
  DEFAULT_TEMPLATE_80MM
} from '../../../src/shared/receipt/default-template'
import { buildItemLine, type SaleReceiptData } from '../../../src/shared/receipt/item-columns'
import type { ReceiptTemplate, ReceiptVars } from '../../../src/shared/receipt/template-schema'
import { generateReceiptBytes } from '../../../src/main/printing/escpos/escpos-generator'
import { degradeToGbk } from '../../../src/main/printing/escpos/gb2312-encoder'

/**
 * Task 12 — ReceiptPreview 同源一致性测试（G7 核心）。
 *
 * 断言基石：组件渲染的 .receipt-line 文本数组 === shared char-grid/buildItemLine
 * 逐行计算的期望数组（居中偏移空格数、截断、满宽、bold/size class）；
 * items 行与 ESC/POS 生成器（shared buildItemLine + degradeToGbk）及其实际
 * 字节流（GBK 解码）三方对齐——所见即所打。
 */

const SAMPLE_DATA: SaleReceiptData = {
  items: [
    { name: '可口可乐330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' },
    { name: '蓝月亮洗衣液', quantity: '1', unitPrice: '45.00', subtotal: '45.00' }
  ]
}

const SAMPLE_VARS: ReceiptVars = {
  shopName: '中文测试收银',
  shopPhone: '13800001111',
  receiptNote: '谢谢惠顾',
  saleNo: '20261101-0001',
  datetime: '2026-11-01 21:00:00',
  total: '52.00',
  itemCount: '3'
}

/** mount 并提取 .receipt-line 原始文本（textContent——不能用 text()，它 trim 掉 pad 空格） */
function mountLines(
  template: ReceiptTemplate,
  data: SaleReceiptData = SAMPLE_DATA,
  vars: ReceiptVars = SAMPLE_VARS,
  logoUrl?: string
): string[] {
  const wrapper = mount(ReceiptPreview, { props: { template, data, vars, logoUrl } })
  return wrapper.findAll('.receipt-line').map((l) => l.element.textContent ?? '')
}

function mountEl(
  template: ReceiptTemplate,
  data: SaleReceiptData = SAMPLE_DATA,
  vars: ReceiptVars = SAMPLE_VARS,
  logoUrl?: string
) {
  return mount(ReceiptPreview, { props: { template, data, vars, logoUrl } })
}

describe('ReceiptPreview 同源一致性（80mm 默认模板）', () => {
  const cols = PAPER_COLUMNS['80mm']

  it('全行序列 === char-grid/buildItemLine 逐行期望数组（9 行 deepEqual）', () => {
    const expected = [
      padLine('中文测试收银', cols, 'center'),
      padLine('13800001111', cols, 'center'),
      buildItemLine('商品', '数量', '单价', '小计', '80mm'),
      buildItemLine('可口可乐330ml', '2', '3.50', '7.00', '80mm'),
      buildItemLine('蓝月亮洗衣液', '1', '45.00', '45.00', '80mm'),
      padLine('件数: 3', cols, 'right'),
      padLine('合计: ￥52.00', cols, 'right'),
      padLine('2026-11-01 21:00:00', cols, 'center'),
      padLine('谢谢惠顾', cols, 'center')
    ]
    expect(mountLines(DEFAULT_TEMPLATE_80MM)).toEqual(expected)
  })

  it('居中偏移空格数：shopName（宽 12）左 18 右 18', () => {
    const [shopName] = mountLines(DEFAULT_TEMPLATE_80MM)
    expect(shopName.startsWith(' '.repeat(18))).toBe(true)
    expect(shopName.endsWith(' '.repeat(18))).toBe(true)
    expect(shopName.slice(18, -18)).toBe('中文测试收银')
  })

  it('居中奇数余量左少右多：shopPhone（宽 11）左 18 右 19', () => {
    const lines = mountLines(DEFAULT_TEMPLATE_80MM)
    const phone = lines[1] as string
    expect(phone.startsWith(' '.repeat(18))).toBe(true)
    expect(phone.endsWith(' '.repeat(19))).toBe(true)
  })

  it('items 行满宽：列头与明细行 stringWidth === 48', () => {
    const lines = mountLines(DEFAULT_TEMPLATE_80MM)
    for (const line of lines.slice(2, 5)) {
      expect(stringWidth(line as string)).toBe(cols)
    }
  })

  it('bold/size class：shopName 行同时挂 receipt-line--bold 与 --double-height', () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM)
    const shop = wrapper.findAll('.receipt-line')[0]
    expect(shop.classes()).toContain('receipt-line--bold')
    expect(shop.classes()).toContain('receipt-line--double-height')
  })

  it('totals 合计行加粗：receipt-line--bold', () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM)
    const totalLine = wrapper.findAll('.receipt-line')[6]
    expect(totalLine.classes()).toContain('receipt-line--bold')
  })

  it('right 对齐行：合计行以 17 个前导空格开头（宽 13 → pad 35）', () => {
    const lines = mountLines(DEFAULT_TEMPLATE_80MM)
    expect(lines[6]?.startsWith(' '.repeat(17))).toBe(true)
  })

  it('等宽字体：容器挂 mono-cjk（小票内容禁止非等宽渲染）', () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM)
    expect(wrapper.find('.mono-cjk').exists()).toBe(true)
  })

  it('容器宽度：80mm → 307px、58mm → 221px（px @96dpi 物理纸宽）', () => {
    const w80 = mountEl(DEFAULT_TEMPLATE_80MM)
    expect((w80.find('[data-testid="receipt-paper"]').element as HTMLElement).style.width).toBe('307px')
    const w58 = mountEl(DEFAULT_TEMPLATE_58MM)
    expect((w58.find('[data-testid="receipt-paper"]').element as HTMLElement).style.width).toBe('221px')
  })

  it('divider：渲染为 border 虚线元素（无文本、不占 receipt-line）', () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM)
    const divider = wrapper.find('.receipt-divider')
    expect(divider.exists()).toBe(true)
    expect((divider.element as HTMLElement).textContent).toBe('')
    expect(divider.classes()).not.toContain('receipt-line')
  })

  it('cutPaper：默认模板 true → 底部剪切示意存在；false → 不存在', () => {
    expect(mountEl(DEFAULT_TEMPLATE_80MM).find('.receipt-cut').exists()).toBe(true)
    const noCut: ReceiptTemplate = { ...DEFAULT_TEMPLATE_80MM, cutPaper: false }
    expect(mountEl(noCut).find('.receipt-cut').exists()).toBe(false)
  })
})

describe('ReceiptPreview 超宽与边界', () => {
  it('超长商品名（宽 80）：name 列截断到 24，整行仍满宽 48，完整名不出现', () => {
    const long = '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
    const data: SaleReceiptData = {
      items: [{ name: long, quantity: '1', unitPrice: '1.00', subtotal: '1.00' }]
    }
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM, data)
    const rows = wrapper.findAll('.receipt-items tr.receipt-line')
    const nameCell = rows[1]?.find('td')?.element.textContent ?? ''
    expect(stringWidth(nameCell)).toBe(24)
    const rowText = (rows[1]?.element as HTMLElement).textContent ?? ''
    expect(stringWidth(rowText)).toBe(48)
    expect(rowText.includes(long)).toBe(false)
    // 截断行 === buildItemLine 同源组合
    expect(rowText).toBe(buildItemLine(long, '1', '1.00', '1.00', '80mm'))
  })

  it('超宽 text 段落：truncate 后 pad（先 truncate 再 pad 顺序）', () => {
    const t: ReceiptTemplate = {
      ...DEFAULT_TEMPLATE_80MM,
      header: [{ type: 'text', content: 'A'.repeat(60), align: 'left' }],
      items: { type: 'items', showHeader: false }
    }
    const lines = mountLines(t, { items: [] })
    expect(lines[0]).toBe(padLine(truncateToGrid('A'.repeat(60), 48), 48, 'left'))
    expect(stringWidth(lines[0] as string)).toBe(48)
  })

  it('未知变量保留原文（T3 契约）', () => {
    const t: ReceiptTemplate = {
      ...DEFAULT_TEMPLATE_80MM,
      footer: [{ type: 'text', content: '{未知变量}尾注', align: 'center' }]
    }
    const lines = mountLines(t)
    expect(lines.at(-1)?.trim()).toBe('{未知变量}尾注')
  })

  it('items 表四列宽度按 ITEM_COLUMN_WIDTHS 换算 %（80mm：50/8.33/20.83/20.83）', () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM)
    const colEls = wrapper.findAll('.receipt-items colgroup col')
    expect(colEls).toHaveLength(4)
    const widths = colEls.map((c) => (c.element as HTMLElement).style.width)
    expect(widths[0]).toBe('50%')
    expect(widths[1]).toBe('8.33%')
    expect(widths[2]).toBe('20.83%')
    expect(widths[3]).toBe('20.83%')
  })

  it('image 段落：logoUrl 传入渲染 img（src+maxWidth 换算列宽）；未传静默跳过', () => {
    const t: ReceiptTemplate = {
      ...DEFAULT_TEMPLATE_80MM,
      header: [{ type: 'image' }, ...DEFAULT_TEMPLATE_80MM.header]
    }
    const noLogo = mountEl(t)
    expect(noLogo.find('.receipt-logo').exists()).toBe(false)

    const logoUrl = 'data:image/png;base64,iVBORw0KGgo='
    const withLogo = mountEl(t, SAMPLE_DATA, SAMPLE_VARS, logoUrl)
    const img = withLogo.find('.receipt-logo')
    expect(img.exists()).toBe(true)
    expect((img.element as HTMLImageElement).getAttribute('src')).toBe(logoUrl)
    // 80mm 网格 48 列 × 半角 6px = 288px 墨迹宽
    expect((img.element as HTMLImageElement).style.maxWidth).toBe('288px')
  })
})

describe('ReceiptPreview 58mm 双纸宽', () => {
  it('shopName 居中 pad 到 32 列（左 10 右 10）', () => {
    const lines = mountLines(DEFAULT_TEMPLATE_58MM)
    expect(lines[0]).toBe(padLine('中文测试收银', 32, 'center'))
    expect(lines[0]?.startsWith(' '.repeat(10))).toBe(true)
  })

  it('items 行 === buildItemLine(..., 58mm) 且满宽 32', () => {
    const lines = mountLines(DEFAULT_TEMPLATE_58MM)
    expect(lines[2]).toBe(buildItemLine('商品', '数量', '单价', '小计', '58mm'))
    expect(lines[3]).toBe(buildItemLine('可口可乐330ml', '2', '3.50', '7.00', '58mm'))
    expect(stringWidth(lines[3] as string)).toBe(32)
  })
})

describe('与 T4 ESC/POS 字节流对齐（所见即所打，G7 锁定）', () => {
  it('items 行文本 === buildItemLine(..., degradeToGbk)（生成器同款降级注入；GBK 内数据恒等）', () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM)
    const rows = wrapper.findAll('.receipt-items tr.receipt-line')
    for (let i = 1; i < rows.length; i++) {
      const text = (rows[i]?.element as HTMLElement).textContent ?? ''
      const item = SAMPLE_DATA.items[i - 1] as { name: string; quantity: string; unitPrice: string; subtotal: string }
      expect(text).toBe(
        buildItemLine(item.name, item.quantity, item.unitPrice, item.subtotal, '80mm', degradeToGbk)
      )
    }
  })

  it('items 行文本可在生成字节流的 GBK 解码中逐行找到（字节级同源）', async () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM)
    const rows = wrapper.findAll('.receipt-items tr.receipt-line')
    const bytes = await generateReceiptBytes(DEFAULT_TEMPLATE_80MM, SAMPLE_DATA, SAMPLE_VARS)
    const decoded = iconv.decode(Buffer.from(bytes), 'EUC-CN')
    for (const row of rows) {
      const text = row.element.textContent ?? ''
      expect(text.length).toBeGreaterThan(0)
      expect(decoded).toContain(text)
    }
  })

  it('text 段落插值内容（trim 后）与字节流解码一致', async () => {
    const lines = mountLines(DEFAULT_TEMPLATE_80MM)
    const bytes = await generateReceiptBytes(DEFAULT_TEMPLATE_80MM, SAMPLE_DATA, SAMPLE_VARS)
    const decoded = iconv.decode(Buffer.from(bytes), 'EUC-CN')
    // shopName / 合计 / 谢谢惠顾 的插值正文（打印侧无 pad，ESC a 物理对齐）
    for (const raw of ['中文测试收银', '合计: ￥52.00', '谢谢惠顾', '2026-11-01 21:00:00']) {
      const rendered = lines.find((l) => l.trim() === raw)
      expect(rendered).toBeDefined()
      expect(decoded).toContain(raw)
    }
  })
})
