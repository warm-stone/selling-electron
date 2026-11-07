import type {
  AppSettings,
  CheckoutExtrasInput,
  CheckoutItem,
  Customer,
  IpcChannels,
  LogoInfo,
  PrintTemplate,
  Product,
  ProductSn,
  ProductTracking,
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
  /** 结账（extras 可选——客户/国补标记/订单备注/销售人员；不传不落 sale_extras 行） */
  checkout: (items: CheckoutItem[], extras?: CheckoutExtrasInput) => Promise<SaleDetail>
  void: (saleId: number) => Promise<Sale>
  list: (filters?: {
    date_from?: string
    date_to?: string
    status?: SaleStatus
  }) => Promise<Sale[]>
  /** 单据明细（头 + items + extras） */
  detail: (saleId: number) => Promise<SaleDetail>
  /** 修改销售附加信息（sale_extras 1:1 upsert；返回更新后明细 头+items+extras） */
  updateExtra: (
    saleId: number,
    patch: Omit<IpcChannels['sales:updateExtra']['req'], 'sale_id'>
  ) => Promise<SaleDetail>
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
    tracking: ProductTracking
    sn_prefix?: string
  }) => Promise<Product>
  update: (req: {
    id: number
    name: string
    default_price_cents: number | null
    sn_prefix?: string
  }) => Promise<Product>
  updateStock: (req: { id: number; stock: number }) => Promise<Product>
  delete: (id: number) => Promise<{ ok: true; willOrphan: number }>
  /** 按 SN 精查（收银扫码第一优先级 D-SN5；未命中/已删除返回 null） */
  findSn: (sn: string) => Promise<{ sn: ProductSn; product: Product } | null>
  /** 商品 SN 列表（默认在库；includeSold 含已售，已售行带关联单号） */
  listSns: (productId: number, includeSold: boolean) => Promise<ProductSn[]>
  /** 删在库 SN（逻辑删除 + stock-1 + manual 流水；已售拒绝） */
  deleteSn: (snId: number) => Promise<{ ok: true }>
}

/** 客户（Task 2 契约层）：通道 customers:list/create/update。 */
export interface CustomersApi {
  /** 分页搜索（keyword 匹配名称/电话；返回行 + 总数） */
  list: (
    opts?: IpcChannels['customers:list']['req']
  ) => Promise<IpcChannels['customers:list']['res']>
  /** 新建客户（phone NOT NULL UNIQUE；重号主进程报错） */
  create: (req: IpcChannels['customers:create']['req']) => Promise<Customer>
  /** 局部更新（patch 至少一键；返回更新后全行） */
  update: (id: number, patch: IpcChannels['customers:update']['req']['patch']) => Promise<Customer>
}

export interface SettingsApi {
  get: () => Promise<AppSettings>
  set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  /** Logo 列表（主进程读文件转 dataURL；文件缺失的行自动跳过） */
  listLogos: () => Promise<LogoInfo[]>
  /** Logo 上传（原生对话框选 png → 复制 userData/logos/<uuid>.png + 入库）；取消时列表不变 */
  uploadLogo: () => Promise<LogoInfo[]>
  /** 删除 Logo（DB 行 + 文件；模板引用残留由渲染端跳过）；返回完整最新列表 */
  deleteLogo: (id: number) => Promise<LogoInfo[]>
  /** 最近销售人员（recent_salespersons JSON 队列，新→旧；脏值主进程回落 []） */
  getRecentSalespersons: () => Promise<string[]>
}

/** 测试打印请求：AppSettings 的打印子集（设置页「打印设置」卡片当前表单值） */
export type PrintTestRequest = Pick<
  AppSettings,
  'printer_channel' | 'printer_name' | 'tcp_host' | 'tcp_port' | 'com_port'
>

/**
 * 小票预览结果（Task 15）：printing:preview res 的运行时结构超集——
 * T3 契约只声明 template+sale，data/vars/logoUrls 为主进程 PreviewPayload
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
  /** Logo dataURL 集合（logoId → dataURL；未引用/读取失败 → 无该 key；Buffer 不跨 IPC） */
  logoUrls: Record<number, string>
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
  customers: CustomersApi
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
