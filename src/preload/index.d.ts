import type {
  CheckoutItem,
  PurchaseInputItem,
  PurchaseOrderWithItems,
  Sale,
  SaleDetail,
  SaleStatus
} from '../shared/types'

/** preload 暴露给 renderer 的类型化 API surface（通道名与 IpcChannels 契约一致）。 */
export interface SalesApi {
  checkout: (items: CheckoutItem[]) => Promise<SaleDetail>
  void: (saleId: number) => Promise<Sale>
  list: (filters?: {
    date_from?: string
    date_to?: string
    status?: SaleStatus
  }) => Promise<Sale[]>
  detail: (saleId: number) => Promise<SaleDetail>
}

export interface PurchasesApi {
  create: (req: { note: string | null; items: PurchaseInputItem[] }) => Promise<PurchaseOrderWithItems>
  list: (filters?: {
    date_from?: string
    date_to?: string
  }) => Promise<PurchaseOrderWithItems[]>
}

export interface PosApi {
  ping: () => string
  /** 底层 IPC 入口：经 shared/types/ipc.ts 的 createTypedInvoke 包装使用（G8） */
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
  sales: SalesApi
  purchases: PurchasesApi
}

declare global {
  interface Window {
    api: PosApi
  }
}
