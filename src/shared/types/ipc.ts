/**
 * typed IPC 契约（G8：无裸 invoke 魔法字符串）——**全应用 IPC 类型的唯一真源**。
 *
 * 三端全部锚定本文件，任何一端漂移都编译不过：
 * - main：ipc/* 经 typedHandle（main/ipc/typed-handle.ts）装配，listener 返回
 *   类型被 IpcChannels[K]['res'] 钉死——service 实际返回与契约不符即编译失败；
 * - preload：index.ts 的 `const api: PosApi` 以本文件的 PosApi 接口为注解，
 *   方法签名不再手写（index.d.ts 仅剩 Window 全局声明，无重复定义）；
 * - renderer：window.api（PosApi）与 createTypedInvoke（TypedInvoke）同源。
 *
 * 契约 = 运行时事实：res 一律按主进程 handler 的**实际返回**声明，禁止
 * 「契约声明子集 + 消费方 cast 结构超集」的漂移模式（历史教训：
 * sales:checkout 曾声明 Sale 实际 SaleDetail；printing:preview 曾只声明
 * template+sale，data/vars/logoUrls 靠三处手写镜像）。
 *
 * **零 Node/Electron 依赖**，两侧可 import（诊断类型来自同层
 * shared/printing/diagnostics-schema——依赖方向恒为「外层 → shared」）。
 */

import type {
  DiagnosticReport,
  RepairActionId,
  RepairOutcome
} from '../printing/diagnostics-schema'
import type { PaperWidth } from '../receipt/char-grid'
import type { SaleReceiptData } from '../receipt/item-columns'
import type { ReceiptTemplate, ReceiptVars } from '../receipt/template-schema'
import type {
  AppSettings,
  CheckoutCustomerInput,
  CheckoutExtrasInput,
  CheckoutItem,
  Customer,
  DailyReport,
  LogoInfo,
  MonthlyReport,
  PrintTemplate,
  PrintTestRequest,
  Product,
  ProductChangeLog,
  ProductRow,
  ProductSn,
  ProductTracking,
  PurchaseInputItem,
  PurchaseOrderWithItems,
  Sale,
  SaleDetail,
  SaleListItem,
  SaleStatus
} from './domain'

/**
 * 动作类通道的统一结果信封（printing:print / testPrint / rawProbe）：
 * ok=false 时 error 为面向用户的中文文案（含通道名 + 引导）。
 */
export interface PrintOperationResult {
  ok: boolean
  error?: string
}

/**
 * printing:preview res：预览载荷——与打印字节同一组装源头（G7）。
 * 主进程 print.service 的 PreviewPayload 即本类型的别名（单一真源）。
 */
export interface PrintPreviewPayload {
  template: ReceiptTemplate
  sale: SaleDetail
  /** 明细行（display-ready：主进程 formatMoney 组装——G1） */
  data: SaleReceiptData
  /** 变量插槽值（纯字符串） */
  vars: ReceiptVars
  /** Logo dataURL 集合（logoId → dataURL；未引用/读取失败 → 无该 key；Buffer 不跨 IPC） */
  logoUrls: Record<number, string>
}

/**
 * IPC 通道类型表：channel → { req, res }。
 * req: void 表示无参通道（typedInvoke 调用时不传实参）。
 */
export interface IpcChannels {
  // ── 商品 ──
  /** 列表行 = Product + willOrphan（删除影响计数——UI 删除弹窗文案数据源） */
  'products:list': { req: { keyword?: string }; res: ProductRow[] }
  'products:create': {
    req: {
      barcode: string | null
      name: string
      default_price_cents: number | null
      stock: number
      /** 计存类型（sn 时 stock 强制 0——service 侧） */
      tracking: ProductTracking
      /** SN 前缀（可空；仅进货侧匹配用——D-SN2） */
      sn_prefix?: string
    }
    res: Product
  }
  'products:update': {
    req: {
      id: number
      name: string
      default_price_cents: number | null
      /** SN 前缀可改（影响以后进货匹配）；tracking 不可改（D-SN1） */
      sn_prefix?: string
      /**
       * 批量计商品可同事务调库存（绝对目标值；与字段更新合并为一次保存
       * 一条改动记录）。SN 商品携带时静默忽略（D-SN11 禁手动调库）。
       */
      stock?: number
      /** 改动原因（必填非空；落 product_change_logs——审计留痕） */
      reason: string
    }
    res: Product
  }
  /** 逻辑删除；willOrphan = 删除时关联的历史单据行数（弹窗文案用）；reason 必填 */
  'products:delete': {
    req: { id: number; reason: string }
    res: { ok: true; willOrphan: number }
  }
  /** 手动改库存（绝对目标值；service 内写 stock_movements source='manual'——G5）；reason 必填 */
  'products:updateStock': {
    req: { id: number; stock: number; reason: string }
    res: Product
  }
  /** 按 SN 精查（仅 deleted=0；收银扫码第一优先级 D-SN5 + SN 弹窗校验共用） */
  'products:findSn': { req: { sn: string }; res: { sn: ProductSn; product: Product } | null }
  /** 商品 SN 列表（默认在库；include_sold 含已售，已售行带关联单号——D-SN16） */
  'products:listSns': { req: { product_id: number; include_sold: boolean }; res: ProductSn[] }
  /** 删在库 SN（逻辑删除 + stock-1 + movements source='manual'；已售拒绝——D-SN16）；reason 必填 */
  'products:deleteSn': { req: { sn_id: number; reason: string }; res: { ok: true } }
  /**
   * 商品改动记录（最新在前；limit 默认 100，只取最近 N 条不翻页——定案）。
   * 软删商品的记录仍可查（product_id FK 有效）。
   */
  'products:listChangeLogs': {
    req: { product_id: number; limit?: number }
    res: ProductChangeLog[]
  }

  // ── 客户 ──
  /** 分页搜索（keyword 匹配名称/电话；total 供分页条） */
  'customers:list': {
    req: { keyword?: string; limit?: number; offset?: number }
    res: { items: Customer[]; total: number }
  }
  /** 新建客户（phone NOT NULL UNIQUE，重号主进程报错） */
  'customers:create': {
    req: { name: string; phone: string; address: string; note: string }
    res: Customer
  }
  /** 局部更新（patch 至少一键；返回更新后全行） */
  'customers:update': {
    req: {
      id: number
      patch: { name?: string; phone?: string; address?: string; note?: string }
    }
    res: Customer
  }

  // ── 销售 ──
  /**
   * 结账（extras 可选——客户/国补标记/订单备注/销售人员；不传则不落 sale_extras 行）。
   * res 为完整明细（头 + items + extras）——收银成功页与预览弹窗直接消费，
   * 无需再发 sales:detail（契约旧版误声明 Sale，已按运行时事实修正）。
   */
  'sales:checkout': { req: { items: CheckoutItem[]; extras?: CheckoutExtrasInput }; res: SaleDetail }
  /** 整单作废（事务回滚库存 + status='voided'——D3） */
  'sales:void': { req: { sale_id: number }; res: Sale }
  /**
   * 销售记录列表：行含国补/销售人员/备注/客户姓名/电话平铺列（双 LEFT JOIN）；
   * 筛选键 trim 后空串 = 不过滤（service 层归一），is_national_subsidy
   * false 含无附加行旧单（与报表口径一致）。
   */
  'sales:list': {
    req: {
      date_from?: string
      date_to?: string
      status?: SaleStatus
      customer_name?: string
      customer_phone?: string
      is_national_subsidy?: boolean
    }
    res: SaleListItem[]
  }
  'sales:detail': { req: { sale_id: number }; res: SaleDetail }
  /** 修改销售附加信息（sale_extras 1:1 upsert；返回更新后明细 头+items+extras） */
  'sales:updateExtra': {
    req: {
      sale_id: number
      is_national_subsidy?: boolean
      order_note?: string
      salesperson?: string
      customer?: CheckoutCustomerInput | null
    }
    res: SaleDetail
  }

  // ── 进货 ──
  'purchases:create': { req: { note: string | null; items: PurchaseInputItem[] }; res: PurchaseOrderWithItems }
  'purchases:list': { req: { date_from?: string; date_to?: string }; res: PurchaseOrderWithItems[] }
  /**
   * 整单作废（单事务：SN 已售守卫先全扫拒绝 → 逐行冲减库存可为负 D2 +
   * movements source='purchase_void' → 头表 voided/时间/原因；不物理删除行——D3 哲学）。
   * reason 必填非空。
   */
  'purchases:void': {
    req: { order_id: number; reason: string }
    res: PurchaseOrderWithItems
  }

  // ── 报表 ──
  'reports:daily': { req: { date: string }; res: DailyReport }
  'reports:monthly': { req: { month: string }; res: MonthlyReport }
  /** 导出（主进程 showSaveDialog 后写文件；file_path null = 用户取消） */
  'reports:export': {
    req: { kind: 'daily' | 'monthly'; period: string; format: 'txt' | 'xlsx' | 'docx' }
    res: { file_path: string | null }
  }

  // ── 打印 ──
  'printing:printers': { req: void; res: { name: string; is_default: boolean }[] }
  /**
   * 测试打印（真实生成链路：样例数据 + 当前默认模板 → 通道载荷；走串行队列）。
   * req 为设置页「打印设置」卡片当前表单值（AppSettings 打印子集）。
   */
  'printing:testPrint': { req: PrintTestRequest; res: PrintOperationResult }
  /**
   * RAW 编码探针（F1）：一张纸按顺序打多段编码假设，纸上结果决定系统打印
   * 通道能不能修好中文；driver 通道后端直接拒（把字节当 HTML 渲染无意义）。
   */
  'printing:rawProbe': { req: PrintTestRequest; res: PrintOperationResult }
  /** 预览（与打印字节同一组装源头——G7；ReceiptPreview 同源渲染） */
  'printing:preview': {
    req: { sale_id: number; template_id?: number }
    res: PrintPreviewPayload
  }
  /** 打印（串行队列内 best-effort；失败不丢销售——G3） */
  'printing:print': {
    req: { sale_id: number; template_id?: number }
    res: PrintOperationResult
  }
  /**
   * 打印诊断（printer-diagnostics T1）：采集系统/打印机/app 快照 → 规则引擎
   * → 诊断报告。printerName 可选（聚焦单机）。动作类通道沿用 { ok, error } 信封；
   * 采集部分失败时 ok 仍可为 true（细节在 report.snapshot.errors）。
   */
  'printing:diagnose': {
    req: { printerName?: string }
    res: { ok: boolean; error?: string; report?: DiagnosticReport }
  }
  /**
   * 执行修复动作（L1 自动 / L2 需确认；targetPrinter 为 printer scope 动作的
   * 归属机）。verify 为动作后复核报告；outcome 为执行结果（renderer 按
   * status 分支引导文案——旧版契约缺失本字段，靠消费方手写镜像，已修正）。
   */
  'printing:repair': {
    req: { actionId: RepairActionId; targetPrinter?: string }
    res: { ok: boolean; error?: string; verify?: DiagnosticReport; outcome?: RepairOutcome }
  }
  /** 导出诊断报告（主进程 showSaveDialog 后写文件；成功返回 filePath，取消时无） */
  'printing:diagnoseExport': {
    req: { report: DiagnosticReport }
    res: { ok: boolean; filePath?: string; error?: string }
  }

  // ── 模板 ──
  'templates:list': { req: void; res: PrintTemplate[] }
  'templates:create': {
    req: { name: string; paper_width: PaperWidth; config_json: string }
    res: PrintTemplate
  }
  'templates:update': { req: { id: number; name?: string; config_json?: string }; res: PrintTemplate }
  'templates:delete': { req: { id: number }; res: { ok: true } }
  'templates:setDefault': { req: { id: number }; res: PrintTemplate }

  // ── 设置 ──
  'settings:get': { req: void; res: AppSettings }
  'settings:set': { req: Partial<AppSettings>; res: AppSettings }
  /** Logo 列表（主进程读文件转 dataURL；文件缺失的行自动跳过） */
  'settings:listLogos': { req: void; res: LogoInfo[] }
  /** Logo 上传（原生对话框选 png → 复制 userData/logos/<uuid>.png + 入库；取消 → 列表不变） */
  'settings:uploadLogo': { req: void; res: LogoInfo[] }
  /** Logo 删除（DB 行 + 文件；模板引用残留由渲染端跳过）；返回完整最新列表 */
  'settings:deleteLogo': { req: { id: number }; res: LogoInfo[] }
  /** 最近销售人员（settings key recent_salespersons 的 JSON 队列，新→旧；脏值回落 []） */
  'settings:getRecentSalespersons': { req: Record<string, never>; res: string[] }
}

/** 契约 req 便捷别名（void 通道 = 无请求体） */
export type IpcReq<K extends keyof IpcChannels> = IpcChannels[K]['req']

/** 契约 res 便捷别名 */
export type IpcRes<K extends keyof IpcChannels> = IpcChannels[K]['res']

/**
 * renderer 侧 typedInvoke 泛型封装签名（G8 类型化 IPC surface）。
 * - req 非 void 通道：`typedInvoke('products:list', { keyword: '可乐' })`
 * - req 为 void 通道：`typedInvoke('settings:get')`（不传实参）
 * 返回值按通道 res 类型收窄。
 */
export type TypedInvoke = <K extends keyof IpcChannels>(
  channel: K,
  ...args: IpcChannels[K]['req'] extends void ? [] : [IpcChannels[K]['req']]
) => Promise<IpcChannels[K]['res']>

/**
 * 用底层 invoke（preload 暴露的裸 invoke：`(channel, request?) => Promise<unknown>`）
 * 构造类型化封装。纯函数转发，运行时零额外逻辑——类型安全由
 * TypedInvoke 签名在编译期保证。
 */
export function createTypedInvoke(
  invoke: (channel: string, request?: unknown) => Promise<unknown>
): TypedInvoke {
  const typed = (channel: string, request?: unknown): Promise<unknown> => invoke(channel, request)
  return typed as TypedInvoke
}

/**
 * preload 暴露给 renderer 的类型化 API surface（window.api 的类型）。
 *
 * 单一真源：所有 req/res 均从 IpcChannels 派生（IpcReq/IpcRes），本接口只
 * 定义「便捷参数 → 通道请求体」的整形规则（如 checkout(items, extras) →
 * { items, extras }、preview(saleId) → { sale_id }）。preload/index.ts 以
 * `const api: PosApi` 实现本接口，index.d.ts 仅做 Window 全局声明——
 * 契约、实现、renderer 类型三方同源，手写镜像全部废除。
 */
export interface PosApi {
  /** 存活探针（E2E/单测桥接就绪断言用；不过 IPC） */
  ping: () => string
  /** 底层类型化 IPC 入口：经 createTypedInvoke 包装后按契约调用（G8） */
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
  /** 扫码枪条码订阅（主进程 before-input-event 检测桥推送）；返回取消订阅函数 */
  onBarcode: (cb: (code: string) => void) => () => void

  sales: {
    /** 结账（单事务落库；返回完整明细 头+items+extras） */
    checkout: (
      items: CheckoutItem[],
      extras?: CheckoutExtrasInput
    ) => Promise<IpcRes<'sales:checkout'>>
    /** 整单作废（事务回滚库存 + status='voided'） */
    void: (saleId: number) => Promise<IpcRes<'sales:void'>>
    /** 销售列表（日期/状态/客户/国补过滤，最新在前） */
    list: (filters?: IpcReq<'sales:list'>) => Promise<IpcRes<'sales:list'>>
    /** 单据明细（头 + items + extras） */
    detail: (saleId: number) => Promise<IpcRes<'sales:detail'>>
    /** 修改销售附加信息（customer 传 null = 显式解绑） */
    updateExtra: (
      saleId: number,
      patch: Omit<IpcReq<'sales:updateExtra'>, 'sale_id'>
    ) => Promise<IpcRes<'sales:updateExtra'>>
  }

  purchases: {
    /** 新建进货单（单事务：单据+快照明细+库存累加+流水） */
    create: (req: IpcReq<'purchases:create'>) => Promise<IpcRes<'purchases:create'>>
    /** 进货单列表（头+明细，最新在前；可选日期过滤） */
    list: (filters?: IpcReq<'purchases:list'>) => Promise<IpcRes<'purchases:list'>>
    /** 整单作废（reason 必填；返回作废后单据——含 status/voided_at/void_reason） */
    void: (orderId: number, reason: string) => Promise<IpcRes<'purchases:void'>>
  }

  products: {
    /** 商品列表；keyword 匹配名称子串/条码前缀（行含 willOrphan） */
    list: (keyword?: string) => Promise<IpcRes<'products:list'>>
    create: (req: IpcReq<'products:create'>) => Promise<IpcRes<'products:create'>>
    update: (req: IpcReq<'products:update'>) => Promise<IpcRes<'products:update'>>
    /** 手动调整库存为绝对目标值（主进程写流水 source='manual'——G5；reason 必填） */
    updateStock: (req: IpcReq<'products:updateStock'>) => Promise<IpcRes<'products:updateStock'>>
    /** 逻辑删除（软删）商品（reason 必填，落改动记录） */
    delete: (id: number, reason: string) => Promise<IpcRes<'products:delete'>>
    /** 按 SN 精查（收银扫码第一优先级 D-SN5；未命中/已删除返回 null） */
    findSn: (sn: string) => Promise<IpcRes<'products:findSn'>>
    /** 商品 SN 列表（默认在库；includeSold 含已售，已售行带关联单号） */
    listSns: (productId: number, includeSold: boolean) => Promise<IpcRes<'products:listSns'>>
    /** 删在库 SN（逻辑删除 + stock-1 + manual 流水；已售拒绝；reason 必填） */
    deleteSn: (snId: number, reason: string) => Promise<IpcRes<'products:deleteSn'>>
    /** 商品改动记录（最新在前；limit 默认 100=仅最近 N 条） */
    listChangeLogs: (productId: number, limit?: number) => Promise<IpcRes<'products:listChangeLogs'>>
  }

  customers: {
    /** 分页搜索（keyword 匹配名称/电话；返回行 + 总数） */
    list: (opts?: IpcReq<'customers:list'>) => Promise<IpcRes<'customers:list'>>
    /** 新建客户（phone NOT NULL UNIQUE；重号主进程报错） */
    create: (req: IpcReq<'customers:create'>) => Promise<IpcRes<'customers:create'>>
    /** 局部更新（patch 至少一键；返回更新后全行） */
    update: (
      id: number,
      patch: IpcReq<'customers:update'>['patch']
    ) => Promise<IpcRes<'customers:update'>>
  }

  settings: {
    /** 全量设置（缺 key 走默认值） */
    get: () => Promise<IpcRes<'settings:get'>>
    /** 增量保存（Partial upsert，事务写入；返回保存后的全量设置） */
    set: (patch: Partial<AppSettings>) => Promise<IpcRes<'settings:set'>>
    /** Logo 列表 */
    listLogos: () => Promise<IpcRes<'settings:listLogos'>>
    /** Logo 上传（原生对话框；取消时列表不变） */
    uploadLogo: () => Promise<IpcRes<'settings:uploadLogo'>>
    /** Logo 删除（DB 行 + 文件）；返回完整最新列表 */
    deleteLogo: (id: number) => Promise<IpcRes<'settings:deleteLogo'>>
    /** 最近销售人员（新→旧） */
    getRecentSalespersons: () => Promise<IpcRes<'settings:getRecentSalespersons'>>
  }

  printing: {
    /** 系统打印机列表（Linux/无窗口环境优雅降级为 []——G11） */
    printers: () => Promise<IpcRes<'printing:printers'>>
    /** 测试打印（真实生成链路；走串行队列） */
    testPrint: (req: IpcReq<'printing:testPrint'>) => Promise<IpcRes<'printing:testPrint'>>
    /** RAW 编码探针（driver 通道后端直接拒） */
    rawProbe: (req: IpcReq<'printing:rawProbe'>) => Promise<IpcRes<'printing:rawProbe'>>
    /** 小票预览（与打印字节同一组装源头——G7） */
    preview: (saleId: number) => Promise<IpcRes<'printing:preview'>>
    /** 小票打印（失败不影响已保存销售——G3） */
    print: (saleId: number) => Promise<IpcRes<'printing:print'>>
    /** 打印诊断（采集 → 规则 → 报告；printerName 聚焦单机） */
    diagnose: (printerName?: string) => Promise<IpcRes<'printing:diagnose'>>
    /** 执行修复动作（L1 自动 / L2 确认后执行） */
    repair: (
      actionId: RepairActionId,
      targetPrinter?: string
    ) => Promise<IpcRes<'printing:repair'>>
    /** 导出诊断报告（主进程选路径写文件） */
    exportReport: (report: DiagnosticReport) => Promise<IpcRes<'printing:diagnoseExport'>>
  }

  templates: {
    /** 模板列表（按创建序；is_default 行为默认模板） */
    list: () => Promise<IpcRes<'templates:list'>>
    /** 新建（config_json 为模板 JSON 字符串；首个模板自动成为默认） */
    create: (req: IpcReq<'templates:create'>) => Promise<IpcRes<'templates:create'>>
    /** 局部更新（name / config_json 至少其一） */
    update: (req: IpcReq<'templates:update'>) => Promise<IpcRes<'templates:update'>>
    /** 删除（唯一模板时主进程守卫抛错） */
    delete: (id: number) => Promise<IpcRes<'templates:delete'>>
    /** 设为默认（事务互斥：全表清零 → 目标置一） */
    setDefault: (id: number) => Promise<IpcRes<'templates:setDefault'>>
  }

  reports: {
    /** 日报（剔除 voided；空数据日零值不抛错） */
    daily: (date: string) => Promise<IpcRes<'reports:daily'>>
    /** 月报（剔除 voided；含按日分桶 buckets——空月为 []） */
    monthly: (month: string) => Promise<IpcRes<'reports:monthly'>>
    /** 导出报表（file_path null = 用户取消） */
    export: (req: IpcReq<'reports:export'>) => Promise<IpcRes<'reports:export'>>
  }
}
