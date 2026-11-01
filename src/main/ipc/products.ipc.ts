/**
 * 商品管理 IPC 装配（薄层：转发 + 参数透传，零 SQL/零业务规则）。
 *
 * 并行任务统一约定：导出 registerXxxIpc(db)，由 src/main/index.ts 在
 * initDatabase() 调用之后逐任务追加一行装配。
 *
 * 通道名/req/res 类型对齐 src/shared/types/ipc.ts IpcChannels（T3 契约）。
 * service 抛出的 ProductServiceError 经 Electron invoke 序列化后 message
 * 保留中文文案（renderer 侧剥去 "Error invoking remote method ..." 前缀展示）。
 */

import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import type { IpcChannels } from '../../shared/types/ipc'
import { createProductService } from '../services/product.service'

export function registerProductsIpc(db: Database.Database): void {
  const productService = createProductService(db)

  ipcMain.handle('products:list', (_event, req: { keyword?: string }) =>
    productService.list(req?.keyword)
  )

  ipcMain.handle('products:create', (_event, req: IpcChannels['products:create']['req']) =>
    productService.create(req)
  )

  ipcMain.handle('products:update', (_event, req: IpcChannels['products:update']['req']) =>
    productService.update(req)
  )

  ipcMain.handle(
    'products:updateStock',
    (_event, req: IpcChannels['products:updateStock']['req']) =>
      productService.updateStock(req)
  )

  ipcMain.handle('products:delete', (_event, req: IpcChannels['products:delete']['req']) =>
    productService.delete(req)
  )
}
