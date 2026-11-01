import { contextBridge, ipcRenderer } from 'electron'
import type {
  CheckoutItem,
  PurchaseInputItem,
  PurchaseOrderWithItems,
  Sale,
  SaleDetail,
  SaleStatus
} from '../shared/types'

/**
 * 单一类型化 API surface（后续任务在此扩展 typed IPC，禁止散落裸 invoke）。
 * 通道名与 shared/types/ipc.ts 的 IpcChannels 契约一一对应。
 */
const api = {
  ping: (): string => 'pong',

  /**
   * 底层类型化 IPC 入口（G8）：renderer 侧经 shared/types/ipc.ts 的
   * createTypedInvoke 包装后按 IpcChannels 契约调用，通道名不散落裸字符串。
   */
  invoke: (channel: string, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(channel, payload),

  // ── 销售（Task 10：结账 + 作废 + 查询）──
  sales: {
    /** 结账（单事务：sales/sale_items/扣库存/movements；返回头+明细，金额整数分） */
    checkout: (items: CheckoutItem[]): Promise<SaleDetail> =>
      ipcRenderer.invoke('sales:checkout', { items }),
    /** 整单作废（事务回滚库存 + status='voided'） */
    void: (saleId: number): Promise<Sale> =>
      ipcRenderer.invoke('sales:void', { sale_id: saleId }),
    /** 销售列表（按日期/状态过滤，最新在前） */
    list: (filters?: {
      date_from?: string
      date_to?: string
      status?: SaleStatus
    }): Promise<Sale[]> => ipcRenderer.invoke('sales:list', filters ?? {}),
    /** 单据明细（头 + items） */
    detail: (saleId: number): Promise<SaleDetail> =>
      ipcRenderer.invoke('sales:detail', { sale_id: saleId })
  },

  // ── 进货（Task 9：入库单 + 库存联动 + 流水）──
  purchases: {
    /** 新建进货单（单事务：单据+快照明细+库存累加+流水；金额整数分） */
    create: (req: { note: string | null; items: PurchaseInputItem[] }): Promise<PurchaseOrderWithItems> =>
      ipcRenderer.invoke('purchases:create', req),
    /** 进货单列表（头+明细，最新在前；可选日期过滤） */
    list: (filters?: {
      date_from?: string
      date_to?: string
    }): Promise<PurchaseOrderWithItems[]> =>
      ipcRenderer.invoke('purchases:list', filters ?? {})
  }
}

contextBridge.exposeInMainWorld('api', api)
