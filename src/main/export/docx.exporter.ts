import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import { formatMoney } from './money'
import { saleStatusText, type ReportExportInput } from './export.types'

/**
 * 报表 → .docx 导出器（docx 库；纯函数，零 dialog/文件 I/O）。
 * 锁定清单：标题（Heading）+ 汇总段落 + 简单单线边框表格止步——无图片/花式排版。
 */

const SIMPLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: '999999' }

const TABLE_BORDERS = {
  top: SIMPLE_BORDER,
  bottom: SIMPLE_BORDER,
  left: SIMPLE_BORDER,
  right: SIMPLE_BORDER,
  insideHorizontal: SIMPLE_BORDER,
  insideVertical: SIMPLE_BORDER
}

function textCell(text: string, bold = false): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold })] })]
  })
}

function makeTable(headers: readonly string[], rows: readonly (readonly string[])[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h) => textCell(h, true))
      }),
      ...rows.map((r) => new TableRow({ children: r.map((cell) => textCell(cell)) }))
    ]
  })
}

export async function exportDocx(input: ReportExportInput): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: input.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `总销售额：${formatMoney(input.report.total_cents)} 元` }),
    new Paragraph({ text: `订单数：${input.report.order_count}` })
  ]
  // 汇总段尾部追加国补行（仅日报——月报无国补小计口径）
  if (input.kind === 'daily') {
    children.push(
      new Paragraph({ text: `国补销售额：${formatMoney(input.report.subsidy_total_cents)} 元` })
    )
  }

  if (input.kind === 'daily') {
    children.push(new Paragraph({ text: '明细', heading: HeadingLevel.HEADING_2 }))
    const sales = input.report.sales
    if (sales.length === 0) {
      children.push(new Paragraph({ text: '（无销售记录）' }))
    } else {
      children.push(
        makeTable(
          // 尾部追加两列（定案——与 txt/xlsx 明细列序一致）
          ['单号', '时间', '商品数', '合计（元）', '状态', '是否国补', '订单备注'],
          sales.map((s) => [
            s.sale_no,
            s.created_at,
            String(s.item_count),
            formatMoney(s.total_cents),
            saleStatusText(s.status),
            s.is_national_subsidy ? '是' : '否',
            s.order_note ?? ''
          ])
        )
      )
    }
  } else {
    children.push(new Paragraph({ text: '按日分桶', heading: HeadingLevel.HEADING_2 }))
    const buckets = input.report.buckets ?? []
    if (buckets.length === 0) {
      children.push(new Paragraph({ text: '（无销售记录）' }))
    } else {
      children.push(
        makeTable(
          ['日期', '销售额（元）', '订单数'],
          buckets.map((b) => [b.date, formatMoney(b.total_cents), String(b.order_count)])
        )
      )
    }
  }

  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc)
}
