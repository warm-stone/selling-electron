import { contextBridge, ipcRenderer } from 'electron'
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

/**
 * 商品列表行：Product + 删除影响计数（契约 products:list res `Product[]`
 * 的运行时结构超集）。与 index.d.ts 的同名声明保持结构同步。
 */
interface ProductRow extends Product {
  willOrphan: number
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
    }): Promise<Product> => ipcRenderer.invoke('products:create', req),
    /** 编辑名称/默认售价（条码不可改——契约 products:update 语义） */
    update: (req: {
      id: number
      name: string
      default_price_cents: number | null
    }): Promise<Product> => ipcRenderer.invoke('products:update', req),
    /** 手动调整库存为绝对目标值（主进程写流水 source='manual'——G5） */
    updateStock: (req: { id: number; stock: number }): Promise<Product> =>
      ipcRenderer.invoke('products:updateStock', req),
    /** 硬删商品；返回 willOrphan=删除时关联的历史单据行数 */
    delete: (id: number): Promise<{ ok: true; willOrphan: number }> =>
      ipcRenderer.invoke('products:delete', { id })
  },

  // ── 设置（Task 19：店铺信息 / 打印配置 / Logo）──
  settings: {
    /** 全量设置（缺 key 走默认值：通道 spooler、auto_cut true 等） */
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    /** 增量保存（Partial upsert，事务写入；返回保存后的全量设置） */
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:set', patch),
    /** Logo 上传（主进程原生对话框选 png → 复制 userData/logos/logo.png）；取消时原值不变 */
    uploadLogo: (): Promise<{ logo_path: string | null }> =>
      ipcRenderer.invoke('settings:uploadLogo'),
    /** Logo 缩略图数据源（主进程读文件转 dataURL；未设置/文件缺失返回 null） */
    getLogoDataUrl: (): Promise<{ data_url: string | null }> =>
      ipcRenderer.invoke('settings:getLogoDataUrl')
  },

  // ── 打印设置（Task 19：打印机枚举 + 测试打印）──
  printing: {
    /** 系统打印机列表（Linux/无窗口环境优雅降级为 []——G11） */
    printers: (): Promise<{ name: string; is_default: boolean }[]> =>
      ipcRenderer.invoke('printing:printers'),
    /**
     * 测试打印（发送最小 ESC/POS 字节：init + 居中 test + 全切）。
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
      ipcRenderer.invoke('printing:testPrint', req)
  },

  // ── 报表（Task 17：导出 .txt/.xlsx/.docx；T14 将追加 daily/monthly 查询）──
  reports: {
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
