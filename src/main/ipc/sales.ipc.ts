/**
 * sales 通道装配（薄层：参数透传 + 调 service；通道名与 shared/types/ipc.ts 契约一致）。
 * 统一模式：registerSalesIpc(db)——main/index.ts 在 initDatabase() 行后调用。
 * service 抛出的 SaleServiceError 经 ipcMain.handle 转为 renderer 侧
 * invoke rejection（message 中文文案原样保留）。
 */

import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { createSaleService } from '../services/sale.service'
import type { CheckoutItem, SaleStatus } from '../../shared/types'

interface CheckoutRequest {
  items?: CheckoutItem[]
}

interface VoidRequest {
  sale_id?: number
}

interface ListRequest {
  date_from?: string
  date_to?: string
  status?: SaleStatus
}

interface DetailRequest {
  sale_id?: number
}

export function registerSalesIpc(db: Database.Database): void {
  const service = createSaleService(db)

  ipcMain.handle('sales:checkout', (_event, req: CheckoutRequest) =>
    service.checkout(req?.items ?? [])
  )

  ipcMain.handle('sales:void', (_event, req: VoidRequest) =>
    service.voidSale(req?.sale_id ?? -1)
  )

  ipcMain.handle('sales:list', (_event, req: ListRequest) =>
    service.list({
      date_from: req?.date_from,
      date_to: req?.date_to,
      status: req?.status
    })
  )

  ipcMain.handle('sales:detail', (_event, req: DetailRequest) =>
    service.getDetail(req?.sale_id ?? -1)
  )
}
