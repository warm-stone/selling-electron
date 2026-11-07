/**
 * 商品 DAL（纯 SQL，无业务规则）。
 *
 * 事务边界约定（与 sale.repo.ts 一致）：
 * - `create` / `updateStock` / `delete` 各自内嵌 `db.transaction()`——独立调用时
 *   自成原子；被 service 层大事务包裹时 better-sqlite3 自动降级为 SAVEPOINT。
 * - `updateStock`：UPDATE products + INSERT stock_movements（before/after 快照，
 *   source 由调用方指定——G5 审计链）。
 * - `delete`：商品逻辑删除（软删——004 迁移）。软删行保留 → sale_items /
 *   purchase_items 的 product_id FK 全部持续有效（历史单据可完整追溯），
 *   stock_movements 审计链原样保留；product_sns 级联软删（D-SN15 原始意图
 *   就地实现——行存续、deleted=1）；barcode 置 NULL 释放表级 UNIQUE 占位
 *   （软删行不占用码空间，历史单据自带条码快照——G4）。
 * - 全部读方法仅见 deleted=0 行（软删商品对应用不可见）；SN 台账读方法
 *   （findSnActive/listSns）亦仅 deleted=0（D-SN3/4 逻辑删除语义），已售行经
 *   sale_item_id LEFT JOIN sales 补 sale_id/sale_no（提示原单号用——D-SN17）。
 */

import type Database from 'better-sqlite3'
import type { Product, ProductSn, ProductTracking, StockMovementSource } from '../../../shared/types'

/** 新商品（落库前形态；stock 即初始库存，允许负值——D2；SN 商品由 service 强制 0——D-SN11） */
export interface NewProduct {
  barcode: string | null
  name: string
  default_price_cents: number | null
  stock: number
  /** 计存类型（建后不可改——D-SN1） */
  tracking: ProductTracking
  /** SN 前缀（空串=无前缀；仅 SN 商品非空——D-SN2） */
  sn_prefix: string
}

/**
 * product_sns 原始行（repo 内部行映射）。sale_id/sale_no 由 LEFT JOIN
 * sale_items + sales 补全（已售行；在库为 NULL）——供 service 组装 ProductSn
 * DTO 及已售提示原单号（D-SN17）。
 */
export interface ProductSnRow {
  id: number
  product_id: number
  sn: string
  status: 'in_stock' | 'sold'
  deleted: number
  purchase_item_id: number | null
  sale_item_id: number | null
  /** 关联销售单 id（JOIN sale_items；在库为 NULL） */
  sale_id: number | null
  /** 关联销售单号（JOIN sales；在库为 NULL） */
  sale_no: string | null
  created_at: string
  updated_at: string
}

/**
 * 列表/搜索行：Product + 删除影响计数（运行时为契约 products:list res
 * `Product[]` 的结构超集——通道封闭约束下 UI 删除确认弹窗引用数的唯一获取途径）。
 */
export interface ProductRow extends Product {
  /** 关联的 sale_items + purchase_items 行数（删除弹窗「N 条历史单据」文案用） */
  willOrphan: number
}

/** 前缀互斥校验用行（D-SN14；name 供冲突文案「与商品「X」的前缀冲突」） */
export interface ProductPrefixRow {
  id: number
  name: string
  sn_prefix: string
}

const PRODUCT_COLUMNS =
  'id, barcode, name, default_price_cents, stock, tracking, sn_prefix, created_at, updated_at'

/** 每行附删除影响计数（子查询聚合，避免 N+1） */
const WILL_ORPHAN_EXPR =
  '(SELECT COUNT(*) FROM sale_items si WHERE si.product_id = p.id)' +
  ' + (SELECT COUNT(*) FROM purchase_items pi WHERE pi.product_id = p.id) AS willOrphan'

/** LIKE 通配符按字面匹配（用户输入 % _ \ 不做模糊语义） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export function createProductRepo(db: Database.Database) {
  const getByIdStmt = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? AND deleted = 0`
  )
  const getByBarcodeStmt = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE barcode = ? AND deleted = 0`
  )
  const listAllStmt = db.prepare(
    `SELECT p.*, ${WILL_ORPHAN_EXPR}
     FROM products p
     WHERE p.deleted = 0
     ORDER BY p.id DESC`
  )
  // 名称子串 LIKE %kw%；条码前缀 LIKE kw%（走 idx_products_barcode）
  const searchStmt = db.prepare(
    `SELECT p.*, ${WILL_ORPHAN_EXPR}
     FROM products p
     WHERE p.deleted = 0
       AND (p.name LIKE ? ESCAPE '\\'
         OR p.barcode LIKE ? ESCAPE '\\')
     ORDER BY p.id DESC`
  )
  const insertProductStmt = db.prepare(
    `INSERT INTO products (barcode, name, default_price_cents, stock, tracking, sn_prefix)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const updateProductStmt = db.prepare(
    `UPDATE products
     SET name = ?, default_price_cents = ?, sn_prefix = ?, updated_at = datetime('now','localtime')
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
  // 软删：行保留 + barcode 置 NULL 释放 UNIQUE 占位（软删行不占用码空间）
  const softDeleteProductStmt = db.prepare(
    `UPDATE products
     SET deleted = 1, barcode = NULL, updated_at = datetime('now','localtime')
     WHERE id = ?`
  )
  // SN 台账级联软删（D-SN15 原始意图：行存续、deleted=1；只刷 active 行幂等）
  const softDeleteSnsByProductStmt = db.prepare(
    `UPDATE product_sns
     SET deleted = 1, updated_at = datetime('now','localtime')
     WHERE product_id = ? AND deleted = 0`
  )

  // ── SN 台账（product_sns）──
  // 已售行补关联销售单号（LEFT JOIN sale_items + sales；在库行两列均 NULL）
  const SN_SALE_JOIN =
    `FROM product_sns ps
     LEFT JOIN sale_items si ON si.id = ps.sale_item_id
     LEFT JOIN sales s ON s.id = si.sale_id`
  const getSnBySnStmt = db.prepare(
    `SELECT ps.*, si.sale_id AS sale_id, s.sale_no AS sale_no
     ${SN_SALE_JOIN}
     WHERE ps.sn = ? AND ps.deleted = 0`
  )
  const getSnByIdStmt = db.prepare(
    `SELECT ps.*, si.sale_id AS sale_id, s.sale_no AS sale_no
     ${SN_SALE_JOIN}
     WHERE ps.id = ?`
  )
  const listSnsStmt = db.prepare(
    `SELECT ps.id, ps.product_id, ps.sn, ps.status, ps.created_at,
            si.sale_id AS sale_id, s.sale_no AS sale_no
     ${SN_SALE_JOIN}
     WHERE ps.product_id = ? AND ps.deleted = 0
     ORDER BY ps.id`
  )
  const listInStockSnsStmt = db.prepare(
    `SELECT ps.id, ps.product_id, ps.sn, ps.status, ps.created_at,
            si.sale_id AS sale_id, s.sale_no AS sale_no
     ${SN_SALE_JOIN}
     WHERE ps.product_id = ? AND ps.deleted = 0 AND ps.status = 'in_stock'
     ORDER BY ps.id`
  )
  const softDeleteSnStmt = db.prepare(
    `UPDATE product_sns
     SET deleted = 1, updated_at = datetime('now','localtime')
     WHERE id = ?`
  )
  const countInStockSnsStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM product_sns
     WHERE product_id = ? AND status = 'in_stock' AND deleted = 0`
  )
  const listSnPrefixesStmt = db.prepare(
    `SELECT id, name, sn_prefix FROM products
     WHERE tracking = 'sn' AND sn_prefix != '' AND deleted = 0
     ORDER BY id`
  )
  const listSnPrefixesExcludingStmt = db.prepare(
    `SELECT id, name, sn_prefix FROM products
     WHERE tracking = 'sn' AND sn_prefix != '' AND deleted = 0 AND id != ?
     ORDER BY id`
  )

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
          input.stock,
          input.tracking,
          input.sn_prefix
        )
        const id = Number(result.lastInsertRowid)
        if (input.stock !== 0) {
          insertMovementStmt.run(id, input.stock, 0, input.stock, 'manual', null)
        }
        return rowById(id)!
      })
      return run()
    },

    /** 更新名称/默认售价/SN 前缀（条码/tracking 不可改——契约 products:update 语义） */
    update(
      id: number,
      input: { name: string; default_price_cents: number | null; sn_prefix: string }
    ): Product {
      const run = db.transaction((): Product => {
        updateProductStmt.run(input.name, input.default_price_cents, input.sn_prefix, id)
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
     * 逻辑删除商品（软删——004 迁移）。事务：软删商品行（barcode 置 NULL 释放
     * UNIQUE 占位）→ 级联软删 SN 台账（active 行全部 deleted=1，行存续）。
     * 历史单据（sale_items/purchase_items）的 product_id FK 保持有效——
     * 快照行可完整追溯；stock_movements 审计链原样保留（不删任何行）。
     * 在库 SN 由 service 层守卫拦截（D-SN15）。
     * @returns willOrphan 软删时的 sale_items + purchase_items 关联行数
     */
    delete(id: number): number {
      const run = db.transaction((): number => {
        const saleCount = (countSaleItemsStmt.get(id) as { n: number }).n
        const purchaseCount = (countPurchaseItemsStmt.get(id) as { n: number }).n
        const willOrphan = saleCount + purchaseCount
        softDeleteProductStmt.run(id)
        softDeleteSnsByProductStmt.run(id)
        return willOrphan
      })
      return run()
    },

    // ── SN 台账（D-SN3/4/16）──

    /**
     * 按 SN 精查未删除行（两步读等价且复用 getByIdStmt 避免列名冲突映射；
     * getByIdStmt 仅见 deleted=0 商品 → 软删商品的 SN 不可见，返回 null）。
     * 收银扫码第一优先级（D-SN5）+ 进货查重（D-SN17）共用。
     */
    findSnActive(sn: string): { sn_row: ProductSnRow; product: Product } | null {
      const sn_row = getSnBySnStmt.get(sn) as ProductSnRow | undefined
      if (!sn_row) return null
      const product = getByIdStmt.get(sn_row.product_id) as Product | undefined
      return product ? { sn_row, product } : null
    },

    /** 按 id 查 SN 台账行（含已删/已售——deleteSn 守卫判据） */
    getSnById(snId: number): ProductSnRow | undefined {
      return getSnByIdStmt.get(snId) as ProductSnRow | undefined
    },

    /** 商品 SN 列表（D-SN16）；includeSold=false 仅在库，已售行带关联单号 */
    listSns(productId: number, includeSold: boolean): ProductSn[] {
      const stmt = includeSold ? listSnsStmt : listInStockSnsStmt
      return stmt.all(productId) as ProductSn[]
    },

    /** SN 逻辑删除（D-SN3/4：partial unique index 仅约束 deleted=0，删后 SN 可重新入库） */
    softDeleteSn(snId: number): void {
      softDeleteSnStmt.run(snId)
    },

    /** 在库 SN 计数（商品删除守卫——D-SN15；亦作 stock 冗余一致性断言基准——D-SN13） */
    countInStockSns(productId: number): number {
      return (countInStockSnsStmt.get(productId) as { n: number }).n
    },

    /** 全部非空 SN 前缀（tracking='sn' 且未软删——软删商品前缀随之释放；excludeProductId 供编辑自身排除——D-SN14） */
    listSnPrefixes(excludeProductId?: number): ProductPrefixRow[] {
      return (
        excludeProductId === undefined
          ? listSnPrefixesStmt.all()
          : listSnPrefixesExcludingStmt.all(excludeProductId)
      ) as ProductPrefixRow[]
    }
  }
}

export type ProductRepo = ReturnType<typeof createProductRepo>
