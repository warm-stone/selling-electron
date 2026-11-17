import { describe, expect, it } from 'vitest'
import {
  FIT_TO_WIDTH_BODY,
  generateReceiptHtml,
  RECEIPT_PRINT_GEOMETRY
} from '../../../../src/main/printing/driver/receipt-html'
import { DEFAULT_TEMPLATES } from '../../../../src/shared/receipt/default-template'
import { buildItemLines, buildSnLines } from '../../../../src/shared/receipt/item-columns'
import type { SaleReceiptData } from '../../../../src/shared/receipt/item-columns'
import type { PaperWidth } from '../../../../src/shared/receipt/char-grid'
import type { ReceiptTemplate, ReceiptVars } from '../../../../src/shared/receipt/template-schema'

/**
 * 收据 HTML 生成器单元测试（纯函数，零 Electron/IO）：
 *  - 完整独立文档骨架（doctype/charset/data-paper-width + data-page-width-microns/
 *    可打印页宽 mm/零外部资源）
 *  - 打印版面几何（RECEIPT_PRINT_GEOMETRY）：页宽 = 可打印宽、半角推进量恰 0.5em
 *  - 纯黑版面（无屏幕灰阶——1 位色深驱动会把灰阶抖动成网点小白点）
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
  it('58mm：doctype + charset + data-paper-width/data-page-width-microns + 48mm 可打印页宽 + 零外部资源', () => {
    const html = generateReceiptHtml(DEFAULT_TEMPLATES['58mm'], DATA, VARS, new Map())

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    // data-page-width-microns 是 driver 通道的页宽来源（= 可打印宽，与驱动 DEVMODE 同基准）
    expect(html).toContain('<body data-paper-width="58mm" data-page-width-microns="48000">')
    // 容器宽 = 可打印宽 48mm，**不是纸宽 58mm**（纸两侧各有物理不可打印边，
    // 旧版 221px≈58.5mm 的网格最右两列半落在打印头之外 → 合计行末位被吃）
    expect(html).toContain('width: 48mm')
    expect(html).not.toContain('width: 221px')
    // 独立文档：无外链样式/脚本/图片（离线可渲染，driver 通道 data: URL 加载）
    expect(html).not.toMatch(/<link\b/)
    expect(html).not.toMatch(/<script\b/)
    expect(html).not.toMatch(/(?:src|href)="https?:/)
  })

  it('80mm：data-page-width-microns="72000" + 72mm 可打印页宽', () => {
    const html = generateReceiptHtml(DEFAULT_TEMPLATES['80mm'], DATA, VARS, new Map())

    expect(html).toContain('<body data-paper-width="80mm" data-page-width-microns="72000">')
    expect(html).toContain('width: 72mm')
    expect(html).not.toContain('width: 307px')
  })

  it('纯黑版面：无屏幕灰阶色（正文/分隔线/剪切线），并声明 print-color-adjust: exact', () => {
    // 真机 20261117 症状「HTML 打印内容中间有很多小白点」的直接根因：
    // 屏幕灰（#14161a/#5a5f66/#9aa0a8）被 1 位色深驱动抖动成网点
    for (const paper of ['58mm', '80mm'] as const) {
      const html = generateReceiptHtml(DEFAULT_TEMPLATES[paper], DATA, VARS, new Map())
      expect(html).not.toMatch(/#14161a|#5a5f66|#9aa0a8/i)
      expect(html).toContain('color: #000000')
      expect(html).toContain('print-color-adjust: exact')
      expect(html).toContain('-webkit-print-color-adjust: exact')
    }
  })
})

describe('RECEIPT_PRINT_GEOMETRY（打印版面几何唯一事实源）', () => {
  it('58mm/80mm：页宽 = 可打印宽，且半角推进量恰 0.5em（网格数学的前提）', () => {
    // 58mm 纸 32 列 / 80mm 纸 48 列（char-grid PAPER_COLUMNS）
    for (const [paper, cols] of [
      ['58mm', 32],
      ['80mm', 48]
    ] as const) {
      const g = RECEIPT_PRINT_GEOMETRY[paper]
      expect(g.pageWidthMicrons).toBe(g.pageWidthMm * 1000)
      expect(g.pageWidthPx).toBe(Math.round((g.pageWidthMm * 96) / 25.4))
      // 半角列宽 = 字号/2 → cols 列恰铺满页宽，全角汉字恰占 2 列
      expect(g.fontSizeMm / 2).toBeCloseTo(g.pageWidthMm / cols, 6)
    }
    expect(RECEIPT_PRINT_GEOMETRY['58mm']).toMatchObject({ pageWidthMm: 48, fontSizeMm: 3 })
    expect(RECEIPT_PRINT_GEOMETRY['80mm']).toMatchObject({ pageWidthMm: 72, fontSizeMm: 3 })
  })

  it('FIT_TO_WIDTH_BODY 自带块级作用域（可安全内联进任何宿主 IIFE，不与其标识符冲突）', () => {
    expect(FIT_TO_WIDTH_BODY.startsWith('{ ')).toBe(true)
    expect(FIT_TO_WIDTH_BODY.endsWith(' }')).toBe(true)
    expect(FIT_TO_WIDTH_BODY).toContain(".receipt-paper")
    // 回缩基准必须是实测值对（scrollWidth / clientWidth）——写死比例救不了未知字体
    expect(FIT_TO_WIDTH_BODY).toContain('fitEl.scrollWidth > fitEl.clientWidth + 1')
    expect(FIT_TO_WIDTH_BODY).toContain('fitEl.clientWidth / fitEl.scrollWidth')
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
    expect(html).toContain('margin-bottom: 1.25em')
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
    expect(html).toContain('style="max-width: 72mm"') // logo 不超可打印页宽（与容器同基准）
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
