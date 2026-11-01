/**
 * reports:daily / reports:monthly 通道装配（薄层：参数透传 + 调 service）。
 * 统一模式：registerReportsIpc(db)——main/index.ts 在 initDatabase() 行后追加。
 * 日期格式校验在 service（REPORT_INVALID_DATE/MONTH 可诊断中文错误）；
 * req 运行时防御：非字符串一律传空串（service 正则拒绝，不依赖 renderer 输入可信）。
 * T18 报表 UI 的数据源；导出链路（reports-export.ipc）同走一个 service 口径。
 */

import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import type { IpcChannels } from '../../shared/types/ipc'
import { createReportService } from '../services/report.service'

export function registerReportsIpc(db: Database.Database): void {
  const service = createReportService(db)

  ipcMain.handle('reports:daily', (_event, req: IpcChannels['reports:daily']['req']) =>
    service.daily(typeof req?.date === 'string' ? req.date : '')
  )

  ipcMain.handle('reports:monthly', (_event, req: IpcChannels['reports:monthly']['req']) =>
    service.monthly(typeof req?.month === 'string' ? req.month : '')
  )
}
