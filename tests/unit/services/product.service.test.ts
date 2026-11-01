/**
 * Task 8 — 商品管理 service 层测试（TDD 先行）。
 *
 * 覆盖：
 * - create：全字段 / 负库存允许（D2）/ 初始库存写流水（G5 审计链）/ 条码冲突 /
 *   参数校验（name 非空、stock 整数、price 整数分 ≥0、barcode 空串归一为 null）
 * - updateStock：before/after 快照流水（验收原文 5→3 → {change_qty:-2, before:5, after:3, source:'manual'}）
 * - update / delete：存在性校验、willOrphan（sale_items + purchase_items 关联计数）
 * - delete：快照行保留（product_id 置 NULL）、库存流水随商品清除（DDL NOT NULL FK 约束决策）
 * - list：名称 LIKE 子串 / 条码前缀 / LIKE 通配符转义
 */

import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import {
  createProductService,
  ProductServiceError
} from '../../../src/main/services/product.service'

let db: Database.Database
let service: ReturnType<typeof createProductService>

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  service = createProductService(db)
})

// ── 测试辅助 ──

interface MovementRow {
  product_id: number
  change_qty: number
  before_stock: number
  after_stock: number
  source: string
  source_id: number | null
}

function movementsOf(productId: number): MovementRow[] {
  return db
    .prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id')
    .all(productId) as MovementRow[]
}

function rawProduct(id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, unknown>
}

let refSeq = 0

/** 直插一条 sale_items 引用（模拟历史销售单据，product_id 外键快照设计） */
function insertSaleItemRef(productId: number, name: string): void {
  const saleNo = `20260101-${String(++refSeq).padStart(4, '0')}`
  const sale = db
    .prepare('INSERT INTO sales (sale_no, total_cents, item_count) VALUES (?, 100, 1)')
    .run(saleNo)
  db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
     VALUES (?, ?, ?, NULL, 1, 100, 100)`
  ).run(Number(sale.lastInsertRowid), productId, name)
}

function insertPurchaseItemRef(productId: number, name: string): void {
  const orderNo = `20260101-P${String(++refSeq).padStart(4, '0')}`
  const order = db
    .prepare('INSERT INTO purchase_orders (order_no) VALUES (?)')
    .run(orderNo)
  db.prepare(
    `INSERT INTO purchase_items (order_id, product_id, product_name, barcode, quantity, cost_price_cents)
     VALUES (?, ?, ?, NULL, 1, 50)`
  ).run(Number(order.lastInsertRowid), productId, name)
}

function expectServiceError(fn: () => unknown, code: string, message?: string): void {
  try {
    fn()
    expect.unreachable(`应抛错误 ${code} 但正常返回`)
  } catch (err) {
    expect(err).toBeInstanceOf(ProductServiceError)
    const e = err as ProductServiceError
    expect(e.code).toBe(code)
    if (message !== undefined) expect(e.message).toBe(message)
  }
}

// ══════════════ create ══════════════

describe('productService.create', () => {
  it('全字段创建：返回值与 DB 行一致（金额整数分 G1）', () => {
    const created = service.create({
      barcode: '6901234567890',
      name: '可口可乐 330ml',
      default_price_cents: 350,
      stock: 100
    })

    expect(created.id).toBeGreaterThan(0)
    expect(created.barcode).toBe('6901234567890')
    expect(created.name).toBe('可口可乐 330ml')
    expect(created.default_price_cents).toBe(350)
    expect(created.stock).toBe(100)

    const row = rawProduct(created.id)
    expect(row['stock']).toBe(100)
    expect(row['default_price_cents']).toBe(350)
    expect(row['barcode']).toBe('6901234567890')
  })

  it('初始库存非 0 写流水：source=manual，before=0 after=stock（G5 审计链）', () => {
    const created = service.create({
      barcode: null,
      name: '无码商品',
      default_price_cents: null,
      stock: 6
    })

    const movements = movementsOf(created.id)
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({
      product_id: created.id,
      change_qty: 6,
      before_stock: 0,
      after_stock: 6,
      source: 'manual',
      source_id: null
    })
  })

  it('初始库存为 0 不写流水（0 变动无审计噪音）', () => {
    const created = service.create({
      barcode: null,
      name: '零库存商品',
      default_price_cents: null,
      stock: 0
    })
    expect(movementsOf(created.id)).toHaveLength(0)
  })

  it('负库存创建允许（D2）：stock=-5 成功且流水 before=0 after=-5', () => {
    const created = service.create({
      barcode: null,
      name: '盘亏商品',
      default_price_cents: 200,
      stock: -5
    })

    expect(created.stock).toBe(-5)
    const movements = movementsOf(created.id)
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({
      change_qty: -5,
      before_stock: 0,
      after_stock: -5,
      source: 'manual'
    })
  })

  it('重复条码抛 BARCODE_CONFLICT，中文消息「条码已存在」', () => {
    service.create({ barcode: '6901234567890', name: '可乐', default_price_cents: null, stock: 0 })
    expectServiceError(
      () =>
        service.create({
          barcode: '6901234567890',
          name: '另一瓶可乐',
          default_price_cents: null,
          stock: 0
        }),
      'BARCODE_CONFLICT',
      '条码已存在'
    )
  })

  it('条码大小写敏感（SQLite binary collation）：ABC 与 abc 不冲突', () => {
    service.create({ barcode: 'abc123', name: 'A 商品', default_price_cents: null, stock: 0 })
    expect(() =>
      service.create({ barcode: 'ABC123', name: 'B 商品', default_price_cents: null, stock: 0 })
    ).not.toThrow()
  })

  it('barcode 空串/纯空格归一为 null（无条码商品 D17）', () => {
    const a = service.create({ barcode: '', name: '无码 A', default_price_cents: null, stock: 0 })
    const b = service.create({ barcode: '   ', name: '无码 B', default_price_cents: null, stock: 0 })
    expect(a.barcode).toBeNull()
    expect(b.barcode).toBeNull()
  })

  it('name 为空串/纯空格/非字符串抛 INVALID_NAME', () => {
    expectServiceError(
      () => service.create({ barcode: null, name: '', default_price_cents: null, stock: 0 }),
      'INVALID_NAME',
      '商品名称不能为空'
    )
    expectServiceError(
      () => service.create({ barcode: null, name: '   ', default_price_cents: null, stock: 0 }),
      'INVALID_NAME'
    )
    expectServiceError(
      () =>
        service.create({
          barcode: null,
          name: 42 as unknown as string,
          default_price_cents: null,
          stock: 0
        }),
      'INVALID_NAME'
    )
  })

  it('stock 非整数抛 INVALID_STOCK（浮点/字符串均拒绝）', () => {
    expectServiceError(
      () => service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 1.5 }),
      'INVALID_STOCK'
    )
    expectServiceError(
      () =>
        service.create({
          barcode: null,
          name: 'X',
          default_price_cents: null,
          stock: '5' as unknown as number
        }),
      'INVALID_STOCK'
    )
  })

  it('price 非整数分或负数抛 INVALID_PRICE（一律整数分 G1）', () => {
    expectServiceError(
      () => service.create({ barcode: null, name: 'X', default_price_cents: -1, stock: 0 }),
      'INVALID_PRICE'
    )
    expectServiceError(
      () => service.create({ barcode: null, name: 'X', default_price_cents: 350.5, stock: 0 }),
      'INVALID_PRICE'
    )
  })

  it('price 为 null 允许（默认售价可空）', () => {
    const created = service.create({
      barcode: null,
      name: '无价商品',
      default_price_cents: null,
      stock: 0
    })
    expect(created.default_price_cents).toBeNull()
  })
})

// ══════════════ update ══════════════

describe('productService.update', () => {
  it('更新名称与默认售价成功', () => {
    const created = service.create({
      barcode: '6901234567890',
      name: '旧名',
      default_price_cents: 300,
      stock: 10
    })

    const updated = service.update({
      id: created.id,
      name: '新名',
      default_price_cents: 500
    })

    expect(updated.name).toBe('新名')
    expect(updated.default_price_cents).toBe(500)
    expect(rawProduct(created.id)['name']).toBe('新名')
  })

  it('售价可清空为 null', () => {
    const created = service.create({
      barcode: null,
      name: 'X',
      default_price_cents: 300,
      stock: 0
    })
    expect(service.update({ id: created.id, name: 'X', default_price_cents: null }).default_price_cents).toBeNull()
  })

  it('name 为空抛 INVALID_NAME；price 非法抛 INVALID_PRICE', () => {
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 0 })
    expectServiceError(() => service.update({ id: created.id, name: ' ', default_price_cents: null }), 'INVALID_NAME')
    expectServiceError(() => service.update({ id: created.id, name: 'X', default_price_cents: -5 }), 'INVALID_PRICE')
  })

  it('不存在的 id 抛 PRODUCT_NOT_FOUND', () => {
    expectServiceError(() => service.update({ id: 999, name: 'X', default_price_cents: null }), 'PRODUCT_NOT_FOUND')
  })
})

// ══════════════ updateStock（G5 核心）══════════════

describe('productService.updateStock', () => {
  it('验收原文：5→3 后流水 {change_qty:-2, before:5, after:3, source:manual}', () => {
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 5 })

    const updated = service.updateStock({ id: created.id, stock: 3 })

    expect(updated.stock).toBe(3)
    const movements = movementsOf(created.id)
    expect(movements).toHaveLength(2) // 创建 0→5 + 调整 5→3
    expect(movements[1]).toMatchObject({
      product_id: created.id,
      change_qty: -2,
      before_stock: 5,
      after_stock: 3,
      source: 'manual',
      source_id: null
    })
  })

  it('调为负库存允许（D2）：3→-5 流水 {change_qty:-8, before:3, after:-5}', () => {
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 3 })
    const updated = service.updateStock({ id: created.id, stock: -5 })
    expect(updated.stock).toBe(-5)
    expect(movementsOf(created.id).at(-1)).toMatchObject({
      change_qty: -8,
      before_stock: 3,
      after_stock: -5,
      source: 'manual'
    })
  })

  it('同值调整也记录流水（change_qty=0，留审计痕迹）', () => {
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 5 })
    service.updateStock({ id: created.id, stock: 5 })
    expect(movementsOf(created.id).at(-1)).toMatchObject({
      change_qty: 0,
      before_stock: 5,
      after_stock: 5
    })
  })

  it('非整数库存抛 INVALID_STOCK（允许负值但必须整数——D2/D4）', () => {
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 5 })
    expectServiceError(() => service.updateStock({ id: created.id, stock: 4.2 }), 'INVALID_STOCK')
    expectServiceError(
      () => service.updateStock({ id: created.id, stock: NaN }),
      'INVALID_STOCK'
    )
  })

  it('不存在的 id 抛 PRODUCT_NOT_FOUND', () => {
    expectServiceError(() => service.updateStock({ id: 999, stock: 1 }), 'PRODUCT_NOT_FOUND')
  })

  it('调整库存不影响名称/售价/条码', () => {
    const created = service.create({
      barcode: '6901234567890',
      name: 'X',
      default_price_cents: 100,
      stock: 5
    })
    const updated = service.updateStock({ id: created.id, stock: 9 })
    expect(updated.name).toBe('X')
    expect(updated.barcode).toBe('6901234567890')
    expect(updated.default_price_cents).toBe(100)
  })
})

// ══════════════ delete ══════════════

describe('productService.delete', () => {
  it('无引用商品删除：willOrphan=0，行消失', () => {
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 5 })
    const result = service.delete({ id: created.id })

    expect(result).toEqual({ ok: true, willOrphan: 0 })
    expect(rawProduct(created.id)).toBeUndefined()
  })

  it('带 sale/purchase 引用删除：willOrphan=计数，快照行保留且 product_id 置 NULL', () => {
    const created = service.create({ barcode: '6901234567890', name: '可乐', default_price_cents: 350, stock: 10 })
    insertSaleItemRef(created.id, '可乐')
    insertSaleItemRef(created.id, '可乐')
    insertPurchaseItemRef(created.id, '可乐')

    const result = service.delete({ id: created.id })

    expect(result).toEqual({ ok: true, willOrphan: 3 })
    // 商品硬删
    expect(rawProduct(created.id)).toBeUndefined()
    // 快照行保留：名称原值，product_id 断链置 NULL（外键 SET NULL 语义，DDL 未带 ON DELETE 由应用层补齐）
    const saleItems = db
      .prepare('SELECT product_name, product_id FROM sale_items')
      .all() as Array<{ product_name: string; product_id: number | null }>
    expect(saleItems).toHaveLength(2)
    for (const item of saleItems) {
      expect(item.product_name).toBe('可乐')
      expect(item.product_id).toBeNull()
    }
    const purchaseItems = db
      .prepare('SELECT product_name, product_id FROM purchase_items')
      .all() as Array<{ product_name: string; product_id: number | null }>
    expect(purchaseItems).toHaveLength(1)
    expect(purchaseItems[0]!.product_id).toBeNull()
    // stock_movements.product_id NOT NULL FK：随商品清除（决策记录 learnings）
    expect(movementsOf(created.id)).toHaveLength(0)
  })

  it('不存在的 id 抛 PRODUCT_NOT_FOUND', () => {
    expectServiceError(() => service.delete({ id: 999 }), 'PRODUCT_NOT_FOUND')
  })
})

// ══════════════ list（LIKE 搜索矩阵）══════════════

describe('productService.list', () => {
  beforeEach(() => {
    service.create({ barcode: '6901234567890', name: '可口可乐 330ml', default_price_cents: 350, stock: 10 })
    service.create({ barcode: '6902345678901', name: '雪碧 330ml', default_price_cents: 350, stock: 5 })
    service.create({ barcode: null, name: '早餐面包（无条码）', default_price_cents: 450, stock: -3 })
  })

  it('无关键字返回全量（新创建在前 id DESC）', () => {
    const rows = service.list()
    expect(rows).toHaveLength(3)
    expect(rows[0]!.name).toBe('早餐面包（无条码）')
    expect(rows.map((r) => r.name)).toContain('可口可乐 330ml')
  })

  it('名称子串匹配：「可乐」命中可口可乐', () => {
    const rows = service.list('可乐')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('可口可乐 330ml')
  })

  it('条码前缀匹配：「6901」命中；条码中段/后缀不命中（前缀语义）', () => {
    expect(service.list('6901')).toHaveLength(1)
    expect(service.list('2345678901')).toHaveLength(0)
    expect(service.list('7890')).toHaveLength(0)
  })

  it('条码与名称同时搜索：任一命中即返回', () => {
    expect(service.list('雪碧')).toHaveLength(1)
    expect(service.list('6902')).toHaveLength(1)
    expect(service.list('面包')).toHaveLength(1)
    expect(service.list('不存在的关键词')).toHaveLength(0)
  })

  it('LIKE 通配符按字面匹配：搜索「%」只命中名字含 % 的商品', () => {
    service.create({ barcode: null, name: '100%果汁', default_price_cents: null, stock: 0 })
    const rows = service.list('%')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('100%果汁')
  })

  it('搜索词纯空格视为无关键字', () => {
    expect(service.list('   ')).toHaveLength(3)
  })

  it('行带 willOrphan：无引用为 0；有引用为计数（删除弹窗文案用）', () => {
    expect(service.list('可乐')[0]!.willOrphan).toBe(0)

    const sprite = service.list('雪碧')[0]!
    insertSaleItemRef(sprite.id, '雪碧 330ml')
    expect(service.list('雪碧')[0]!.willOrphan).toBe(1)
  })
})
