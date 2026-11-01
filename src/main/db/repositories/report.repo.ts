/**
 * 报表 DAL（纯 SQL 聚合，无业务规则）——由 T17 的 export/report-loader.ts 演进而来。
 *
 * - 剔除 voided（D3）：聚合与明细共用 `status = 'completed'` 过滤，
 *   日报 total 与明细行集自洽由同一 WHERE 构造保证。
 * - 分桶全在 SQL 内完成：`date(created_at)`（日）与 `strftime('%Y-%m', created_at)`（月）
 *   与 created_at 写入默认值 `datetime('now','localtime')` 同钟——零 JS Date 重解析、
 *   零时区错位。
 * - 空数据态：SUM 空集返回 NULL，COALESCE 归 0（空日/空月零值不抛错——T14 空态契约）。
 */

import type Database from 'better-sqlite3'
import type { DailyBucket, Sale } from '../../../shared/types'

/** SUM/COUNT 聚合行形态（COALESCE 保证空集为 0 非 NULL） */
export interface ReportTotals {
  total_cents: number
  order_count: number
}

/** 日报聚合结果（repo 形态；service 组装为 DailyReport DTO） */
export interface DailyAggregate extends ReportTotals {
  sales: Sale[]
}

export function createReportRepo(db: Database.Database) {
  const dailyTotalsStmt = db.prepare(
    `SELECT COALESCE(SUM(total_cents), 0) AS total_cents, COUNT(*) AS order_count
       FROM sales
      WHERE status = 'completed' AND date(created_at) = ?`
  )
  const dailySalesStmt = db.prepare(
    `SELECT id, sale_no, total_cents, item_count, status, voided_at, created_at
       FROM sales
      WHERE status = 'completed' AND date(created_at) = ?
      ORDER BY created_at, id`
  )
  const monthlyTotalsStmt = db.prepare(
    `SELECT COALESCE(SUM(total_cents), 0) AS total_cents, COUNT(*) AS order_count
       FROM sales
      WHERE status = 'completed' AND strftime('%Y-%m', created_at) = ?`
  )
  const dailyBucketsStmt = db.prepare(
    `SELECT date(created_at) AS date, SUM(total_cents) AS total_cents, COUNT(*) AS order_count
       FROM sales
      WHERE status = 'completed' AND strftime('%Y-%m', created_at) = ?
      GROUP BY date(created_at)
      ORDER BY date(created_at)`
  )

  return {
    /** 日报：SUM/COUNT 聚合 + 明细列表（同 WHERE 剔除 voided；同秒双单按 id 稳定排序） */
    daily(dateStr: string): DailyAggregate {
      const totals = dailyTotalsStmt.get(dateStr) as ReportTotals
      const sales = dailySalesStmt.all(dateStr) as Sale[]
      return { total_cents: totals.total_cents, order_count: totals.order_count, sales }
    },

    /** 月报：月度 SUM/COUNT 合计（剔除 voided） */
    monthly(ymStr: string): ReportTotals {
      return monthlyTotalsStmt.get(ymStr) as ReportTotals
    },

    /** 月报按日分桶（SQL 内 GROUP BY date 分桶，返回仅有销售发生的日） */
    dailyBuckets(ymStr: string): DailyBucket[] {
      return dailyBucketsStmt.all(ymStr) as DailyBucket[]
    }
  }
}

export type ReportRepo = ReturnType<typeof createReportRepo>
