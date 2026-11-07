// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'

import ReceiptPreview from '../../../src/renderer/src/components/receipt/ReceiptPreview.vue'
import { PAPER_COLUMNS, padLine, stringWidth, truncateToGrid, wrapToGrid } from '../../../src/shared/receipt/char-grid'
import {
  DEFAULT_TEMPLATE_58MM,
  DEFAULT_TEMPLATE_80MM
} from '../../../src/shared/receipt/default-template'
import { buildItemLines, type SaleReceiptData } from '../../../src/shared/receipt/item-columns'
import type { ReceiptTemplate, ReceiptVars } from '../../../src/shared/receipt/template-schema'
import { generateReceiptBytes } from '../../../src/main/printing/escpos/escpos-generator'
import { degradeToGbk } from '../../../src/main/printing/escpos/gb2312-encoder'

/**
 * Task 12 — ReceiptPreview 同源一致性测试（G7 核心）。
 *
 * 断言基石：组件渲染的 .receipt-line 文本数组 === shared char-grid/buildItemLines
 * 逐行计算的期望数组（居中偏移空格数、折行、满宽、bold/size class）；
 * items 行与 ESC/POS 生成器（shared buildItemLines + degradeToGbk）及其实际
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
  logoUrls?: Record<number, string>
): string[] {
  const wrapper = mount(ReceiptPreview, { props: { template, data, vars, logoUrls } })
  return wrapper.findAll('.receipt-line').map((l) => l.element.textContent ?? '')
}

function mountEl(
  template: ReceiptTemplate,
  data: SaleReceiptData = SAMPLE_DATA,
  vars: ReceiptVars = SAMPLE_VARS,
  logoUrls?: Record<number, string>
) {
  return mount(ReceiptPreview, { props: { template, data, vars, logoUrls } })
}

describe('ReceiptPreview 同源一致性（80mm 默认模板）', () => {
  const cols = PAPER_COLUMNS['80mm']

  it('全行序列 === char-grid/buildItemLines 逐行期望数组（9 行 deepEqual）', () => {
    const expected = [
      padLine('中文测试收银', cols, 'center'),
      padLine('13800001111', cols, 'center'),
      ...buildItemLines('商品', '数量', '单价', '小计', '80mm'),
      ...buildItemLines('可口可乐330ml', '2', '3.50', '7.00', '80mm'),
      ...buildItemLines('蓝月亮洗衣液', '1', '45.00', '45.00', '80mm'),
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
  it('超长商品名（宽 56）：名称列折行多行，续行右侧三列空白；行集 === buildItemLines 同源组合', () => {
    const long = '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
    const data: SaleReceiptData = {
      items: [{ name: long, quantity: '1', unitPrice: '1.00', subtotal: '1.00' }]
    }
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM, data)
    const rows = wrapper.findAll('.receipt-items tr.receipt-line')
    // 行集 === buildItemLines（G7 同源：首行四列齐备、续行右侧三列空白）
    const expectedLines = buildItemLines(long, '1', '1.00', '1.00', '80mm')
    // 56 宽在 24 列名称栏折 3 行：列头 1 + 长名 3 = 4 行
    expect(expectedLines.length).toBeGreaterThan(1)
    expect(rows).toHaveLength(1 + expectedLines.length)

    const nameCell = rows[1]?.find('td')?.element.textContent ?? ''
    expect(stringWidth(nameCell)).toBe(24)
    const rowText = (rows[1]?.element as HTMLElement).textContent ?? ''
    expect(stringWidth(rowText)).toBe(48)
    expect(rowText.includes(long)).toBe(false)

    for (let i = 0; i < expectedLines.length; i++) {
      const text = (rows[i + 1]?.element as HTMLElement).textContent ?? ''
      expect(text).toBe(expectedLines[i])
      // 每行仍满宽（续行 = 名称列 pad + 三空白列 pad）
      expect(stringWidth(text)).toBe(48)
    }
  })

  it('超宽 text 段落：wrap 折行后逐行 pad（先 wrap 再 pad 顺序）', () => {
    const t: ReceiptTemplate = {
      ...DEFAULT_TEMPLATE_80MM,
      header: [{ type: 'text', content: 'A'.repeat(60), align: 'left' }],
      items: { type: 'items', showHeader: false }
    }
    const lines = mountLines(t, { items: [] })
    // 60 半角在 48 列折 2 行：48 + 12，每行 pad 满宽（模板 totals/footer 段落仍在，取 header 前缀）
    const expected = wrapToGrid('A'.repeat(60), 48).map((l) => padLine(l, 48, 'left'))
    expect(lines.slice(0, 2)).toEqual(expected)
    for (const line of expected) {
      expect(stringWidth(line)).toBe(48)
    }
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

  it('image 段落：logoUrls 按 logoId 命中渲染 img（src+maxWidth 换算列宽）；未指定/未命中静默跳过', () => {
    const t = (logoId?: number): ReceiptTemplate => ({
      ...DEFAULT_TEMPLATE_80MM,
      header: [{ type: 'image', logoId }, ...DEFAULT_TEMPLATE_80MM.header]
    })
    // 未指定 logoId：静默跳过（同打印侧语义）
    expect(mountEl(t(undefined)).find('.receipt-logo').exists()).toBe(false)
    // 指定 logoId 但 logoUrls 无对应图：静默跳过
    expect(mountEl(t(1), SAMPLE_DATA, SAMPLE_VARS, {}).find('.receipt-logo').exists()).toBe(false)

    const logoUrl = 'data:image/png;base64,iVBORw0KGgo='
    const withLogo = mountEl(t(1), SAMPLE_DATA, SAMPLE_VARS, { 1: logoUrl })
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

  it('items 行 === buildItemLines(..., 58mm) 且满宽 32；宽 13 名折行续行右侧空白', () => {
    const lines = mountLines(DEFAULT_TEMPLATE_58MM)
    expect(lines[2]).toBe(buildItemLines('商品', '数量', '单价', '小计', '58mm')[0])
    // '可口可乐330ml' 宽 13 > 12 列名称栏 → 折 2 行（首行 + 续行）
    const colaLines = buildItemLines('可口可乐330ml', '2', '3.50', '7.00', '58mm')
    expect(colaLines).toHaveLength(2)
    expect(lines[3]).toBe(colaLines[0])
    expect(lines[4]).toBe(colaLines[1])
    expect(stringWidth(lines[3] as string)).toBe(32)
    expect(stringWidth(lines[4] as string)).toBe(32)
  })
})

describe('与 T4 ESC/POS 字节流对齐（所见即所打，G7 锁定）', () => {
  it('items 行文本 === buildItemLines(..., degradeToGbk) 行集（生成器同款降级注入；GBK 内数据恒等）', () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM)
    const rows = wrapper.findAll('.receipt-items tr.receipt-line')
    // 明细行集（跳过 nth(0) 列头行）与 buildItemLines 全量行集逐行相等（折行场景同序）
    const rowTexts = rows.slice(1).map((r) => r.element.textContent ?? '')
    const expectedLines = SAMPLE_DATA.items.flatMap((item) =>
      buildItemLines(item.name, item.quantity, item.unitPrice, item.subtotal, '80mm', degradeToGbk)
    )
    expect(rowTexts).toEqual(expectedLines)
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

describe('SN 副行（D-SN12/T3.1：数据驱动渲染，G7 同源）', () => {
  /** SN 混合样例：1 SN 行 + 1 批量计行（无 sn——两侧行集都不出现副行） */
  const SN_DATA: SaleReceiptData = {
    items: [
      { name: '华为路由器 AX3', quantity: '1', unitPrice: '199.00', subtotal: '199.00', sn: 'SN861001AB12345' },
      { name: '可口可乐330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' }
    ]
  }

  it('58mm：sn 行名称折行后渲染 SN 副行，文本 === char-grid 同源组合；批量计行无副行', () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_58MM, SN_DATA)
    const snRows = wrapper.findAll('[data-testid="receipt-item-sn"]')
    expect(snRows).toHaveLength(1)
    // '  SN:SN861001AB12345' 宽 20 → pad 至 32
    expect(snRows[0]!.element.textContent).toBe(padLine('  SN:SN861001AB12345', 32))
    // 行序：列头 1 + 名称折行 2（'华为路由器 AX3' 宽 14 > 12）+ 副行 1 + 批量行名称折行 2
    const rows = wrapper.findAll('.receipt-items tr.receipt-line')
    expect(rows).toHaveLength(1 + 2 + 1 + 2)
    // 副行排在名称行集之后（index 3，恰为名称两行之后）
    expect(rows[3]!.element.textContent).toBe(padLine('  SN:SN861001AB12345', 32))
  })

  it("58mm 超长 SN 截断：保留前 26 列 + '*'，行宽恰 32，全码不出现（R3）", () => {
    const long = 'SN-VERY-LONG-IDENTIFIER-000123456789'
    const data: SaleReceiptData = {
      items: [{ name: '蓝牙耳机', quantity: '1', unitPrice: '49.00', subtotal: '49.00', sn: long }]
    }
    const wrapper = mountEl(DEFAULT_TEMPLATE_58MM, data)
    const snRow = wrapper.find('[data-testid="receipt-item-sn"]')
    expect(snRow.exists()).toBe(true)
    const text = snRow.element.textContent ?? ''
    expect(stringWidth(text)).toBe(32)
    expect(text.trimEnd()).toBe('  SN:' + truncateToGrid(long, 26) + '*')
    expect(text.includes(long)).toBe(false)
  })

  it('sn 行文本可在生成字节流的 GBK 解码中逐行找到（副行字节级同源，所见即所打）', async () => {
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM, SN_DATA)
    const bytes = await generateReceiptBytes(DEFAULT_TEMPLATE_80MM, SN_DATA, SAMPLE_VARS)
    const decoded = iconv.decode(Buffer.from(bytes), 'EUC-CN')
    const snRows = wrapper.findAll('[data-testid="receipt-item-sn"]')
    expect(snRows).toHaveLength(1)
    const text = snRows[0]!.element.textContent ?? ''
    // 80mm 可用 43 列 ≥ 15 列原码 → 副行无截断，预览文本与字节流逐字一致
    expect(stringWidth(text)).toBe(PAPER_COLUMNS['80mm'])
    expect(decoded).toContain(text)
  })

  it('sn=null 行不渲染副行（批量计行零行为变化——数据驱动默认行为）', () => {
    const data: SaleReceiptData = {
      items: [{ name: '可乐', quantity: '1', unitPrice: '2.00', subtotal: '2.00', sn: null }]
    }
    const wrapper = mountEl(DEFAULT_TEMPLATE_80MM, data)
    expect(wrapper.find('[data-testid="receipt-item-sn"]').exists()).toBe(false)
    // 无 sn 销售的行集与旧版完全一致：列头 1 + 明细 1
    expect(wrapper.findAll('.receipt-items tr.receipt-line')).toHaveLength(2)
  })
})
