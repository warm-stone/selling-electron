/**
 * sales 通道装配（薄层：参数透传 + 调 service；通道名/req/res 经 typedHandle
 * 钉死在 shared/types/ipc.ts 契约）。
 * 统一模式：registerSalesIpc(db)——main/index.ts 在 initDatabase() 行后调用。
 * service 抛出的 SaleServiceError 经 ipcMain.handle 转为 renderer 侧
 * invoke rejection（message 中文文案原样保留）。
 *
 * req 的运行时防御照旧（`req?.x ?? 哨兵`）：契约类型是编译期约定，
 * renderer 实际 payload 不可信——哨兵值走 service 的可诊断错误路径。
 */

import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { typedHandle } from './typed-handle'
import { createSaleService } from '../services/sale.service'

export function registerSalesIpc(db: Database.Database): void {
  const service = createSaleService(db)

  typedHandle(ipcMain, 'sales:checkout', (req) =>
    // extras 缺省 undefined = 散客快单路径（service 侧不落 sale_extras 行）
    service.checkout(req?.items ?? [], req?.extras)
  )

  typedHandle(ipcMain, 'sales:void', (req) => service.voidSale(req?.sale_id ?? -1))

  typedHandle(ipcMain, 'sales:list', (req) =>
    // 三筛选键缺省 undefined = 不过滤（trim 归一在 service 层）
    service.list({
      date_from: req?.date_from,
      date_to: req?.date_to,
      status: req?.status,
      customer_name: req?.customer_name,
      customer_phone: req?.customer_phone,
      is_national_subsidy: req?.is_national_subsidy
    })
  )

  typedHandle(ipcMain, 'sales:detail', (req) => service.getDetail(req?.sale_id ?? -1))

  // patch 键缺省 undefined = 不动（sale-extra.repo.upsert 部分键语义）；
  // customer: null 透传为显式解绑
  typedHandle(ipcMain, 'sales:updateExtra', (req) =>
    service.updateExtra(req?.sale_id ?? -1, {
      is_national_subsidy: req?.is_national_subsidy,
      order_note: req?.order_note,
      salesperson: req?.salesperson,
      customer: req?.customer
    })
  )
}
