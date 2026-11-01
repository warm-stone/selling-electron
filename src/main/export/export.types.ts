import type { DailyReport, MonthlyReport, SaleStatus } from '../../shared/types/domain'

/**
 * 导出子系统统一输入契约（Task 17）。
 *
 * - 报表体字段与 T3 DTO 逐字对齐（snake_case `*_cents`——G1 整数分），
 *   金额→元只发生在各 exporter 的格式化边界。
 * - T3 MonthlyReport 暂缺按日分桶字段（DTO 缺口，issues 已记录）：
 *   此处以本地结构扩展 `buckets?`，T14 在 shared DTO 补字段后结构兼容可直接替换。
 */

export type ExportFormat = 'txt' | 'xlsx' | 'docx'

export const EXPORT_FORMATS: readonly ExportFormat[] = ['txt', 'xlsx', 'docx']

/** 月报按日分桶行（date=yyyy-MM-dd） */
export interface MonthlyBucket {
  date: string
  total_cents: number
  order_count: number
}

/** 月报导入入形态：T3 MonthlyReport + 可选按日分桶（结构性兼容 T14 的扩展 DTO） */
export type MonthlyReportInput = MonthlyReport & { buckets?: MonthlyBucket[] }

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
