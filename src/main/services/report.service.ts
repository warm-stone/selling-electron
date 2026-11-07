/**
 * 报表统计业务核心（T14）：日/月聚合 + voided 剔除（D3）+ 参数校验 + 空态优雅。
 *
 * 单一数据源：reports:daily / reports:monthly 通道（T18 报表 UI 消费）与
 * reports:export 导出链路（T17 起改为委托本 service）共用同一聚合口径。
 * created_at 写入用 SQLite datetime('now','localtime')（T2 定案），
 * 分桶在 repo 的 SQL 内完成——本层零时区运算。
 */

import type Database from 'better-sqlite3'
import type { DailyReport, MonthlyReport } from '../../shared/types'
import { createReportRepo } from '../db/repositories/report.repo'

/** service 错误码（IPC 层透传 message 给 renderer） */
export type ReportErrorCode = 'REPORT_INVALID_DATE' | 'REPORT_INVALID_MONTH'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class ReportServiceError extends Error {
  constructor(readonly code: ReportErrorCode, message: string) {
    super(message)
    this.name = 'ReportServiceError'
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

export function createReportService(db: Database.Database) {
  const repo = createReportRepo(db)

  return {
    /** 日报（剔除 voided；空数据日零值不抛错） */
    daily(dateStr: string): DailyReport {
      if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) {
        throw new ReportServiceError(
          'REPORT_INVALID_DATE',
          `日报日期须为 yyyy-MM-dd 格式：${JSON.stringify(dateStr)}`
        )
      }
      // repo.daily 已含 sale_extras 平铺列（is_national_subsidy/order_note）与
      // 国补小计（LEFT JOIN 聚合，同 WHERE 剔除 voided）——本层零组装直接透传
      const { total_cents, order_count, subsidy_total_cents, sales } = repo.daily(dateStr)
      return { date: dateStr, total_cents, order_count, subsidy_total_cents, sales }
    },

    /** 月报（剔除 voided；含按日分桶 buckets；空月零值不抛错） */
    monthly(ymStr: string): MonthlyReport {
      if (typeof ymStr !== 'string' || !MONTH_RE.test(ymStr)) {
        throw new ReportServiceError(
          'REPORT_INVALID_MONTH',
          `月报月份须为 yyyy-MM 格式：${JSON.stringify(ymStr)}`
        )
      }
      const { total_cents, order_count } = repo.monthly(ymStr)
      return { month: ymStr, total_cents, order_count, buckets: repo.dailyBuckets(ymStr) }
    }
  }
}

export type ReportService = ReturnType<typeof createReportService>
