import { describe, expect, it } from 'vitest'
import { Workbook } from 'exceljs'
import { exportXlsx } from '../../../src/main/export/xlsx.exporter'
import {
  BUCKETLESS_MONTHLY_INPUT,
  EMPTY_DAILY_INPUT,
  SAMPLE_DAILY_INPUT,
  SAMPLE_MONTHLY_INPUT
} from './export-report.fixture'

/**
 * Task 17 — xlsx.exporter round-trip：
 * exporter Buffer → exceljs 重新 load → 断言汇总单元格值（total 元值）、
 * 明细行数 == 明细数、状态列值、numFmt '0.00'（金额导出层转元——G1 边界格式化）。
 */

async function reload(buffer: Buffer): Promise<Workbook> {
  const wb = new Workbook()
  // exceljs d.ts 的 Buffer 入参声明为 extends ArrayBuffer；运行时 Node Buffer 可直接 load（README 同款用法）
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb
}

describe('xlsx.exporter：日报', () => {
  it('Sheet『汇总』：总销售额（元值 123.45 + numFmt 0.00）/ 订单数 / 日期范围', async () => {
    const wb = await reload(await exportXlsx(SAMPLE_DAILY_INPUT))
    const summary = wb.getWorksheet('汇总')
    expect(summary).toBeDefined()
    if (!summary) throw new Error('缺少汇总 sheet')

    expect(summary.getCell('A2').value).toBe('总销售额（元）')
    expect(summary.getCell('B2').value).toBeCloseTo(123.45, 2)
    expect(summary.getCell('B2').numFmt).toBe('0.00')
    expect(summary.getCell('A3').value).toBe('订单数')
    expect(summary.getCell('B3').value).toBe(3)
    expect(summary.getCell('A4').value).toBe('日期范围')
    expect(summary.getCell('B4').value).toBe('2026-11-01')
  })

  it('Sheet『明细』：行数 == 明细数 + 1（表头），单号/商品数/合计元值/状态列逐格断言', async () => {
    const wb = await reload(await exportXlsx(SAMPLE_DAILY_INPUT))
    const detail = wb.getWorksheet('明细')
    expect(detail).toBeDefined()
    if (!detail) throw new Error('缺少明细 sheet')

    expect(detail.actualRowCount).toBe(SAMPLE_DAILY_INPUT.report.sales.length + 1)

    expect(detail.getCell('A1').value).toBe('单号')
    expect(detail.getCell('B1').value).toBe('时间')
    expect(detail.getCell('C1').value).toBe('商品数')
    expect(detail.getCell('D1').value).toBe('合计（元）')
    expect(detail.getCell('E1').value).toBe('状态')

    expect(detail.getCell('A2').value).toBe('20261101-0001')
    expect(detail.getCell('B2').value).toBe('2026-11-01 08:30:12')
    expect(detail.getCell('C2').value).toBe(2)
    expect(detail.getCell('D2').value).toBeCloseTo(52.5, 2)
    expect(detail.getCell('D2').numFmt).toBe('0.00')
    expect(detail.getCell('E2').value).toBe('已完成')

    expect(detail.getCell('A4').value).toBe('20261101-0003')
    expect(detail.getCell('D4').value).toBeCloseTo(29.95, 2)
    expect(detail.getCell('E4').value).toBe('已完成')
  })

  it('列宽自适应：单号列宽 ≥ 内容宽 + 边距', async () => {
    const wb = await reload(await exportXlsx(SAMPLE_DAILY_INPUT))
    const detail = wb.getWorksheet('明细')
    if (!detail) throw new Error('缺少明细 sheet')
    // '20261101-0001' = 14 个半角字符 → 自适应宽至少 14（+边距）
    expect(detail.getColumn(1).width).toBeGreaterThanOrEqual(14)
    // 时间列 '2026-11-01 08:30:12' = 19 半角字符
    expect(detail.getColumn(2).width).toBeGreaterThanOrEqual(19)
  })
  it('空数据日：仅表头行，汇总为 0', async () => {
    const wb = await reload(await exportXlsx(EMPTY_DAILY_INPUT))
    const detail = wb.getWorksheet('明细')
    if (!detail) throw new Error('缺少明细 sheet')
    expect(detail.actualRowCount).toBe(1)
    const summary = wb.getWorksheet('汇总')
    if (!summary) throw new Error('缺少汇总 sheet')
    expect(summary.getCell('B2').value).toBeCloseTo(0, 2)
    expect(summary.getCell('B3').value).toBe(0)
  })
})

describe('xlsx.exporter：月报', () => {
  it('含按日分桶 sheet（元值 + numFmt），无明细 sheet（月报无销售明细）', async () => {
    const wb = await reload(await exportXlsx(SAMPLE_MONTHLY_INPUT))
    expect(wb.getWorksheet('明细')).toBeUndefined()

    const buckets = wb.getWorksheet('按日分桶')
    expect(buckets).toBeDefined()
    if (!buckets) throw new Error('缺少按日分桶 sheet')

    expect(buckets.getCell('A1').value).toBe('日期')
    expect(buckets.getCell('B1').value).toBe('销售额（元）')
    expect(buckets.getCell('C1').value).toBe('订单数')

    expect(buckets.actualRowCount).toBe(3)
    expect(buckets.getCell('A2').value).toBe('2026-11-01')
    expect(buckets.getCell('B2').value).toBeCloseTo(123.45, 2)
    expect(buckets.getCell('B2').numFmt).toBe('0.00')
    expect(buckets.getCell('C2').value).toBe(3)
    expect(buckets.getCell('A3').value).toBe('2026-11-02')
    expect(buckets.getCell('B3').value).toBeCloseTo(197.6, 2)
    expect(buckets.getCell('C3').value).toBe(2)
  })

  it('汇总 sheet：月度合计 321.05 元 / 5 单 / 期间 2026-11', async () => {
    const wb = await reload(await exportXlsx(SAMPLE_MONTHLY_INPUT))
    const summary = wb.getWorksheet('汇总')
    if (!summary) throw new Error('缺少汇总 sheet')
    expect(summary.getCell('B2').value).toBeCloseTo(321.05, 2)
    expect(summary.getCell('B2').numFmt).toBe('0.00')
    expect(summary.getCell('B3').value).toBe(5)
    expect(summary.getCell('B4').value).toBe('2026-11')
  })

  it('缺 buckets 的月报输入：无按日分桶 sheet（T14 前兼容形态）', async () => {
    const wb = await reload(await exportXlsx(BUCKETLESS_MONTHLY_INPUT))
    expect(wb.getWorksheet('按日分桶')).toBeUndefined()
  })
})

describe('xlsx.exporter：产物形态', () => {
  it('产出 zip 魔数（PK 头）的 xlsx Buffer', async () => {
    const buf = await exportXlsx(SAMPLE_DAILY_INPUT)
    expect(buf.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))).toBe(true)
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('两次导出结构等价（exceljs docProps 含毫秒时间戳——字节级不幂等，断言改为读回结构）', async () => {
    // 已知坑：writeBuffer 产物含创建时间戳（同秒两次调用字节也不同）——round-trip 断言必须基于 load 回读
    const [wa, wb2] = await Promise.all([
      reload(await exportXlsx(SAMPLE_DAILY_INPUT)),
      reload(await exportXlsx(SAMPLE_DAILY_INPUT))
    ])
    const summaryA = wa.getWorksheet('汇总')
    const summaryB = wb2.getWorksheet('汇总')
    if (!summaryA || !summaryB) throw new Error('缺少汇总 sheet')
    expect(summaryA.getCell('B2').value).toBeCloseTo(123.45, 2)
    expect(summaryB.getCell('B2').value).toBeCloseTo(123.45, 2)
    const detailA = wa.getWorksheet('明细')
    const detailB = wb2.getWorksheet('明细')
    if (!detailA || !detailB) throw new Error('缺少明细 sheet')
    expect(detailA.actualRowCount).toBe(detailB.actualRowCount)
  })
})
