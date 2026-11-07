/**
 * customers 通道装配（薄层：参数归一 + 调 service；通道名与 shared/types/ipc.ts 契约一致）。
 * 统一模式：registerCustomersIpc(db)——main/index.ts 在 initDatabase() 行后调用。
 * service 抛出的 CustomerServiceError 经 ipcMain.handle 转为 renderer 侧
 * invoke rejection（message 中文文案原样保留——照 sales.ipc 惯例不做捕获）。
 *
 * 通道（T2 契约）：
 * - customers:list   { keyword?, limit?, offset? } → { items, total }
 * - customers:create { name, phone, address, note } → Customer
 * - customers:update { id, patch } → Customer
 */

import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import type { IpcChannels } from '../../shared/types/ipc'
import { createCustomerService } from '../services/customer.service'

export function registerCustomersIpc(db: Database.Database): void {
  const service = createCustomerService(db)

  ipcMain.handle(
    'customers:list',
    (_event, req: IpcChannels['customers:list']['req'] | undefined) =>
      // keyword/limit/offset 全可选：undefined 透传，trim/缺省值/上限归一在 service 层
      service.list(req?.keyword, req?.limit, req?.offset)
  )

  // 四字段缺省归 ''：phone 缺失 → service 拦为 CUSTOMER_PHONE_REQUIRED（可诊断中文文案）
  ipcMain.handle(
    'customers:create',
    (_event, req: IpcChannels['customers:create']['req'] | undefined) =>
      service.create({
        name: req?.name ?? '',
        phone: req?.phone ?? '',
        address: req?.address ?? '',
        note: req?.note ?? ''
      })
  )

  // id 缺省 -1（哨兵必无行）→ service 回读落空 → CUSTOMER_NOT_FOUND（照 sales:void 惯例）
  ipcMain.handle(
    'customers:update',
    (_event, req: IpcChannels['customers:update']['req'] | undefined) =>
      service.update(req?.id ?? -1, req?.patch ?? {})
  )
}
