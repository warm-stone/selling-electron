import type Database from 'better-sqlite3'
import type { IpcChannels } from '../../shared/types/ipc'
import { exportReport } from '../export/export.service'
import type { ExportFormat } from '../export/export.types'
import { loadReportExportInput } from '../export/report-loader'

/**
 * reports:export 通道（T3 契约：req { kind, period, format } → res { file_path | null }）。
 *
 * ⚠️ 冲突预警（Wave 2a/2b 并行）：本文件只注册 reports:export 单通道；
 * T14（报表 service）将另行注册 reports:daily / reports:monthly（不同文件，同归 reports 域）。
 *
 * 薄层三件事：参数校验（parseReportsExportRequest，纯函数可单测）→
 * 调 export 数据侧/编排层 → 序列化返回。electron 懒加载 require——本模块可被
 * vitest 纯 Node 环境导入（parse 单测）。
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

export function registerReportsExportIpc(db: Database.Database): void {
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
    const input = loadReportExportInput(db, kind, period)
    const filePath = await exportReport(input, format)
    return { file_path: filePath }
  })
}
