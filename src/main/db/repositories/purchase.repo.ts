import type Database from 'better-sqlite3'
import type {
  ProductTracking,
  PurchaseInputItem,
  PurchaseItem,
  PurchaseOrder,
  PurchaseOrderWithItems
} from '../../../shared/types'
import { PurchaseServiceError } from '../../services/purchase.service'

/**
 * 进货 DAL（Task 9 + SN 商品 T1.3）。
 *
 * 职责边界：纯 SQL 编排，无业务规则（结构校验在 service）。
 * - createOrderWithItems：**单事务**完成 order_no 序列生成（SQLite 本地时间，
 *   与 created_at 默认值同源）→ 头表 → 行表（快照列从 products 事务内实时读）
 *   → 库存累加 → stock_movements（source='purchase'，G5 审计链）。
 *   productId 不存在 / 行类型与 tracking 不符 / SN 已在库或已售 → 事务内抛
 *   PurchaseServiceError 全回滚（kill-point 依据）。
 * - SN 行展开（D-SN9/10）：每个 SN = 1 行 purchase_items（quantity=1、同成本价、
 *   sn 快照列）+ 1 行 product_sns（in_stock、purchase_item_id 回链）+ stock+1
 *   + 流水 +1；库存 before/after 按行快照逐 SN 链式衔接。
 * - SN 台账查重（D-SN4/17）：只看 deleted=0 的 active 行——已删 SN 可重新入库
 *   （partial unique index 允许）；已售 SN 拒绝并提示原销售单号。
 * - getDetail：只读 purchase_items 快照列，**不 join products**（G4 快照不可变）。
 * - list：头表 + 行两段查询组装（品种数 = items.length）。
 *
 * 领地规则：本文件是入库事务 owner，product_sns 的读写 SQL 直接写在这里
 * （不 import product.repo 方法——事务所有者直写自己的 SQL 的库惯例）。
 * PurchaseServiceError 定义在 service 层（与 Sale/ProductServiceError 同惯例），
 * 此处跨向 import 仅供事务内 throw 使用——调用时 service 模块已完成求值，
 * 无初始化顺序风险。
 */

/** products 事务内读取的最小快照面（tracking 供行类型匹配校验——D-SN9） */
export interface ProductSnapshot {
  id: number
  name: string
  barcode: string | null
  stock: number
  tracking: ProductTracking
}

/** SN 台账查重结果（active 行；含归属商品名与已售关联单号，供错误文案） */
interface SnLedgerRow {
  id: number
  status: 'in_stock' | 'sold'
  product_id: number
  product_name: string | null
  sale_item_id: number | null
  sale_no: string | null
}

const SELECT_ORDER_COLS = 'id, order_no, note, created_at'
const SELECT_ITEM_COLS =
  'id, order_id, product_id, product_name, barcode, quantity, cost_price_cents, sn'

export function createPurchaseRepo(db: Database.Database) {
  // ── 预编译语句 ──
  const stmtGetProduct = db.prepare(
    'SELECT id, name, barcode, stock, tracking FROM products WHERE id = ? AND deleted = 0'
  )
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
    `INSERT INTO purchase_items (order_id, product_id, product_name, barcode, quantity, cost_price_cents, sn)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  // SN 台账查重（active 行）：JOIN products 取归属商品名、JOIN 销售链取原单号（D-SN17 文案）
  const stmtFindSnLedger = db.prepare(
    `SELECT ps.id, ps.status, ps.product_id, p.name AS product_name,
           ps.sale_item_id, s.sale_no
      FROM product_sns ps
      LEFT JOIN products p ON ps.product_id = p.id
      LEFT JOIN sale_items si ON ps.sale_item_id = si.id
      LEFT JOIN sales s ON si.sale_id = s.id
     WHERE ps.sn = ? AND ps.deleted = 0`
  )
  const stmtInsertSn = db.prepare(
    `INSERT INTO product_sns (product_id, sn, status, deleted, purchase_item_id)
     VALUES (?, ?, 'in_stock', 0, ?)`
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

  /** 单事务入库：任一步失败（商品不存在 / 类型不符 / SN 重复入账）全回滚 */
  const createOrderWithItemsTx = db.transaction(
    (items: readonly PurchaseInputItem[], note: string | null): PurchaseOrderWithItems => {
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
          throw new PurchaseServiceError(
            'PRODUCT_NOT_FOUND',
            `商品不存在（product_id=${item.product_id}），本单已回滚`
          )
        }

        if (item.kind === 'quantity') {
          // SN 商品禁按数量入库（行类型必须与 tracking 一致——D-SN9）
          if (product.tracking === 'sn') {
            throw new PurchaseServiceError(
              'PURCHASE_TYPE_MISMATCH',
              `商品「${product.name}」是 SN 商品，必须按 SN 入库`
            )
          }
          const itemResult = stmtInsertItem.run(
            orderId,
            product.id,
            product.name,
            product.barcode,
            item.quantity,
            item.cost_price_cents,
            null
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
            cost_price_cents: item.cost_price_cents,
            sn: null
          })
        } else {
          // SN 行：tracking 必须为 'sn'（D-SN9）
          if (product.tracking !== 'sn') {
            throw new PurchaseServiceError(
              'PURCHASE_TYPE_MISMATCH',
              `商品「${product.name}」不是 SN 商品，不能按 SN 入库`
            )
          }
          // 逐 SN 展开（D-SN10）：每 SN 一行明细（quantity=1、同成本价）+ 一条台账 + stock+1 + 流水+1；
          // before/after 以行快照为起点逐 SN 链式衔接（同一事务内可读到本行此前累计）
          let runningStock = product.stock
          for (const sn of item.sns) {
            const ledger = stmtFindSnLedger.get(sn) as SnLedgerRow | undefined
            if (ledger) {
              if (ledger.status === 'in_stock') {
                throw new PurchaseServiceError(
                  'PURCHASE_SN_EXISTS',
                  `SN ${sn} 已在库（商品「${ledger.product_name ?? `id=${ledger.product_id}`}」）`
                )
              }
              throw new PurchaseServiceError(
                'PURCHASE_SN_EXISTS',
                `SN ${sn} 已售出（销售单 ${ledger.sale_no ?? '未知'}），如需退货请作废原单`
              )
            }
            const itemResult = stmtInsertItem.run(
              orderId,
              product.id,
              product.name,
              product.barcode,
              1,
              item.cost_price_cents,
              sn
            )
            const itemRowId = Number(itemResult.lastInsertRowid)
            stmtInsertSn.run(product.id, sn, itemRowId)
            const afterStock = runningStock + 1
            stmtAddStock.run(1, product.id)
            stmtInsertMovement.run(product.id, 1, runningStock, afterStock, orderId)
            runningStock = afterStock
            insertedItems.push({
              id: itemRowId,
              order_id: orderId,
              product_id: product.id,
              product_name: product.name,
              barcode: product.barcode,
              quantity: 1,
              cost_price_cents: item.cost_price_cents,
              sn
            })
          }
        }
      }

      const order = stmtGetOrder.get(orderId) as unknown as PurchaseOrder
      return { ...order, items: insertedItems }
    }
  )

  return {
    /**
     * 创建进货单（单事务）。items 已通过 service 结构校验与归一化（SN 已 trim、
     * 本单无重复）；productId 存在性 / tracking 匹配 / SN 台账查重在事务内校验
     * ——失败即抛错回滚（整单零残留）。
     */
    createOrderWithItems(
      note: string | null,
      items: readonly PurchaseInputItem[]
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
