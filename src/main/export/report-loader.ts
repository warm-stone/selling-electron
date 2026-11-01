import type Database from 'better-sqlite3'
import type { DailyReport, Sale } from '../../shared/types/domain'
import type { MonthlyReportInput, ReportExportInput } from './export.types'

/**
 * reports:export 通道的数据侧：日/月聚合 SQL（剔除 voided——D3）。
 *
 * ⚠️ T14（report.service，Wave 2b）落地后本模块应改为委托 report.service，
 * 届时删除此处聚合 SQL（技术债已在 issues 记录；当前为避免跨波次依赖暂存私有实现）。
 */

export function loadDailyReport(db: Database.Database, date: string): DailyReport {
  const rows = db
    .prepare(
      `SELECT id, sale_no, total_cents, item_count, status, voided_at, created_at
         FROM sales
        WHERE status = 'completed' AND date(created_at) = ?
        ORDER BY created_at, id`
    )
    .all(date) as Sale[]

  return {
    date,
    total_cents: rows.reduce((sum, s) => sum + s.total_cents, 0),
    order_count: rows.length,
    sales: rows
  }
}

interface BucketRow {
  date: string
  total_cents: number
  order_count: number
}

export function loadMonthlyReport(db: Database.Database, month: string): MonthlyReportInput {
  const rows = db
    .prepare(
      `SELECT date(created_at) AS date, SUM(total_cents) AS total_cents, COUNT(*) AS order_count
         FROM sales
        WHERE status = 'completed' AND strftime('%Y-%m', created_at) = ?
        GROUP BY date(created_at)
        ORDER BY date(created_at)`
    )
    .all(month) as BucketRow[]

  const buckets = rows.map((r) => ({ date: r.date, total_cents: r.total_cents, order_count: r.order_count }))
  return {
    month,
    total_cents: buckets.reduce((sum, b) => sum + b.total_cents, 0),
    order_count: buckets.reduce((sum, b) => sum + b.order_count, 0),
    buckets
  }
}

export function loadReportExportInput(
  db: Database.Database,
  kind: 'daily' | 'monthly',
  period: string
): ReportExportInput {
  const title = `${period} 销售报表`
  if (kind === 'daily') {
    return { kind, period, title, report: loadDailyReport(db, period) }
  }
  return { kind, period, title, report: loadMonthlyReport(db, period) }
}
