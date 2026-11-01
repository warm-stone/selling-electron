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
})
