import { padLine, stringWidth, truncateToGrid } from '../../shared/receipt/char-grid'
import { formatMoney } from './money'
import { saleStatusText, type ReportExportInput } from './export.types'

/**
 * 报表 → 纯文本导出器（纯函数，零 I/O / 零 dialog——G 类约束：UI 交互在 export.service 层）。
 *
 * - 对齐复用 shared/receipt/char-grid（padLine/stringWidth，先 truncate 再 pad 的同源顺序）
 * - UTF-8 with BOM（\uFEFF = EF BB BF）——Windows 记事本兼容
 * - CRLF 行尾（Windows 目标平台）
 */

interface TxtColumn {
  header: string
  width: number
  align: 'left' | 'center' | 'right'
}

const DETAIL_COLUMNS: readonly TxtColumn[] = [
  { header: '单号', width: 16, align: 'left' },
  { header: '时间', width: 22, align: 'left' },
  { header: '商品数', width: 8, align: 'right' },
  { header: '合计(元)', width: 12, align: 'right' },
  { header: '状态', width: 8, align: 'left' },
  // 尾部追加（定案两列，不改既有列顺序/宽度——尾部原则是 xlsx 'D' 引用
  // 与 E2E nth 坐标断言的兼容基础）
  { header: '是否国补', width: 8, align: 'center' },
  // 备注超 20 显示列时被 truncateToGrid 截断（尾部丢弃，不折行）——
  // 纯文本报表定宽网格下的可读性取舍，定案接受
  { header: '订单备注', width: 20, align: 'left' }
]

const BUCKET_COLUMNS: readonly TxtColumn[] = [
  { header: '日期', width: 12, align: 'left' },
  { header: '销售额(元)', width: 14, align: 'right' },
  { header: '订单数', width: 8, align: 'right' }
]

const COLUMN_GAP = 2
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

function gridWidth(columns: readonly TxtColumn[]): number {
  return columns.reduce((sum, c) => sum + c.width, 0) + COLUMN_GAP * (columns.length - 1)
}

function rowLine(cells: readonly string[], columns: readonly TxtColumn[]): string {
  return columns
    .map((c, i) => padLine(truncateToGrid(cells[i] ?? '', c.width), c.width, c.align))
    .join(' '.repeat(COLUMN_GAP))
}

export function exportTxt(input: ReportExportInput): Buffer {
  const { title } = input
  const lines: string[] = []

  const wide = Math.max(gridWidth(DETAIL_COLUMNS), gridWidth(BUCKET_COLUMNS), stringWidth(title))
  const heavyRule = '═'.repeat(wide)
  const lightRule = '─'.repeat(wide)

  lines.push(title)
  lines.push(heavyRule)
  lines.push(`总销售额: ${formatMoney(input.report.total_cents)} 元`)
  lines.push(`订单数: ${input.report.order_count}`)
  // 汇总块尾部追加国补行（仅日报——月报无国补小计口径）
  if (input.kind === 'daily') {
    lines.push(`国补销售额: ${formatMoney(input.report.subsidy_total_cents)} 元`)
  }
  lines.push(lightRule)

  if (input.kind === 'daily') {
    const sales = input.report.sales
    lines.push('明细')
    lines.push(rowLine(DETAIL_COLUMNS.map((c) => c.header), DETAIL_COLUMNS))
    if (sales.length === 0) {
      lines.push('（无销售记录）')
    }
    for (const s of sales) {
      lines.push(
        rowLine(
          [
            s.sale_no,
            s.created_at,
            String(s.item_count),
            formatMoney(s.total_cents),
            saleStatusText(s.status),
            s.is_national_subsidy ? '是' : '否',
            s.order_note ?? ''
          ],
          DETAIL_COLUMNS
        )
      )
    }
  } else {
    const buckets = input.report.buckets ?? []
    lines.push('按日分桶')
    lines.push(rowLine(BUCKET_COLUMNS.map((c) => c.header), BUCKET_COLUMNS))
    if (buckets.length === 0) {
      lines.push('（无销售记录）')
    }
    for (const b of buckets) {
      lines.push(rowLine([b.date, formatMoney(b.total_cents), String(b.order_count)], BUCKET_COLUMNS))
    }
  }

  const body = `${lines.join('\r\n')}\r\n`
  return Buffer.concat([UTF8_BOM, Buffer.from(body, 'utf8')])
}
