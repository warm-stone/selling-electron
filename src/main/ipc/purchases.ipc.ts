import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { createPurchaseService } from '../services/purchase.service'
import type { PurchaseInputItem, PurchaseOrderWithItems } from '../../shared/types'

/**
 * 进货 IPC 薄层（Task 9）：参数校验在 service，此处仅装配（统一模式：
 * registerPurchasesIpc(db)，由 main/index.ts 在 initDatabase() 后调用）。
 *
 * 通道契约见 src/shared/types/ipc.ts：purchases:create / purchases:list。
 * handler 内直接透传 service 结果——错误经 Electron invoke 序列化为
 * Error(message)，renderer 侧 catch 展示（中文消息由 service/repo 生成）。
 */
export function registerPurchasesIpc(db: Database.Database): void {
  const service = createPurchaseService(db)

  ipcMain.handle(
    'purchases:create',
    (
      _event,
      req: { note?: string | null; items: PurchaseInputItem[] } | undefined
    ): PurchaseOrderWithItems => service.createPurchase(req?.items ?? [], req?.note)
  )

  ipcMain.handle(
    'purchases:list',
    (
      _event,
      req?: { date_from?: string; date_to?: string }
    ): PurchaseOrderWithItems[] => service.list(req?.date_from, req?.date_to)
  )
}
