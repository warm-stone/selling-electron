import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { closeDatabase, initDatabase } from '../../../src/main/db/database'
import {
  createPurchaseService,
  type PurchaseService
} from '../../../src/main/services/purchase.service'
import { createPurchaseRepo } from '../../../src/main/db/repositories/purchase.repo'
import { createProductService } from '../../../src/main/services/product.service'
import { insertProduct } from '../../fixtures/seed'
import { rmTempDirSync } from '../../helpers/cleanup'
import type { PurchaseInputItem, StockMovement } from '../../../src/shared/types'

let dir: string
let db: Database.Database
let service: PurchaseService
let repo: ReturnType<typeof createPurchaseRepo>
let colaId: number
let spriteId: number
let breadId: number
let phoneId: number
let padId: number

/** 测试机本地日期 yyyyMMdd（与 SQL 侧 strftime('%Y%m%d','now','localtime') 同源） */
function localYmd(): string {
  const now = new Date()
  return (
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`
  )
}

/**
 * 测试机本地日期 yyyy-MM-dd（与 service.list 的 substr(created_at) / SQLite
 * datetime('now','localtime') 语义一致）。勿用 toISOString——它返回 UTC 日期，
 * 在 UTC+N 时区的本地 00:00–08:00 窗口比本地日期早一天，"明天"会算成"今天"。
 */
function localIsoDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 3600 * 1000)
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  )
}

function getStock(id: number): number {
  return (db.prepare('SELECT stock FROM products WHERE id = ?').get(id) as { stock: number }).stock
}

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function allMovements(): StockMovement[] {
  return db
    .prepare('SELECT * FROM stock_movements ORDER BY id')
    .all() as unknown as StockMovement[]
}

/** 插入 SN 商品（tracking='sn'；seed.ts 为共享 fixture，本文件本地扩展避免并行改动冲突） */
function insertSnProduct(name: string, stock = 0): number {
  const result = db
    .prepare(
      `INSERT INTO products (barcode, name, default_price_cents, stock, tracking, sn_prefix)
       VALUES (NULL, ?, 2999, ?, 'sn', '')`
    )
    .run(name, stock)
  return Number(result.lastInsertRowid)
}

function activeSnRows(productId: number): Array<{ sn: string; status: string; purchase_item_id: number; deleted: number }> {
  return db
    .prepare(
      'SELECT sn, status, purchase_item_id, deleted FROM product_sns WHERE product_id = ? ORDER BY id'
    )
    .all(productId) as unknown as Array<{ sn: string; status: string; purchase_item_id: number; deleted: number }>
}

/** D-SN13 一致性：在库 SN 数（status='in_stock' 且 deleted=0） */
function inStockSnCount(productId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM product_sns WHERE product_id = ? AND status = 'in_stock' AND deleted = 0"
      )
      .get(productId) as { n: number }
  ).n
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-purchase-'))
  db = initDatabase(dir)
  colaId = insertProduct(db, { barcode: '6901234567890', name: '可乐 330ml', default_price_cents: 350, stock: 100 })
  spriteId = insertProduct(db, { barcode: '6902345678901', name: '雪碧 330ml', default_price_cents: 350, stock: 50 })
  breadId = insertProduct(db, { barcode: null, name: '早餐面包', default_price_cents: 450, stock: 20 })
  phoneId = insertSnProduct('测试手机')
  padId = insertSnProduct('测试平板')
  service = createPurchaseService(db)
  repo = createPurchaseRepo(db)
})

afterEach(() => {
  // initDatabase 是模块级单例：不关闭则 Windows 上删 temp 目录 EBUSY
  closeDatabase()
  rmTempDirSync(dir)
})

// ═══════════ 事务原子性（TDD 核心：部分失败全回滚）═══════════

describe('purchase.service：入库事务原子性', () => {
  it('第二个 item 的 productId 不存在 → 整单不入库、库存不变、流水零行', () => {
    expect(() =>
      service.createPurchase(
        [
          { kind: 'quantity', product_id: colaId, quantity: 10, cost_price_cents: 200 },
          { kind: 'quantity', product_id: 99999, quantity: 3, cost_price_cents: 100 }
        ],
        '部分失败场景'
      )
    ).toThrow(/商品不存在/)

    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('purchase_items')).toBe(0)
    expect(countRows('stock_movements')).toBe(0)
    expect(getStock(colaId)).toBe(100)
    expect(getStock(spriteId)).toBe(50)
    expect(getStock(breadId)).toBe(20)
  })

  it('全部校验通过才落库：第一行非法同样零残留', () => {
    expect(() =>
      service.createPurchase([
        { kind: 'quantity', product_id: 99999, quantity: 1, cost_price_cents: 100 },
        { kind: 'quantity', product_id: colaId, quantity: 1, cost_price_cents: 100 }
      ])
    ).toThrow(/商品不存在/)
    expect(countRows('purchase_orders')).toBe(0)
    expect(getStock(colaId)).toBe(100)
  })

  it('软删商品进货 → 同样商品不存在拒绝且整单回滚（004 迁移：读过滤 deleted=0）', () => {
    createProductService(db).delete({ id: spriteId })

    expect(() =>
      service.createPurchase([
        { kind: 'quantity', product_id: colaId, quantity: 1, cost_price_cents: 100 },
        { kind: 'quantity', product_id: spriteId, quantity: 2, cost_price_cents: 120 }
      ])
    ).toThrow(/商品不存在/)

    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('purchase_items')).toBe(0)
    expect(getStock(colaId)).toBe(100)
    expect(getStock(spriteId)).toBe(50)
  })
})

// ═══════════ 正常入库：库存联动 + 流水审计链 + 快照 ═══════════

describe('purchase.service：正常入库', () => {
  it('3 行入库：库存 +10/+5/+2，流水 3 行 source=purchase 且 before/after 衔接，items 含商品快照', () => {
    const order = service.createPurchase(
      [
        { kind: 'quantity', product_id: colaId, quantity: 10, cost_price_cents: 200 },
        { kind: 'quantity', product_id: spriteId, quantity: 5, cost_price_cents: 210 },
        { kind: 'quantity', product_id: breadId, quantity: 2, cost_price_cents: 120 }
      ],
      '首批进货'
    )

    expect(order.order_no).toBe(`${localYmd()}-0001`)
    expect(order.note).toBe('首批进货')
    expect(order.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(order.items).toHaveLength(3)
    expect(order.items.map((i) => i.product_name)).toEqual(['可乐 330ml', '雪碧 330ml', '早餐面包'])
    expect(order.items.map((i) => i.barcode)).toEqual(['6901234567890', '6902345678901', null])

    expect(getStock(colaId)).toBe(110)
    expect(getStock(spriteId)).toBe(55)
    expect(getStock(breadId)).toBe(22)

    const movements = allMovements()
    expect(movements).toHaveLength(3)
    expect(movements.map((m) => m.source_id)).toEqual([order.id, order.id, order.id])
    expect(movements.map((m) => [m.before_stock, m.after_stock])).toEqual([
      [100, 110],
      [50, 55],
      [20, 22]
    ])
    expect(movements.every((m) => m.source === 'purchase')).toBe(true)
    expect(movements.map((m) => m.product_id)).toEqual([colaId, spriteId, breadId])
  })

  it('同品重复行允许：两行同商品独立入账', () => {
    const order = service.createPurchase([
      { kind: 'quantity', product_id: colaId, quantity: 3, cost_price_cents: 200 },
      { kind: 'quantity', product_id: colaId, quantity: 4, cost_price_cents: 190 }
    ])
    expect(order.items).toHaveLength(2)
    expect(getStock(colaId)).toBe(107)
    expect(allMovements().map((m) => m.change_qty)).toEqual([3, 4])
  })
})

// ═══════════ order_no 序列（D18：yyyyMMdd-NNNN，与销售独立）═══════════

describe('purchase.service：order_no 序列', () => {
  it('同日递增 0001/0002/0003，格式 yyyyMMdd-NNNN', () => {
    const o1 = service.createPurchase([{ kind: 'quantity', product_id: colaId, quantity: 1, cost_price_cents: 1 }])
    const o2 = service.createPurchase([{ kind: 'quantity', product_id: spriteId, quantity: 1, cost_price_cents: 1 }])
    const o3 = service.createPurchase([{ kind: 'quantity', product_id: breadId, quantity: 1, cost_price_cents: 1 }])
    expect(o1.order_no).toBe(`${localYmd()}-0001`)
    expect(o2.order_no).toBe(`${localYmd()}-0002`)
    expect(o3.order_no).toBe(`${localYmd()}-0003`)
  })

  it('与销售序列独立：已存在销售单不占用进货序号', () => {
    db.prepare("INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-0001', 100, 1)").run()
    db.prepare("INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-0002', 100, 1)").run()
    const order = service.createPurchase([{ kind: 'quantity', product_id: colaId, quantity: 1, cost_price_cents: 1 }])
    expect(order.order_no).toBe(`${localYmd()}-0001`)
  })
})

// ═══════════ 快照不可变（G4）═══════════

describe('purchase.repo：快照不可变', () => {
  it('商品改名后历史进货明细名称/条码不变（getDetail 读快照列，不 join products）', () => {
    const order = service.createPurchase([{ kind: 'quantity', product_id: colaId, quantity: 10, cost_price_cents: 200 }])
    expect(order.items[0]?.product_name).toBe('可乐 330ml')

    db.prepare("UPDATE products SET name = '改名后的可乐', barcode = '0000000000000' WHERE id = ?").run(colaId)

    const detail = repo.getDetail(order.id)
    expect(detail).toBeDefined()
    expect(detail?.items).toHaveLength(1)
    expect(detail?.items[0]?.product_name).toBe('可乐 330ml')
    expect(detail?.items[0]?.barcode).toBe('6901234567890')

    const viaList = service.list().find((o) => o.id === order.id)
    expect(viaList?.items[0]?.product_name).toBe('可乐 330ml')
  })

  it('getDetail 不存在的单 → undefined', () => {
    expect(repo.getDetail(99999)).toBeUndefined()
  })
})

// ═══════════ 参数校验 ═══════════

describe('purchase.service：参数校验', () => {
  it.each([
    ['空 items', []],
    ['数量为 0', [{ kind: 'quantity', product_id: 1, quantity: 0, cost_price_cents: 100 }]],
    ['数量为负', [{ kind: 'quantity', product_id: 1, quantity: -5, cost_price_cents: 100 }]],
    ['数量非整数', [{ kind: 'quantity', product_id: 1, quantity: 1.5, cost_price_cents: 100 }]],
    ['成本价为负', [{ kind: 'quantity', product_id: 1, quantity: 1, cost_price_cents: -1 }]],
    ['成本价非整数', [{ kind: 'quantity', product_id: 1, quantity: 1, cost_price_cents: 9.9 }]]
  ] as Array<[string, PurchaseInputItem[]]>)('%s → 抛错且零落库', (_label, items) => {
    expect(() => service.createPurchase(items)).toThrow()
    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('stock_movements')).toBe(0)
  })

  it('productId 非正整数 → 抛错', () => {
    expect(() => service.createPurchase([{ kind: 'quantity', product_id: 0, quantity: 1, cost_price_cents: 1 }])).toThrow()
    expect(() => service.createPurchase([{ kind: 'quantity', product_id: -1, quantity: 1, cost_price_cents: 1 }])).toThrow()
  })

  it('note 空串/null → 落库为 null', () => {
    const a = service.createPurchase([{ kind: 'quantity', product_id: colaId, quantity: 1, cost_price_cents: 1 }], '')
    const b = service.createPurchase([{ kind: 'quantity', product_id: colaId, quantity: 1, cost_price_cents: 1 }], null)
    const c = service.createPurchase([{ kind: 'quantity', product_id: colaId, quantity: 1, cost_price_cents: 1 }])
    expect(a.note).toBeNull()
    expect(b.note).toBeNull()
    expect(c.note).toBeNull()
  })
})

// ═══════════ list 组装（头 + 行，品种数 = items.length）═══════════

describe('purchase.service：list', () => {
  it('返回头+行组装，最新在前', () => {
    const o1 = service.createPurchase(
      [
        { kind: 'quantity', product_id: colaId, quantity: 10, cost_price_cents: 200 },
        { kind: 'quantity', product_id: spriteId, quantity: 5, cost_price_cents: 210 }
      ],
      '第一单'
    )
    const o2 = service.createPurchase([{ kind: 'quantity', product_id: breadId, quantity: 3, cost_price_cents: 120 }], null)

    const list = service.list()
    expect(list).toHaveLength(2)
    expect(list[0]?.id).toBe(o2.id)
    expect(list[0]?.order_no).toBe(o2.order_no)
    expect(list[0]?.note).toBeNull()
    expect(list[0]?.items).toHaveLength(1)
    expect(list[0]?.items[0]?.product_name).toBe('早餐面包')
    expect(list[1]?.id).toBe(o1.id)
    expect(list[1]?.items).toHaveLength(2)
    expect(list[1]?.note).toBe('第一单')
  })

  it('日期过滤：date_from 晚于全部单据 → 空（本地日期构造，时区无关）', () => {
    service.createPurchase([{ kind: 'quantity', product_id: colaId, quantity: 1, cost_price_cents: 1 }])
    expect(service.list(localIsoDate(1), undefined)).toHaveLength(0)
    expect(service.list(undefined, '2000-01-01')).toHaveLength(0)
    expect(service.list()).toHaveLength(1)
  })
})

// ═══════════ SN 进货行（T1.3：D-SN9/10/17 展开 + 台账 + 一致性）═══════════

describe('purchase.service：SN 行入库（展开落库）', () => {
  it('1 商品 3 SN → 3 行明细(quantity=1/sn/同成本价) + 3 条台账 in_stock + 库存+3 + 3 条流水，明细含 sn', () => {
    const order = service.createPurchase(
      [{ kind: 'sn', product_id: phoneId, sns: ['SN-A', 'SN-B', 'SN-C'], cost_price_cents: 150000 }],
      '手机进货'
    )

    expect(order.items).toHaveLength(3)
    expect(order.items.map((i) => i.sn)).toEqual(['SN-A', 'SN-B', 'SN-C'])
    expect(order.items.every((i) => i.quantity === 1)).toBe(true)
    expect(order.items.every((i) => i.cost_price_cents === 150000)).toBe(true)
    expect(order.items.every((i) => i.product_name === '测试手机')).toBe(true)
    expect(order.items.every((i) => i.order_id === order.id)).toBe(true)

    const sns = activeSnRows(phoneId)
    expect(sns.map((r) => r.sn)).toEqual(['SN-A', 'SN-B', 'SN-C'])
    expect(sns.every((r) => r.status === 'in_stock' && r.deleted === 0)).toBe(true)
    expect(sns.map((r) => r.purchase_item_id)).toEqual(order.items.map((i) => i.id))

    expect(getStock(phoneId)).toBe(3)

    const movements = allMovements()
    expect(movements).toHaveLength(3)
    expect(movements.every((m) => m.source === 'purchase' && m.source_id === order.id)).toBe(true)
    expect(movements.map((m) => [m.product_id, m.change_qty])).toEqual([
      [phoneId, 1],
      [phoneId, 1],
      [phoneId, 1]
    ])
    expect(movements.map((m) => [m.before_stock, m.after_stock])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3]
    ])

    const detail = repo.getDetail(order.id)
    expect(detail?.items.map((i) => i.sn)).toEqual(['SN-A', 'SN-B', 'SN-C'])
  })

  it('SN 自动 trim 后落库（归一化），空白差异不算不同 SN', () => {
    const order = service.createPurchase([
      { kind: 'sn', product_id: phoneId, sns: ['  SN-T  '], cost_price_cents: 100 }
    ])
    expect(order.items[0]?.sn).toBe('SN-T')
    expect(activeSnRows(phoneId)[0]?.sn).toBe('SN-T')

    expect(() =>
      service.createPurchase([{ kind: 'sn', product_id: phoneId, sns: ['SN-T', ' SN-T '], cost_price_cents: 100 }])
    ).toThrow(/进货单内 SN 重复：SN-T/)
  })

  it('D-SN13 一致性：入库后 products.stock === 在库 SN 数', () => {
    service.createPurchase([
      { kind: 'sn', product_id: phoneId, sns: ['SN-1', 'SN-2'], cost_price_cents: 100 },
      { kind: 'sn', product_id: padId, sns: ['PAD-1'], cost_price_cents: 200 }
    ])
    expect(getStock(phoneId)).toBe(inStockSnCount(phoneId))
    expect(getStock(padId)).toBe(inStockSnCount(padId))
    expect(getStock(colaId)).toBe(100)
  })
})

describe('purchase.service：混排单（批量计行 + SN 行）', () => {
  it('两类行同单落库：各自展开、库存与流水独立正确', () => {
    const order = service.createPurchase([
      { kind: 'quantity', product_id: colaId, quantity: 10, cost_price_cents: 200 },
      { kind: 'sn', product_id: phoneId, sns: ['SN-X', 'SN-Y'], cost_price_cents: 150000 }
    ])

    expect(order.items).toHaveLength(3)
    expect(order.items[0]).toMatchObject({ product_name: '可乐 330ml', quantity: 10, sn: null })
    expect(order.items.slice(1).map((i) => i.sn)).toEqual(['SN-X', 'SN-Y'])

    expect(getStock(colaId)).toBe(110)
    expect(getStock(phoneId)).toBe(2)
    expect(countRows('product_sns')).toBe(2)

    const movements = allMovements()
    expect(movements.map((m) => [m.product_id, m.change_qty])).toEqual([
      [colaId, 10],
      [phoneId, 1],
      [phoneId, 1]
    ])
    expect(movements.map((m) => [m.before_stock, m.after_stock])).toEqual([
      [100, 110],
      [0, 1],
      [1, 2]
    ])
  })
})

describe('purchase.service：本单内 SN 重复', () => {
  it('两个 sn 行共享同一 SN → 拒绝且整单回滚（零落库）', () => {
    expect(() =>
      service.createPurchase([
        { kind: 'sn', product_id: phoneId, sns: ['SN-A'], cost_price_cents: 100 },
        { kind: 'sn', product_id: padId, sns: ['SN-B', 'SN-A'], cost_price_cents: 100 }
      ])
    ).toThrow(/进货单内 SN 重复：SN-A/)

    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('purchase_items')).toBe(0)
    expect(countRows('product_sns')).toBe(0)
    expect(countRows('stock_movements')).toBe(0)
    expect(getStock(phoneId)).toBe(0)
    expect(getStock(padId)).toBe(0)
  })

  it('同一行数组内 SN 重复 → 拒绝且零落库', () => {
    expect(() =>
      service.createPurchase([
        { kind: 'sn', product_id: phoneId, sns: ['SN-A', 'SN-A'], cost_price_cents: 100 }
      ])
    ).toThrow(/进货单内 SN 重复：SN-A/)
    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('product_sns')).toBe(0)
    expect(countRows('stock_movements')).toBe(0)
  })
})

describe('purchase.service：SN 台账查重（事务内，D-SN4/17）', () => {
  it('已在库 SN 再次进货 → 拒绝（文案含在库商品名，跨商品亦然）且回滚', () => {
    service.createPurchase([{ kind: 'sn', product_id: phoneId, sns: ['SN-A'], cost_price_cents: 100 }])

    expect(() =>
      service.createPurchase([{ kind: 'sn', product_id: phoneId, sns: ['SN-A'], cost_price_cents: 100 }])
    ).toThrow(/SN SN-A 已在库（商品「测试手机」）/)
    expect(() =>
      service.createPurchase([{ kind: 'sn', product_id: padId, sns: ['SN-A'], cost_price_cents: 100 }])
    ).toThrow(/SN SN-A 已在库（商品「测试手机」）/)

    expect(countRows('purchase_orders')).toBe(1)
    expect(countRows('product_sns')).toBe(1)
    expect(countRows('stock_movements')).toBe(1)
    expect(getStock(phoneId)).toBe(1)
    expect(getStock(padId)).toBe(0)
  })

  it('已售 SN 再次进货 → 拒绝并提示原销售单号（D-SN17）且回滚', () => {
    service.createPurchase([{ kind: 'sn', product_id: phoneId, sns: ['SN-S'], cost_price_cents: 100 }])
    // 模拟已售（raw SQL 构造销售链，绕过 sale.service——非本任务范围）
    const saleId = Number(
      db
        .prepare("INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-0099', 2999, 1)")
        .run().lastInsertRowid
    )
    const saleItemId = Number(
      db
        .prepare(
          `INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents, sn)
           VALUES (?, ?, '测试手机', NULL, 1, 2999, 2999, 'SN-S')`
        )
        .run(saleId, phoneId).lastInsertRowid
    )
    db.prepare("UPDATE product_sns SET status = 'sold', sale_item_id = ? WHERE sn = 'SN-S'").run(saleItemId)
    db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').run(phoneId)

    expect(() =>
      service.createPurchase([{ kind: 'sn', product_id: phoneId, sns: ['SN-S'], cost_price_cents: 100 }])
    ).toThrow(/SN SN-S 已售出（销售单 20261101-0099），如需退货请作废原单/)

    expect(countRows('purchase_orders')).toBe(1)
    expect(countRows('product_sns')).toBe(1)
    expect(activeSnRows(phoneId)[0]?.status).toBe('sold')
  })

  it('已逻辑删除的 SN 可重新入库（D-SN4：partial unique index 只约束 active 行）', () => {
    service.createPurchase([{ kind: 'sn', product_id: phoneId, sns: ['SN-D'], cost_price_cents: 100 }])
    // 模拟 deleteSn 语义（raw SQL：逻辑删除 + stock-1）
    db.prepare("UPDATE product_sns SET deleted = 1, updated_at = datetime('now','localtime') WHERE sn = 'SN-D'").run()
    db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').run(phoneId)
    expect(inStockSnCount(phoneId)).toBe(0)

    const order2 = service.createPurchase([
      { kind: 'sn', product_id: phoneId, sns: ['SN-D'], cost_price_cents: 120 }
    ])

    expect(order2.items[0]?.sn).toBe('SN-D')
    const rows = db
      .prepare('SELECT deleted, status FROM product_sns WHERE sn = ? ORDER BY id')
      .all('SN-D') as unknown as Array<{ deleted: number; status: string }>
    expect(rows).toEqual([
      { deleted: 1, status: 'in_stock' },
      { deleted: 0, status: 'in_stock' }
    ])
    expect(getStock(phoneId)).toBe(1)
    expect(getStock(phoneId)).toBe(inStockSnCount(phoneId))
  })
})

describe('purchase.service：行类型与商品 tracking 不符（D-SN9）', () => {
  it('sn 行指向批量计商品 → 拒绝且整单回滚', () => {
    expect(() =>
      service.createPurchase([
        { kind: 'quantity', product_id: colaId, quantity: 5, cost_price_cents: 100 },
        { kind: 'sn', product_id: colaId, sns: ['SN-Q'], cost_price_cents: 100 }
      ])
    ).toThrow(/商品「可乐 330ml」不是 SN 商品，不能按 SN 入库/)

    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('purchase_items')).toBe(0)
    expect(countRows('product_sns')).toBe(0)
    expect(countRows('stock_movements')).toBe(0)
    expect(getStock(colaId)).toBe(100)
  })

  it('quantity 行指向 SN 商品 → 拒绝且整单回滚', () => {
    expect(() =>
      service.createPurchase([{ kind: 'quantity', product_id: phoneId, quantity: 3, cost_price_cents: 100 }])
    ).toThrow(/商品「测试手机」是 SN 商品，必须按 SN 入库/)

    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('purchase_items')).toBe(0)
    expect(countRows('stock_movements')).toBe(0)
    expect(getStock(phoneId)).toBe(0)
  })
})

describe('purchase.service：SN 行结构校验（事务外快速失败）', () => {
  it.each([
    ['空 SN 列表', [{ kind: 'sn', product_id: 1, sns: [], cost_price_cents: 100 }]],
    ['空白 SN', [{ kind: 'sn', product_id: 1, sns: ['SN-A', '   '], cost_price_cents: 100 }]],
    ['空串 SN', [{ kind: 'sn', product_id: 1, sns: [''], cost_price_cents: 100 }]],
    ['非字符串 SN', [{ kind: 'sn', product_id: 1, sns: [123 as unknown as string], cost_price_cents: 100 }]],
    ['超长 SN', [{ kind: 'sn', product_id: 1, sns: ['X'.repeat(129)], cost_price_cents: 100 }]],
    ['负成本价', [{ kind: 'sn', product_id: 1, sns: ['SN-A'], cost_price_cents: -1 }]],
    ['非整数成本价', [{ kind: 'sn', product_id: 1, sns: ['SN-A'], cost_price_cents: 9.9 }]],
    ['product_id 非法', [{ kind: 'sn', product_id: 0, sns: ['SN-A'], cost_price_cents: 100 }]],
    ['行类型缺失', [{ product_id: 1, sns: ['SN-A'], cost_price_cents: 100 } as unknown as PurchaseInputItem]]
  ] as Array<[string, PurchaseInputItem[]]>)('%s → 抛错且零落库', (_label, items) => {
    expect(() => service.createPurchase(items)).toThrow()
    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('purchase_items')).toBe(0)
    expect(countRows('product_sns')).toBe(0)
    expect(countRows('stock_movements')).toBe(0)
  })
})
