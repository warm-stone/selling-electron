/**
 * typed IPC 契约（G8：无裸 invoke 魔法字符串）。
 *
 * 仅定义通道名 → { req, res } 类型映射与 renderer 侧泛型封装签名，
 * **不含任何 IpcMain.handle 实现**（handler 由 main/ipc/* 后续任务装配，
 * preload 暴露底层 invoke，renderer 用 createTypedInvoke 包装）。
 * **零 Node/Electron 依赖**，两侧可 import。
 */

import type { PaperWidth } from '../receipt/char-grid'
import type { ReceiptTemplate } from '../receipt/template-schema'
import type {
  AppSettings,
  CheckoutItem,
  DailyReport,
  MonthlyReport,
  PrintTemplate,
  Product,
  ProductSn,
  ProductTracking,
  PurchaseInputItem,
  PurchaseOrderWithItems,
  Sale,
  SaleDetail,
  SaleStatus
} from './domain'

/**
 * IPC 通道类型表：channel → { req, res }。
 * req: void 表示无参通道（typedInvoke 调用时不传实参）。
 */
export interface IpcChannels {
  // ── 商品 ──
  'products:list': { req: { keyword?: string }; res: Product[] }
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
    }
    res: Product
  }
  'products:delete': { req: { id: number }; res: { ok: true } }
  /** 手动改库存（绝对目标值；service 内写 stock_movements source='manual'——G5） */
  'products:updateStock': { req: { id: number; stock: number }; res: Product }
  /** 按 SN 精查（仅 deleted=0；收银扫码第一优先级 D-SN5 + SN 弹窗校验共用） */
  'products:findSn': { req: { sn: string }; res: { sn: ProductSn; product: Product } | null }
  /** 商品 SN 列表（默认在库；include_sold 含已售，已售行带关联单号——D-SN16） */
  'products:listSns': { req: { product_id: number; include_sold: boolean }; res: ProductSn[] }
  /** 删在库 SN（逻辑删除 + stock-1 + movements source='manual'；已售拒绝——D-SN16） */
  'products:deleteSn': { req: { sn_id: number }; res: { ok: true } }

  // ── 销售 ──
  'sales:checkout': { req: { items: CheckoutItem[] }; res: Sale }
  /** 整单作废（事务回滚库存 + status='voided'——D3） */
  'sales:void': { req: { sale_id: number }; res: Sale }
  'sales:list': { req: { date_from?: string; date_to?: string; status?: SaleStatus }; res: Sale[] }
  'sales:detail': { req: { sale_id: number }; res: SaleDetail }

  // ── 进货 ──
  'purchases:create': { req: { note: string | null; items: PurchaseInputItem[] }; res: PurchaseOrderWithItems }
  'purchases:list': { req: { date_from?: string; date_to?: string }; res: PurchaseOrderWithItems[] }

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
  /** 预览（返回解析后的模板 + 销售明细，ReceiptPreview 同源渲染——G7） */
  'printing:preview': {
    req: { sale_id: number; template_id?: number }
    res: { template: ReceiptTemplate; sale: SaleDetail }
  }
  /** 打印（串行队列内 best-effort；失败不丢销售——G3） */
  'printing:print': {
    req: { sale_id: number; template_id?: number }
    res: { ok: boolean; error?: string }
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
}

/**
 * 全部 IPC 通道名（satisfies 编译期保证每个常量都是合法通道键，
 * 测试用它做 grep 断言；preload/renderer 组装时也用它枚举注册）。
 */
export const IPC_CHANNEL_NAMES = [
  'products:list',
  'products:create',
  'products:update',
  'products:delete',
  'products:updateStock',
  'products:findSn',
  'products:listSns',
  'products:deleteSn',
  'sales:checkout',
  'sales:void',
  'sales:list',
  'sales:detail',
  'purchases:create',
  'purchases:list',
  'reports:daily',
  'reports:monthly',
  'reports:export',
  'printing:printers',
  'printing:preview',
  'printing:print',
  'templates:list',
  'templates:create',
  'templates:update',
  'templates:delete',
  'templates:setDefault',
  'settings:get',
  'settings:set'
] as const satisfies readonly (keyof IpcChannels)[]

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
