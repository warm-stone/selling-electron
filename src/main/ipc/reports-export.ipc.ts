import type Database from 'better-sqlite3'
import type { IpcChannels } from '../../shared/types/ipc'
import { exportReport } from '../export/export.service'
import type { ExportFormat, ReportExportInput } from '../export/export.types'
import { createReportService, type ReportService } from '../services/report.service'

/**
 * reports:export 通道（T3 契约：req { kind, period, format } → res { file_path | null }）。
 *
 * T14 起数据侧统一走 report.service（T17 的临时 report-loader 已删除——
 * 单一数据源，reports:daily/monthly 与 export 同口径）。薄层三件事：
 * 参数校验（parseReportsExportRequest，纯函数可单测）→
 * buildReportExportInput（service 输出 → exporter 输入，export 编排层转换点）→
 * exportReport 编排。electron 懒加载 require——本模块可被
 * vitest 纯 Node 环境导入（parse / build 单测）。
 */

export interface ReportsExportRequest {
  kind: 'daily' | 'monthly'
  period: string
  format: ExportFormat
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

export function parseReportsExportRequest(req: unknown): ReportsExportRequest {
  if (typeof req !== 'object' || req === null) {
    throw new Error('reports:export 请求必须是对象')
  }
  const { kind, period, format } = req as { kind?: unknown; period?: unknown; format?: unknown }

  if (kind !== 'daily' && kind !== 'monthly') {
    throw new Error(`reports:export 非法报表类型 kind=${JSON.stringify(kind)}（须为 daily|monthly）`)
  }
  if (format !== 'txt' && format !== 'xlsx' && format !== 'docx') {
    throw new Error(`reports:export 非法导出格式 format=${JSON.stringify(format)}（须为 txt|xlsx|docx）`)
  }
  if (typeof period !== 'string') {
    throw new Error('reports:export period 必须是字符串')
  }
  if (kind === 'daily' && !DATE_RE.test(period)) {
    throw new Error(`reports:export 日报 period 须为 yyyy-MM-dd 格式：${JSON.stringify(period)}`)
  }
  if (kind === 'monthly' && !MONTH_RE.test(period)) {
    throw new Error(`reports:export 月报 period 须为 yyyy-MM 格式：${JSON.stringify(period)}`)
  }

  return { kind, period, format }
}

/**
 * service 输出 → ReportExportInput 组装（export 编排层转换点）。
 * DailyReport / MonthlyReport（含 buckets——T14 起 shared 契约）与 exporter
 * 输入结构逐字段一致，零结构转换；period/标题语义与 T17 行为不变。
 */
export function buildReportExportInput(
  service: ReportService,
  kind: 'daily' | 'monthly',
  period: string
): ReportExportInput {
  const title = `${period} 销售报表`
  if (kind === 'daily') {
    return { kind, period, title, report: service.daily(period) }
  }
  return { kind, period, title, report: service.monthly(period) }
}

export function registerReportsExportIpc(db: Database.Database): void {
  const service = createReportService(db)
  // 懒加载 electron：registerReportsExportIpc 仅在主进程装配时调用（main/index.ts）
  const { ipcMain } = require('electron') as {
    ipcMain: {
      handle(
        channel: 'reports:export',
        listener: (event: unknown, req: IpcChannels['reports:export']['req']) => Promise<IpcChannels['reports:export']['res']>
      ): void
    }
  }

  ipcMain.handle('reports:export', async (_event, req) => {
    const { kind, period, format } = parseReportsExportRequest(req)
    const input = buildReportExportInput(service, kind, period)
    const filePath = await exportReport(input, format)
    return { file_path: filePath }
  })
}
