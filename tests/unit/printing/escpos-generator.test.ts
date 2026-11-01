import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TEMPLATE_58MM,
  DEFAULT_TEMPLATE_80MM
} from '../../../src/shared/receipt/default-template'
import {
  PAPER_COLUMNS,
  padLine,
  stringWidth,
  truncateToGrid,
  type PaperWidth
} from '../../../src/shared/receipt/char-grid'
import type { ReceiptTemplate } from '../../../src/shared/receipt/template-schema'
import {
  ITEM_COLUMN_WIDTHS,
  generateReceiptBytes,
  type ReceiptPrintVars,
  type SaleReceiptData
} from '../../../src/main/printing/escpos/escpos-generator'
import {
  degradeToGbk,
  detectNonGbk,
  encodeGbk
} from '../../../src/main/printing/escpos/gb2312-encoder'

/**
 * Task 4 — ESC/POS 生成器 golden 字节测试矩阵（无实机验证策略的核心）。
 *
 * 矩阵维度：{58mm, 80mm} × {bold on/off} × {doubleHeight/Width/quad/normal}
 *            × {left/center/right} × {Logo 有/无} × {cutPaper on/off}
 * 每项断言十六进制指令序列；另含 GBK 中文断言、GBK 降级（'𠀀'→'?'）、
 * 重打幂等、char-grid 同源几何、golden .bin 字节级 diff。
 */

// ─────────────────────────── 测试辅助 ───────────────────────────

/** 十六进制字节序列断言辅助：seq(0x1b, 0x61, 0x01) */
function seq(...bytes: number[]): Buffer {
  return Buffer.from(bytes)
}

function includes(haystack: Uint8Array, needle: Buffer): boolean {
  return Buffer.from(haystack).indexOf(needle) !== -1
}

async function gen(
  template: ReceiptTemplate,
  sale: SaleReceiptData = SAMPLE_SALE,
  vars: ReceiptPrintVars = SAMPLE_VARS
): Promise<Buffer> {
  return Buffer.from(await generateReceiptBytes(template, sale, vars))
}

/** 基于默认模板深拷贝构造测试模板（G14：仅段落级属性调整） */
function makeTemplate(
  patch: (t: ReceiptTemplate) => void,
  base: ReceiptTemplate = DEFAULT_TEMPLATE_80MM
): ReceiptTemplate {
  const t = JSON.parse(JSON.stringify(base)) as ReceiptTemplate
  patch(t)
  return t
}

// pngjs（node-thermal-printer 传递依赖，无自带类型——测试侧以 createRequire + 最小接口消费）
interface PngImage {
  width: number
  height: number
  data: Buffer
}
interface PngCtor {
  new (opts: { width: number; height: number }): PngImage
  sync: { write(png: PngImage): Buffer }
}
const { PNG } = createRequire(import.meta.url)('pngjs') as { PNG: PngCtor }

/** 确定性 16×8 棋盘 Logo PNG（像素固定 → 光栅字节跨环境稳定） */
function makeLogoPng(): Buffer {
  const png = new PNG({ width: 16, height: 8 })
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      const idx = (y * 16 + x) * 4
      const dark = (x + y) % 2 === 0 ? 0 : 255
      png.data[idx] = dark
      png.data[idx + 1] = dark
      png.data[idx + 2] = dark
      png.data[idx + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

/** 与生成器同源的期望 items 行（测试侧用 shared char-grid 独立重算——G7 交叉验证） */
function expectedItemRow(
  paper: PaperWidth,
  name: string,
  qty: string,
  price: string,
  subtotal: string
): string {
  const w = ITEM_COLUMN_WIDTHS[paper]
  return (
    padLine(truncateToGrid(name, w.name), w.name) +
    padLine(truncateToGrid(qty, w.qty), w.qty, 'right') +
    padLine(truncateToGrid(price, w.price), w.price, 'right') +
    padLine(truncateToGrid(subtotal, w.subtotal), w.subtotal, 'right')
  )
}

// ─────────────────────────── 样例数据 ───────────────────────────

const SAMPLE_SALE: SaleReceiptData = {
  items: [
    { name: '可口可乐330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' },
    { name: '蓝月亮洗衣液', quantity: '1', unitPrice: '45.00', subtotal: '45.00' }
  ]
}

const SAMPLE_VARS: ReceiptPrintVars = {
  shopName: '中文测试收银',
  shopPhone: '13800001111',
  receiptNote: '谢谢惠顾',
  saleNo: '20261101-0001',
  datetime: '2026-11-01 21:00:00',
  total: '52.00',
  itemCount: '3'
}

// ═════════════════════════════════════════════════════════════════
// golden 字节矩阵（断言函数：bytes.includes(hexSequence)）
// ═════════════════════════════════════════════════════════════════

describe('ESC/POS 生成器 golden 字节矩阵', () => {
  it('80mm 默认模板全指令链：ESC @ 开头 + 中文页 + 居中 + 粗体 + 倍高 + GBK 中文 + 切纸', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_80MM)
    // 字节流以 ESC @（1b 40）开头，紧随 ESC R 15（1b 52 0f）中文页
    expect(bytes.subarray(0, 2)).toEqual(seq(0x1b, 0x40))
    expect(bytes.subarray(0, 5)).toEqual(seq(0x1b, 0x40, 0x1b, 0x52, 0x0f))
    expect(includes(bytes, seq(0x1b, 0x61, 0x01))).toBe(true) // ESC a 1 居中
    expect(includes(bytes, seq(0x1b, 0x45, 0x01))).toBe(true) // ESC E 1 粗体开
    expect(includes(bytes, seq(0x1b, 0x45, 0x00))).toBe(true) // ESC E 0 粗体关
    expect(includes(bytes, seq(0x1b, 0x21, 0x10))).toBe(true) // ESC ! 倍高
    expect(includes(bytes, seq(0x1d, 0x21, 0x00))).toBe(true) // GS ! 0 倍率归一
    // '中文测试收银' → GBK：d6 d0 ce c4 b2 e2 ca d4 ca d5 d2 f8
    expect(includes(bytes, seq(0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xca, 0xd5, 0xd2, 0xf8))).toBe(true)
    expect(includes(bytes, seq(0x1d, 0x56, 0x42, 0x00))).toBe(true) // GS V 66 0 切纸（cutPaper=true）
  })

  it('58mm 默认模板全指令链 + 32 列 divider（80mm divider 不出现）', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_58MM)
    expect(bytes.subarray(0, 2)).toEqual(seq(0x1b, 0x40))
    expect(includes(bytes, seq(0x1b, 0x52, 0x0f))).toBe(true)
    expect(includes(bytes, seq(0x1b, 0x61, 0x01))).toBe(true)
    expect(includes(bytes, seq(0x1b, 0x45, 0x01))).toBe(true)
    expect(includes(bytes, seq(0x1b, 0x21, 0x10))).toBe(true)
    expect(includes(bytes, seq(0x1d, 0x56, 0x42, 0x00))).toBe(true)
    expect(includes(bytes, Buffer.from('-'.repeat(32), 'latin1'))).toBe(true) // 58mm=32 列
    expect(includes(bytes, Buffer.from('-'.repeat(48), 'latin1'))).toBe(false)
  })

  it('80mm divider = 48 个 "-"（PAPER_COLUMNS）', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_80MM)
    expect(includes(bytes, Buffer.from('-'.repeat(48), 'latin1'))).toBe(true)
  })

  it('cutPaper=false → 不出现 GS V 切纸字节（cutPaper off 维）', async () => {
    const t = makeTemplate((x) => {
      x.cutPaper = false
    })
    const bytes = await gen(t)
    expect(includes(bytes, seq(0x1d, 0x56))).toBe(false)
  })

  it('段落全部 bold=false → 不出现粗体开 1b 45 01（bold off 维）', async () => {
    const t = makeTemplate((x) => {
      x.header = [
        { type: 'text', content: '店名', align: 'center', size: 'doubleHeight' },
        { type: 'divider' }
      ]
      x.totals = [{ type: 'total', label: '合计: ￥{total}', align: 'right' }]
      x.footer = [{ type: 'text', content: '谢谢惠顾', align: 'center' }]
    })
    const bytes = await gen(t)
    expect(includes(bytes, seq(0x1b, 0x45, 0x01))).toBe(false)
    expect(includes(bytes, seq(0x1b, 0x21, 0x10))).toBe(true) // 倍高仍在（尺寸独立维）
  })

  it('size=doubleWidth → ESC ! 20（1b 21 20）', async () => {
    const t = makeTemplate((x) => {
      x.header = [{ type: 'text', content: '加宽标题', size: 'doubleWidth' }, { type: 'divider' }]
    })
    const bytes = await gen(t)
    expect(includes(bytes, seq(0x1b, 0x21, 0x20))).toBe(true)
  })

  it('size=quad → ESC ! 30（1b 21 30）', async () => {
    const t = makeTemplate((x) => {
      x.header = [{ type: 'text', content: '四倍标题', size: 'quad' }, { type: 'divider' }]
    })
    const bytes = await gen(t)
    expect(includes(bytes, seq(0x1b, 0x21, 0x30))).toBe(true)
  })

  it('size 缺省 normal → ESC ! 00（1b 21 00）', async () => {
    const t = makeTemplate((x) => {
      x.header = [{ type: 'text', content: '常规行' }, { type: 'divider' }]
    })
    const bytes = await gen(t)
    expect(includes(bytes, seq(0x1b, 0x21, 0x00))).toBe(true)
  })

  it('align=right → ESC a 2（1b 61 02，默认模板合计行）', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_80MM)
    expect(includes(bytes, seq(0x1b, 0x61, 0x02))).toBe(true)
  })

  it('align=left → ESC a 0（1b 61 00）', async () => {
    const t = makeTemplate((x) => {
      x.header = [{ type: 'text', content: '左对齐行' }, { type: 'divider' }]
    })
    const bytes = await gen(t)
    expect(includes(bytes, seq(0x1b, 0x61, 0x00))).toBe(true)
  })

  it('Logo 段落：vars.logoBuffer 有 → 光栅 1d 76 30 00；无 → 跳过不发光栅', async () => {
    const t = makeTemplate((x) => {
      x.header.unshift({ type: 'image' })
    })
    const noLogo = await gen(t) // vars 无 logoBuffer
    expect(includes(noLogo, seq(0x1d, 0x76, 0x30, 0x00))).toBe(false)

    const withLogo = await gen(t, SAMPLE_SALE, { ...SAMPLE_VARS, logoBuffer: makeLogoPng() })
    expect(includes(withLogo, seq(0x1d, 0x76, 0x30, 0x00))).toBe(true)
  })

  it('58mm + Logo 组合：光栅与 32 列 divider 共存', async () => {
    const t = makeTemplate(
      (x) => {
        x.header.unshift({ type: 'image' })
      },
      DEFAULT_TEMPLATE_58MM
    )
    const bytes = await gen(t, SAMPLE_SALE, { ...SAMPLE_VARS, logoBuffer: makeLogoPng() })
    expect(includes(bytes, seq(0x1d, 0x76, 0x30, 0x00))).toBe(true)
    expect(includes(bytes, Buffer.from('-'.repeat(32), 'latin1'))).toBe(true)
  })

  // ── char-grid 同源几何（items 四列）──

  it('items 表四列几何：列头 + 每行均由 shared char-grid 组合，行宽恰为 PAPER_COLUMNS', async () => {
    for (const paper of ['58mm', '80mm'] as const) {
      const base = paper === '58mm' ? DEFAULT_TEMPLATE_58MM : DEFAULT_TEMPLATE_80MM
      const bytes = await gen(base)
      // 列头行
      const header = expectedItemRow(paper, '商品', '数量', '单价', '小计')
      expect(stringWidth(header)).toBe(PAPER_COLUMNS[paper])
      expect(includes(bytes, iconv.encode(header, 'EUC-CN'))).toBe(true)
      // 每个明细行
      for (const item of SAMPLE_SALE.items) {
        const line = expectedItemRow(paper, item.name, item.quantity, item.unitPrice, item.subtotal)
        expect(stringWidth(line)).toBe(PAPER_COLUMNS[paper])
        expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
      }
    }
  })

  it('超长商品名截断到名称列宽（truncateToGrid 同源），完整名不出现', async () => {
    const longName = '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
    const sale: SaleReceiptData = {
      items: [{ name: longName, quantity: '1', unitPrice: '1.00', subtotal: '1.00' }]
    }
    const bytes = await gen(DEFAULT_TEMPLATE_80MM, sale)
    const line = expectedItemRow('80mm', longName, '1', '1.00', '1.00')
    expect(stringWidth(line)).toBe(PAPER_COLUMNS['80mm'])
    expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    // 未截断的完整商品名不得出现
    expect(includes(bytes, iconv.encode(longName, 'EUC-CN'))).toBe(false)
  })

  it('items.showHeader=false → 无列头行', async () => {
    const t = makeTemplate((x) => {
      x.items = { type: 'items', showHeader: false }
    })
    const bytes = await gen(t)
    const header = expectedItemRow('80mm', '商品', '数量', '单价', '小计')
    expect(includes(bytes, iconv.encode(header, 'EUC-CN'))).toBe(false)
  })

  it('items 自定义列头文案渲染', async () => {
    const t = makeTemplate((x) => {
      x.items = {
        type: 'items',
        showHeader: true,
        nameLabel: '品名',
        qtyLabel: '数',
        priceLabel: '价',
        subtotalLabel: '计'
      }
    })
    const bytes = await gen(t)
    const header = expectedItemRow('80mm', '品名', '数', '价', '计')
    expect(includes(bytes, iconv.encode(header, 'EUC-CN'))).toBe(true)
  })

  // ── GBK 编码与降级（D20）──

  it('GBK 降级：商品名含 𠀀（U+20000，GBK 外）→ 输出含 3f（"?"）且无原字符', async () => {
    const sale: SaleReceiptData = {
      items: [{ name: '𠀀测试品', quantity: '1', unitPrice: '2.00', subtotal: '2.00' }]
    }
    const bytes = await gen(DEFAULT_TEMPLATE_80MM, sale)
    // 降级 '?' 宽 1，参与 char-grid 组合后的行必须出现
    const line = expectedItemRow('80mm', '?测试品', '1', '2.00', '2.00')
    expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    // 原字符（UTF-8 编码的 U+20000）不得出现在字节流
    expect(includes(bytes, Buffer.from('𠀀', 'utf-8'))).toBe(false)
  })

  it('全角 ￥（U+FFE5 → GBK 0xA3A4）不触发降级', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_80MM)
    expect(includes(bytes, seq(0xa3, 0xa4))).toBe(true)
    const label = degradeToGbk('合计: ￥52.00')
    expect(label).toBe('合计: ￥52.00')
    expect(includes(bytes, iconv.encode(label, 'EUC-CN'))).toBe(true)
  })

  // ── 插槽与幂等 ──

  it('变量插值：{saleNo} 替换后进入字节流', async () => {
    const t = makeTemplate((x) => {
      x.footer.unshift({ type: 'text', content: '单号:{saleNo}', align: 'center' })
    })
    const bytes = await gen(t)
    expect(includes(bytes, Buffer.from('20261101-0001', 'latin1'))).toBe(true)
  })

  it('未知插槽保留原文（T3 契约）', async () => {
    const t = makeTemplate((x) => {
      x.footer.unshift({ type: 'text', content: '{未知变量}尾注', align: 'center' })
    })
    const bytes = await gen(t)
    expect(includes(bytes, iconv.encode('{未知变量}尾注', 'EUC-CN'))).toBe(true)
  })

  it('重打幂等：同输入两次生成字节完全一致', async () => {
    const a = await gen(DEFAULT_TEMPLATE_80MM)
    const b = await gen(DEFAULT_TEMPLATE_80MM)
    expect(Buffer.compare(a, b)).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════
// gb2312-encoder（GBK/EUC-CN 链路 + D20 降级）
// ═════════════════════════════════════════════════════════════════

describe('gb2312-encoder（CHINA 代码页 EUC-CN 链路）', () => {
  it('encodeGbk：中文 → 标准 GBK 字节（d6d0 cec4 b2e2 cad4 cad5 d2f8）', () => {
    expect(encodeGbk('中文测试收银').toString('hex')).toBe('d6d0cec4b2e2cad4cad5d2f8')
  })

  it('encodeGbk：全角 ￥ → 0xA3A4（T3 默认模板金额符号约定）', () => {
    expect(encodeGbk('￥').toString('hex')).toBe('a3a4')
  })

  it('detectNonGbk：ASCII/常用中文/全角 ￥ 均为 GBK 内；𠀀/半角 ¥ 为外', () => {
    expect(detectNonGbk('可口可乐330ml 13800001111')).toBe(false)
    expect(detectNonGbk('中文测试收银￥（12.00）')).toBe(false)
    expect(detectNonGbk('𠀀')).toBe(true)
    expect(detectNonGbk('¥')).toBe(true) // U+00A5 半角——EUC-CN 无映射
  })

  it('degradeToGbk：GBK 外字符替换 "?"，可编码部分原样保留', () => {
    expect(degradeToGbk('𠀀测试品')).toBe('?测试品')
    expect(degradeToGbk('合计¥12')).toBe('合计?12')
    expect(degradeToGbk('全中文无降级')).toBe('全中文无降级')
    expect(degradeToGbk('')).toBe('')
  })
})

// ═════════════════════════════════════════════════════════════════
// golden .bin 字节级 diff（提交入库的基准产物）
// ═════════════════════════════════════════════════════════════════

describe('golden .bin 字节级 diff', () => {
  const goldenDir = fileURLToPath(new URL('../../fixtures/golden', import.meta.url))

  it('58mm 默认模板完整输出与入库基准逐字节一致', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_58MM)
    const expected = readFileSync(join(goldenDir, 'receipt-58mm-default.bin'))
    expect(Buffer.compare(bytes, expected)).toBe(0)
  })

  it('80mm 含 Logo 模板完整输出与入库基准逐字节一致', async () => {
    const t = makeTemplate(
      (x) => {
        x.header.unshift({ type: 'image' })
      },
      DEFAULT_TEMPLATE_80MM
    )
    const bytes = await gen(t, SAMPLE_SALE, { ...SAMPLE_VARS, logoBuffer: makeLogoPng() })
    const expected = readFileSync(join(goldenDir, 'receipt-80mm-with-logo.bin'))
    expect(Buffer.compare(bytes, expected)).toBe(0)
  })
})

// GOLDEN_UPDATE=1 时运行：重写基准 .bin + 任务证据样例（80mm 默认模板完整字节）
describe.skipIf(!process.env['GOLDEN_UPDATE'])('GOLDEN_UPDATE 再生模式', () => {
  it('重写 tests/fixtures/golden/*.bin 与 .omo/evidence/task-4-sample-receipt.bin', async () => {
    const goldenDir = fileURLToPath(new URL('../../fixtures/golden', import.meta.url))
    mkdirSync(goldenDir, { recursive: true })

    const t = makeTemplate(
      (x) => {
        x.header.unshift({ type: 'image' })
      },
      DEFAULT_TEMPLATE_80MM
    )
    const logo80 = await gen(t, SAMPLE_SALE, { ...SAMPLE_VARS, logoBuffer: makeLogoPng() })
    writeFileSync(join(goldenDir, 'receipt-80mm-with-logo.bin'), logo80)
    writeFileSync(join(goldenDir, 'receipt-58mm-default.bin'), await gen(DEFAULT_TEMPLATE_58MM))

    // 测试文件位于 tests/unit/printing/ → 三级 '..' 回仓库根
    const evidence = fileURLToPath(new URL('../../../.omo/evidence', import.meta.url))
    mkdirSync(evidence, { recursive: true })
    writeFileSync(
      join(evidence, 'task-4-sample-receipt.bin'),
      await gen(DEFAULT_TEMPLATE_80MM)
    )
  })
})
