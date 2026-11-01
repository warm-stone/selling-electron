import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../../src/main/db/database'
import {
  createPurchaseService,
  type PurchaseService
} from '../../../src/main/services/purchase.service'
import { createPurchaseRepo } from '../../../src/main/db/repositories/purchase.repo'
import { insertProduct } from '../../fixtures/seed'
import type { StockMovement } from '../../../src/shared/types'

let dir: string
let db: Database.Database
let service: PurchaseService
let repo: ReturnType<typeof createPurchaseRepo>
let colaId: number
let spriteId: number
let breadId: number

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-purchase-'))
  db = initDatabase(dir)
  colaId = insertProduct(db, { barcode: '6901234567890', name: '可乐 330ml', default_price_cents: 350, stock: 100 })
  spriteId = insertProduct(db, { barcode: '6902345678901', name: '雪碧 330ml', default_price_cents: 350, stock: 50 })
  breadId = insertProduct(db, { barcode: null, name: '早餐面包', default_price_cents: 450, stock: 20 })
  service = createPurchaseService(db)
  repo = createPurchaseRepo(db)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ═══════════ 事务原子性（TDD 核心：部分失败全回滚）═══════════

describe('purchase.service：入库事务原子性', () => {
  it('第二个 item 的 productId 不存在 → 整单不入库、库存不变、流水零行', () => {
    expect(() =>
      service.createPurchase(
        [
          { product_id: colaId, quantity: 10, cost_price_cents: 200 },
          { product_id: 99999, quantity: 3, cost_price_cents: 100 }
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
        { product_id: 99999, quantity: 1, cost_price_cents: 100 },
        { product_id: colaId, quantity: 1, cost_price_cents: 100 }
      ])
    ).toThrow(/商品不存在/)
    expect(countRows('purchase_orders')).toBe(0)
    expect(getStock(colaId)).toBe(100)
  })
})

// ═══════════ 正常入库：库存联动 + 流水审计链 + 快照 ═══════════

describe('purchase.service：正常入库', () => {
  it('3 行入库：库存 +10/+5/+2，流水 3 行 source=purchase 且 before/after 衔接，items 含商品快照', () => {
    const order = service.createPurchase(
      [
        { product_id: colaId, quantity: 10, cost_price_cents: 200 },
        { product_id: spriteId, quantity: 5, cost_price_cents: 210 },
        { product_id: breadId, quantity: 2, cost_price_cents: 120 }
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
      { product_id: colaId, quantity: 3, cost_price_cents: 200 },
      { product_id: colaId, quantity: 4, cost_price_cents: 190 }
    ])
    expect(order.items).toHaveLength(2)
    expect(getStock(colaId)).toBe(107)
    expect(allMovements().map((m) => m.change_qty)).toEqual([3, 4])
  })
})

// ═══════════ order_no 序列（D18：yyyyMMdd-NNNN，与销售独立）═══════════

describe('purchase.service：order_no 序列', () => {
  it('同日递增 0001/0002/0003，格式 yyyyMMdd-NNNN', () => {
    const o1 = service.createPurchase([{ product_id: colaId, quantity: 1, cost_price_cents: 1 }])
    const o2 = service.createPurchase([{ product_id: spriteId, quantity: 1, cost_price_cents: 1 }])
    const o3 = service.createPurchase([{ product_id: breadId, quantity: 1, cost_price_cents: 1 }])
    expect(o1.order_no).toBe(`${localYmd()}-0001`)
    expect(o2.order_no).toBe(`${localYmd()}-0002`)
    expect(o3.order_no).toBe(`${localYmd()}-0003`)
  })

  it('与销售序列独立：已存在销售单不占用进货序号', () => {
    db.prepare("INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-0001', 100, 1)").run()
    db.prepare("INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-0002', 100, 1)").run()
    const order = service.createPurchase([{ product_id: colaId, quantity: 1, cost_price_cents: 1 }])
    expect(order.order_no).toBe(`${localYmd()}-0001`)
  })
})

// ═══════════ 快照不可变（G4）═══════════

describe('purchase.repo：快照不可变', () => {
  it('商品改名后历史进货明细名称/条码不变（getDetail 读快照列，不 join products）', () => {
    const order = service.createPurchase([{ product_id: colaId, quantity: 10, cost_price_cents: 200 }])
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
    ['空 items', [] as Array<{ product_id: number; quantity: number; cost_price_cents: number }>],
    ['数量为 0', [{ product_id: 1, quantity: 0, cost_price_cents: 100 }]],
    ['数量为负', [{ product_id: 1, quantity: -5, cost_price_cents: 100 }]],
    ['数量非整数', [{ product_id: 1, quantity: 1.5, cost_price_cents: 100 }]],
    ['成本价为负', [{ product_id: 1, quantity: 1, cost_price_cents: -1 }]],
    ['成本价非整数', [{ product_id: 1, quantity: 1, cost_price_cents: 9.9 }]]
  ])('%s → 抛错且零落库', (_label, items) => {
    expect(() => service.createPurchase(items)).toThrow()
    expect(countRows('purchase_orders')).toBe(0)
    expect(countRows('stock_movements')).toBe(0)
  })

  it('productId 非正整数 → 抛错', () => {
    expect(() => service.createPurchase([{ product_id: 0, quantity: 1, cost_price_cents: 1 }])).toThrow()
    expect(() => service.createPurchase([{ product_id: -1, quantity: 1, cost_price_cents: 1 }])).toThrow()
  })

  it('note 空串/null → 落库为 null', () => {
    const a = service.createPurchase([{ product_id: colaId, quantity: 1, cost_price_cents: 1 }], '')
    const b = service.createPurchase([{ product_id: colaId, quantity: 1, cost_price_cents: 1 }], null)
    const c = service.createPurchase([{ product_id: colaId, quantity: 1, cost_price_cents: 1 }])
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
        { product_id: colaId, quantity: 10, cost_price_cents: 200 },
        { product_id: spriteId, quantity: 5, cost_price_cents: 210 }
      ],
      '第一单'
    )
    const o2 = service.createPurchase([{ product_id: breadId, quantity: 3, cost_price_cents: 120 }], null)

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
    service.createPurchase([{ product_id: colaId, quantity: 1, cost_price_cents: 1 }])
    expect(service.list(localIsoDate(1), undefined)).toHaveLength(0)
    expect(service.list(undefined, '2000-01-01')).toHaveLength(0)
    expect(service.list()).toHaveLength(1)
  })
})
