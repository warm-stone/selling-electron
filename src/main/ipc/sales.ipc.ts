/**
 * sales 通道装配（薄层：参数透传 + 调 service；通道名与 shared/types/ipc.ts 契约一致）。
 * 统一模式：registerSalesIpc(db)——main/index.ts 在 initDatabase() 行后调用。
 * service 抛出的 SaleServiceError 经 ipcMain.handle 转为 renderer 侧
 * invoke rejection（message 中文文案原样保留）。
 */

import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { createSaleService } from '../services/sale.service'
import type {
  CheckoutCustomerInput,
  CheckoutExtrasInput,
  CheckoutItem,
  SaleStatus
} from '../../shared/types'

interface CheckoutRequest {
  items?: CheckoutItem[]
  extras?: CheckoutExtrasInput
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

interface UpdateExtraRequest {
  sale_id?: number
  is_national_subsidy?: boolean
  order_note?: string
  salesperson?: string
  customer?: CheckoutCustomerInput | null
}

export function registerSalesIpc(db: Database.Database): void {
  const service = createSaleService(db)

  ipcMain.handle('sales:checkout', (_event, req: CheckoutRequest) =>
    // extras 缺省 undefined = 散客快单路径（service 侧不落 sale_extras 行）
    service.checkout(req?.items ?? [], req?.extras ?? undefined)
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

  // patch 键缺省 undefined = 不动（sale-extra.repo.upsert 部分键语义）；
  // customer: null 透传为显式解绑
  ipcMain.handle('sales:updateExtra', (_event, req: UpdateExtraRequest) =>
    service.updateExtra(req?.sale_id ?? -1, {
      is_national_subsidy: req?.is_national_subsidy,
      order_note: req?.order_note,
      salesperson: req?.salesperson,
      customer: req?.customer
    })
  )
}
