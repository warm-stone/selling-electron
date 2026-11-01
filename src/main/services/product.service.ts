/**
 * 商品管理业务核心（参数校验 + 审计流水——G5）。
 *
 * 手动改库存必走 updateStock → stock_movements（source='manual'）；
 * 负库存是定案（D2）：创建/调整允许负值，不在此拦截，UI 负库存标红。
 * 金额一律整数分（G1）：price 校验 Number.isInteger + ≥0，元单位浮点
 * 只存在于 UI 层边界转换。
 */

import type Database from 'better-sqlite3'
import type { Product } from '../../shared/types'
import { createProductRepo } from '../db/repositories/product.repo'
import type { NewProduct, ProductRow } from '../db/repositories/product.repo'

/** service 错误码（IPC 层透传 message 给 renderer；测试断言 code） */
export type ProductErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_PRICE'
  | 'INVALID_STOCK'
  | 'BARCODE_CONFLICT'
  | 'PRODUCT_NOT_FOUND'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class ProductServiceError extends Error {
  constructor(readonly code: ProductErrorCode, message: string) {
    super(message)
    this.name = 'ProductServiceError'
  }
}

/** IpcChannels['products:create'] req 形状（snake_case，与契约逐字一致） */
export interface ProductCreateInput {
  barcode: string | null
  name: string
  default_price_cents: number | null
  stock: number
}

/** IpcChannels['products:update'] req 形状（条码不可改——契约语义） */
export interface ProductUpdateInput {
  id: number
  name: string
  default_price_cents: number | null
}

function assertValidName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ProductServiceError('INVALID_NAME', '商品名称不能为空')
  }
  return name.trim()
}

/** 价格：null（未设默认售价）或整数分 ≥0（一律整数分——G1） */
function assertValidPriceCents(cents: unknown): number | null {
  if (cents === null || cents === undefined) return null
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) {
    throw new ProductServiceError('INVALID_PRICE', '默认售价必须是大于等于 0 的整数（分）')
  }
  return cents
}

/** 库存：整数（允许负值——D2） */
function assertValidStock(stock: unknown): number {
  if (typeof stock !== 'number' || !Number.isInteger(stock)) {
    throw new ProductServiceError('INVALID_STOCK', '库存必须是整数')
  }
  return stock
}

/** 条码：null / 空白 → null（无条码商品 D17）；其余 trim 后原样（大小写敏感） */
function normalizeBarcode(barcode: unknown): string | null {
  if (typeof barcode !== 'string') return null
  const trimmed = barcode.trim()
  return trimmed.length === 0 ? null : trimmed
}

export function createProductService(db: Database.Database) {
  const repo = createProductRepo(db)

  /** 存在性守卫（TOCTOU 无虞：better-sqlite3 同步单线程） */
  function requireProduct(id: number): Product {
    if (!Number.isInteger(id)) {
      throw new ProductServiceError('PRODUCT_NOT_FOUND', '商品不存在')
    }
    const found = repo.getById(id)
    if (!found) {
      throw new ProductServiceError('PRODUCT_NOT_FOUND', '商品不存在')
    }
    return found
  }

  return {
    /**
     * 列表/搜索：名称子串 / 条码前缀。
     * 行带 willOrphan（删除影响计数——通道封闭约束下 UI 删除弹窗的唯一获取途径，
     * 运行时为契约 res `Product[]` 的结构超集）。
     */
    list(keyword?: string): ProductRow[] {
      const kw = typeof keyword === 'string' ? keyword.trim() : ''
      return kw.length === 0 ? repo.list() : repo.search(kw)
    },

    create(input: ProductCreateInput): Product {
      const name = assertValidName(input.name)
      const barcode = normalizeBarcode(input.barcode)
      const stock = assertValidStock(input.stock)
      const priceCents = assertValidPriceCents(input.default_price_cents)

      if (barcode !== null && repo.findByBarcode(barcode)) {
        throw new ProductServiceError('BARCODE_CONFLICT', '条码已存在')
      }

      const created: NewProduct = {
        barcode,
        name,
        default_price_cents: priceCents,
        stock
      }
      return repo.create(created)
    },

    update(input: ProductUpdateInput): Product {
      requireProduct(input.id)
      const name = assertValidName(input.name)
      const priceCents = assertValidPriceCents(input.default_price_cents)
      return repo.update(input.id, { name, default_price_cents: priceCents })
    },

    /** 手动调整库存为绝对目标值；repo 事务内写流水 source='manual'（G5） */
    updateStock(input: { id: number; stock: number }): Product {
      requireProduct(input.id)
      const stock = assertValidStock(input.stock)
      return repo.updateStock(input.id, stock, 'manual')
    },

    /** 硬删商品；返回 willOrphan（关联历史单据行数，UI 弹窗文案用） */
    delete(input: { id: number }): { ok: true; willOrphan: number } {
      requireProduct(input.id)
      const willOrphan = repo.delete(input.id)
      return { ok: true, willOrphan }
    }
  }
}

export type ProductService = ReturnType<typeof createProductService>
