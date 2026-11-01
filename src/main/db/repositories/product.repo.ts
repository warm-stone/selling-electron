/**
 * 商品 DAL（纯 SQL，无业务规则）。
 *
 * 事务边界约定（与 sale.repo.ts 一致）：
 * - `create` / `updateStock` / `delete` 各自内嵌 `db.transaction()`——独立调用时
 *   自成原子；被 service 层大事务包裹时 better-sqlite3 自动降级为 SAVEPOINT。
 * - `updateStock`：UPDATE products + INSERT stock_movements（before/after 快照，
 *   source 由调用方指定——G5 审计链）。
 * - `delete`：商品硬删（D15）。快照设计（G4）下 sale_items/purchase_items 的
 *   product_id 断链置 NULL（DDL 未带 ON DELETE SET NULL，由本层等价补齐）；
 *   stock_movements.product_id 为 NOT NULL FK，无法断链，随商品清除
 *   （计划 DDL 约束下的必然选择，决策记录 learnings）。
 */

import type Database from 'better-sqlite3'
import type { Product, StockMovementSource } from '../../../shared/types'

/** 新商品（落库前形态；stock 即初始库存，允许负值——D2） */
export interface NewProduct {
  barcode: string | null
  name: string
  default_price_cents: number | null
  stock: number
}

/**
 * 列表/搜索行：Product + 删除影响计数（运行时为契约 products:list res
 * `Product[]` 的结构超集——通道封闭约束下 UI 删除确认弹窗引用数的唯一获取途径）。
 */
export interface ProductRow extends Product {
  /** 关联的 sale_items + purchase_items 行数（删除弹窗「N 条历史单据」文案用） */
  willOrphan: number
}

const PRODUCT_COLUMNS =
  'id, barcode, name, default_price_cents, stock, created_at, updated_at'

/** 每行附删除影响计数（子查询聚合，避免 N+1） */
const WILL_ORPHAN_EXPR =
  '(SELECT COUNT(*) FROM sale_items si WHERE si.product_id = p.id)' +
  ' + (SELECT COUNT(*) FROM purchase_items pi WHERE pi.product_id = p.id) AS willOrphan'

/** LIKE 通配符按字面匹配（用户输入 % _ \ 不做模糊语义） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export function createProductRepo(db: Database.Database) {
  const getByIdStmt = db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`)
  const getByBarcodeStmt = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE barcode = ?`
  )
  const listAllStmt = db.prepare(
    `SELECT p.*, ${WILL_ORPHAN_EXPR} FROM products p ORDER BY p.id DESC`
  )
  // 名称子串 LIKE %kw%；条码前缀 LIKE kw%（走 idx_products_barcode）
  const searchStmt = db.prepare(
    `SELECT p.*, ${WILL_ORPHAN_EXPR}
     FROM products p
     WHERE p.name LIKE ? ESCAPE '\\'
        OR p.barcode LIKE ? ESCAPE '\\'
     ORDER BY p.id DESC`
  )
  const insertProductStmt = db.prepare(
    `INSERT INTO products (barcode, name, default_price_cents, stock)
     VALUES (?, ?, ?, ?)`
  )
  const updateProductStmt = db.prepare(
    `UPDATE products
     SET name = ?, default_price_cents = ?, updated_at = datetime('now','localtime')
     WHERE id = ?`
  )
  const updateStockStmt = db.prepare(
    `UPDATE products
     SET stock = ?, updated_at = datetime('now','localtime')
     WHERE id = ?`
  )
  const insertMovementStmt = db.prepare(
    `INSERT INTO stock_movements
       (product_id, change_qty, before_stock, after_stock, source, source_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const countSaleItemsStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM sale_items WHERE product_id = ?'
  )
  const countPurchaseItemsStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM purchase_items WHERE product_id = ?'
  )
  const detachSaleItemsStmt = db.prepare(
    'UPDATE sale_items SET product_id = NULL WHERE product_id = ?'
  )
  const detachPurchaseItemsStmt = db.prepare(
    'UPDATE purchase_items SET product_id = NULL WHERE product_id = ?'
  )
  const deleteMovementsStmt = db.prepare(
    'DELETE FROM stock_movements WHERE product_id = ?'
  )
  const deleteProductStmt = db.prepare('DELETE FROM products WHERE id = ?')

  function rowById(id: number): Product | undefined {
    return getByIdStmt.get(id) as Product | undefined
  }

  return {
    /** 全量列表（新创建在前） */
    list(): ProductRow[] {
      return listAllStmt.all() as ProductRow[]
    },

    /** 搜索：名称子串 / 条码前缀，LIKE 通配符按字面匹配 */
    search(keyword: string): ProductRow[] {
      const like = escapeLike(keyword)
      return searchStmt.all(`%${like}%`, `${like}%`) as ProductRow[]
    },

    findByBarcode(barcode: string): Product | undefined {
      return getByBarcodeStmt.get(barcode) as Product | undefined
    },

    getById(id: number): Product | undefined {
      return rowById(id)
    },

    /**
     * 创建商品；初始库存非 0 时写一条 source='manual' 流水
     * （before=0 → after=stock，保证审计链起点完整——G5）。
     */
    create(input: NewProduct): Product {
      const run = db.transaction((): Product => {
        const result = insertProductStmt.run(
          input.barcode,
          input.name,
          input.default_price_cents,
          input.stock
        )
        const id = Number(result.lastInsertRowid)
        if (input.stock !== 0) {
          insertMovementStmt.run(id, input.stock, 0, input.stock, 'manual', null)
        }
        return rowById(id)!
      })
      return run()
    },

    /** 更新名称/默认售价（条码不可改——契约 products:update 语义） */
    update(id: number, input: { name: string; default_price_cents: number | null }): Product {
      const run = db.transaction((): Product => {
        updateProductStmt.run(input.name, input.default_price_cents, id)
        return rowById(id)!
      })
      return run()
    },

    /**
     * 调整库存为绝对目标值（事务：UPDATE products + INSERT stock_movements，
     * before/after 快照；source 由调用方指定，手动调整='manual'——G5）。
     */
    updateStock(
      id: number,
      newStock: number,
      source: StockMovementSource,
      sourceId: number | null = null
    ): Product {
      const run = db.transaction((): Product => {
        const current = rowById(id)
        if (!current) {
          throw new Error(`商品不存在：id=${id}`)
        }
        const before = current.stock
        updateStockStmt.run(newStock, id)
        insertMovementStmt.run(id, newStock - before, before, newStock, source, sourceId)
        return rowById(id)!
      })
      return run()
    },

    /**
     * 硬删商品（D15）。事务：断链历史引用（快照行保留）→ 清库存流水 → 删商品。
     * @returns willOrphan 断链前的 sale_items + purchase_items 关联行数
     */
    delete(id: number): number {
      const run = db.transaction((): number => {
        const saleCount = (countSaleItemsStmt.get(id) as { n: number }).n
        const purchaseCount = (countPurchaseItemsStmt.get(id) as { n: number }).n
        const willOrphan = saleCount + purchaseCount
        detachSaleItemsStmt.run(id)
        detachPurchaseItemsStmt.run(id)
        deleteMovementsStmt.run(id)
        deleteProductStmt.run(id)
        return willOrphan
      })
      return run()
    }
  }
}

export type ProductRepo = ReturnType<typeof createProductRepo>
