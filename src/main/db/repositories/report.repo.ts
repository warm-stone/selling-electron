/**
 * 报表 DAL（纯 SQL 聚合，无业务规则）——由 T17 的 export/report-loader.ts 演进而来。
 *
 * - 剔除 voided（D3）：聚合与明细共用 `status = 'completed'` 过滤，
 *   日报 total 与明细行集自洽由同一 WHERE 构造保证；国补小计同 WHERE，
 *   作废国补单自动剔除。
 * - 国补小计（T9）：`LEFT JOIN sale_extras`——sale_id 兼任 PK（1:1 旁挂），
 *   JOIN 不产生行倍增，COUNT(*)/SUM(total_cents) 语义不变；无 extras 行
 *   `se.is_national_subsidy` 为 NULL，`= 1` 判定不成立 → 天然归非国补。
 * - 分桶全在 SQL 内完成：`date(created_at)`（日）与 `strftime('%Y-%m', created_at)`（月）
 *   与 created_at 写入默认值 `datetime('now','localtime')` 同钟——零 JS Date 重解析、
 *   零时区错位。
 * - 空数据态：SUM 空集返回 NULL，COALESCE 归 0（空日/空月零值不抛错——T14 空态契约）。
 */

import type Database from 'better-sqlite3'
import type { DailyBucket, Sale, SaleWithExtras } from '../../../shared/types'

/** SUM/COUNT 聚合行形态（COALESCE 保证空集为 0 非 NULL） */
export interface ReportTotals {
  total_cents: number
  order_count: number
}

/** 日报聚合结果（repo 形态；service 组装为 DailyReport DTO） */
export interface DailyAggregate extends ReportTotals {
  /** 国补单合计（is_national_subsidy=1 的 completed 单 total_cents 之和；无国补单为 0） */
  subsidy_total_cents: number
  sales: SaleWithExtras[]
}

/** dailySalesStmt 原始行：is_national_subsidy 为 SQLite INTEGER 0/1，LEFT JOIN 未命中为 NULL */
interface DailySaleRow extends Sale {
  is_national_subsidy: number | null
  order_note: string | null
}

export function createReportRepo(db: Database.Database) {
  const dailyTotalsStmt = db.prepare(
    `SELECT COALESCE(SUM(total_cents), 0) AS total_cents,
            COALESCE(SUM(CASE WHEN se.is_national_subsidy = 1 THEN total_cents ELSE 0 END), 0) AS subsidy_total_cents,
            COUNT(*) AS order_count
       FROM sales
       LEFT JOIN sale_extras se ON se.sale_id = sales.id
      WHERE status = 'completed' AND date(created_at) = ?`
  )
  const dailySalesStmt = db.prepare(
    `SELECT sales.id, sales.sale_no, sales.total_cents, sales.item_count, sales.status,
            sales.voided_at, sales.created_at,
            se.is_national_subsidy, se.order_note
       FROM sales
       LEFT JOIN sale_extras se ON se.sale_id = sales.id
      WHERE sales.status = 'completed' AND date(sales.created_at) = ?
      ORDER BY sales.created_at, sales.id`
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
    /** 日报：SUM/COUNT 聚合 + 国补小计 + 明细列表（同 WHERE 剔除 voided；同秒双单按 id 稳定排序） */
    daily(dateStr: string): DailyAggregate {
      const totals = dailyTotalsStmt.get(dateStr) as ReportTotals & { subsidy_total_cents: number }
      const sales: SaleWithExtras[] = (dailySalesStmt.all(dateStr) as DailySaleRow[]).map((row) => ({
        ...row,
        // INTEGER 0/1 → boolean；LEFT JOIN 未命中（无 extras 行的旧单）NULL → false
        is_national_subsidy: row.is_national_subsidy === 1,
        order_note: row.order_note ?? null
      }))
      return {
        total_cents: totals.total_cents,
        order_count: totals.order_count,
        subsidy_total_cents: totals.subsidy_total_cents,
        sales
      }
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
