import { describe, expect, it } from 'vitest'
import { generateReceiptHtml } from '../../../../src/main/printing/driver/receipt-html'
import { DEFAULT_TEMPLATES } from '../../../../src/shared/receipt/default-template'
import { buildItemLines, buildSnLines } from '../../../../src/shared/receipt/item-columns'
import type { SaleReceiptData } from '../../../../src/shared/receipt/item-columns'
import type { PaperWidth } from '../../../../src/shared/receipt/char-grid'
import type { ReceiptTemplate, ReceiptVars } from '../../../../src/shared/receipt/template-schema'

/**
 * 收据 HTML 生成器单元测试（纯函数，零 Electron/IO）：
 *  - 完整独立文档骨架（doctype/charset/data-paper-width/纸宽 px/零外部资源）
 *  - 58mm/80mm 双默认模板全结构（店名/明细/分隔线/合计/页脚/剪切示意）
 *  - HTML 转义（店名/商品名注入 <script> → 实体化，不得注入标记）
 *  - Logo dataURL（logoBuffers → <img>；缺 Buffer 静默跳过）
 *  - G7 同源交叉验证：items 表逐格拼接与 buildItemLines 行集逐字一致；
 *    SN 副行与 buildSnLines 一致（第三渲染器与打印/预览同数学的证据）
 */

/** 1×1 透明 PNG（valid 头，dataURL 断言用——同 settings.ipc.test 夹具） */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const VARS: ReceiptVars = {
  shopName: '测试便利店',
  shopPhone: '13800000000',
  receiptNote: '谢谢惠顾，欢迎再次光临',
  saleNo: '20261101-0003',
  datetime: '2026-11-01 12:30:05',
  total: '10.50',
  itemCount: '3'
}

const DATA: SaleReceiptData = {
  items: [
    { name: '可口可乐 330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' },
    {
      // 超长名（显示宽 50 > 80mm 名称列 24）→ wrapToGrid 折行（折行路径覆盖）
      name: '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸',
      quantity: '1',
      unitPrice: '3.50',
      subtotal: '3.50'
    }
  ]
}

describe('generateReceiptHtml（文档骨架：完整独立 HTML）', () => {
  it('58mm：doctype + charset + data-paper-width="58mm" + 221px 纸宽 + 零外部资源', () => {
    const html = generateReceiptHtml(DEFAULT_TEMPLATES['58mm'], DATA, VARS, new Map())

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<body data-paper-width="58mm">')
    expect(html).toContain('width: 221px') // 与 ReceiptPreview 同值（几何同源）
    // 独立文档：无外链样式/脚本/图片（离线可渲染，driver 通道 data: URL 加载）
    expect(html).not.toMatch(/<link\b/)
    expect(html).not.toMatch(/<script\b/)
    expect(html).not.toMatch(/(?:src|href)="https?:/)
  })

  it('80mm：data-paper-width="80mm" + 307px 纸宽', () => {
    const html = generateReceiptHtml(DEFAULT_TEMPLATES['80mm'], DATA, VARS, new Map())

    expect(html).toContain('<body data-paper-width="80mm">')
    expect(html).toContain('width: 307px')
  })
})

describe('generateReceiptHtml（58mm 默认模板全结构）', () => {
  const html = generateReceiptHtml(DEFAULT_TEMPLATES['58mm'], DATA, VARS, new Map())

  it('店名段落：倍高加粗居中 class + align/transform-origin 样式 + 转义后店名文本', () => {
    // 默认模板 header[0]：{shopName} doubleHeight bold center
    expect(html).toContain('receipt-line--bold')
    expect(html).toContain('receipt-line--double-height')
    expect(html).toContain('text-align: center')
    expect(html).toContain('transform-origin: center top')
    expect(html).toContain('margin-bottom: 1.35em')
    expect(html).toContain('测试便利店')
  })

  it('明细表：列头 + 商品行（四列 colgroup + 右对齐数字格）', () => {
    expect(html).toContain('<table class="receipt-items">')
    expect(html).toContain('<colgroup>')
    // 58mm 默认列宽 12+4+8+8=32 → % 列宽（与 ReceiptPreview 同换算）
    expect(html).toContain('<col style="width: 37.5%">')
    expect(html).toContain('<td style="text-align: right">')
    // 58mm 名称列 12 宽：'可口可乐 330ml'（显示宽 14）必然折行——分段断言
    expect(html).toContain('可口可乐')
    expect(html).toContain('330ml')
    expect(html).toContain('商品') // 列头默认文案
  })

  it('分隔线 + 合计区 + 页脚 + 剪切示意', () => {
    expect(html).toContain('class="receipt-divider"')
    expect(html).toContain('件数')
    expect(html).toContain('合计')
    expect(html).toContain('￥10.50') // {total} 插槽替换（全角￥保留）
    expect(html).toContain('2026-11-01 12:30:05') // {datetime}
    expect(html).toContain('谢谢惠顾')
    expect(html).toContain('class="receipt-cut"') // cutPaper=true → 剪切示意
  })
})

describe('generateReceiptHtml（HTML 转义：插值文本不得注入标记）', () => {
  it('店名含 <script>/引号 → 实体化；商品名含 &/</> → 实体化', () => {
    const vars: ReceiptVars = {
      ...VARS,
      shopName: '<script>alert("x")</script>',
      shopPhone: "138'000"
    }
    const data: SaleReceiptData = {
      items: [{ name: 'A&B<C>"D\'', quantity: '1', unitPrice: '1.00', subtotal: '1.00' }]
    }
    const html = generateReceiptHtml(DEFAULT_TEMPLATES['80mm'], data, vars, new Map())

    // 原文标记不出现（防注入），实体化形态出现
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).toContain('A&amp;B&lt;C&gt;&quot;D&#39;')
    // 单引号（shopPhone）→ &#39;
    expect(html).toContain('138&#39;000')
  })
})

describe('generateReceiptHtml（Logo dataURL）', () => {
  const templateWithLogo: ReceiptTemplate = {
    ...DEFAULT_TEMPLATES['80mm'],
    header: [{ type: 'image', logoId: 5 }, ...DEFAULT_TEMPLATES['80mm'].header]
  }

  it('logoBuffers 命中 logoId → <img> dataURL（max-width 与列宽同基准）', () => {
    const png = Buffer.from(PNG_1PX_BASE64, 'base64')
    const html = generateReceiptHtml(
      templateWithLogo,
      DATA,
      VARS,
      new Map([[5, png]])
    )

    expect(html).toContain(
      `<img class="receipt-logo" src="data:image/png;base64,${PNG_1PX_BASE64}"`
    )
    expect(html).toContain('style="max-width: 288px"') // 80mm 48 列 × 6px（同预览 logoMaxWidth）
  })

  it('logoBuffers 无对应 Buffer → image 段落静默跳过（同 ESC/POS/预览语义）', () => {
    const html = generateReceiptHtml(templateWithLogo, DATA, VARS, new Map())
    expect(html).not.toContain('<img')
  })
})

describe('generateReceiptHtml（G7 同源交叉验证：与 buildItemLines/buildSnLines 同数学）', () => {
  ;(['58mm', '80mm'] as const).forEach((paper: PaperWidth) => {
    it(`${paper}：items 表逐格拼接文本 === buildItemLines 行集逐字一致（含折行）`, () => {
      const template = DEFAULT_TEMPLATES[paper]
      const html = generateReceiptHtml(template, DATA, VARS, new Map())

      // 提取 items 表并剥离标签：单元格文本按 DOM 顺序拼接（每行 4 格 = 一条网格行）
      const table = html.match(/<table class="receipt-items">([\s\S]*)<\/table>/)
      expect(table).not.toBeNull()
      const stripped = table![1].replace(/<[^>]+>/g, '')

      // 期望行集：列头 + 逐商品（shared buildItemLines 独立重算——恒等降级）
      const expected = [
        ...buildItemLines(
          '商品', '数量', '单价', '小计', paper
        ),
        ...DATA.items.flatMap((it) =>
          buildItemLines(it.name, it.quantity, it.unitPrice, it.subtotal, paper)
        )
      ].join('')

      expect(stripped).toBe(expected)
    })
  })

  it('SN 副行：buildSnLines 行文本进入 colspan 全宽行', () => {
    const dataWithSn: SaleReceiptData = {
      items: [{ name: '国补手机', quantity: '1', unitPrice: '1999.00', subtotal: '1999.00', sn: 'SN861001AB12345' }]
    }
    const html = generateReceiptHtml(DEFAULT_TEMPLATES['80mm'], dataWithSn, VARS, new Map())

    expect(html).toContain('receipt-line--sn')
    expect(html).toContain('<td colspan="4" style="text-align: left">')
    const sn = buildSnLines('SN861001AB12345', '80mm')[0] ?? ''
    expect(sn).not.toBe('')
    expect(html).toContain(sn)
  })

  it('无列头且无明细 → 整表不渲染（同 ReceiptPreview 语义）；cutPaper=false → 无剪切示意', () => {
    const template: ReceiptTemplate = {
      ...DEFAULT_TEMPLATES['58mm'],
      items: { type: 'items', showHeader: false },
      cutPaper: false
    }
    const html = generateReceiptHtml(template, { items: [] }, VARS, new Map())

    expect(html).not.toContain('<table')
    // CSS 中 .receipt-cut 规则文本常在——断言的是剪切示意元素本身
    expect(html).not.toContain('<div class="receipt-cut"')
  })
})
