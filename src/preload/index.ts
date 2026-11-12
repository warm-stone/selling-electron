import { contextBridge, ipcRenderer } from 'electron'
import type { DiagnosticReport, RepairActionId } from '../main/printing/diagnostics/schema'
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
  SaleDetail
} from '../shared/types'
import type { SaleReceiptData } from '../shared/receipt/item-columns'
import type { ReceiptTemplate, ReceiptVars } from '../shared/receipt/template-schema'

/**
 * 商品列表行：Product + 删除影响计数（契约 products:list res `Product[]`
 * 的运行时结构超集）。与 index.d.ts 的同名声明保持结构同步。
 */
interface ProductRow extends Product {
  willOrphan: number
}

/**
 * 小票预览结果（printing:preview res 的运行时结构超集——契约只声明
 * template+sale；与 index.d.ts 的同名声明保持结构同步）。
 */
interface PrintingPreviewResult {
  template: ReceiptTemplate
  sale: SaleDetail
  data: SaleReceiptData
  vars: ReceiptVars
  /** Logo dataURL 集合（logoId → dataURL；未引用/读取失败 → 无该 key） */
  logoUrls: Record<number, string>
}

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

  /**
   * 扫码枪条码订阅（主进程 before-input-event 检测桥推送，绕过 IME）。
   * 返回取消订阅函数（页面卸载时调用，防泄漏）。
   */
  onBarcode: (cb: (code: string) => void): (() => void) => {
    const listener = (_event: unknown, code: string): void => cb(code)
    ipcRenderer.on('scanner:barcode', listener)
    return () => ipcRenderer.removeListener('scanner:barcode', listener)
  },

  // ── 销售（Task 10：结账 + 作废 + 查询；Task 2 契约：附加信息）──
  sales: {
    /**
     * 结账（单事务：sales/sale_items/扣库存/movements；返回头+明细，金额整数分）。
     * extras 可选附加信息（客户/国补标记/订单备注/销售人员）——不传则不落 sale_extras 行。
     */
    checkout: (items: CheckoutItem[], extras?: CheckoutExtrasInput): Promise<SaleDetail> =>
      ipcRenderer.invoke('sales:checkout', { items, extras }),
    /** 整单作废（事务回滚库存 + status='voided'） */
    void: (saleId: number): Promise<Sale> =>
      ipcRenderer.invoke('sales:void', { sale_id: saleId }),
    /** 销售列表（按日期/状态/客户姓名/电话/国补过滤，最新在前；行含附加/客户平铺列） */
    list: (
      filters?: IpcChannels['sales:list']['req']
    ): Promise<IpcChannels['sales:list']['res']> =>
      ipcRenderer.invoke('sales:list', filters ?? {}),
    /** 单据明细（头 + items + extras） */
    detail: (saleId: number): Promise<SaleDetail> =>
      ipcRenderer.invoke('sales:detail', { sale_id: saleId }),
    /**
     * 修改销售附加信息（sale_extras 1:1 upsert；customer 传裸值由主进程
     * 建新/匹配）。返回更新后明细（头 + items + extras）。
     */
    updateExtra: (
      saleId: number,
      patch: Omit<IpcChannels['sales:updateExtra']['req'], 'sale_id'>
    ): Promise<SaleDetail> =>
      ipcRenderer.invoke('sales:updateExtra', { sale_id: saleId, ...patch })
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
  },

  // ── 商品（Task 8：CRUD + 搜索 + 手动库存调整流水）──
  products: {
    /** 商品列表；keyword 匹配名称子串/条码前缀，行含 willOrphan（删除影响计数） */
    list: (keyword?: string): Promise<ProductRow[]> =>
      ipcRenderer.invoke('products:list', { keyword }),
    /** 新建商品（金额整数分；初始库存非 0 时主进程写流水 source='manual'） */
    create: (req: {
      barcode: string | null
      name: string
      default_price_cents: number | null
      stock: number
      tracking: ProductTracking
      sn_prefix?: string
    }): Promise<Product> => ipcRenderer.invoke('products:create', req),
    /** 编辑名称/默认售价/SN 前缀（条码/tracking 不可改——契约 products:update 语义） */
    update: (req: {
      id: number
      name: string
      default_price_cents: number | null
      sn_prefix?: string
    }): Promise<Product> => ipcRenderer.invoke('products:update', req),
    /** 手动调整库存为绝对目标值（主进程写流水 source='manual'——G5） */
    updateStock: (req: { id: number; stock: number }): Promise<Product> =>
      ipcRenderer.invoke('products:updateStock', req),
    /** 逻辑删除（软删）商品；返回 willOrphan=删除时关联的历史单据行数 */
    delete: (id: number): Promise<{ ok: true; willOrphan: number }> =>
      ipcRenderer.invoke('products:delete', { id }),
    /** 按 SN 精查（收银扫码第一优先级 D-SN5；未命中/已删除返回 null） */
    findSn: (sn: string): Promise<{ sn: ProductSn; product: Product } | null> =>
      ipcRenderer.invoke('products:findSn', { sn }),
    /** 商品 SN 列表（默认在库；includeSold 含已售，已售行带关联单号） */
    listSns: (productId: number, includeSold: boolean): Promise<ProductSn[]> =>
      ipcRenderer.invoke('products:listSns', {
        product_id: productId,
        include_sold: includeSold
      }),
    /** 删在库 SN（逻辑删除 + stock-1 + manual 流水；已售拒绝） */
    deleteSn: (snId: number): Promise<{ ok: true }> =>
      ipcRenderer.invoke('products:deleteSn', { sn_id: snId })
  },

  // ── 客户（Task 2 契约层：结账客户信息——handler 由后续任务装配）──
  customers: {
    /** 分页搜索（keyword 匹配名称/电话；返回行 + 总数） */
    list: (
      opts?: IpcChannels['customers:list']['req']
    ): Promise<IpcChannels['customers:list']['res']> =>
      ipcRenderer.invoke('customers:list', opts ?? {}),
    /** 新建客户（phone NOT NULL UNIQUE；重号主进程报错） */
    create: (req: IpcChannels['customers:create']['req']): Promise<Customer> =>
      ipcRenderer.invoke('customers:create', req),
    /** 局部更新（patch 至少一键；返回更新后全行） */
    update: (
      id: number,
      patch: IpcChannels['customers:update']['req']['patch']
    ): Promise<Customer> => ipcRenderer.invoke('customers:update', { id, patch })
  },

  // ── 设置（Task 19：店铺信息 / 打印配置；多 Logo 架构）──
  settings: {
    /** 全量设置（缺 key 走默认值：通道 spooler、auto_cut true 等） */
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    /** 增量保存（Partial upsert，事务写入；返回保存后的全量设置） */
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:set', patch),
    /** Logo 列表（主进程读文件转 dataURL；文件缺失的行自动跳过） */
    listLogos: (): Promise<LogoInfo[]> => ipcRenderer.invoke('settings:listLogos'),
    /**
     * Logo 上传（主进程原生对话框选 png → 复制 userData/logos/<uuid>.png +
     * 入库）；用户取消时列表不变。返回完整最新列表。
     */
    uploadLogo: (): Promise<LogoInfo[]> => ipcRenderer.invoke('settings:uploadLogo'),
    /**
     * 删除 Logo（DB 行 + 文件；模板引用残留由渲染端跳过）。
     * 返回完整最新列表。
     */
    deleteLogo: (id: number): Promise<LogoInfo[]> =>
      ipcRenderer.invoke('settings:deleteLogo', { id }),
    /** 最近销售人员（recent_salespersons JSON 队列，新→旧；脏值主进程回落 []） */
    getRecentSalespersons: (): Promise<string[]> =>
      ipcRenderer.invoke('settings:getRecentSalespersons', {})
  },

  // ── 打印设置（Task 19：打印机枚举 + 测试打印）──
  // ── 打印（Task 19：打印机枚举 + 测试打印；Task 15：小票预览 + 打印）──
  printing: {
    /** 系统打印机列表（Linux/无窗口环境优雅降级为 []——G11） */
    printers: (): Promise<{ name: string; is_default: boolean }[]> =>
      ipcRenderer.invoke('printing:printers'),
    /**
     * 测试打印（真实生成链路：样例数据 + 当前默认模板 → ESC/POS 字节）。
     * req 为设置页当前打印表单值；走串行队列（PrintQueue），失败返回
     * { ok:false, error }（error 首段含通道名）。
     */
    testPrint: (req: {
      printer_channel: AppSettings['printer_channel']
      printer_name: string | null
      tcp_host: string | null
      tcp_port: number | null
      com_port: string | null
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('printing:testPrint', req),
    /**
     * 小票预览（Task 15）：返回模板/明细/vars/logoUrls——与打印字节同一组装
     * 源头（G7）。与 index.d.ts 的 PrintingPreviewResult 保持结构同步。
     */
    preview: (saleId: number): Promise<PrintingPreviewResult> =>
      ipcRenderer.invoke('printing:preview', { sale_id: saleId }),
    /**
     * 小票打印（Task 15）：串行队列 best-effort；失败返回 { ok:false, error }
     * （error 含通道名 + 重打引导）——销售已落库不受影响（G3）。
     */
    print: (saleId: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('printing:print', { sale_id: saleId }),
    /** 打印诊断（printer-diagnostics T1）：采集 → 规则 → 报告；printerName 聚焦单机 */
    diagnose: (
      printerName?: string
    ): Promise<IpcChannels['printing:diagnose']['res']> =>
      ipcRenderer.invoke('printing:diagnose', { printerName }),
    /** 执行修复动作（L1 自动 / L2 确认后执行）；verify 为动作后复核报告 */
    repair: (
      actionId: RepairActionId,
      targetPrinter?: string
    ): Promise<IpcChannels['printing:repair']['res']> =>
      ipcRenderer.invoke('printing:repair', { actionId, targetPrinter }),
    /** 导出诊断报告（主进程 showSaveDialog 后写文件；成功返回 filePath） */
    exportReport: (
      report: DiagnosticReport
    ): Promise<IpcChannels['printing:diagnoseExport']['res']> =>
      ipcRenderer.invoke('printing:diagnoseExport', { report })
  },

  // ── 模板（Task 16：小票模板 CRUD + 设默认；类型对齐 IpcChannels 契约防漂移）──
  templates: {
    /** 模板列表（按创建序；is_default 行为默认模板） */
    list: (): Promise<PrintTemplate[]> => ipcRenderer.invoke('templates:list'),
    /** 新建（config_json 为模板 JSON 字符串；首个模板自动成为默认） */
    create: (req: IpcChannels['templates:create']['req']): Promise<PrintTemplate> =>
      ipcRenderer.invoke('templates:create', req),
    /** 局部更新（name / config_json 至少其一） */
    update: (req: IpcChannels['templates:update']['req']): Promise<PrintTemplate> =>
      ipcRenderer.invoke('templates:update', req),
    /** 删除（唯一模板时主进程守卫抛错） */
    delete: (id: number): Promise<{ ok: true }> =>
      ipcRenderer.invoke('templates:delete', { id }),
    /** 设为默认（事务互斥：全表清零 → 目标置一） */
    setDefault: (id: number): Promise<PrintTemplate> =>
      ipcRenderer.invoke('templates:setDefault', { id })
  },

  // ── 报表（Task 14：日/月报查询；Task 17：导出 .txt/.xlsx/.docx）──
  reports: {
    /** 日报（剔除 voided；空数据日零值不抛错；明细行带 status 标记） */
    daily: (date: string): Promise<IpcChannels['reports:daily']['res']> =>
      ipcRenderer.invoke('reports:daily', { date }),
    /** 月报（剔除 voided；含按日分桶 buckets——空月为 []） */
    monthly: (month: string): Promise<IpcChannels['reports:monthly']['res']> =>
      ipcRenderer.invoke('reports:monthly', { month }),
    /**
     * 导出报表（主进程 showSaveDialog → 写文件 → 打开所在文件夹；
     * E2E_EXPORT_DIR 注入时直写固定目录——E2E 钩子）。
     * file_path null = 用户取消。
     */
    export: (
      req: IpcChannels['reports:export']['req']
    ): Promise<IpcChannels['reports:export']['res']> =>
      ipcRenderer.invoke('reports:export', req)
  }
}

contextBridge.exposeInMainWorld('api', api)
