import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { exportDocx } from '../../../src/main/export/docx.exporter'
import {
  EMPTY_DAILY_INPUT,
  SAMPLE_DAILY_INPUT,
  SAMPLE_MONTHLY_INPUT
} from './export-report.fixture'

/**
 * Task 17 — docx.exporter round-trip：
 * docx 是 zip（OOXML）——Buffer → jszip 解压 → word/document.xml 含标题文本与合计数字。
 * 锁定清单：标题 + 简单边框表格止步（无图片/复杂样式）。
 */

async function readDocumentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('docx 缺少 word/document.xml')
  return entry.async('string')
}

/** 提取首个表格首行（表头行）的单元格文本序列（docx XML：tbl → tr → tc → w:t） */
function firstTableRowTexts(xml: string): string[] {
  const table = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)?.[0] ?? ''
  const firstRow = table.match(/<w:tr[^>]*>[\s\S]*?<\/w:tr>/)?.[0] ?? ''
  return [...firstRow.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1])
}

describe('docx.exporter：日报', () => {
  it('产物是合法 zip 且包含 word/document.xml', async () => {
    const buf = await exportDocx(SAMPLE_DAILY_INPUT)
    expect(buf.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))).toBe(true)
    const zip = await JSZip.loadAsync(buf)
    expect(zip.file('word/document.xml')).toBeDefined()
  })

  it('document.xml 含标题（Heading）与汇总数字', async () => {
    const xml = await readDocumentXml(await exportDocx(SAMPLE_DAILY_INPUT))
    expect(xml).toContain('2026-11-01 销售报表')
    expect(xml).toContain('Heading1')
    expect(xml).toContain('总销售额')
    expect(xml).toContain('123.45')
    expect(xml).toContain('订单数')
    expect(xml).toContain('3')
  })

  it('汇总段尾部含国补行：国补销售额 41.00 元', async () => {
    const xml = await readDocumentXml(await exportDocx(SAMPLE_DAILY_INPUT))
    expect(xml).toContain('国补销售额：41.00 元')
  })

  it('明细表头 7 列：是否国补/订单备注 尾部追加（表头数组长度 7）', async () => {
    const xml = await readDocumentXml(await exportDocx(SAMPLE_DAILY_INPUT))
    const headers = firstTableRowTexts(xml)
    expect(headers).toHaveLength(7)
    expect(headers).toEqual([
      '单号',
      '时间',
      '商品数',
      '合计（元）',
      '状态',
      '是否国补',
      '订单备注'
    ])
  })

  it('明细数据行：国补 是/否 + 备注文本直出（null 渲染空单元格）', async () => {
    const xml = await readDocumentXml(await exportDocx(SAMPLE_DAILY_INPUT))
    expect(xml).toContain('老顾客回购')
    expect(xml).toContain('国补资格已核验')
  })

  it('document.xml 含明细表格：表头/单号/合计元值/状态', async () => {
    const xml = await readDocumentXml(await exportDocx(SAMPLE_DAILY_INPUT))
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('20261101-0001')
    expect(xml).toContain('52.50')
    expect(xml).toContain('29.95')
    expect(xml).toContain('已完成')
  })

  it('表格为简单单线边框（w:val="single"），无图片（锁定清单：标题+表格止步）', async () => {
    const xml = await readDocumentXml(await exportDocx(SAMPLE_DAILY_INPUT))
    expect(xml).toContain('w:val="single"')
    expect(xml).not.toContain('<w:drawing>')
    expect(xml).not.toContain('<pic:pic')
  })

  it('空数据日：仅表头行的表格 + 汇总 0.00', async () => {
    const xml = await readDocumentXml(await exportDocx(EMPTY_DAILY_INPUT))
    expect(xml).toContain('2026-11-03 销售报表')
    expect(xml).toContain('0.00')
    expect(xml).toContain('无销售记录')
  })
})

describe('docx.exporter：月报', () => {
  it('document.xml 含月度标题、合计 321.05 与按日分桶表', async () => {
    const xml = await readDocumentXml(await exportDocx(SAMPLE_MONTHLY_INPUT))
    expect(xml).toContain('2026-11 销售报表')
    expect(xml).toContain('321.05')
    expect(xml).toContain('按日分桶')
    expect(xml).toContain('2026-11-01')
    expect(xml).toContain('123.45')
    expect(xml).toContain('2026-11-02')
    expect(xml).toContain('197.60')
  })

  it('月报零国补内容（国补小计仅日报口径）', async () => {
    const xml = await readDocumentXml(await exportDocx(SAMPLE_MONTHLY_INPUT))
    expect(xml).not.toContain('国补销售额')
    expect(xml).not.toContain('是否国补')
    expect(xml).not.toContain('订单备注')
  })
})
