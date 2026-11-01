import { Workbook, type Worksheet } from 'exceljs'
import { stringWidth } from '../../shared/receipt/char-grid'
import type { Sale } from '../../shared/types/domain'
import { formatMoney } from './money'
import { saleStatusText, type MonthlyBucket, type ReportExportInput } from './export.types'

/**
 * 报表 → .xlsx 导出器（exceljs；纯函数，零 dialog/文件 I/O——交互在 export.service 层）。
 *
 * Sheet 结构：
 * - 『汇总』：总销售额（元）/ 订单数 / 日期范围 —— 三格式一致的汇总块
 * - 『明细』（日报）：单号/时间/商品数/合计（元）/状态
 * - 『按日分桶』（月报，buckets 存在时）：日期/销售额（元）/订单数
 *
 * 金额写入规则（G1 边界格式化）：分 → 元数值（/ 100）+ numFmt '0.00'，
 * 单元格保持数值类型（Excel 可再计算），显示层由 numFmt 呈现两位小数。
 */

const MONEY_FMT = '0.00'
const COLUMN_PADDING = 2

function autoWidth(header: string, samples: readonly string[]): number {
  let width = stringWidth(header)
  for (const s of samples) width = Math.max(width, stringWidth(s))
  return width + COLUMN_PADDING
}

export async function exportXlsx(input: ReportExportInput): Promise<Buffer> {
  const wb = new Workbook()

  const summary = wb.addWorksheet('汇总')
  summary.columns = [
    { header: '项目', width: autoWidth('项目', ['总销售额（元）', '订单数', '日期范围']) },
    {
      header: '数值',
      width: autoWidth('数值', [
        formatMoney(input.report.total_cents),
        String(input.report.order_count),
        input.period
      ])
    }
  ]
  summary.addRow(['总销售额（元）', input.report.total_cents / 100])
  summary.getCell('B2').numFmt = MONEY_FMT
  summary.addRow(['订单数', input.report.order_count])
  summary.addRow(['日期范围', input.period])

  if (input.kind === 'daily') {
    appendDetailSheet(wb, input.report.sales)
  } else if (input.report.buckets) {
    appendBucketSheet(wb, input.report.buckets)
  }

  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}

type SummarySheet = Worksheet

function appendDetailSheet(wb: Workbook, sales: readonly Sale[]): SummarySheet {
  const sheet = wb.addWorksheet('明细')
  sheet.columns = [
    { header: '单号', width: autoWidth('单号', sales.map((s) => s.sale_no)) },
    { header: '时间', width: autoWidth('时间', sales.map((s) => s.created_at)) },
    { header: '商品数', width: autoWidth('商品数', sales.map((s) => String(s.item_count))) },
    { header: '合计（元）', width: autoWidth('合计（元）', sales.map((s) => formatMoney(s.total_cents))) },
    { header: '状态', width: autoWidth('状态', sales.map((s) => saleStatusText(s.status))) }
  ]
  sales.forEach((s) => {
    sheet.addRow([s.sale_no, s.created_at, s.item_count, s.total_cents / 100, saleStatusText(s.status)])
    const moneyCell = sheet.getCell(`D${sheet.rowCount}`)
    moneyCell.numFmt = MONEY_FMT
  })
  return sheet
}

function appendBucketSheet(wb: Workbook, buckets: readonly MonthlyBucket[]): SummarySheet {
  const sheet = wb.addWorksheet('按日分桶')
  sheet.columns = [
    { header: '日期', width: autoWidth('日期', buckets.map((b) => b.date)) },
    { header: '销售额（元）', width: autoWidth('销售额（元）', buckets.map((b) => formatMoney(b.total_cents))) },
    { header: '订单数', width: autoWidth('订单数', buckets.map((b) => String(b.order_count))) }
  ]
  buckets.forEach((b) => {
    sheet.addRow([b.date, b.total_cents / 100, b.order_count])
    const moneyCell = sheet.getCell(`B${sheet.rowCount}`)
    moneyCell.numFmt = MONEY_FMT
  })
  return sheet
}
