import type Database from 'better-sqlite3'
import type { PurchaseItem, PurchaseOrder, PurchaseOrderWithItems } from '../../../shared/types'

/**
 * 进货 DAL（Task 9）。
 *
 * 职责边界：纯 SQL 编排，无业务规则（校验在 service）。
 * - createOrderWithItems：**单事务**完成 order_no 序列生成（SQLite 本地时间，
 *   与 created_at 默认值同源）→ 头表 → 行表（快照列从 products 事务内实时读）
 *   → 库存累加 → stock_movements（source='purchase'，G5 审计链）。
 *   productId 不存在时事务内抛错 → better-sqlite3 throw 自动回滚（kill-point 依据）。
 * - getDetail：只读 purchase_items 快照列，**不 join products**（G4 快照不可变）。
 * - list：头表 + 行两段查询组装（品种数 = items.length）。
 *
 * 注：products 读取 SQL 写在本 repo（T8 的 product.repo 并行未合并，
 * 领地规则——只消费不修改；缺方法已记录 issues.md）。
 */

export interface PurchaseItemInput {
  product_id: number
  quantity: number
  cost_price_cents: number
}

/** products 事务内读取的最小快照面 */
export interface ProductSnapshot {
  id: number
  name: string
  barcode: string | null
  stock: number
}

const SELECT_ORDER_COLS = 'id, order_no, note, created_at'
const SELECT_ITEM_COLS =
  'id, order_id, product_id, product_name, barcode, quantity, cost_price_cents'

export function createPurchaseRepo(db: Database.Database) {
  // ── 预编译语句 ──
  const stmtGetProduct = db.prepare('SELECT id, name, barcode, stock FROM products WHERE id = ?')
  // order_no 序列：SQLite 本地时间（与 created_at 的 datetime('now','localtime') 同源），
  // 且在事务内执行（WAL 单写者串行化，无竞态——D18）
  const stmtNextOrderNo = db.prepare(
    `SELECT strftime('%Y%m%d', 'now', 'localtime') AS ymd,
            COUNT(*) AS n
       FROM purchase_orders
      WHERE order_no LIKE strftime('%Y%m%d', 'now', 'localtime') || '-%'`
  )
  const stmtInsertOrder = db.prepare('INSERT INTO purchase_orders (order_no, note) VALUES (?, ?)')
  const stmtInsertItem = db.prepare(
    `INSERT INTO purchase_items (order_id, product_id, product_name, barcode, quantity, cost_price_cents)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const stmtAddStock = db.prepare(
    `UPDATE products
        SET stock = stock + ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?`
  )
  const stmtInsertMovement = db.prepare(
    `INSERT INTO stock_movements (product_id, change_qty, before_stock, after_stock, source, source_id)
     VALUES (?, ?, ?, ?, 'purchase', ?)`
  )
  const stmtListOrders = db.prepare(
    `SELECT ${SELECT_ORDER_COLS} FROM purchase_orders ORDER BY created_at DESC, id DESC`
  )
  const stmtListOrdersBetween = db.prepare(
    `SELECT ${SELECT_ORDER_COLS}
       FROM purchase_orders
      WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
      ORDER BY created_at DESC, id DESC`
  )
  const stmtGetItemsByOrder = db.prepare(
    `SELECT ${SELECT_ITEM_COLS} FROM purchase_items WHERE order_id = ? ORDER BY id`
  )
  const stmtGetOrder = db.prepare(`SELECT ${SELECT_ORDER_COLS} FROM purchase_orders WHERE id = ?`)

  function getItems(orderId: number): PurchaseItem[] {
    return stmtGetItemsByOrder.all(orderId) as unknown as PurchaseItem[]
  }

  function attachItems(order: PurchaseOrder): PurchaseOrderWithItems {
    return { ...order, items: getItems(order.id) }
  }

  /** 单事务入库：任一步失败（如 productId 不存在）全回滚 */
  const createOrderWithItemsTx = db.transaction(
    (items: readonly PurchaseItemInput[], note: string | null): PurchaseOrderWithItems => {
      // 1) 事务内生成本单号（yyyyMMdd-NNNN，与销售序列独立——D18）
      const seq = stmtNextOrderNo.get() as { ymd: string; n: number }
      const orderNo = `${seq.ymd}-${String(seq.n + 1).padStart(4, '0')}`

      // 2) 头表
      const orderResult = stmtInsertOrder.run(orderNo, note)
      const orderId = Number(orderResult.lastInsertRowid)

      // 3) 逐行：快照读取（products 实时值）→ 行落库 → 库存累加 → 流水
      const insertedItems: PurchaseItem[] = []
      for (const item of items) {
        const product = stmtGetProduct.get(item.product_id) as ProductSnapshot | undefined
        if (!product) {
          throw new Error(`商品不存在（product_id=${item.product_id}），本单已回滚`)
        }
        const itemResult = stmtInsertItem.run(
          orderId,
          product.id,
          product.name,
          product.barcode,
          item.quantity,
          item.cost_price_cents
        )
        const afterStock = product.stock + item.quantity
        stmtAddStock.run(item.quantity, product.id)
        stmtInsertMovement.run(product.id, item.quantity, product.stock, afterStock, orderId)
        insertedItems.push({
          id: Number(itemResult.lastInsertRowid),
          order_id: orderId,
          product_id: product.id,
          product_name: product.name,
          barcode: product.barcode,
          quantity: item.quantity,
          cost_price_cents: item.cost_price_cents
        })
      }

      const order = stmtGetOrder.get(orderId) as unknown as PurchaseOrder
      return { ...order, items: insertedItems }
    }
  )

  return {
    /**
     * 创建进货单（单事务）。items 已通过 service 结构校验；
     * productId 存在性在事务内校验——不存在即抛错回滚（整单零残留）。
     */
    createOrderWithItems(
      note: string | null,
      items: readonly PurchaseItemInput[]
    ): PurchaseOrderWithItems {
      return createOrderWithItemsTx(items, note)
    },

    /** 头+行组装列表（品种数 = items.length）；date 参数为 yyyy-MM-dd */
    list(dateFrom?: string, dateTo?: string): PurchaseOrderWithItems[] {
      const orders =
        dateFrom !== undefined || dateTo !== undefined
          ? (stmtListOrdersBetween.all(dateFrom ?? '0000-01-01', dateTo ?? '9999-12-31') as unknown as PurchaseOrder[])
          : (stmtListOrders.all() as unknown as PurchaseOrder[])
      return orders.map(attachItems)
    },

    /** 单张明细（读快照列，不 join products——G4） */
    getDetail(id: number): PurchaseOrderWithItems | undefined {
      const order = stmtGetOrder.get(id) as unknown as PurchaseOrder | undefined
      return order ? attachItems(order) : undefined
    }
  }
}

export type PurchaseRepo = ReturnType<typeof createPurchaseRepo>
