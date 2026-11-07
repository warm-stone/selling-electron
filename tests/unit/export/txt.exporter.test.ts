import { describe, expect, it } from 'vitest'
import { exportTxt } from '../../../src/main/export/txt.exporter'
import { stringWidth } from '../../../src/shared/receipt/char-grid'
import {
  BUCKETLESS_MONTHLY_INPUT,
  EMPTY_DAILY_INPUT,
  SAMPLE_DAILY_INPUT,
  SAMPLE_MONTHLY_INPUT
} from './export-report.fixture'

/**
 * Task 17 — txt.exporter round-trip：
 * UTF-8 with BOM（Windows 记事本兼容）+ 标题/汇总/明细行文本断言 + char-grid 对齐。
 */

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

function decode(buf: Buffer): string {
  return buf.subarray(3).toString('utf8')
}

describe('txt.exporter：日报', () => {
  it('UTF-8 with BOM：头三字节 EF BB BF', () => {
    const buf = exportTxt(SAMPLE_DAILY_INPUT)
    expect(buf.subarray(0, 3).equals(BOM)).toBe(true)
  })

  it('含标题行、汇总（总销售额 XX.XX 元 / 订单数）', () => {
    const text = decode(exportTxt(SAMPLE_DAILY_INPUT))
    expect(text).toContain('2026-11-01 销售报表')
    expect(text).toContain('总销售额: 123.45 元')
    expect(text).toContain('订单数: 3')
  })

  it('含明细行：单号 / 时间 / 商品数 / 合计 / 状态', () => {
    const text = decode(exportTxt(SAMPLE_DAILY_INPUT))
    expect(text).toContain('20261101-0001')
    expect(text).toContain('2026-11-01 08:30:12')
    expect(text).toContain('52.50')
    expect(text).toContain('41.00')
    expect(text).toContain('29.95')
    expect(text).toContain('已完成')
  })

  it('汇总块尾部含国补行：国补销售额 41.00 元（单 2 国补 4100 分）', () => {
    const text = decode(exportTxt(SAMPLE_DAILY_INPUT))
    expect(text).toContain('国补销售额: 41.00 元')
  })

  it('明细表头：是否国补 在 状态 之后（尾部追加，既有列序不变）', () => {
    const text = decode(exportTxt(SAMPLE_DAILY_INPUT))
    const headerLine = text.split('\r\n').find((l) => l.includes('单号') && l.includes('是否国补'))
    expect(headerLine).toBeDefined()
    const header = headerLine as string
    expect(header.indexOf('状态')).toBeLessThan(header.indexOf('是否国补'))
    expect(header.indexOf('是否国补')).toBeLessThan(header.indexOf('订单备注'))
  })

  it('明细数据行：国补单渲染「是」、非国补单「否」、备注列文本直出（null 留空）', () => {
    const text = decode(exportTxt(SAMPLE_DAILY_INPUT))
    const lines = text.split('\r\n')
    const row1 = lines.find((l) => l.startsWith('20261101-0001')) as string
    const row2 = lines.find((l) => l.startsWith('20261101-0002')) as string
    const row3 = lines.find((l) => l.startsWith('20261101-0003')) as string
    // 非国补带备注
    expect(row1).toContain('否')
    expect(row1).toContain('老顾客回购')
    // 国补单
    expect(row2).toContain('是')
    expect(row2).toContain('国补资格已核验')
    // 无附加信息旧单兜底：否 + 备注 null 渲染为空
    expect(row3).toContain('否')
    expect(row3).not.toContain('老顾客回购')
  })

  it('CRLF 行尾（Windows 记事本兼容）', () => {
    const buf = exportTxt(SAMPLE_DAILY_INPUT)
    expect(buf.subarray(3).includes(Buffer.from('\r\n'))).toBe(true)
    expect(decode(buf).includes('\n\r')).toBe(false)
  })

  it('char-grid 对齐：全部明细数据行显示宽度一致（padLine 复用）', () => {
    const text = decode(exportTxt(SAMPLE_DAILY_INPUT))
    const detailLines = text.split('\r\n').filter((l) => l.startsWith('20261101-'))
    expect(detailLines).toHaveLength(3)
    const widths = detailLines.map((l) => stringWidth(l))
    expect(new Set(widths).size).toBe(1)
  })

  it('空数据日：仍产出合法文件（BOM + 标题 + 空态提示）', () => {
    const buf = exportTxt(EMPTY_DAILY_INPUT)
    expect(buf.subarray(0, 3).equals(BOM)).toBe(true)
    const text = decode(buf)
    expect(text).toContain('2026-11-03 销售报表')
    expect(text).toContain('总销售额: 0.00 元')
    expect(text).toContain('订单数: 0')
    expect(text).toContain('无销售记录')
  })
})

describe('txt.exporter：月报', () => {
  it('含月度标题、汇总与按日分桶行', () => {
    const text = decode(exportTxt(SAMPLE_MONTHLY_INPUT))
    expect(text).toContain('2026-11 销售报表')
    expect(text).toContain('总销售额: 321.05 元')
    expect(text).toContain('订单数: 5')
    expect(text).toContain('按日分桶')
    expect(text).toContain('2026-11-01')
    expect(text).toContain('123.45')
    expect(text).toContain('2026-11-02')
    expect(text).toContain('197.60')
  })

  it('缺 buckets 的月报输入（契约外运行时形态）：跳过按日分桶区块不抛错', () => {
    const text = decode(exportTxt(BUCKETLESS_MONTHLY_INPUT))
    expect(text).toContain('2026-11 销售报表')
    expect(text).toContain('总销售额: 321.05 元')
  })

  it('月报零国补内容（国补小计仅日报口径）', () => {
    const text = decode(exportTxt(SAMPLE_MONTHLY_INPUT))
    expect(text).not.toContain('国补销售额')
    expect(text).not.toContain('是否国补')
    expect(text).not.toContain('订单备注')
  })
})
