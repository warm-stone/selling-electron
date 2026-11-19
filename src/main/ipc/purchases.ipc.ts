import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { typedHandle } from './typed-handle'
import { createPurchaseService } from '../services/purchase.service'

/**
 * 进货 IPC 薄层（Task 9）：参数校验在 service，此处仅装配（统一模式：
 * registerPurchasesIpc(db)，由 main/index.ts 在 initDatabase() 后调用）。
 *
 * 通道契约见 src/shared/types/ipc.ts：purchases:create / purchases:list——
 * req/res 经 typedHandle 编译期钉死。handler 内直接透传 service 结果——
 * 错误经 Electron invoke 序列化为 Error(message)，renderer 侧 catch 展示
 * （中文消息由 service/repo 生成）。
 */
export function registerPurchasesIpc(db: Database.Database): void {
  const service = createPurchaseService(db)

  typedHandle(ipcMain, 'purchases:create', (req) => service.createPurchase(req?.items ?? [], req?.note))

  typedHandle(ipcMain, 'purchases:list', (req) => service.list(req?.date_from, req?.date_to))
}
