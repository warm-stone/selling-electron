/**
 * 商品管理 IPC 装配（薄层：转发 + 参数透传，零 SQL/零业务规则）。
 *
 * 并行任务统一约定：导出 registerXxxIpc(db)，由 src/main/index.ts 在
 * initDatabase() 调用之后逐任务追加一行装配。
 *
 * 通道名/req/res 类型经 typedHandle 钉死在 src/shared/types/ipc.ts 的
 * IpcChannels 契约（T3）——service 返回与契约漂移即编译失败。
 * service 抛出的 ProductServiceError 经 Electron invoke 序列化后 message
 * 保留中文文案（renderer 侧剥去 "Error invoking remote method ..." 前缀展示）。
 */

import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { typedHandle } from './typed-handle'
import { createProductService } from '../services/product.service'

export function registerProductsIpc(db: Database.Database): void {
  const productService = createProductService(db)

  typedHandle(ipcMain, 'products:list', (req) => productService.list(req?.keyword))

  typedHandle(ipcMain, 'products:create', (req) => productService.create(req))

  typedHandle(ipcMain, 'products:update', (req) => productService.update(req))

  typedHandle(ipcMain, 'products:updateStock', (req) => productService.updateStock(req))

  typedHandle(ipcMain, 'products:delete', (req) => productService.delete(req))

  typedHandle(ipcMain, 'products:findSn', (req) => productService.findSn(req.sn))

  typedHandle(ipcMain, 'products:listSns', (req) =>
    productService.listSns(req.product_id, req.include_sold)
  )

  typedHandle(ipcMain, 'products:deleteSn', (req) =>
    productService.deleteSn(req.sn_id, req.reason)
  )

  typedHandle(ipcMain, 'products:listChangeLogs', (req) =>
    productService.listChangeLogs(req.product_id, req.limit)
  )
}
