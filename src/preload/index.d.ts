import type {
  AppSettings,
  CheckoutItem,
  IpcChannels,
  Product,
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

/**
 * 商品列表行：Product + 删除影响计数。运行时为契约 products:list res
 * `Product[]` 的结构超集（通道封闭约束下 UI 删除弹窗引用数的获取途径）。
 * 与 src/preload/index.ts 的同名声明保持结构同步。
 */
export interface ProductRow extends Product {
  /** 关联的 sale_items + purchase_items 行数（删除弹窗「N 条历史单据」文案用） */
  willOrphan: number
}

export interface ProductsApi {
  list: (keyword?: string) => Promise<ProductRow[]>
  create: (req: {
    barcode: string | null
    name: string
    default_price_cents: number | null
    stock: number
  }) => Promise<Product>
  update: (req: {
    id: number
    name: string
    default_price_cents: number | null
  }) => Promise<Product>
  updateStock: (req: { id: number; stock: number }) => Promise<Product>
  delete: (id: number) => Promise<{ ok: true; willOrphan: number }>
}

export interface SettingsApi {
  get: () => Promise<AppSettings>
  set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  uploadLogo: () => Promise<{ logo_path: string | null }>
  getLogoDataUrl: () => Promise<{ data_url: string | null }>
}

/** 测试打印请求：AppSettings 的打印子集（设置页「打印设置」卡片当前表单值） */
export type PrintTestRequest = Pick<
  AppSettings,
  'printer_channel' | 'printer_name' | 'tcp_host' | 'tcp_port' | 'com_port'
>

export interface PrintingApi {
  printers: () => Promise<{ name: string; is_default: boolean }[]>
  testPrint: (req: PrintTestRequest) => Promise<{ ok: boolean; error?: string }>
}

/** 报表（Task 14 日/月查询 + Task 17 导出）：file_path null = 用户取消。 */
export interface ReportsApi {
  /** 日报（剔除 voided；空数据日零值不抛错；明细行带 status 标记） */
  daily: (date: string) => Promise<IpcChannels['reports:daily']['res']>
  /** 月报（剔除 voided；含按日分桶 buckets——空月为 []） */
  monthly: (month: string) => Promise<IpcChannels['reports:monthly']['res']>
  export: (
    req: IpcChannels['reports:export']['req']
  ) => Promise<IpcChannels['reports:export']['res']>
}

export interface PosApi {
  ping: () => string
  /** 底层 IPC 入口：经 shared/types/ipc.ts 的 createTypedInvoke 包装使用（G8） */
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
  /** 扫码枪条码订阅（主进程检测桥推送）；返回取消订阅函数 */
  onBarcode: (cb: (code: string) => void) => () => void
  sales: SalesApi
  purchases: PurchasesApi
  products: ProductsApi
  settings: SettingsApi
  printing: PrintingApi
  reports: ReportsApi
}

declare global {
  interface Window {
    api: PosApi
  }
}
