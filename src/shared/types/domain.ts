/**
 * 领域 DTO 全集（主/渲染两侧共享的数据契约）。
 *
 * 字段命名与 ER schema 列名一一对应（snake_case，如
 * SaleItem.product_name ↔ sale_items.product_name 快照列——G4），
 * 便于 repository 行映射零翻译。
 * 铁律 G1：金额一律整数分 `*_cents: number`，数量一律整数，
 * 元单位浮点只存在于 UI/导出层的边界格式化。
 */

import type { PaperWidth } from '../receipt/char-grid'

// ══════════════ 商品 ══════════════

/**
 * 商品计存类型（products.tracking——D-SN1）：
 * - 'quantity' 批量计商品（原逻辑：stock 整数计数）
 * - 'sn' SN 商品（一物一码，逐个录 SN；建后不可互转）
 */
export type ProductTracking = 'quantity' | 'sn'

/** 商品（products 表；允许负库存——D2） */
export interface Product {
  id: number
  /** UNIQUE + nullable（D17：无条码商品靠搜索加购） */
  barcode: string | null
  name: string
  /** 默认售价（分）；nullable——购物车自动带出可改 */
  default_price_cents: number | null
  /** 允许负数（D2：UI 负库存标红）；SN 商品=在库 SN 数冗余汇总（D-SN13） */
  stock: number
  /** 计存类型（建后不可改——D-SN1） */
  tracking: ProductTracking
  /** SN 前缀（空串=无前缀；仅进货侧扫 SN 自动匹配商品用——D-SN2） */
  sn_prefix: string
  created_at: string
  updated_at: string
}

/**
 * 购物车行（renderer 侧内存结构，不落库——D21）。
 * 重复扫码合并行规则（D16）：行 key = product_id + unit_price_cents。
 */
export interface CartItem {
  product_id: number
  name: string
  barcode: string | null
  quantity: number
  unit_price_cents: number
  /** SN 行标识；批量计行 null（SN 行 quantity 恒 1、禁合并——D-SN7） */
  sn: string | null
}

// ══════════════ 销售 ══════════════

/** 销售单状态（sales.status） */
export type SaleStatus = 'completed' | 'voided'

/** 销售单头（sales 表） */
export interface Sale {
  id: number
  /** yyyyMMdd-NNNN（D18 按日序列） */
  sale_no: string
  total_cents: number
  item_count: number
  status: SaleStatus
  voided_at: string | null
  created_at: string
}

/** 销售明细行（sale_items 表；含商品快照，product_id nullable——G4） */
export interface SaleItem {
  id: number
  sale_id: number
  product_id: number | null
  product_name: string
  barcode: string | null
  quantity: number
  unit_price_cents: number
  subtotal_cents: number
  /** SN 快照（D-SN12 小票/明细展示）；批量计行 null */
  sn: string | null
}

/** 销售单明细（头 + 行 + 附加信息，sales:detail / sales:updateExtra / printing:preview 消费） */
export interface SaleDetail extends Sale {
  items: SaleItem[]
  /**
   * 附加信息（sale_extras 旁挂行 + 平铺 customer，见下方 SaleExtraInfo）。
   * 旧单（迁移前/无附加行）整体为 null——禁止空对象冒充。
   */
  extras: SaleExtraInfo | null
}

/** 结账请求行（购物车行 → service 内查快照落库） */
export interface CheckoutItem {
  product_id: number
  /** SN 行恒 1（service 校验——D-SN7） */
  quantity: number
  unit_price_cents: number
  /** SN 行必填非空（service 校验）；批量计行 null */
  sn: string | null
}

// ══════════════ 客户与订单附加信息 ══════════════

/**
 * 客户（customers 表——005 迁移，7 列一一对应）。
 * phone NOT NULL UNIQUE：散客空串占位只可插一行（二插 UNIQUE 报错，repo 侧防）。
 */
export interface Customer {
  id: number
  name: string
  phone: string
  address: string
  note: string
  created_at: string
  updated_at: string
}

/**
 * 结账客户信息输入（sales:checkout extras.customer / sales:updateExtra
 * customer 的裸值形状；建新/匹配已有客户由 service 决定）。
 */
export interface CheckoutCustomerInput {
  name: string
  phone: string
  address: string
  note: string
}

/**
 * 结账附加信息（sales:checkout req.extras；整体可选——不传则不落 sale_extras 行）。
 * 字段与 sale_extras 列对应；salesperson 另写 settings 的
 * recent_salespersons 最近输入队列（定案：不进 AppSettings 白名单）。
 */
export interface CheckoutExtrasInput {
  customer?: CheckoutCustomerInput | null
  /** 国补标记（sale_extras.is_national_subsidy，SQLite INTEGER 0/1 → 布尔） */
  is_national_subsidy?: boolean
  /** 订单备注（sale_extras.order_note） */
  order_note?: string
  /** 销售人员（sale_extras.salesperson） */
  salesperson?: string
}

/**
 * 销售附加信息（sale_extras 行 + LEFT JOIN customers 平铺 customer）。
 * sale_extras.sale_id 兼 PRIMARY KEY（1:1 旁挂，同单天然至多一行）。
 */
export interface SaleExtraInfo {
  sale_id: number
  customer_id: number | null
  is_national_subsidy: boolean
  order_note: string | null
  salesperson: string | null
  /** customer_id 非空时关联行；无关联客户为 null */
  customer: Customer | null
}

/**
 * 日报明细行销售头（reports:daily 专用）：Sale + sale_extras 平铺列。
 * 不并入 Sale 本体——sales:list / printing 等消费方零波及（Sale 接口铁律不动）。
 */
export interface SaleWithExtras extends Sale {
  is_national_subsidy: boolean
  order_note: string | null
}

// ══════════════ 进货 ══════════════

/** 进货单头（purchase_orders 表） */
export interface PurchaseOrder {
  id: number
  /** yyyyMMdd-NNNN（D18，与销售独立日序列） */
  order_no: string
  note: string | null
  created_at: string
}

/** 进货明细行（purchase_items 表；含商品快照——G4） */
export interface PurchaseItem {
  id: number
  order_id: number
  product_id: number | null
  product_name: string
  barcode: string | null
  quantity: number
  cost_price_cents: number
  /** SN 快照（SN 行每 SN 一行、quantity=1——D-SN10）；批量计行 null */
  sn: string | null
}

/** 进货单明细（头 + 行） */
export interface PurchaseOrderWithItems extends PurchaseOrder {
  items: PurchaseItem[]
}

/**
 * 进货入库请求行（联合类型——D-SN9/10）：
 * - quantity 批量计行（原逻辑）
 * - sn 行：sns 逐个录入，落库展开为每 SN 一行独立 cost_price_cents（值相同）
 */
export type PurchaseInputItem =
  | { kind: 'quantity'; product_id: number; quantity: number; cost_price_cents: number }
  | { kind: 'sn'; product_id: number; sns: string[]; cost_price_cents: number }

/**
 * SN 台账行（商品管理 SN 浏览 / findSn 用——D-SN16）。
 * 已售行带关联销售单号（listSns JOIN sale_items 取，跳转用）；在库为 null。
 */
export interface ProductSn {
  id: number
  product_id: number
  sn: string
  status: 'in_stock' | 'sold'
  sale_id: number | null
  sale_no: string | null
  created_at: string
}

// ══════════════ 库存流水 ══════════════

/** 流水来源（stock_movements.source CHECK 约束） */
export type StockMovementSource = 'sale' | 'purchase' | 'manual' | 'void'

/** 库存流水（stock_movements 表；审计链全覆盖——G5） */
export interface StockMovement {
  id: number
  product_id: number
  /** 正=入库 负=出库 */
  change_qty: number
  before_stock: number
  after_stock: number
  source: StockMovementSource
  /** sale_id / purchase order_id / null(manual) */
  source_id: number | null
  created_at: string
}

// ══════════════ 报表 ══════════════

/** 日报（剔除 voided——D3；date=业务日 yyyy-MM-dd） */
export interface DailyReport {
  date: string
  total_cents: number
  order_count: number
  /** 当日国补单合计（is_national_subsidy=1 单的 total_cents 之和；无国补单为 0） */
  subsidy_total_cents: number
  /** 当日销售详细记录（含国补标记/订单备注平铺列——日报明细行展示用） */
  sales: SaleWithExtras[]
}

/** 月报按日分桶行（date=yyyy-MM-dd；T14 上提 shared，结构与导出层历史 MonthlyBucket 逐字段一致） */
export interface DailyBucket {
  date: string
  total_cents: number
  order_count: number
}

/** 月报（剔除 voided；month=yyyy-MM） */
export interface MonthlyReport {
  month: string
  total_cents: number
  order_count: number
  /** 按日分桶（SQL strftime 分桶；仅含有销售的日；空月为 []——T14 补齐 T3 契约缺口） */
  buckets: DailyBucket[]
}

// ══════════════ 打印模板 ══════════════

/** 打印模板元数据（print_templates 表；config_json 反序列化后即 shared/receipt ReceiptTemplate） */
export interface PrintTemplate {
  id: number
  name: string
  paper_width: PaperWidth
  /** 模板 JSON 字符串（结构见 shared/receipt/template-schema） */
  config_json: string
  /** DB INTEGER 0/1 → 布尔映射 */
  is_default: boolean
  created_at: string
  updated_at: string
}

// ══════════════ 系统设置 ══════════════

/** 打印通道（settings.printer_channel；spooler 主 / tcp 辅 / 串口备——D5） */
export type PrinterChannel = 'spooler' | 'tcp' | 'serial'

/** 应用设置（settings key-value 行 → 对象映射；settings:get/set 消费） */
export interface AppSettings {
  shop_name: string
  shop_phone: string
  receipt_note: string
  printer_channel: PrinterChannel
  printer_name: string | null
  tcp_host: string | null
  tcp_port: number | null
  com_port: string | null
  auto_cut: boolean
}

// ══════════════ Logo（多 Logo 架构） ══════════════

/**
 * Logo 信息（settings:listLogos / uploadLogo / deleteLogo 返回行）。
 * data_url 由主进程读 logos 目录文件转 dataURL（MIME 固定 image/png——
 * 上传已限定；renderer 无任意文件读权限）；文件缺失的行被跳过。
 */
export interface LogoInfo {
  id: number
  display_name: string
  /** PNG dataURL（data:image/png;base64,...） */
  data_url: string
}
