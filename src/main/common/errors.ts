/**
 * main 进程业务错误（P1-2 分层修复：从各 service 下沉到 common）。
 *
 * 为什么住这里而不是 service 文件内：purchase.repo 的事务内检查需要抛
 * PurchaseServiceError（kill-point 全回滚语义），错误类若定义在 service 层，
 * repo → service 的 import 会构成运行时循环依赖（service 又 import repo）。
 * 错误类是「跨层共享的领域词汇」，放 common 层打断环（db → common ← services）。
 *
 * 为什么不放 src/shared：错误实例从不跨 IPC 边界——ipcMain.handle 已把
 * rejection 序列化成 message 字符串，renderer 只消费文案；shared 只放
 * 双侧真实 import 的跨进程契约（omo 评估裁决 1）。
 *
 * ★ 纯移动约定：5 个类的 code 类型、message 文案、name 与下沉前逐字一致
 *   （message 直达 renderer 展示、code 被既有测试断言——不得改写/合并）。
 */

// ════════════════ customer ════════════════

/** service 错误码（IPC 层透传 message 给 renderer） */
export type CustomerErrorCode =
  | 'CUSTOMER_PHONE_REQUIRED'
  | 'CUSTOMER_PHONE_INVALID'
  | 'CUSTOMER_PHONE_EXISTS'
  | 'CUSTOMER_NOT_FOUND'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class CustomerServiceError extends Error {
  constructor(readonly code: CustomerErrorCode, message: string) {
    super(message)
    this.name = 'CustomerServiceError'
  }
}

// ════════════════ product ════════════════

/** service 错误码（IPC 层透传 message 给 renderer；测试断言 code） */
export type ProductErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_PRICE'
  | 'INVALID_STOCK'
  | 'INVALID_TRACKING'
  | 'INVALID_SN_PREFIX'
  | 'BARCODE_CONFLICT'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_SN_PREFIX_CONFLICT'
  | 'PRODUCT_SN_HAS_STOCK'
  | 'PRODUCT_SN_NO_MANUAL_STOCK'
  | 'PRODUCT_SN_NOT_DELETABLE'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class ProductServiceError extends Error {
  constructor(readonly code: ProductErrorCode, message: string) {
    super(message)
    this.name = 'ProductServiceError'
  }
}

// ════════════════ purchase ════════════════

/** service 错误码（IPC 层透传 message 给 renderer；repo 事务内抛出同款——见 purchase.repo） */
export type PurchaseErrorCode =
  | 'PURCHASE_INVALID_ITEM' // 行结构非法（数量/成本价/SN 结构等，message 指明字段）
  | 'PURCHASE_SN_DUP_IN_ORDER' // 本单内 SN 重复（跨所有 sn 行收集后统一判重）
  | 'PURCHASE_TYPE_MISMATCH' // 行类型与商品 tracking 不符（D-SN9）
  | 'PURCHASE_SN_EXISTS' // SN 已在库 / 已售（事务内台账检查——D-SN4/17）
  | 'PRODUCT_NOT_FOUND' // 商品不存在（事务内）
  | 'PURCHASE_NOT_FOUND' // 进货单不存在（getDetail）

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class PurchaseServiceError extends Error {
  constructor(readonly code: PurchaseErrorCode, message: string) {
    super(message)
    this.name = 'PurchaseServiceError'
  }
}

// ════════════════ report ════════════════

/** service 错误码（IPC 层透传 message 给 renderer） */
export type ReportErrorCode = 'REPORT_INVALID_DATE' | 'REPORT_INVALID_MONTH'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class ReportServiceError extends Error {
  constructor(readonly code: ReportErrorCode, message: string) {
    super(message)
    this.name = 'ReportServiceError'
  }
}

// ════════════════ sale ════════════════

/** service 错误码（IPC 层透传 message 给 renderer） */
export type SaleErrorCode =
  | 'SALE_EMPTY_CART'
  | 'SALE_INVALID_ITEM'
  | 'PRODUCT_NOT_FOUND'
  | 'SALE_NOT_FOUND'
  | 'SALE_ALREADY_VOIDED'
  | 'SALE_SN_REQUIRED'
  | 'SALE_SN_NOT_FOUND'
  | 'SALE_SN_SOLD'
  | 'SALE_SN_PRODUCT_MISMATCH'
  | 'SALE_EXTRAS_PHONE_REQUIRED'
  | 'SALE_EXTRAS_PHONE_INVALID'
  | 'SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class SaleServiceError extends Error {
  constructor(readonly code: SaleErrorCode, message: string) {
    super(message)
    this.name = 'SaleServiceError'
  }
}
