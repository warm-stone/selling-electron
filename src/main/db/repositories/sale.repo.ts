/**
 * 销售 DAL（纯 SQL，无业务规则）。
 *
 * 事务边界约定：
 * - `createSaleWithItems` / `voidSale` 各自内嵌 `db.transaction()`——独立调用时
 *   自成原子；被 service 层大事务包裹时 better-sqlite3 自动降级为 SAVEPOINT
 *   （嵌套事务安全，见 docs/api.md#transaction）。
 * - `dailyCount` 是 sale_no 序列的计数查询（D18 按日序列），必须在调用方
 *   事务内执行才有意义（service.checkout 保证）。
 */

import type Database from 'better-sqlite3'
import type {
  Sale,
  SaleDetail,
  SaleItem,
  SaleStatus
} from '../../../shared/types'

/** 新销售单头（落库前形态；status 固定 'completed' 由 DDL DEFAULT 承担） */
export interface NewSale {
  sale_no: string
  total_cents: number
  item_count: number
}

/** 新销售明细行（含商品快照——G4） */
export interface NewSaleItem {
  product_id: number | null
  product_name: string
  barcode: string | null
  quantity: number
  unit_price_cents: number
  subtotal_cents: number
}

/** 商品快照读取（checkout 事务内实时读 products） */
export interface ProductSnapshot {
  id: number
  name: string
  barcode: string | null
  stock: number
}

/** 流水写入参数 */
export interface MovementInput {
  product_id: number
  change_qty: number
  before_stock: number
  after_stock: number
  source: 'sale' | 'purchase' | 'manual' | 'void'
  source_id: number | null
}

/** list 过滤条件（date_from/date_to 为本地日期 'yyyy-MM-dd'） */
export interface SaleListFilter {
  from?: string
  to?: string
  status?: SaleStatus
}

export const SALE_PAGE_SIZE = 50

export function createSaleRepo(db: Database.Database) {
  const insertSaleStmt = db.prepare(
    `INSERT INTO sales (sale_no, total_cents, item_count, status)
     VALUES (?, ?, ?, 'completed')`
  )
  const insertSaleItemStmt = db.prepare(
    `INSERT INTO sale_items
       (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const insertMovementStmt = db.prepare(
    `INSERT INTO stock_movements
       (product_id, change_qty, before_stock, after_stock, source, source_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const getProductStmt = db.prepare(
    'SELECT id, name, barcode, stock FROM products WHERE id = ?'
  )
  const adjustStockStmt = db.prepare(
    `UPDATE products
     SET stock = stock + ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  )

  function getSaleItems(saleId: number): SaleItem[] {
    return db
      .prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id')
      .all(saleId) as SaleItem[]
  }

  function getDetail(saleId: number): SaleDetail | undefined {
    const sale = db
      .prepare('SELECT * FROM sales WHERE id = ?')
      .get(saleId) as Sale | undefined
    if (!sale) return undefined
    return { ...sale, items: getSaleItems(sale.id) }
  }

  return {
    /** 插销售头 + 明细快照行（内嵌事务；外层事务内自动 SAVEPOINT）→ saleId */
    createSaleWithItems(sale: NewSale, items: NewSaleItem[]): number {
      const run = db.transaction((): number => {
        const result = insertSaleStmt.run(
          sale.sale_no,
          sale.total_cents,
          sale.item_count
        )
        const saleId = Number(result.lastInsertRowid)
        for (const item of items) {
          insertSaleItemStmt.run(
            saleId,
            item.product_id,
            item.product_name,
            item.barcode,
            item.quantity,
            item.unit_price_cents,
            item.subtotal_cents
          )
        }
        return saleId
      })
      return run()
    },

    /** 按 id 查销售头 */
    getById(id: number): Sale | undefined {
      return db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as
        | Sale
        | undefined
    },

    /** 按单号查销售头 */
    findByNo(saleNo: string): Sale | undefined {
      return db.prepare('SELECT * FROM sales WHERE sale_no = ?').get(saleNo) as
        | Sale
        | undefined
    },

    /** 头 + 明细（sales:detail / 打印预览消费的结构） */
    getDetail,

    /** 明细行（作废事务按行复原库存用） */
    getSaleItems,

    /**
     * 分页列表（id 倒序=最新在前）+ 过滤（日期按 created_at 本地日期匹配）。
     * page 从 1 起。
     */
    list(page: number, filter: SaleListFilter): Sale[] {
      const conditions: string[] = []
      const params: unknown[] = []
      if (filter.from) {
        conditions.push('date(created_at) >= ?')
        params.push(filter.from)
      }
      if (filter.to) {
        conditions.push('date(created_at) <= ?')
        params.push(filter.to)
      }
      if (filter.status) {
        conditions.push('status = ?')
        params.push(filter.status)
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      params.push(SALE_PAGE_SIZE, Math.max(0, page - 1) * SALE_PAGE_SIZE)
      return db
        .prepare(
          `SELECT * FROM sales ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
        )
        .all(...params) as Sale[]
    },

    /** 标记整单作废（status + voided_at；不删任何行——D3） */
    markVoided(id: number): void {
      db.prepare(
        `UPDATE sales
         SET status = 'voided', voided_at = datetime('now', 'localtime')
         WHERE id = ?`
      ).run(id)
    },

    /**
     * 当日已有销售单数（sale_no LIKE 'yyyyMMdd-%' 前缀计数——D18 序列）。
     * 必须在事务内调用（service.checkout 保证与单号写入同事务）。
     */
    dailyCount(datePrefix: string): number {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM sales WHERE sale_no LIKE ?")
        .get(`${datePrefix}-%`) as { n: number }
      return row.n
    },

    /** 事务内实时读商品快照 + 当前库存（checkout/void 复原共用） */
    getProductSnapshot(productId: number): ProductSnapshot | undefined {
      return getProductStmt.get(productId) as ProductSnapshot | undefined
    },

    /** 库存增减（delta 正负皆可；负库存允许——D2 无 CHECK 拦截） */
    adjustStock(productId: number, delta: number): void {
      adjustStockStmt.run(delta, productId)
    },

    /** 写库存流水（审计链——G5） */
    insertMovement(movement: MovementInput): void {
      insertMovementStmt.run(
        movement.product_id,
        movement.change_qty,
        movement.before_stock,
        movement.after_stock,
        movement.source,
        movement.source_id
      )
    }
  }
}

export type SaleRepo = ReturnType<typeof createSaleRepo>
