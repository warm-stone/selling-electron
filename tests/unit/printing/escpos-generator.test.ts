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
  wrapToGrid,
  type PaperWidth
} from '../../../src/shared/receipt/char-grid'
import { ITEM_COLUMN_WIDTHS } from '../../../src/shared/receipt/item-columns'
import type { ReceiptTemplate } from '../../../src/shared/receipt/template-schema'
import {
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
 * ESC/POS 生成器 golden 字节测试矩阵（无实机验证策略的核心）。
 *
 * 矩阵维度：{58mm, 80mm} × {bold on/off} × {doubleHeight/Width/quad/normal}
 *            × {left/center/right} × {Logo 有/无} × {cutPaper on/off}
 * 每项断言十六进制指令序列；另含 GBK 中文断言、GBK 降级（'𠀀'→'?'）、
 * FS & 汉字模式（真机修复指令链）、名称折行多行 items、1d 76 30 30 光栅头、
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

/**
 * 与生成器同源的期望 items 行集（测试侧用 shared char-grid 独立重算——G7
 * 交叉验证；名称列 wrapToGrid 折行、首行四列齐备、续行三列空白）。
 */
function expectedItemLines(
  paper: PaperWidth,
  name: string,
  qty: string,
  price: string,
  subtotal: string
): string[] {
  const w = ITEM_COLUMN_WIDTHS[paper]
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

/**
 * 测试侧独立重算的期望 SN 副行（G7 交叉验证——不调 buildSnLines，用
 * char-grid 原语按 '  SN:' 前缀宽 5 / 截断标记 '*' 独立组合）：
 * 可用列 = 纸宽 - 5，超长保留前 avail-1 列 + '*'，整行 pad 满宽。
 */
function expectedSnLines(paper: PaperWidth, sn: string): string[] {
  const cols = PAPER_COLUMNS[paper]
  const avail = cols - stringWidth('  SN:')
  const cell = stringWidth(sn) > avail ? truncateToGrid(sn, avail - 1) + '*' : sn
  return [padLine('  SN:' + cell, cols)]
}

// ─────────────────────────── 样例数据 ───────────────────────────

const SAMPLE_SALE: SaleReceiptData = {
  items: [
    { name: '可口可乐330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' },
    { name: '蓝月亮洗衣液', quantity: '1', unitPrice: '45.00', subtotal: '45.00' }
  ]
}

/**
 * SN 混合单（T3.1）：1 批量计行（无 sn）+ 1 SN 行 + 1 超长 SN 行
 * （37 列 > 58mm 可用 27 列——R3 截断维度；≤ 80mm 可用 43 列——80mm 原码完整）。
 */
const SN_SALE: SaleReceiptData = {
  items: [
    { name: '可口可乐330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' },
    { name: '华为路由器 AX3', quantity: '1', unitPrice: '199.00', subtotal: '199.00', sn: 'SN861001AB12345' },
    {
      name: '蓝牙耳机',
      quantity: '1',
      unitPrice: '49.00',
      subtotal: '49.00',
      sn: 'SN-VERY-LONG-IDENTIFIER-000123456789'
    }
  ]
}

/** 58mm 超长 SN（37 列）——R3 截断用例的固定码值 */
const LONG_SN = 'SN-VERY-LONG-IDENTIFIER-000123456789'

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
  it('80mm 默认模板全指令链：ESC @ 开头 + 中文页 + FS & 汉字模式 + 居中 + 粗体 + 倍高 + GBK 中文 + 切纸', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_80MM)
    // 字节流以 ESC @（1b 40）开头，紧随 ESC R 15（1b 52 0f）中文页 + FS &（1c 26）汉字模式
    expect(bytes.subarray(0, 2)).toEqual(seq(0x1b, 0x40))
    expect(bytes.subarray(0, 5)).toEqual(seq(0x1b, 0x40, 0x1b, 0x52, 0x0f))
    expect(bytes.subarray(2, 5)).toEqual(seq(0x1b, 0x52, 0x0f))
    expect(bytes.subarray(5, 7)).toEqual(seq(0x1c, 0x26))
    expect(includes(bytes, seq(0x1b, 0x61, 0x01))).toBe(true) // ESC a 1 居中
    expect(includes(bytes, seq(0x1b, 0x45, 0x01))).toBe(true) // ESC E 1 粗体开
    expect(includes(bytes, seq(0x1b, 0x45, 0x00))).toBe(true) // ESC E 0 粗体关
    expect(includes(bytes, seq(0x1b, 0x21, 0x10))).toBe(true) // ESC ! 倍高
    expect(includes(bytes, seq(0x1d, 0x21, 0x00))).toBe(true) // GS ! 0 倍率归一
    // '中文测试收银' → GBK：d6 d0 ce c4 b2 e2 ca d4 ca d5 d2 f8
    expect(includes(bytes, seq(0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xca, 0xd5, 0xd2, 0xf8))).toBe(true)
    expect(includes(bytes, seq(0x1d, 0x56, 0x42, 0x00))).toBe(true) // GS V 66 0 切纸（cutPaper=true）
  })

  it('58mm 默认模板全指令链 + FS & + 32 列 divider（80mm divider 不出现）', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_58MM)
    expect(bytes.subarray(0, 2)).toEqual(seq(0x1b, 0x40))
    expect(includes(bytes, seq(0x1b, 0x52, 0x0f))).toBe(true)
    expect(includes(bytes, seq(0x1c, 0x26))).toBe(true) // FS & 汉字模式
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

  it('Logo 段落：vars.logoBuffers 命中 logoId → 光栅 1d 76 30 30（m=0x30 库默认）；未命中/未指定 → 跳过不发光栅', async () => {
    const t = makeTemplate((x) => {
      x.header.unshift({ type: 'image', logoId: 7 })
    })
    const noLogo = await gen(t) // vars 无 logoBuffers
    expect(includes(noLogo, seq(0x1d, 0x76, 0x30, 0x30))).toBe(false)

    const missingId = await gen(t, SAMPLE_SALE, {
      ...SAMPLE_VARS,
      logoBuffers: new Map([[999, makeLogoPng()]])
    })
    expect(includes(missingId, seq(0x1d, 0x76, 0x30, 0x30))).toBe(false)

    const withLogo = await gen(t, SAMPLE_SALE, {
      ...SAMPLE_VARS,
      logoBuffers: new Map([[7, makeLogoPng()]])
    })
    expect(includes(withLogo, seq(0x1d, 0x76, 0x30, 0x30))).toBe(true)
    // 旧 m=0x00 patch 值不得出现（1d 76 30 00 为非 0x30 模式头）
    expect(includes(withLogo, seq(0x1d, 0x76, 0x30, 0x00))).toBe(false)
  })

  it('多 Logo：header/footer 各引用一个 logoId → 两个光栅段均出现', async () => {
    const t = makeTemplate((x) => {
      x.header.unshift({ type: 'image', logoId: 1 })
      x.footer.push({ type: 'image', logoId: 2 })
    })
    const bytes = await gen(t, SAMPLE_SALE, {
      ...SAMPLE_VARS,
      logoBuffers: new Map([
        [1, makeLogoPng()],
        [2, makeLogoPng()]
      ])
    })
    // 两段相同棋盘图 → 光栅头出现两次
    const head = seq(0x1d, 0x76, 0x30, 0x30)
    const first = Buffer.from(bytes).indexOf(head)
    const second = Buffer.from(bytes).indexOf(head, first + 1)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
  })

  it('58mm + Logo 组合：光栅与 32 列 divider 共存', async () => {
    const t = makeTemplate(
      (x) => {
        x.header.unshift({ type: 'image', logoId: 7 })
      },
      DEFAULT_TEMPLATE_58MM
    )
    const bytes = await gen(t, SAMPLE_SALE, {
      ...SAMPLE_VARS,
      logoBuffers: new Map([[7, makeLogoPng()]])
    })
    expect(includes(bytes, seq(0x1d, 0x76, 0x30, 0x30))).toBe(true)
    expect(includes(bytes, Buffer.from('-'.repeat(32), 'latin1'))).toBe(true)
  })

  // ── char-grid 同源几何（items 四列）──

  it('items 表四列几何：列头 + 每行行集均由 shared char-grid 组合，每行宽恰为 PAPER_COLUMNS', async () => {
    for (const paper of ['58mm', '80mm'] as const) {
      const base = paper === '58mm' ? DEFAULT_TEMPLATE_58MM : DEFAULT_TEMPLATE_80MM
      const bytes = await gen(base)
      // 列头行集
      const header = expectedItemLines(paper, '商品', '数量', '单价', '小计')
      for (const line of header) {
        expect(stringWidth(line)).toBe(PAPER_COLUMNS[paper])
        expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
      }
      // 每个明细行集（单行名 → 单元素数组）
      for (const item of SAMPLE_SALE.items) {
        const lines = expectedItemLines(paper, item.name, item.quantity, item.unitPrice, item.subtotal)
        for (const line of lines) {
          expect(stringWidth(line)).toBe(PAPER_COLUMNS[paper])
          expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
        }
      }
    }
  })

  it('超长商品名折行成多行 items（wrapToGrid 同源）：每行满宽、完整名不出现', async () => {
    const longName = '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
    const sale: SaleReceiptData = {
      items: [{ name: longName, quantity: '1', unitPrice: '1.00', subtotal: '1.00' }]
    }
    const bytes = await gen(DEFAULT_TEMPLATE_80MM, sale)
    const lines = expectedItemLines('80mm', longName, '1', '1.00', '1.00')
    // 80mm name 列宽 24 → 40 宽长名折成多行
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(stringWidth(line)).toBe(PAPER_COLUMNS['80mm'])
      expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    }
    // 未折行的完整商品名不得出现
    expect(includes(bytes, iconv.encode(longName, 'EUC-CN'))).toBe(false)
  })

  it('items.showHeader=false → 无列头行', async () => {
    const t = makeTemplate((x) => {
      x.items = { type: 'items', showHeader: false }
    })
    const bytes = await gen(t)
    const header = expectedItemLines('80mm', '商品', '数量', '单价', '小计')
    for (const line of header) {
      expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(false)
    }
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
    const header = expectedItemLines('80mm', '品名', '数', '价', '计')
    for (const line of header) {
      expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    }
  })

  it('items.columnWidths 覆盖：名称列按覆盖宽度折行，行宽仍满网格', async () => {
    const t = makeTemplate((x) => {
      x.items = { type: 'items', showHeader: true, columnWidths: { name: 28, qty: 4, price: 8, subtotal: 8 } }
    })
    const longName = '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
    const sale: SaleReceiptData = {
      items: [{ name: longName, quantity: '1', unitPrice: '1.00', subtotal: '1.00' }]
    }
    const bytes = await gen(t, sale)
    // 覆盖列宽下的期望行集（测试侧独立重算：wrapToGrid(name, 28)）
    const nameLines = wrapToGrid(longName, 28)
    for (let i = 0; i < nameLines.length; i++) {
      const line =
        i === 0
          ? padLine(nameLines[i] as string, 28) +
            padLine(truncateToGrid('1', 4), 4, 'right') +
            padLine(truncateToGrid('1.00', 8), 8, 'right') +
            padLine(truncateToGrid('1.00', 8), 8, 'right')
          : padLine(nameLines[i] as string, 28) + padLine('', 4) + padLine('', 8, 'right') + padLine('', 8, 'right')
      expect(stringWidth(line)).toBe(PAPER_COLUMNS['80mm'])
      expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    }
    // 覆盖 name 列宽 28 > 默认 24：完整前 14 个汉字（28 列）单行出现
    expect(includes(bytes, iconv.encode(longName.slice(0, 14), 'EUC-CN'))).toBe(true)
  })

  it('text/total 段落超宽折行：wrapToGrid 逐行进入字节流，不依赖打印机硬件折行', async () => {
    const longNote = '本店长期供应各类日用百货生鲜果蔬欢迎新老顾客光临惠顾谢谢惠顾'
    const t = makeTemplate((x) => {
      x.footer.unshift({ type: 'text', content: longNote, align: 'center' })
      x.totals.push({ type: 'total', label: `备注: ${longNote}`, align: 'left' })
    })
    const bytes = await gen(t)
    const wrapped = wrapToGrid(longNote, 48)
    expect(wrapped.length).toBeGreaterThan(1)
    for (const line of wrapped) {
      expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    }
  })

  // ── GBK 编码与降级（D20）──

  it('GBK 降级：商品名含 𠀀（U+20000，GBK 外）→ 输出含 3f（"?"）且无原字符', async () => {
    const sale: SaleReceiptData = {
      items: [{ name: '𠀀测试品', quantity: '1', unitPrice: '2.00', subtotal: '2.00' }]
    }
    const bytes = await gen(DEFAULT_TEMPLATE_80MM, sale)
    // 降级 '?' 宽 1，参与 char-grid 组合后的行必须出现
    const lines = expectedItemLines('80mm', '?测试品', '1', '2.00', '2.00')
    for (const line of lines) {
      expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    }
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

  // ── SN 副行（T3.1/D-SN12：数据驱动默认行为，无模板配置）──

  it.each(['58mm', '80mm'] as const)(
    '%s：SN 混合单——sn 行名称行集后渲染 SN 副行（GBK 字节），行序在名称行之后、下一行之前',
    async (paper) => {
      const base = paper === '58mm' ? DEFAULT_TEMPLATE_58MM : DEFAULT_TEMPLATE_80MM
      const bytes = await gen(base, SN_SALE)
      const decoded = iconv.decode(Buffer.from(bytes), 'EUC-CN')

      // SN 副行进入字节流（测试侧独立重算），行宽恰为 PAPER_COLUMNS
      const snLine = expectedSnLines(paper, 'SN861001AB12345')[0] as string
      expect(stringWidth(snLine)).toBe(PAPER_COLUMNS[paper])
      expect(includes(bytes, iconv.encode(snLine, 'EUC-CN'))).toBe(true)
      expect(decoded).toContain(snLine)

      // 行序：副行在该商品名称行集之后、下一商品行之前（GBK 解码文本索引序）
      const routerLines = expectedItemLines(paper, '华为路由器 AX3', '1', '199.00', '199.00')
      const nextLines = expectedItemLines(paper, '蓝牙耳机', '1', '49.00', '49.00')
      const routerLast = decoded.indexOf(routerLines[routerLines.length - 1] as string)
      const snIdx = decoded.indexOf(snLine)
      const nextFirst = decoded.indexOf(nextLines[0] as string)
      expect(routerLast).toBeGreaterThanOrEqual(0)
      expect(snIdx).toBeGreaterThan(routerLast)
      expect(nextFirst).toBeGreaterThan(snIdx)
    }
  )

  it("58mm 超长 SN（37 > 27 可用列）截断：保留前 26 列 + '*'，全码不出现（R3）", async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_58MM, SN_SALE)
    const line = expectedSnLines('58mm', LONG_SN)[0] as string
    expect(stringWidth(line)).toBe(32)
    expect(line.trimEnd()).toBe('  SN:' + LONG_SN.slice(0, 26) + '*')
    expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    // 全码（ASCII，latin1 即字节形态）不得原样出现在字节流
    expect(includes(bytes, Buffer.from(LONG_SN, 'latin1'))).toBe(false)
  })

  it("80mm 超长 SN（44 > 43 可用列）同样截断：42 列 + '*'（双纸宽截断维度）", async () => {
    const sn44 = 'S' + 'N'.repeat(43) // 宽 44 > 43
    const sale: SaleReceiptData = {
      items: [{ name: '测试品', quantity: '1', unitPrice: '1.00', subtotal: '1.00', sn: sn44 }]
    }
    const bytes = await gen(DEFAULT_TEMPLATE_80MM, sale)
    const line = expectedSnLines('80mm', sn44)[0] as string
    expect(stringWidth(line)).toBe(48)
    expect(line.trimEnd()).toBe('  SN:' + sn44.slice(0, 42) + '*')
    expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
  })

  it('sn=null 与缺省 sn 字段的销售字节完全一致，且无 SN 副行（批量计行零行为变化）', async () => {
    const withNull = await gen(DEFAULT_TEMPLATE_58MM, {
      items: [{ name: '可乐', quantity: '1', unitPrice: '2.00', subtotal: '2.00', sn: null }]
    })
    const withoutField = await gen(DEFAULT_TEMPLATE_58MM, {
      items: [{ name: '可乐', quantity: '1', unitPrice: '2.00', subtotal: '2.00' }]
    })
    expect(Buffer.compare(withNull, withoutField)).toBe(0)
    expect(iconv.decode(withNull, 'EUC-CN')).not.toContain('  SN:')
  })

  it("SN 副行含 GBK 降级链路：SN 带 GBK 外字符（𠀀）→ 副行 '?' 降级后进入字节流", async () => {
    const sale: SaleReceiptData = {
      items: [{ name: '测试品', quantity: '1', unitPrice: '1.00', subtotal: '1.00', sn: '𠀀-SN-001' }]
    }
    const bytes = await gen(DEFAULT_TEMPLATE_80MM, sale)
    // 降级 '?'（宽 1）参与宽度数学：'?-SN-001' 宽 9 ≤ 43，原码区完整保留
    const line = expectedSnLines('80mm', '?-SN-001')[0] as string
    expect(includes(bytes, iconv.encode(line, 'EUC-CN'))).toBe(true)
    expect(includes(bytes, Buffer.from('𠀀', 'utf-8'))).toBe(false)
  })

  it('SN 重打幂等：同 SN 销售两次生成字节完全一致', async () => {
    const a = await gen(DEFAULT_TEMPLATE_58MM, SN_SALE)
    const b = await gen(DEFAULT_TEMPLATE_58MM, SN_SALE)
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
        x.header.unshift({ type: 'image', logoId: 7 })
      },
      DEFAULT_TEMPLATE_80MM
    )
    const bytes = await gen(t, SAMPLE_SALE, {
      ...SAMPLE_VARS,
      logoBuffers: new Map([[7, makeLogoPng()]])
    })
    const expected = readFileSync(join(goldenDir, 'receipt-80mm-with-logo.bin'))
    expect(Buffer.compare(bytes, expected)).toBe(0)
  })

  it('58mm SN 混合单完整输出与入库基准逐字节一致（SN 副行 + R3 截断锁定）', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_58MM, SN_SALE)
    const expected = readFileSync(join(goldenDir, 'receipt-58mm-sn.bin'))
    expect(Buffer.compare(bytes, expected)).toBe(0)
  })

  it('80mm SN 混合单完整输出与入库基准逐字节一致', async () => {
    const bytes = await gen(DEFAULT_TEMPLATE_80MM, SN_SALE)
    const expected = readFileSync(join(goldenDir, 'receipt-80mm-sn.bin'))
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
        x.header.unshift({ type: 'image', logoId: 7 })
      },
      DEFAULT_TEMPLATE_80MM
    )
    const logo80 = await gen(t, SAMPLE_SALE, {
      ...SAMPLE_VARS,
      logoBuffers: new Map([[7, makeLogoPng()]])
    })
    writeFileSync(join(goldenDir, 'receipt-80mm-with-logo.bin'), logo80)
    writeFileSync(join(goldenDir, 'receipt-58mm-default.bin'), await gen(DEFAULT_TEMPLATE_58MM))
    // SN 混合单基准（T3.1：58mm 含 R3 截断副行、80mm 原码完整副行）
    writeFileSync(join(goldenDir, 'receipt-58mm-sn.bin'), await gen(DEFAULT_TEMPLATE_58MM, SN_SALE))
    writeFileSync(join(goldenDir, 'receipt-80mm-sn.bin'), await gen(DEFAULT_TEMPLATE_80MM, SN_SALE))

    // 测试文件位于 tests/unit/printing/ → 三级 '..' 回仓库根
    const evidence = fileURLToPath(new URL('../../../.omo/evidence', import.meta.url))
    mkdirSync(evidence, { recursive: true })
    writeFileSync(
      join(evidence, 'task-4-sample-receipt.bin'),
      await gen(DEFAULT_TEMPLATE_80MM)
    )
  })
})
