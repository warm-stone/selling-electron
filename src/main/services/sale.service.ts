/**
 * 销售结账 + 作废业务核心（全应用最核心的事务——G2）。
 *
 * checkout：单事务 = sale_no 生成（事务内 COUNT LIKE 前缀）→ 整数分合计
 * → INSERT sales → 逐项 INSERT sale_items（实时读 products 快照）→
 * 逐项 stock -= qty（负库存允许 D2）→ INSERT movements(source='sale')。
 * voidSale：单事务 = 校验 → status='voided' + voided_at → 逐行 stock += qty
 * → movements(source='void')。作废不物理删除任何行（D3）。
 *
 * 事务内零 I/O：无 channel/网络/文件/打印调用（G3：打印是落库后异步）。
 * 竞态分析见 learnings：better-sqlite3 同步事务在单条 JS 调用栈内完成，
 * Node 单线程下事务中途不可能插入其它 checkout → COUNT+1 无竞态。
 */

import type Database from 'better-sqlite3'
import type {
  CheckoutItem,
  Sale,
  SaleDetail,
  SaleStatus
} from '../../shared/types'
import { createSaleRepo } from '../db/repositories/sale.repo'
import type { SaleListFilter } from '../db/repositories/sale.repo'

/** service 错误码（IPC 层透传 message 给 renderer） */
export type SaleErrorCode =
  | 'SALE_EMPTY_CART'
  | 'SALE_INVALID_ITEM'
  | 'PRODUCT_NOT_FOUND'
  | 'SALE_NOT_FOUND'
  | 'SALE_ALREADY_VOIDED'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class SaleServiceError extends Error {
  constructor(readonly code: SaleErrorCode, message: string) {
    super(message)
    this.name = 'SaleServiceError'
  }
}

/** IpcChannels['sales:list'] req 形状（date_from/date_to/status） */
export interface SaleListQuery {
  date_from?: string
  date_to?: string
  status?: SaleStatus
}

/** 本地今日 yyyyMMdd（sale_no 日期前缀；与 DDL datetime('now','localtime') 同口径） */
function localDateCompact(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** 结账行校验（数量/单价的编译期外防线；DB CHECK 约束兜底） */
function assertValidItems(items: CheckoutItem[]): void {
  if (items.length === 0) {
    throw new SaleServiceError('SALE_EMPTY_CART', '购物车为空，无法结账')
  }
  for (const item of items) {
    if (!Number.isInteger(item.product_id) || item.product_id <= 0) {
      throw new SaleServiceError('SALE_INVALID_ITEM', '购物车存在非法商品，无法结账')
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new SaleServiceError(
        'SALE_INVALID_ITEM',
        `商品数量必须为正整数（当前：${item.quantity}）`
      )
    }
    if (!Number.isInteger(item.unit_price_cents) || item.unit_price_cents < 0) {
      throw new SaleServiceError(
        'SALE_INVALID_ITEM',
        `商品单价必须为非负整数分（当前：${item.unit_price_cents}）`
      )
    }
  }
}

export function createSaleService(db: Database.Database) {
  const repo = createSaleRepo(db)

  return {
    /**
     * 结账：单事务落 sales + sale_items（快照）+ 扣库存 + movements。
     * 返回头 + items 明细（T11 收银台 / T15 打印编排的核心输入——金额全程整数分）。
     */
    checkout(items: CheckoutItem[]): SaleDetail {
      assertValidItems(items)

      const run = db.transaction((): SaleDetail => {
        const datePrefix = localDateCompact()
        const seq = repo.dailyCount(datePrefix) + 1
        const saleNo = `${datePrefix}-${String(seq).padStart(4, '0')}`

        // 事务内实时读快照（product_name/barcode/当前库存）；商品已被硬删 → 抛错回滚
        const lines = items.map((item) => {
          const product = repo.getProductSnapshot(item.product_id)
          if (!product) {
            throw new SaleServiceError(
              'PRODUCT_NOT_FOUND',
              `商品不存在（id=${item.product_id}），无法结账`
            )
          }
          return { item, product }
        })

        // 整数分乘加（G1）：subtotal = qty × unit_price_cents
        const totalCents = lines.reduce(
          (sum, l) => sum + l.item.quantity * l.item.unit_price_cents,
          0
        )
        const itemCount = lines.reduce((sum, l) => sum + l.item.quantity, 0)

        const saleId = repo.createSaleWithItems(
          { sale_no: saleNo, total_cents: totalCents, item_count: itemCount },
          lines.map((l) => ({
            product_id: l.product.id,
            product_name: l.product.name,
            barcode: l.product.barcode,
            quantity: l.item.quantity,
            unit_price_cents: l.item.unit_price_cents,
            subtotal_cents: l.item.quantity * l.item.unit_price_cents
          }))
        )

        // 扣库存（负库存允许 D2）+ 流水（source='sale'，before/after 审计链）
        for (const l of lines) {
          repo.adjustStock(l.product.id, -l.item.quantity)
          repo.insertMovement({
            product_id: l.product.id,
            change_qty: -l.item.quantity,
            before_stock: l.product.stock,
            after_stock: l.product.stock - l.item.quantity,
            source: 'sale',
            source_id: saleId
          })
        }

        const detail = repo.getDetail(saleId)
        if (!detail) {
          throw new SaleServiceError('SALE_NOT_FOUND', '销售单不存在')
        }
        return detail
      })

      return run()
    },

    /**
     * 整单作废（D3）：单事务 = 校验 → status='voided' + voided_at →
     * 逐行 stock += qty → movements(source='void')。不物理删除任何行。
     * 商品已硬删（product_id 为 NULL 或 products 行不存在——D15 快照设计）
     * 的明细行跳过库存复原（库存随硬删废弃）。
     */
    voidSale(saleId: number): Sale {
      const run = db.transaction((): Sale => {
        const sale = repo.getById(saleId)
        if (!sale) {
          throw new SaleServiceError(
            'SALE_NOT_FOUND',
            `销售单不存在（id=${saleId}）`
          )
        }
        if (sale.status !== 'completed') {
          throw new SaleServiceError('SALE_ALREADY_VOIDED', '该销售单已作废')
        }

        repo.markVoided(saleId)

        for (const item of repo.getSaleItems(saleId)) {
          if (item.product_id == null) continue
          const product = repo.getProductSnapshot(item.product_id)
          if (!product) continue // 商品硬删（D15）：快照行保留，库存废弃，不写复原流水
          repo.adjustStock(product.id, item.quantity)
          repo.insertMovement({
            product_id: product.id,
            change_qty: item.quantity,
            before_stock: product.stock,
            after_stock: product.stock + item.quantity,
            source: 'void',
            source_id: saleId
          })
        }

        const updated = repo.getById(saleId)
        if (!updated) {
          throw new SaleServiceError('SALE_NOT_FOUND', '销售单不存在')
        }
        return updated
      })

      return run()
    },

    /** 销售列表（分页 + 过滤；id 倒序=最新在前） */
    list(query: SaleListQuery, page = 1): Sale[] {
      const filter: SaleListFilter = {
        from: query.date_from,
        to: query.date_to,
        status: query.status
      }
      return repo.list(page, filter)
    },

    /** 单据明细（头 + items） */
    getDetail(saleId: number): SaleDetail {
      const detail = repo.getDetail(saleId)
      if (!detail) {
        throw new SaleServiceError(
          'SALE_NOT_FOUND',
          `销售单不存在（id=${saleId}）`
        )
      }
      return detail
    }
  }
}

export type SaleService = ReturnType<typeof createSaleService>
