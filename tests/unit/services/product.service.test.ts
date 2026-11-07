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
 *
 * SN 商品（Wave 2——计划 §2 D-SN1..17）：
 * - create：tracking/sn_prefix 真实落库、sn 时 stock 强制 0（D-SN11）
 * - 前缀互斥（D-SN14）：相同 / 互为前缀 / 空 / 自身编辑排除 / 大小写敏感（R7）
 * - updateStock 守卫（D-SN11）/ delete 守卫（D-SN15，含 product_sns 级联清除）
 * - findSn / listSns / deleteSn（D-SN16：逻辑删除 + stock-1 + manual 流水 -1）
 * - 一致性（D-SN13）：每次变更后 products.stock === 在库 SN 计数
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

// ── SN 商品测试辅助（进货录入落库由 purchase 侧负责，此处直插模拟稳态）──

function rawSnRow(id: number): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM product_sns WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
}

function insertSnRow(
  productId: number,
  sn: string,
  status: 'in_stock' | 'sold' = 'in_stock'
): number {
  const result = db
    .prepare('INSERT INTO product_sns (product_id, sn, status) VALUES (?, ?, ?)')
    .run(productId, sn, status)
  return Number(result.lastInsertRowid)
}

/** 模拟进货入库后的稳态：N 个在库 SN + stock=N（D-SN13 冗余一致） */
function seedSns(productId: number, sns: string[]): number[] {
  const ids = sns.map((sn) => insertSnRow(productId, sn))
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(sns.length, productId)
  return ids
}

/** 模拟已售 SN：销售单 + sale_items 快照行 + product_sns(sold, sale_item_id) */
function insertSoldSn(
  productId: number,
  productName: string,
  sn: string
): { snId: number; saleNo: string } {
  const saleNo = `20260101-SN${String(++refSeq).padStart(4, '0')}`
  const sale = db
    .prepare('INSERT INTO sales (sale_no, total_cents, item_count) VALUES (?, 100, 1)')
    .run(saleNo)
  const item = db
    .prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents, sn)
       VALUES (?, ?, ?, NULL, 1, 100, 100, ?)`
    )
    .run(Number(sale.lastInsertRowid), productId, productName, sn)
  const result = db
    .prepare(
      `INSERT INTO product_sns (product_id, sn, status, sale_item_id) VALUES (?, ?, 'sold', ?)`
    )
    .run(productId, sn, Number(item.lastInsertRowid))
  return { snId: Number(result.lastInsertRowid), saleNo }
}

/** D-SN13 一致性断言：products.stock === 在库 SN 计数（status='in_stock' AND deleted=0） */
function expectStockConsistent(productId: number): void {
  const product = rawProduct(productId)
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n FROM product_sns
       WHERE product_id = ? AND status = 'in_stock' AND deleted = 0`
    )
    .get(productId) as { n: number }
  expect(product!['stock']).toBe(count.n)
}

// ══════════════ create ══════════════

describe('productService.create', () => {
  it('全字段创建：返回值与 DB 行一致（金额整数分 G1）', () => {
    const created = service.create({
      barcode: '6901234567890',
      name: '可口可乐 330ml',
      default_price_cents: 350,
      stock: 100,
      tracking: 'quantity'
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
      stock: 6,
      tracking: 'quantity'
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
      stock: 0,
      tracking: 'quantity'
    })
    expect(movementsOf(created.id)).toHaveLength(0)
  })

  it('负库存创建允许（D2）：stock=-5 成功且流水 before=0 after=-5', () => {
    const created = service.create({
      barcode: null,
      name: '盘亏商品',
      default_price_cents: 200,
      stock: -5,
      tracking: 'quantity'
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
    service.create({ barcode: '6901234567890', name: '可乐', default_price_cents: null, stock: 0, tracking: 'quantity' })
    expectServiceError(
      () =>
        service.create({
          barcode: '6901234567890',
          name: '另一瓶可乐',
          default_price_cents: null,
          stock: 0,
          tracking: 'quantity'
        }),
      'BARCODE_CONFLICT',
      '条码已存在'
    )
  })

  it('条码大小写敏感（SQLite binary collation）：ABC 与 abc 不冲突', () => {
    service.create({ barcode: 'abc123', name: 'A 商品', default_price_cents: null, stock: 0, tracking: 'quantity' })
    expect(() =>
      service.create({ barcode: 'ABC123', name: 'B 商品', default_price_cents: null, stock: 0, tracking: 'quantity' })
    ).not.toThrow()
  })

  it('barcode 空串/纯空格归一为 null（无条码商品 D17）', () => {
    const a = service.create({ barcode: '', name: '无码 A', default_price_cents: null, stock: 0, tracking: 'quantity' })
    const b = service.create({ barcode: '   ', name: '无码 B', default_price_cents: null, stock: 0, tracking: 'quantity' })
    expect(a.barcode).toBeNull()
    expect(b.barcode).toBeNull()
  })

  it('name 为空串/纯空格/非字符串抛 INVALID_NAME', () => {
    expectServiceError(
      () => service.create({ barcode: null, name: '', default_price_cents: null, stock: 0, tracking: 'quantity' }),
      'INVALID_NAME',
      '商品名称不能为空'
    )
    expectServiceError(
      () => service.create({ barcode: null, name: '   ', default_price_cents: null, stock: 0, tracking: 'quantity' }),
      'INVALID_NAME'
    )
    expectServiceError(
      () =>
        service.create({
          barcode: null,
          name: 42 as unknown as string,
          default_price_cents: null,
          stock: 0,
          tracking: 'quantity'
        }),
      'INVALID_NAME'
    )
  })

  it('stock 非整数抛 INVALID_STOCK（浮点/字符串均拒绝）', () => {
    expectServiceError(
      () => service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 1.5, tracking: 'quantity' }),
      'INVALID_STOCK'
    )
    expectServiceError(
      () =>
        service.create({
          barcode: null,
          name: 'X',
          default_price_cents: null,
          stock: '5' as unknown as number,
          tracking: 'quantity'
        }),
      'INVALID_STOCK'
    )
  })

  it('price 非整数分或负数抛 INVALID_PRICE（一律整数分 G1）', () => {
    expectServiceError(
      () => service.create({ barcode: null, name: 'X', default_price_cents: -1, stock: 0, tracking: 'quantity' }),
      'INVALID_PRICE'
    )
    expectServiceError(
      () => service.create({ barcode: null, name: 'X', default_price_cents: 350.5, stock: 0, tracking: 'quantity' }),
      'INVALID_PRICE'
    )
  })

  it('price 为 null 允许（默认售价可空）', () => {
    const created = service.create({
      barcode: null,
      name: '无价商品',
      default_price_cents: null,
      stock: 0,
      tracking: 'quantity'
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
      stock: 10,
      tracking: 'quantity'
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
      stock: 0,
      tracking: 'quantity'
    })
    expect(service.update({ id: created.id, name: 'X', default_price_cents: null }).default_price_cents).toBeNull()
  })

  it('name 为空抛 INVALID_NAME；price 非法抛 INVALID_PRICE', () => {
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 0, tracking: 'quantity' })
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
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 5, tracking: 'quantity' })

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
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 3, tracking: 'quantity' })
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
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 5, tracking: 'quantity' })
    service.updateStock({ id: created.id, stock: 5 })
    expect(movementsOf(created.id).at(-1)).toMatchObject({
      change_qty: 0,
      before_stock: 5,
      after_stock: 5
    })
  })

  it('非整数库存抛 INVALID_STOCK（允许负值但必须整数——D2/D4）', () => {
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 5, tracking: 'quantity' })
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
      stock: 5,
      tracking: 'quantity'
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
    const created = service.create({ barcode: null, name: 'X', default_price_cents: null, stock: 5, tracking: 'quantity' })
    const result = service.delete({ id: created.id })

    expect(result).toEqual({ ok: true, willOrphan: 0 })
    expect(rawProduct(created.id)).toBeUndefined()
  })

  it('带 sale/purchase 引用删除：willOrphan=计数，快照行保留且 product_id 置 NULL', () => {
    const created = service.create({ barcode: '6901234567890', name: '可乐', default_price_cents: 350, stock: 10, tracking: 'quantity' })
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
    service.create({ barcode: '6901234567890', name: '可口可乐 330ml', default_price_cents: 350, stock: 10, tracking: 'quantity' })
    service.create({ barcode: '6902345678901', name: '雪碧 330ml', default_price_cents: 350, stock: 5, tracking: 'quantity' })
    service.create({ barcode: null, name: '早餐面包（无条码）', default_price_cents: 450, stock: -3, tracking: 'quantity' })
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
    service.create({ barcode: null, name: '100%果汁', default_price_cents: null, stock: 0, tracking: 'quantity' })
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

// ══════════════ SN 商品：create（D-SN1/2/11）══════════════

describe('productService.create（SN 商品）', () => {
  it('SN 商品建档：tracking/sn_prefix 真实落库；stock 强制 0（入参 10 被忽略——D-SN11）', () => {
    const created = service.create({
      barcode: null,
      name: 'iPhone 15',
      default_price_cents: 599900,
      stock: 10,
      tracking: 'sn',
      sn_prefix: 'IPH'
    })

    expect(created.tracking).toBe('sn')
    expect(created.sn_prefix).toBe('IPH')
    expect(created.stock).toBe(0)

    const row = rawProduct(created.id)
    expect(row['tracking']).toBe('sn')
    expect(row['sn_prefix']).toBe('IPH')
    expect(row['stock']).toBe(0)
    // stock=0 不写流水（审计链零噪音）
    expect(movementsOf(created.id)).toHaveLength(0)
    expectStockConsistent(created.id)
  })

  it('sn_prefix 归一化：trim；未传 / 纯空格 → 空串', () => {
    const a = service.create({
      barcode: null, name: 'A', default_price_cents: null, stock: 0, tracking: 'sn'
    })
    const b = service.create({
      barcode: null, name: 'B', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: '  '
    })
    const c = service.create({
      barcode: null, name: 'C', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: ' SN9 '
    })
    expect(a.sn_prefix).toBe('')
    expect(b.sn_prefix).toBe('')
    expect(c.sn_prefix).toBe('SN9')
  })

  it('批量计商品 sn_prefix 强制空串（前缀仅 SN 商品属性——D-SN2）', () => {
    const created = service.create({
      barcode: null,
      name: '可乐',
      default_price_cents: 300,
      stock: 5,
      tracking: 'quantity',
      sn_prefix: 'SHOULD_BE_IGNORED'
    })
    expect(created.tracking).toBe('quantity')
    expect(created.sn_prefix).toBe('')
    expect(rawProduct(created.id)['sn_prefix']).toBe('')
  })

  it('tracking 非法值抛 INVALID_TRACKING（IPC 边界防御，先于 DDL CHECK）', () => {
    expectServiceError(
      () =>
        service.create({
          barcode: null,
          name: 'X',
          default_price_cents: null,
          stock: 0,
          tracking: 'weight' as unknown as 'quantity'
        }),
      'INVALID_TRACKING'
    )
  })
})

// ══════════════ SN 前缀互斥（D-SN14）══════════════

describe('productService（SN 前缀互斥——D-SN14）', () => {
  it('相同前缀拒绝：文案含冲突商品名与两个前缀', () => {
    service.create({
      barcode: null, name: '手机 A', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN1'
    })
    expectServiceError(
      () =>
        service.create({
          barcode: null, name: '手机 B', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN1'
        }),
      'PRODUCT_SN_PREFIX_CONFLICT',
      'SN 前缀与商品「手机 A」的前缀冲突（SN1 / SN1）'
    )
  })

  it('互为前缀拒绝：已有 SN1，新建 SN12 被拒（SN1 是 SN12 的前缀）', () => {
    service.create({
      barcode: null, name: 'A', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN1'
    })
    expectServiceError(
      () =>
        service.create({
          barcode: null, name: 'B', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN12'
        }),
      'PRODUCT_SN_PREFIX_CONFLICT',
      'SN 前缀与商品「A」的前缀冲突（SN1 / SN12）'
    )
  })

  it('互为前缀拒绝（反向）：已有 SN12，新建 SN1 同样被拒', () => {
    service.create({
      barcode: null, name: '长前缀', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN12'
    })
    expectServiceError(
      () =>
        service.create({
          barcode: null, name: '短前缀', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN1'
        }),
      'PRODUCT_SN_PREFIX_CONFLICT',
      'SN 前缀与商品「长前缀」的前缀冲突（SN12 / SN1）'
    )
  })

  it('空前缀永不冲突：多个 SN 商品均无前缀可共存', () => {
    service.create({ barcode: null, name: 'A', default_price_cents: null, stock: 0, tracking: 'sn' })
    service.create({ barcode: null, name: 'B', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: '' })
    expect(service.list('B')[0]!.sn_prefix).toBe('')
  })

  it('前缀比较大小写敏感（R7，与 barcode BINARY collation 一致）：sn1 与 SN1 不冲突', () => {
    service.create({
      barcode: null, name: 'A', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN1'
    })
    expect(() =>
      service.create({
        barcode: null, name: 'B', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'sn1'
      })
    ).not.toThrow()
  })

  it('update 保留自身前缀不误判（自身排除）', () => {
    const created = service.create({
      barcode: null, name: 'A', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN1'
    })
    const updated = service.update({
      id: created.id, name: 'A 改名', default_price_cents: 100, sn_prefix: 'SN1'
    })
    expect(updated.sn_prefix).toBe('SN1')
    expect(updated.name).toBe('A 改名')
  })

  it('update 改为与他人冲突的前缀被拒', () => {
    const a = service.create({
      barcode: null, name: 'A', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN1'
    })
    const b = service.create({
      barcode: null, name: 'B', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN2'
    })
    expectServiceError(
      () => service.update({ id: b.id, name: 'B', default_price_cents: null, sn_prefix: 'SN12' }),
      'PRODUCT_SN_PREFIX_CONFLICT',
      'SN 前缀与商品「A」的前缀冲突（SN1 / SN12）'
    )
    // 失败后库内保持原值
    expect(rawProduct(b.id)!['sn_prefix']).toBe('SN2')
    expect(a.sn_prefix).toBe('SN1')
  })

  it('update 省略 sn_prefix 保持现值；显式空串清除；改为不冲突前缀成功', () => {
    const created = service.create({
      barcode: null, name: 'A', default_price_cents: null, stock: 0, tracking: 'sn', sn_prefix: 'SN1'
    })
    const kept = service.update({ id: created.id, name: 'A', default_price_cents: null })
    expect(kept.sn_prefix).toBe('SN1')

    const cleared = service.update({ id: created.id, name: 'A', default_price_cents: null, sn_prefix: '' })
    expect(cleared.sn_prefix).toBe('')

    const changed = service.update({ id: created.id, name: 'A', default_price_cents: null, sn_prefix: 'ZZ9' })
    expect(changed.sn_prefix).toBe('ZZ9')
    expect(rawProduct(created.id)['sn_prefix']).toBe('ZZ9')
  })

  it('update 对批量计商品：sn_prefix 恒空串（传入也被丢弃）', () => {
    const created = service.create({
      barcode: null, name: '可乐', default_price_cents: 300, stock: 5, tracking: 'quantity'
    })
    const updated = service.update({
      id: created.id, name: '可乐', default_price_cents: 300, sn_prefix: 'NOPE'
    })
    expect(updated.sn_prefix).toBe('')
    expect(rawProduct(created.id)['sn_prefix']).toBe('')
  })
})

// ══════════════ SN 商品：updateStock 守卫（D-SN11）══════════════

describe('productService.updateStock（SN 守卫——D-SN11）', () => {
  it('SN 商品拒绝手动调整库存', () => {
    const created = service.create({
      barcode: null, name: '手机', default_price_cents: null, stock: 0, tracking: 'sn'
    })
    expectServiceError(
      () => service.updateStock({ id: created.id, stock: 5 }),
      'PRODUCT_SN_NO_MANUAL_STOCK',
      'SN 商品不支持手动调整库存，请通过 SN 增删管理'
    )
    expect(rawProduct(created.id)!['stock']).toBe(0)
  })

  it('批量计商品手动调整照常（回归）', () => {
    const created = service.create({
      barcode: null, name: '可乐', default_price_cents: null, stock: 5, tracking: 'quantity'
    })
    expect(service.updateStock({ id: created.id, stock: 3 }).stock).toBe(3)
  })
})

// ══════════════ SN 商品：delete 守卫（D-SN15）══════════════

describe('productService.delete（SN 守卫——D-SN15）', () => {
  it('有在库 SN 的 SN商品禁止删除：文案含在库计数', () => {
    const created = service.create({
      barcode: null, name: '手机', default_price_cents: null, stock: 0, tracking: 'sn'
    })
    seedSns(created.id, ['SN-A', 'SN-B'])

    expectServiceError(
      () => service.delete({ id: created.id }),
      'PRODUCT_SN_HAS_STOCK',
      '该 SN 商品仍有 2 个在库 SN，请先删除在库 SN'
    )
    expect(rawProduct(created.id)).toBeDefined()
  })

  it('仅已售 SN：商品可删；product_sns 行随商品清除（NOT NULL FK 约束——同 stock_movements 决策）；sale_items.sn 快照保留', () => {
    const created = service.create({
      barcode: null, name: '手机', default_price_cents: null, stock: 0, tracking: 'sn'
    })
    const { saleNo } = insertSoldSn(created.id, '手机', 'SN-SOLD')

    const result = service.delete({ id: created.id })

    expect(result).toEqual({ ok: true, willOrphan: 1 })
    // 商品硬删
    expect(rawProduct(created.id)).toBeUndefined()
    // product_sns 行随商品清除（product_id NOT NULL FK 无法断链存续；
    // 已售历史由下方 sale_items 快照承担——D-SN12）
    const snRows = db
      .prepare('SELECT * FROM product_sns WHERE product_id = ?')
      .all(created.id)
    expect(snRows).toHaveLength(0)
    // 快照行保留：product_id 断链 + sn 列原值
    const item = db
      .prepare('SELECT product_id, product_name, sn FROM sale_items')
      .get() as { product_id: number | null; product_name: string; sn: string | null }
    expect(item.product_id).toBeNull()
    expect(item.product_name).toBe('手机')
    expect(item.sn).toBe('SN-SOLD')
    expect(saleNo).toMatch(/^20260101-SN\d{4}$/)
  })

  it('无 SN 的 SN 商品（台账为空）可直接删除', () => {
    const created = service.create({
      barcode: null, name: '空台账', default_price_cents: null, stock: 0, tracking: 'sn'
    })
    expect(service.delete({ id: created.id }).ok).toBe(true)
    expect(rawProduct(created.id)).toBeUndefined()
  })
})

// ══════════════ SN 商品：findSn（D-SN5）══════════════

describe('productService.findSn', () => {
  let productId: number

  beforeEach(() => {
    const created = service.create({
      barcode: null, name: '手机', default_price_cents: 599900, stock: 0, tracking: 'sn'
    })
    productId = created.id
    seedSns(productId, ['SN-001', 'SN-002'])
  })

  it('命中在库 SN：返回 { sn, product }，字段齐全', () => {
    const found = service.findSn('SN-001')
    expect(found).not.toBeNull()
    expect(found!.sn.sn).toBe('SN-001')
    expect(found!.sn.status).toBe('in_stock')
    expect(found!.sn.product_id).toBe(productId)
    expect(found!.sn.sale_id).toBeNull()
    expect(found!.sn.sale_no).toBeNull()
    expect(found!.sn.id).toBeGreaterThan(0)
    expect(found!.product.id).toBe(productId)
    expect(found!.product.name).toBe('手机')
    expect(found!.product.tracking).toBe('sn')
  })

  it('命中已售 SN：status=sold + sale_id/sale_no 填充（提示原单号用）', () => {
    const { snId, saleNo } = insertSoldSn(productId, '手机', 'SN-003')
    const found = service.findSn('SN-003')
    expect(found).not.toBeNull()
    expect(found!.sn.id).toBe(snId)
    expect(found!.sn.status).toBe('sold')
    expect(found!.sn.sale_id).not.toBeNull()
    expect(found!.sn.sale_no).toBe(saleNo)
  })

  it('未命中 → null（收银侧继续查商品码链路）', () => {
    expect(service.findSn('SN-NOT-EXIST')).toBeNull()
  })

  it('已软删 SN → null（partial unique index 之外的行不可见——D-SN4）', () => {
    const [snId] = seedSns(productId, ['SN-004'])
    db.prepare('UPDATE product_sns SET deleted = 1 WHERE id = ?').run(snId)
    expect(service.findSn('SN-004')).toBeNull()
  })

  it('SN 两端空白归一（R7）：带空格查询命中', () => {
    expect(service.findSn('  SN-001  ')).not.toBeNull()
  })
})

// ══════════════ SN 商品：listSns（D-SN16）══════════════

describe('productService.listSns', () => {
  let productId: number
  let soldSaleNo: string

  beforeEach(() => {
    const created = service.create({
      barcode: null, name: '手机', default_price_cents: null, stock: 0, tracking: 'sn'
    })
    productId = created.id
    seedSns(productId, ['SN-A', 'SN-B'])
    const { saleNo } = insertSoldSn(productId, '手机', 'SN-C')
    soldSaleNo = saleNo
    // 已售一个：手动同步 stock 至 1（模拟 sale 侧事务联动——D-SN13）
    db.prepare('UPDATE products SET stock = 1 WHERE id = ?').run(productId)
  })

  it('默认仅在库：已售行排除', () => {
    const rows = service.listSns(productId, false)
    expect(rows.map((r) => r.sn)).toEqual(['SN-A', 'SN-B'])
    for (const row of rows) {
      expect(row.status).toBe('in_stock')
      expect(row.sale_id).toBeNull()
      expect(row.sale_no).toBeNull()
    }
  })

  it('includeSold：已售行含 sale_id/sale_no', () => {
    const rows = service.listSns(productId, true)
    expect(rows.map((r) => r.sn)).toEqual(['SN-A', 'SN-B', 'SN-C'])
    const sold = rows.find((r) => r.sn === 'SN-C')!
    expect(sold.status).toBe('sold')
    expect(sold.sale_id).not.toBeNull()
    expect(sold.sale_no).toBe(soldSaleNo)
  })

  it('软删行不出现在任何列表', () => {
    const rows = service.listSns(productId, true)
    const target = rows.find((r) => r.sn === 'SN-A')!
    db.prepare('UPDATE product_sns SET deleted = 1 WHERE id = ?').run(target.id)
    expect(service.listSns(productId, false).map((r) => r.sn)).toEqual(['SN-B'])
    expect(service.listSns(productId, true).map((r) => r.sn)).toEqual(['SN-B', 'SN-C'])
  })

  it('商品不存在抛 PRODUCT_NOT_FOUND', () => {
    expectServiceError(() => service.listSns(999, false), 'PRODUCT_NOT_FOUND')
  })
})

// ══════════════ SN 商品：deleteSn（D-SN16 + D-SN13）══════════════

describe('productService.deleteSn', () => {
  let productId: number

  beforeEach(() => {
    const created = service.create({
      barcode: null, name: '手机', default_price_cents: null, stock: 0, tracking: 'sn'
    })
    productId = created.id
  })

  it('删在库 SN：逻辑删除 + stock-1 + 流水 {source=manual, change_qty=-1, before/after}', () => {
    const [snId] = seedSns(productId, ['SN-A', 'SN-B'])

    const result = service.deleteSn(snId)

    expect(result).toEqual({ ok: true })
    // 逻辑删除（deleted=1，updated_at 刷新）
    const row = rawSnRow(snId)!
    expect(row['deleted']).toBe(1)
    // stock -1 + 一致性（D-SN13）
    expect(rawProduct(productId)!['stock']).toBe(1)
    expectStockConsistent(productId)
    // 流水：source='manual'、change_qty=-1、before=2 after=1、source_id=null
    const movements = movementsOf(productId)
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({
      product_id: productId,
      change_qty: -1,
      before_stock: 2,
      after_stock: 1,
      source: 'manual',
      source_id: null
    })
  })

  it('删后同 SN 可重新入库（partial unique index 仅约束未删除行——D-SN4）', () => {
    const [snId] = seedSns(productId, ['SN-A'])
    service.deleteSn(snId)

    const reinsert = db
      .prepare('INSERT INTO product_sns (product_id, sn) VALUES (?, ?)')
      .run(productId, 'SN-A')
    expect(Number(reinsert.lastInsertRowid)).toBeGreaterThan(snId)
    expect(service.findSn('SN-A')!.sn.status).toBe('in_stock')
  })

  it('已售 SN 拒绝删除（PRODUCT_SN_NOT_DELETABLE）', () => {
    const { snId } = insertSoldSn(productId, '手机', 'SN-SOLD')
    expectServiceError(
      () => service.deleteSn(snId),
      'PRODUCT_SN_NOT_DELETABLE',
      '该 SN 已售出或已删除，不可删除'
    )
    expect(rawSnRow(snId)!['deleted']).toBe(0)
    expectStockConsistent(productId)
  })

  it('已删 SN / 不存在 id 拒绝删除', () => {
    const [snId] = seedSns(productId, ['SN-A'])
    service.deleteSn(snId)
    expectServiceError(() => service.deleteSn(snId), 'PRODUCT_SN_NOT_DELETABLE')
    expectServiceError(() => service.deleteSn(99999), 'PRODUCT_SN_NOT_DELETABLE')
  })

  it('连续删除保持一致性（D-SN13）：2→1→0，每次后 stock === 在库计数', () => {
    const [idA, idB] = seedSns(productId, ['SN-A', 'SN-B'])
    service.deleteSn(idA)
    expect(rawProduct(productId)!['stock']).toBe(1)
    expectStockConsistent(productId)
    service.deleteSn(idB)
    expect(rawProduct(productId)!['stock']).toBe(0)
    expectStockConsistent(productId)
    expect(service.listSns(productId, true)).toHaveLength(0)
  })
})
