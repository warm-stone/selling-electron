/**
 * 销售 DAL（纯 SQL，无业务规则）。
 *
 * 事务边界约定：
 * - `createSaleWithItems` / `voidSale` 各自内嵌 `db.transaction()`——独立调用时
 *   自成原子；被 service 层大事务包裹时 better-sqlite3 自动降级为 SAVEPOINT
 *   （嵌套事务安全，见 docs/api.md#transaction）。
 * - `dailyCount` 是 sale_no 序列的计数查询（D18 按日序列），必须在调用方
 *   事务内执行才有意义（service.checkout 保证）。
 * - SN 台账（product_sns）SQL 属销售事务所有，直接写在本 repo（架构约定：
 *   事务 owner 写自己的 SQL，不越界 import product.repo——D-SN8）。
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

/** 新销售明细行（含商品快照——G4；sn 为 SN 行快照，批量计行 null——D-SN12） */
export interface NewSaleItem {
  product_id: number | null
  product_name: string
  barcode: string | null
  quantity: number
  unit_price_cents: number
  subtotal_cents: number
  sn: string | null
}

/** SN 台账行（checkout 事务内校验读取——D-SN6 拒绝态判定） */
export interface SnLedgerRow {
  id: number
  status: 'in_stock' | 'sold'
  product_id: number
  sale_item_id: number | null
  /** 已售时关联单号（SALE_SN_SOLD 文案引导作废用）；在库为 null */
  sale_no: string | null
}

/** 商品快照读取（checkout/void 事务内实时读 products） */
export interface ProductSnapshot {
  id: number
  name: string
  barcode: string | null
  stock: number
  /** 计类型（SN 行防御性校验：sn 行要求 tracking='sn'——D-SN1 商品二分） */
  tracking: 'quantity' | 'sn'
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
       (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents, sn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertMovementStmt = db.prepare(
    `INSERT INTO stock_movements
       (product_id, change_qty, before_stock, after_stock, source, source_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const getProductStmt = db.prepare(
    'SELECT id, name, barcode, stock, tracking FROM products WHERE id = ? AND deleted = 0'
  )
  const adjustStockStmt = db.prepare(
    `UPDATE products
     SET stock = stock + ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  )
  const findSnStmt = db.prepare(
    `SELECT ps.id, ps.status, ps.product_id, ps.sale_item_id, s.sale_no
     FROM product_sns ps
     LEFT JOIN sale_items si ON si.id = ps.sale_item_id
     LEFT JOIN sales s ON s.id = si.sale_id
     WHERE ps.sn = ? AND ps.deleted = 0`
  )
  const markSnSoldStmt = db.prepare(
    `UPDATE product_sns
     SET status = 'sold', sale_item_id = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ? AND deleted = 0`
  )
  const restoreSnStmt = db.prepare(
    `UPDATE product_sns
     SET status = 'in_stock', sale_item_id = NULL, updated_at = datetime('now', 'localtime')
     WHERE sale_item_id = ? AND deleted = 0`
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
    // T2 契约接线占位：extras 平铺由 sale_extras LEFT JOIN 装配任务（后续 Wave）替换；
    // 当前无 sale_extras 行写入 → null 即旧单准确语义
    return { ...sale, items: getSaleItems(sale.id), extras: null }
  }

  return {
    /**
     * 插销售头 + 明细快照行（内嵌事务；外层事务内自动 SAVEPOINT）
     * → { saleId, itemIds }（itemIds 与入参 items 逐行对应——SN 台账回写
     * sale_item_id 用，D-SN8）。
     */
    createSaleWithItems(
      sale: NewSale,
      items: NewSaleItem[]
    ): { saleId: number; itemIds: number[] } {
      const run = db.transaction((): { saleId: number; itemIds: number[] } => {
        const result = insertSaleStmt.run(
          sale.sale_no,
          sale.total_cents,
          sale.item_count
        )
        const saleId = Number(result.lastInsertRowid)
        const itemIds = items.map((item) => {
          const r = insertSaleItemStmt.run(
            saleId,
            item.product_id,
            item.product_name,
            item.barcode,
            item.quantity,
            item.unit_price_cents,
            item.subtotal_cents,
            item.sn
          )
          return Number(r.lastInsertRowid)
        })
        return { saleId, itemIds }
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

    /** 事务内实时读商品快照 + 当前库存（checkout/void 复原共用；仅未软删商品——软删行 undefined） */
    getProductSnapshot(productId: number): ProductSnapshot | undefined {
      return getProductStmt.get(productId) as ProductSnapshot | undefined
    },

    /** 事务内按 SN 查台账行（deleted=0；checkout 校验读取——D-SN6） */
    findSnForSale(sn: string): SnLedgerRow | undefined {
      return findSnStmt.get(sn) as SnLedgerRow | undefined
    },

    /**
     * SN 台账流转 in_stock→sold + 回写销售去向行（D-SN8）。
     * 返回实际更新行数（service 防御性断言 ===1 用）。
     */
    markSnSold(snRowId: number, saleItemId: number): number {
      return Number(markSnSoldStmt.run(saleItemId, snRowId).changes)
    },

    /**
     * SN 台账回滚 sold→in_stock + 清空销售去向（D-SN8 作废链路，按明细行
     * 自身 id 定位）。商品已软删时 product_sns 已被级联软删 →
     * WHERE deleted=0 命中 0 行，静默跳过（与库存复原的 skip 语义一致）。
     */
    restoreSnBySaleItem(saleItemId: number): void {
      restoreSnStmt.run(saleItemId)
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
