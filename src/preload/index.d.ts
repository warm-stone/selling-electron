import type {
  AppSettings,
  CheckoutItem,
  IpcChannels,
  PrintTemplate,
  Product,
  PurchaseInputItem,
  PurchaseOrderWithItems,
  Sale,
  SaleDetail,
  SaleStatus
} from '../shared/types'
import type { SaleReceiptData } from '../shared/receipt/item-columns'
import type { ReceiptTemplate, ReceiptVars } from '../shared/receipt/template-schema'

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

/**
 * 小票预览结果（Task 15）：printing:preview res 的运行时结构超集——
 * T3 契约只声明 template+sale，data/vars/logoUrl 为主进程 PreviewPayload
 * 附加字段（与打印字节同一组装源头，G7）。
 * 与 src/preload/index.ts 的同名声明保持结构同步。
 */
export interface PrintingPreviewResult {
  template: ReceiptTemplate
  sale: SaleDetail
  /** 明细行（display-ready：主进程 formatMoney 组装——G1） */
  data: SaleReceiptData
  /** 变量插槽值（纯字符串） */
  vars: ReceiptVars
  /** Logo dataURL（未设置/读取失败 → null；Buffer 不跨 IPC） */
  logoUrl: string | null
}

export interface PrintingApi {
  printers: () => Promise<{ name: string; is_default: boolean }[]>
  testPrint: (req: PrintTestRequest) => Promise<{ ok: boolean; error?: string }>
  /** 小票预览（printing:preview）：ReceiptPreview 同源渲染（G7） */
  preview: (saleId: number) => Promise<PrintingPreviewResult>
  /** 小票打印（printing:print）：串行队列 best-effort；失败 { ok:false, error }（G3 不影响已保存销售） */
  print: (saleId: number) => Promise<{ ok: boolean; error?: string }>
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

/** 模板（Task 16）：config_json 为 shared/receipt ReceiptTemplate 的 JSON 序列化。 */
export interface TemplatesApi {
  list: () => Promise<PrintTemplate[]>
  create: (req: IpcChannels['templates:create']['req']) => Promise<PrintTemplate>
  update: (req: IpcChannels['templates:update']['req']) => Promise<PrintTemplate>
  delete: (id: number) => Promise<{ ok: true }>
  setDefault: (id: number) => Promise<PrintTemplate>
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
  templates: TemplatesApi
}

declare global {
  interface Window {
    api: PosApi
  }
}
