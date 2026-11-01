import type { DailyBucket, DailyReport, MonthlyReport, SaleStatus } from '../../shared/types/domain'

/**
 * 导出子系统统一输入契约（Task 17）。
 *
 * - 报表体字段与 shared DTO 逐字对齐（snake_case `*_cents`——G1 整数分），
 *   金额→元只发生在各 exporter 的格式化边界。
 * - T14 起 shared MonthlyReport 已含 buckets（issues Task 17 待办清零）：
 *   MonthlyReportInput/MonthlyBucket 为兼容别名，exporter 文件零改动。
 */

export type ExportFormat = 'txt' | 'xlsx' | 'docx'

export const EXPORT_FORMATS: readonly ExportFormat[] = ['txt', 'xlsx', 'docx']

/** 月报按日分桶行（与 shared DailyBucket 同构——T14 上提后的兼容别名） */
export type MonthlyBucket = DailyBucket

/** 月报输入形态：T14 起 shared DTO 已含必填 buckets，本地扩展删除 */
export type MonthlyReportInput = MonthlyReport

/**
 * 导出统一输入：标题（'{日期} 销售报表'，docx Heading / txt 首行共用）+
 * 期间 period（日报 yyyy-MM-dd / 月报 yyyy-MM，默认文件名组成部分）+ 报表体。
 */
export type ReportExportInput =
  | { kind: 'daily'; period: string; title: string; report: DailyReport }
  | { kind: 'monthly'; period: string; title: string; report: MonthlyReportInput }

/** 销售状态的导出层中文显示（voided 仅防御性映射——D3 报表已剔除 voided） */
export function saleStatusText(status: SaleStatus): string {
  return status === 'completed' ? '已完成' : '已作废'
}
