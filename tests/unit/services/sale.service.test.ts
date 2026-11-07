import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { closeDatabase, initDatabase } from '../../../src/main/db/database'
import {
  SaleServiceError,
  createSaleService
} from '../../../src/main/services/sale.service'
import type { SaleErrorCode } from '../../../src/main/services/sale.service'
import { createProductService } from '../../../src/main/services/product.service'
import { rmTempDirSync } from '../../helpers/cleanup'
import type { Sale, StockMovement } from '../../../src/shared/types'

// ── 测试脚手架 ──────────────────────────────────────────────

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-sale-service-'))
  db = initDatabase(dir)
})

afterEach(() => {
  // initDatabase 是模块级单例：不关闭则 Windows 上删 temp 目录 EBUSY
  closeDatabase()
  rmTempDirSync(dir)
})

function svc(): ReturnType<typeof createSaleService> {
  return createSaleService(db)
}

function addProduct(
  name: string,
  opts: { barcode?: string | null; price?: number; stock?: number } = {}
): number {
  const r = db
    .prepare(
      'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
    )
    .run(opts.barcode ?? null, name, opts.price ?? 100, opts.stock ?? 0)
  return Number(r.lastInsertRowid)
}

function count(table: string, where = '', ...params: unknown[]): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
    .get(...params) as { n: number }
  return row.n
}

function stockOf(productId: number): number {
  return (
    db.prepare('SELECT stock FROM products WHERE id = ?').get(productId) as {
      stock: number
    }
  ).stock
}

function movements(where = '', ...params: unknown[]): StockMovement[] {
  return db
    .prepare(`SELECT * FROM stock_movements ${where} ORDER BY id`)
    .all(...params) as StockMovement[]
}

/** 测试侧自算本地今日 yyyyMMdd（sale_no 前缀断言用，跨运行日期稳定） */
function todayPrefix(): string {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('')
}

function rawSaleNo(saleId: number): string {
  return (
    db.prepare('SELECT sale_no FROM sales WHERE id = ?').get(saleId) as {
      sale_no: string
    }
  ).sale_no
}

// ── SN 商品测试脚手架（D-SN5/6/7/8）─────────────────────────

/** SN 商品建档（tracking='sn'，初始库存 0——SN 商品无初始库存语义） */
function addSnProduct(
  name: string,
  opts: { barcode?: string | null; price?: number } = {}
): number {
  const r = db
    .prepare(
      "INSERT INTO products (barcode, name, default_price_cents, stock, tracking) VALUES (?, ?, ?, 0, 'sn')"
    )
    .run(opts.barcode ?? null, name, opts.price ?? 100)
  return Number(r.lastInsertRowid)
}

/**
 * SN 入库（模拟进货链路效果）：INSERT product_sns(in_stock) + stock +1，
 * 维持 D-SN13 不变量 stock === 在库 SN 数。返回台账行 id。
 */
function addSn(productId: number, sn: string): number {
  const r = db
    .prepare('INSERT INTO product_sns (product_id, sn) VALUES (?, ?)')
    .run(productId, sn)
  db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(
    productId
  )
  return Number(r.lastInsertRowid)
}

/** 台账行整读（按 id，含软删行——硬删场景断言用） */
function snRowById(id: number): {
  id: number
  product_id: number
  sn: string
  status: string
  sale_item_id: number | null
  deleted: number
} {
  return db.prepare('SELECT * FROM product_sns WHERE id = ?').get(id) as {
    id: number
    product_id: number
    sn: string
    status: string
    sale_item_id: number | null
    deleted: number
  }
}

/** 在库 SN 数（D-SN13 一致性断言用） */
function inStockSnCount(productId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM product_sns WHERE product_id = ? AND status = 'in_stock' AND deleted = 0"
      )
      .get(productId) as { n: number }
  ).n
}

/** 按单据 + SN 取明细行（sale_item_id 回写断言用） */
function saleItemBySn(
  saleId: number,
  sn: string
): { id: number; product_id: number | null; quantity: number; unit_price_cents: number; sn: string | null } {
  return db
    .prepare('SELECT * FROM sale_items WHERE sale_id = ? AND sn = ?')
    .get(saleId, sn) as {
    id: number
    product_id: number | null
    quantity: number
    unit_price_cents: number
    sn: string | null
  }
}

/** 拒绝态公用断言：抛 SaleServiceError(code)（可选精确文案） */
function expectReject(
  fn: () => unknown,
  code: SaleErrorCode,
  message?: string
): void {
  try {
    fn()
    expect.unreachable(`应抛 ${code}`)
  } catch (e) {
    expect(e).toBeInstanceOf(SaleServiceError)
    expect((e as SaleServiceError).code).toBe(code)
    if (message != null) {
      expect((e as SaleServiceError).message).toBe(message)
    }
  }
}

// ── 1. 正常结账：4 表联写 + 返回结构 ────────────────────────

describe('checkout：正常结账（G2 单事务四表联写）', () => {
  it('结账 2 商品 → sales 1 行、sale_items 2 行快照、stock 各减、movements 2 行 source=sale', () => {
    const cola = addProduct('可口可乐 330ml', {
      barcode: '6901234567890',
      price: 350,
      stock: 10
    })
    const water = addProduct('农夫山泉 550ml', {
      barcode: '6903456789012',
      price: 200,
      stock: 5
    })

    const receipt = svc().checkout([
      { product_id: cola, quantity: 2, unit_price_cents: 350, sn: null },
      { product_id: water, quantity: 1, unit_price_cents: 500, sn: null } // 改价售出（快照记录实际成交价）
    ])

    // ── sales：1 行，total = 2×350 + 1×500 = 1200（整数分乘加 G1）──
    expect(count('sales')).toBe(1)
    const saleRow = db.prepare('SELECT * FROM sales').get() as Sale
    expect(saleRow.sale_no).toMatch(/^\d{8}-\d{4}$/)
    expect(saleRow.total_cents).toBe(1200)
    expect(saleRow.item_count).toBe(3) // 件数 = Σquantity
    expect(saleRow.status).toBe('completed')
    expect(saleRow.voided_at).toBeNull()
    expect(saleRow.created_at).toBeTruthy()

    // ── sale_items：2 行，含商品快照（product_name/barcode/product_id）──
    expect(count('sale_items')).toBe(2)
    const itemRows = db
      .prepare('SELECT * FROM sale_items ORDER BY id')
      .all() as Array<{
      sale_id: number
      product_id: number
      product_name: string
      barcode: string | null
      quantity: number
      unit_price_cents: number
      subtotal_cents: number
    }>
    expect(itemRows[0]).toEqual({
      id: 1,
      sale_id: saleRow.id,
      product_id: cola,
      product_name: '可口可乐 330ml',
      barcode: '6901234567890',
      quantity: 2,
      unit_price_cents: 350,
      subtotal_cents: 700,
      sn: null
    })
    expect(itemRows[1]).toEqual({
      id: 2,
      sale_id: saleRow.id,
      product_id: water,
      product_name: '农夫山泉 550ml',
      barcode: '6903456789012',
      quantity: 1,
      unit_price_cents: 500,
      subtotal_cents: 500,
      sn: null
    })

    // ── products.stock：各扣 ──
    expect(stockOf(cola)).toBe(8)
    expect(stockOf(water)).toBe(4)

    // ── stock_movements：2 行 source='sale' source_id=saleId，before/after 衔接 ──
    expect(count('stock_movements')).toBe(2)
    const mvRows = movements()
    expect(mvRows[0]).toMatchObject({
      product_id: cola,
      change_qty: -2,
      before_stock: 10,
      after_stock: 8,
      source: 'sale',
      source_id: saleRow.id
    })
    expect(mvRows[1]).toMatchObject({
      product_id: water,
      change_qty: -1,
      before_stock: 5,
      after_stock: 4,
      source: 'sale',
      source_id: saleRow.id
    })

    // ── 返回结构（T11 收银台 / T15 打印编排的核心输入）──
    expect(receipt.sale_no).toBe(saleRow.sale_no)
    expect(receipt.created_at).toBe(saleRow.created_at)
    expect(receipt.total_cents).toBe(1200)
    expect(receipt.item_count).toBe(3)
    expect(receipt.status).toBe('completed')
    expect(receipt.items).toHaveLength(2)
    expect(receipt.items.map((i) => i.product_name)).toEqual([
      '可口可乐 330ml',
      '农夫山泉 550ml'
    ])
    expect(receipt.items[0]).toMatchObject({
      product_id: cola,
      barcode: '6901234567890',
      quantity: 2,
      unit_price_cents: 350,
      subtotal_cents: 700
    })
    // 金额全程整数分（G1：无浮点）
    expect(Number.isInteger(receipt.total_cents)).toBe(true)
    expect(receipt.items.every((i) => Number.isInteger(i.subtotal_cents))).toBe(
      true
    )
  })

  it('同购物车重复商品行按传入顺序落库（合并是 renderer 购物车的职责 D16，service 不合并）', () => {
    const cola = addProduct('可乐', { barcode: '6901', stock: 10 })
    svc().checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 350, sn: null },
      { product_id: cola, quantity: 3, unit_price_cents: 300, sn: null }
    ])
    expect(count('sale_items')).toBe(2)
    expect(
      (db.prepare('SELECT total_cents, item_count FROM sales').get() as {
        total_cents: number
        item_count: number
      })
    ).toEqual({ total_cents: 350 + 900, item_count: 4 })
  })
})

// ── 2. 负库存允许（D2：不拦截不报错）────────────────────────

describe('checkout：负库存允许（D2）', () => {
  it('qty=10 库存=3 → 成功结账 stock=-7，流水 after_stock=-7', () => {
    const cola = addProduct('可乐', { barcode: '6902', stock: 3 })

    expect(() =>
      svc().checkout([{ product_id: cola, quantity: 10, unit_price_cents: 100, sn: null }])
    ).not.toThrow()

    expect(stockOf(cola)).toBe(-7)
    expect(movements()[0]).toMatchObject({
      product_id: cola,
      change_qty: -10,
      before_stock: 3,
      after_stock: -7,
      source: 'sale'
    })
  })
})

// ── 3. 作废：库存复原 + 审计链（D3 整单作废）────────────────

describe('voidSale：整单作废（D3）', () => {
  it('作废后 stock 复原 + movements 2 行 source=void + status/voided_at + 明细不物理删除', () => {
    const cola = addProduct('可口可乐', { barcode: '6903', stock: 10 })
    const water = addProduct('矿泉水', { barcode: '6904', stock: 5 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 2, unit_price_cents: 350, sn: null },
      { product_id: water, quantity: 1, unit_price_cents: 200, sn: null }
    ])
    expect(stockOf(cola)).toBe(8)
    expect(stockOf(water)).toBe(4)

    const voided = service.voidSale(receipt.id)

    // ── sales：status='voided' + voided_at 落地 ──
    expect(voided.status).toBe('voided')
    expect(voided.voided_at).toBeTruthy()
    const row = db
      .prepare('SELECT status, voided_at FROM sales WHERE id = ?')
      .get(receipt.id) as { status: string; voided_at: string }
    expect(row.status).toBe('voided')
    expect(row.voided_at).toBeTruthy()

    // ── stock 复原 ──
    expect(stockOf(cola)).toBe(10)
    expect(stockOf(water)).toBe(5)

    // ── movements：+2 行 source='void'，change_qty 为正、before/after 复原衔接 ──
    const voidMv = movements("WHERE source = 'void'")
    expect(voidMv).toHaveLength(2)
    expect(voidMv[0]).toMatchObject({
      product_id: cola,
      change_qty: 2,
      before_stock: 8,
      after_stock: 10,
      source: 'void',
      source_id: receipt.id
    })
    expect(voidMv[1]).toMatchObject({
      product_id: water,
      change_qty: 1,
      before_stock: 4,
      after_stock: 5,
      source: 'void',
      source_id: receipt.id
    })
    // 出库+入库审计链完整（sale 2 + void 2）
    expect(movements()).toHaveLength(4)

    // ── 不物理删除任何行 ──
    expect(count('sales')).toBe(1)
    expect(count('sale_items')).toBe(2)
    expect(
      (
        db
          .prepare('SELECT product_name, quantity FROM sale_items WHERE sale_id = ?')
          .all(receipt.id) as Array<{ product_name: string; quantity: number }>
      ).map((i) => i.product_name)
    ).toEqual(['可口可乐', '矿泉水'])
  })

  it('作废后再次结账独立成单（作废不污染当日序列）', () => {
    const cola = addProduct('可乐', { barcode: '6905', stock: 10 })
    const service = svc()
    const a = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }])
    service.voidSale(a.id)
    const b = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }])
    expect(b.sale_no).toBe(`${todayPrefix()}-0002`)
    expect(b.status).toBe('completed')
  })
})

// ── 4. 重复作废 → SALE_ALREADY_VOIDED ───────────────────────

describe('voidSale：重复作废防护', () => {
  it('重复作废抛 SALE_ALREADY_VOIDED，中文消息「该销售单已作废」', () => {
    const cola = addProduct('可乐', { barcode: '6906', stock: 10 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])
    service.voidSale(receipt.id)

    expect(() => service.voidSale(receipt.id)).toThrowError(SaleServiceError)
    try {
      service.voidSale(receipt.id)
      expect.unreachable('应抛 SALE_ALREADY_VOIDED')
    } catch (e) {
      expect((e as SaleServiceError).code).toBe('SALE_ALREADY_VOIDED')
      expect((e as SaleServiceError).message).toBe('该销售单已作废')
    }

    // 二次作废失败不产生任何新副作用
    expect(movements()).toHaveLength(2)
    expect(stockOf(cola)).toBe(10)
  })

  it('作废不存在的销售单抛 SALE_NOT_FOUND', () => {
    expect(() => svc().voidSale(99999)).toThrowError(/销售单不存在/)
  })
})

// ── 5. kill-point：中途失败全回滚（G2 原子性证明）──────────

describe('kill-point：事务中途失败全回滚（better-sqlite3 throw→ROLLBACK）', () => {
  it('注入点=stock_movements 触发器 RAISE(ABORT)：sales/sale_items/movements 零行、stock 原值', () => {
    const cola = addProduct('可口可乐', { barcode: '6907', stock: 10 })
    const water = addProduct('矿泉水', { barcode: '6908', stock: 5 })

    // 注入真实 DB 层失败：movements 写入（sales/sale_items/stock 扣减已全部发生后）触发 ABORT
    db.exec(
      `CREATE TRIGGER killpoint_before_movement
         BEFORE INSERT ON stock_movements
         WHEN NEW.source = 'sale'
       BEGIN
         SELECT RAISE(ABORT, 'kill-point 注入失败');
       END`
    )

    expect(() =>
      svc().checkout([
        { product_id: cola, quantity: 2, unit_price_cents: 350, sn: null },
        { product_id: water, quantity: 1, unit_price_cents: 200, sn: null }
      ])
    ).toThrowError(/kill-point/)

    // ── 4 表零变化：部分写入（sales 行 + sale_items 行 + stock 扣减）全部回滚 ──
    expect(count('sales')).toBe(0)
    expect(count('sale_items')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(stockOf(cola)).toBe(10)
    expect(stockOf(water)).toBe(5)
  })

  it('注入点=第 2 项商品不存在（快照读取抛错，第 1 项已完整写入）→ 全回滚', () => {
    const cola = addProduct('可口可乐', { barcode: '6909', stock: 10 })

    let err: SaleServiceError | undefined
    try {
      svc().checkout([
        { product_id: cola, quantity: 2, unit_price_cents: 350, sn: null },
        { product_id: 999999, quantity: 1, unit_price_cents: 100, sn: null } // 商品在加购后被硬删（D15 场景）
      ])
    } catch (e) {
      err = e as SaleServiceError
    }
    expect(err).toBeInstanceOf(SaleServiceError)
    expect(err?.code).toBe('PRODUCT_NOT_FOUND')

    // 事务回滚：sales 头（先写入）+ 第 1 项 sale_item/扣库存在内的全部变化撤销
    expect(count('sales')).toBe(0)
    expect(count('sale_items')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(stockOf(cola)).toBe(10)
  })
})

// ── 6. sale_no 序列（D18：yyyyMMdd-NNNN 按日序列）───────────

describe('sale_no 序列（D18）', () => {
  it('同日递增：连续结账 0001/0002', () => {
    const cola = addProduct('可乐', { barcode: '6910', stock: 10 })
    const service = svc()

    const first = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }])
    const second = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }])

    expect(first.sale_no).toBe(`${todayPrefix()}-0001`)
    expect(second.sale_no).toBe(`${todayPrefix()}-0002`)
  })

  it('跨日重置：直接 SQL 插入旧日期单（昨日 5 单）不影响今日从 0001 开始', () => {
    const cola = addProduct('可乐', { barcode: '6911', stock: 10 })
    db.prepare(
      "INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20200101-0005', 100, 1)"
    ).run()

    const receipt = svc().checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])
    expect(receipt.sale_no).toBe(`${todayPrefix()}-0001`)
  })

  it('当日计数：直接 SQL 插入今日 2 单（含跳号历史）→ 下一单为第 3 单（COUNT 前缀计数语义，非 MAX 续接）', () => {
    const cola = addProduct('可乐', { barcode: '6912', stock: 10 })
    // 手工插入跳号单（0007/0012）——序列按 COUNT 当日单数+1，不按最大序号续接
    for (const no of ['-0007', '-0012']) {
      db.prepare(
        'INSERT INTO sales (sale_no, total_cents, item_count) VALUES (?, 100, 1)'
      ).run(`${todayPrefix()}${no}`)
    }

    const receipt = svc().checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])
    expect(receipt.sale_no).toBe(`${todayPrefix()}-0003`)
  })

  it('repo.dailyCount：只按 sale_no LIKE 前缀计数（与 purchase order_no 序列互相独立）', () => {
    db.prepare(
      'INSERT INTO purchase_orders (order_no, note) VALUES (?, NULL)'
    ).run(`${todayPrefix()}-0009`) // 进货单同日前缀不应干扰销售序列
    const cola = addProduct('可乐', { barcode: '6913', stock: 10 })

    const receipt = svc().checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])
    expect(receipt.sale_no).toBe(`${todayPrefix()}-0001`)
  })
})

// ── 7. 边界：入参校验与作废边界 ─────────────────────────────

describe('checkout/voidSale 边界校验', () => {
  it('空购物车抛 SALE_EMPTY_CART', () => {
    try {
      svc().checkout([])
      expect.unreachable('空购物车应抛错')
    } catch (e) {
      expect((e as SaleServiceError).code).toBe('SALE_EMPTY_CART')
      expect((e as SaleServiceError).message).toBe('购物车为空，无法结账')
    }
  })

  it.each([
    ['数量为 0', { quantity: 0, unit_price_cents: 100 }],
    ['数量为负', { quantity: -1, unit_price_cents: 100 }],
    ['数量非整数', { quantity: 1.5, unit_price_cents: 100 }],
    ['单价为负', { quantity: 1, unit_price_cents: -1 }],
    ['单价非整数分', { quantity: 1, unit_price_cents: 3.5 }]
  ])('非法行（%s）抛 SALE_INVALID_ITEM 且零写入', (_label, bad) => {
    const cola = addProduct('可乐', { barcode: '6914', stock: 10 })
    try {
      svc().checkout([{ product_id: cola, sn: null, ...bad }])
      expect.unreachable('非法行应抛错')
    } catch (e) {
      expect((e as SaleServiceError).code).toBe('SALE_INVALID_ITEM')
    }
    expect(count('sales')).toBe(0)
    expect(stockOf(cola)).toBe(10)
  })

  it('作废时商品已被硬删（快照行 product_id 置 NULL——D15）：跳过该行复原、其余行正常复原', () => {
    const cola = addProduct('可口可乐', { barcode: '6915', stock: 10 })
    const bread = addProduct('面包', { barcode: null, stock: 5 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 2, unit_price_cents: 350, sn: null },
      { product_id: bread, quantity: 1, unit_price_cents: 450, sn: null }
    ])
    expect(stockOf(cola)).toBe(8)
    expect(stockOf(bread)).toBe(4)

    // 模拟 T8 硬删商品后的世界：快照行 product_id 断链（products 行与引用
    // 由 T8 删除逻辑处理，本测试只构造快照行断链后的可达状态）
    db.prepare('UPDATE sale_items SET product_id = NULL WHERE sale_id = ? AND product_id = ?').run(
      receipt.id,
      cola
    )

    expect(() => service.voidSale(receipt.id)).not.toThrow()

    expect(rawSaleNo(receipt.id)).toBeTruthy()
    expect(stockOf(bread)).toBe(5) // 存活商品复原
    expect(stockOf(cola)).toBe(8) // 断链商品不复原（库存随硬删废弃）
    expect(
      movements("WHERE source = 'void'").map((m) => m.product_id)
    ).toEqual([bread]) // 断链行不写复原流水
    expect(count('sale_items')).toBe(2) // 快照行不删
  })
})

// ── 8. 查询：list / getDetail（repo 层行为经 service 出口）────

describe('list / getDetail 查询', () => {
  it('list 按 status/日期过滤，getDetail 返回头+明细', () => {
    const cola = addProduct('可乐', { barcode: '6916', stock: 10 })
    const service = svc()
    const a = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }])
    const b = service.checkout([{ product_id: cola, quantity: 2, unit_price_cents: 100, sn: null }])
    service.voidSale(b.id)

    const all = service.list({})
    expect(all).toHaveLength(2)

    const completedOnly = service.list({ status: 'completed' })
    expect(completedOnly.map((s) => s.sale_no)).toEqual([a.sale_no])

    const voidedOnly = service.list({ status: 'voided' })
    expect(voidedOnly.map((s) => s.sale_no)).toEqual([b.sale_no])

    // created_at 是 localtime 'YYYY-MM-DD ...'，按当日过滤可命中
    const today = new Date()
    const iso = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0')
    ].join('-')
    expect(service.list({ date_from: iso, date_to: iso })).toHaveLength(2)
    expect(service.list({ date_from: '2000-01-01', date_to: '2000-01-02' })).toHaveLength(0)

    const detail = service.getDetail(a.id)
    expect(detail.sale_no).toBe(a.sale_no)
    expect(detail.items.map((i) => i.product_name)).toEqual(['可乐'])
    expect(detail.items[0]?.subtotal_cents).toBe(100)

    expect(() => service.getDetail(99999)).toThrowError(/销售单不存在/)
  })

  it('list 多页分页：repo 层 page 参数按 id 倒序切页', () => {
    const cola = addProduct('可乐', { barcode: '6917', stock: 100 })
    const service = svc()
    for (let i = 0; i < 3; i++) {
      service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }])
    }
    const page1 = service.list({})
    expect(page1).toHaveLength(3)
    // 倒序：最新在前
    expect(page1[0]?.sale_no).toBe(`${todayPrefix()}-0003`)
    expect(page1[2]?.sale_no).toBe(`${todayPrefix()}-0001`)
  })
})

// ── 9. SN 商品结账（D-SN5/6/7/8：校验 → 落库快照 → 台账流转）──

describe('checkout：SN 商品（D-SN5/6/7/8）', () => {
  it('混合结账（SN 行 + 批量计行）：快照/台账流转/扣库存/流水全链路 + 返回明细带 sn', () => {
    const phone = addSnProduct('红米手机', { barcode: 'SNPH01', price: 299900 })
    const snId = addSn(phone, 'SN001')
    const cola = addProduct('可口可乐', { barcode: '69SN01', stock: 10 })

    const receipt = svc().checkout([
      { product_id: phone, quantity: 1, unit_price_cents: 299900, sn: 'SN001' },
      { product_id: cola, quantity: 2, unit_price_cents: 350, sn: null }
    ])

    // ── sale_items：SN 行 quantity=1 + sn 快照；批量计行 sn=null（D-SN12）──
    expect(count('sale_items')).toBe(2)
    const snItem = saleItemBySn(receipt.id, 'SN001')
    expect(snItem).toMatchObject({
      sale_id: receipt.id,
      product_id: phone,
      quantity: 1,
      unit_price_cents: 299900,
      subtotal_cents: 299900,
      sn: 'SN001'
    })
    const qtyItems = db
      .prepare('SELECT * FROM sale_items WHERE sale_id = ? AND sn IS NULL')
      .all(receipt.id) as Array<{ quantity: number; product_id: number | null }>
    expect(qtyItems).toHaveLength(1)
    expect(qtyItems[0]).toMatchObject({ product_id: cola, quantity: 2 })

    // ── product_sns：status='sold' + sale_item_id 指向该明细行（D-SN8）──
    expect(snRowById(snId)).toMatchObject({
      status: 'sold',
      sale_item_id: snItem.id
    })

    // ── 库存：SN 商品 -1、批量计 -2（SN 行同走 adjustStock/movements）──
    expect(stockOf(phone)).toBe(0)
    expect(stockOf(cola)).toBe(8)
    expect(stockOf(phone)).toBe(inStockSnCount(phone)) // D-SN13 一致性（结账后）

    // ── 流水：2 行 source='sale'，SN 行 change_qty=-1 ──
    expect(movements()).toHaveLength(2)
    expect(movements()[0]).toMatchObject({
      product_id: phone,
      change_qty: -1,
      before_stock: 1,
      after_stock: 0,
      source: 'sale',
      source_id: receipt.id
    })
    expect(movements()[1]).toMatchObject({
      product_id: cola,
      change_qty: -2,
      before_stock: 10,
      after_stock: 8,
      source: 'sale'
    })

    // ── 头合计 + 返回明细携带 sn（收银台/打印消费——D-SN12）──
    expect(receipt.total_cents).toBe(299900 + 700)
    expect(receipt.item_count).toBe(3)
    expect(receipt.items.find((i) => i.sn === 'SN001')).toMatchObject({
      product_name: '红米手机',
      quantity: 1
    })
    expect(receipt.items.find((i) => i.sn === null)?.quantity).toBe(2)
  })

  it('同商品两个 SN 独立成行、独立价格（D-SN7 禁合并 + 独立单价），台账各自回写', () => {
    const phone = addSnProduct('红米手机', { price: 299900 })
    const sn1 = addSn(phone, 'SN001')
    const sn2 = addSn(phone, 'SN002')

    const receipt = svc().checkout([
      { product_id: phone, quantity: 1, unit_price_cents: 299900, sn: 'SN001' },
      { product_id: phone, quantity: 1, unit_price_cents: 289900, sn: 'SN002' }
    ])

    const rows = db
      .prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id')
      .all(receipt.id) as Array<{
      id: number
      sn: string | null
      quantity: number
      unit_price_cents: number
      subtotal_cents: number
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      sn: 'SN001',
      quantity: 1,
      unit_price_cents: 299900,
      subtotal_cents: 299900
    })
    expect(rows[1]).toMatchObject({
      sn: 'SN002',
      quantity: 1,
      unit_price_cents: 289900,
      subtotal_cents: 289900
    })
    expect(receipt.total_cents).toBe(299900 + 289900)
    expect(receipt.item_count).toBe(2)

    // 两个 SN 均已售，sale_item_id 各自指向自己的明细行（D-SN8）
    expect(snRowById(sn1)).toMatchObject({ status: 'sold', sale_item_id: rows[0].id })
    expect(snRowById(sn2)).toMatchObject({ status: 'sold', sale_item_id: rows[1].id })
    expect(stockOf(phone)).toBe(0)
    expect(inStockSnCount(phone)).toBe(0)
  })

  it('拒绝：SN 不在台账 → SALE_SN_NOT_FOUND，事务零写入', () => {
    const phone = addSnProduct('红米手机')
    const snId = addSn(phone, 'SN001')

    expectReject(
      () =>
        svc().checkout([
          { product_id: phone, quantity: 1, unit_price_cents: 100, sn: 'GHOST' }
        ]),
      'SALE_SN_NOT_FOUND',
      'SN GHOST 不存在或已删除'
    )

    expect(count('sales')).toBe(0)
    expect(count('sale_items')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(snRowById(snId).status).toBe('in_stock')
    expect(stockOf(phone)).toBe(1)
  })

  it('拒绝：SN 已售出 → SALE_SN_SOLD（文案带原单号引导作废），事务零写入', () => {
    const phone = addSnProduct('红米手机')
    const snId = addSn(phone, 'SN001')
    const service = svc()
    const first = service.checkout([
      { product_id: phone, quantity: 1, unit_price_cents: 100, sn: 'SN001' }
    ])

    expectReject(
      () =>
        service.checkout([
          { product_id: phone, quantity: 1, unit_price_cents: 100, sn: 'SN001' }
        ]),
      'SALE_SN_SOLD',
      `SN SN001 已售出（单号 ${first.sale_no}），不可重复销售`
    )

    // 只有第一单存在，台账/库存停在第一次结账后的状态
    expect(count('sales')).toBe(1)
    expect(count('sale_items')).toBe(1)
    expect(snRowById(snId).status).toBe('sold')
    expect(stockOf(phone)).toBe(0)
  })

  it('拒绝：SN 属于其它商品 → SALE_SN_PRODUCT_MISMATCH，事务零写入', () => {
    const phoneA = addSnProduct('手机A')
    const phoneB = addSnProduct('手机B')
    const snId = addSn(phoneB, 'SN009')

    expectReject(
      () =>
        svc().checkout([
          { product_id: phoneA, quantity: 1, unit_price_cents: 100, sn: 'SN009' }
        ]),
      'SALE_SN_PRODUCT_MISMATCH',
      'SN SN009 不属于该商品'
    )

    expect(count('sales')).toBe(0)
    expect(count('sale_items')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(snRowById(snId).status).toBe('in_stock')
    expect(stockOf(phoneA)).toBe(0)
    expect(stockOf(phoneB)).toBe(1)
  })

  it('拒绝：SN 行数量 ≠ 1 → SALE_SN_REQUIRED，事务零写入', () => {
    const phone = addSnProduct('红米手机')
    const snId = addSn(phone, 'SN001')

    expectReject(
      () =>
        svc().checkout([
          { product_id: phone, quantity: 2, unit_price_cents: 100, sn: 'SN001' }
        ]),
      'SALE_SN_REQUIRED',
      'SN 商品数量必须为 1（SN：SN001）'
    )

    expect(count('sales')).toBe(0)
    expect(count('sale_items')).toBe(0)
    expect(snRowById(snId).status).toBe('in_stock')
    expect(stockOf(phone)).toBe(1)
  })

  it('拒绝：SN 为空白字符串 → SALE_SN_REQUIRED', () => {
    const phone = addSnProduct('红米手机')

    expectReject(
      () =>
        svc().checkout([
          { product_id: phone, quantity: 1, unit_price_cents: 100, sn: '   ' }
        ]),
      'SALE_SN_REQUIRED',
      'SN 不能为空'
    )

    expect(count('sales')).toBe(0)
    expect(count('sale_items')).toBe(0)
  })

  it('拒绝：批量计商品行带 sn → SALE_SN_PRODUCT_MISMATCH（防御：商品不是 SN 商品）', () => {
    const cola = addProduct('可口可乐', { barcode: '69SN02', stock: 10 })

    expectReject(
      () =>
        svc().checkout([
          { product_id: cola, quantity: 1, unit_price_cents: 100, sn: 'SN001' }
        ]),
      'SALE_SN_PRODUCT_MISMATCH',
      '商品「可口可乐」不是 SN 商品'
    )

    expect(count('sales')).toBe(0)
    expect(count('sale_items')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(stockOf(cola)).toBe(10)
  })
})

// ── 10. SN 作废回滚 + 一致性（D-SN8/D-SN13）─────────────────

describe('voidSale：SN 回滚（D-SN8）', () => {
  it('混合单作废：SN 台账回 in_stock + sale_item_id 清空 + 库存/流水复原；重复作废仍拒绝', () => {
    const phone = addSnProduct('红米手机', { price: 299900 })
    const snId = addSn(phone, 'SN001')
    const cola = addProduct('可口可乐', { barcode: '69SN03', stock: 10 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: phone, quantity: 1, unit_price_cents: 299900, sn: 'SN001' },
      { product_id: cola, quantity: 2, unit_price_cents: 350, sn: null }
    ])
    expect(stockOf(phone)).toBe(0)
    expect(stockOf(cola)).toBe(8)

    const voided = service.voidSale(receipt.id)

    expect(voided.status).toBe('voided')

    // ── SN 台账：in_stock + sale_item_id NULL（D-SN8）──
    expect(snRowById(snId)).toMatchObject({ status: 'in_stock', sale_item_id: null })

    // ── 库存复原：SN 商品 +1、批量计 +2 ──
    expect(stockOf(phone)).toBe(1)
    expect(stockOf(cola)).toBe(10)
    expect(stockOf(phone)).toBe(inStockSnCount(phone)) // D-SN13 一致性（作废后）

    // ── 流水：sale 2 + void 2（SN 行 +1）──
    const voidMv = movements("WHERE source = 'void'")
    expect(voidMv).toHaveLength(2)
    expect(voidMv[0]).toMatchObject({
      product_id: phone,
      change_qty: 1,
      before_stock: 0,
      after_stock: 1,
      source: 'void',
      source_id: receipt.id
    })
    expect(voidMv[1]).toMatchObject({
      product_id: cola,
      change_qty: 2,
      before_stock: 8,
      after_stock: 10
    })
    expect(movements()).toHaveLength(4)

    // 重复作废仍被拒（既有行为不回归），且不产生新副作用
    expect(() => service.voidSale(receipt.id)).toThrowError(SaleServiceError)
    expect(movements()).toHaveLength(4)
    expect(snRowById(snId).status).toBe('in_stock')
  })

  it('作废时商品已硬删（SN 被删除级联软删——D15/D-SN15）：不崩溃、SN 不复活、单据正常作废', () => {
    const phone = addSnProduct('红米手机')
    const snId = addSn(phone, 'SN001')
    const service = svc()
    const receipt = service.checkout([
      { product_id: phone, quantity: 1, unit_price_cents: 100, sn: 'SN001' }
    ])
    const snItem = saleItemBySn(receipt.id, 'SN001')

    // 模拟商品硬删后的世界（既有 D15 测试同款手法 + SN 级联软删）：
    // 快照行 product_id 断链 + product_sns 被删除级联软删
    db.prepare('UPDATE sale_items SET product_id = NULL WHERE sale_id = ?').run(
      receipt.id
    )
    db.prepare(
      "UPDATE product_sns SET deleted = 1, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(snId)

    expect(() => service.voidSale(receipt.id)).not.toThrow()

    // 单据正常作废
    expect(
      (
        db.prepare('SELECT status FROM sales WHERE id = ?').get(receipt.id) as {
          status: string
        }
      ).status
    ).toBe('voided')

    // SN 行保持软删 + sold + 指向原明细行（WHERE deleted=0 自然不命中——不复活）
    expect(snRowById(snId)).toMatchObject({
      deleted: 1,
      status: 'sold',
      sale_item_id: snItem.id
    })
    expect(inStockSnCount(phone)).toBe(0)

    // 断链行不写复原流水（既有 skip 语义）
    expect(movements("WHERE source = 'void'")).toHaveLength(0)
  })

  it('作废时商品已软删（004 迁移链路，经 product.service 删除）：不崩溃、单据正常作废、SN 不复活（级联软删行 WHERE deleted=0 命中 0 行）、库存不复原', () => {
    const phone = addSnProduct('红米手机')
    const snId = addSn(phone, 'SN001')
    const service = svc()
    const receipt = service.checkout([
      { product_id: phone, quantity: 1, unit_price_cents: 100, sn: 'SN001' }
    ])
    const snItem = saleItemBySn(receipt.id, 'SN001')
    expect(stockOf(phone)).toBe(0)

    // 已售 SN 不阻删（D-SN15 只拦在库）→ 经 product.service 软删商品
    const productService = createProductService(db)
    expect(productService.delete({ id: phone })).toEqual({ ok: true, willOrphan: 1 })

    expect(() => service.voidSale(receipt.id)).not.toThrow()

    // 单据正常作废
    expect(
      (
        db.prepare('SELECT status FROM sales WHERE id = ?').get(receipt.id) as {
          status: string
        }
      ).status
    ).toBe('voided')

    // SN 行保持级联软删态（deleted=1、status/sale_item_id 冻结——restore
    // WHERE deleted=0 命中 0 行，不复活）
    expect(snRowById(snId)).toMatchObject({
      deleted: 1,
      status: 'sold',
      sale_item_id: snItem.id
    })
    expect(inStockSnCount(phone)).toBe(0)

    // 软删商品对 getProductSnapshot 不可见 → 库存不复原、不写复原流水
    // （与 product_id=NULL 断链行同款 skip 语义——两条路径并存）
    expect(stockOf(phone)).toBe(0)
    expect(movements("WHERE source = 'void'")).toHaveLength(0)

    // 快照行保留且 product_id 保持指向软删商品（FK 有效——软删链路的意义所在）
    expect(snItem.product_id).toBe(phone)
  })

  it('D-SN13 一致性：结账/作废穿插后 stock 恒等于在库 SN 数（同事务绑定）', () => {
    const phone = addSnProduct('红米手机')
    addSn(phone, 'SN001')
    addSn(phone, 'SN002')
    addSn(phone, 'SN003')
    const service = svc()

    expect(stockOf(phone)).toBe(3)
    expect(stockOf(phone)).toBe(inStockSnCount(phone))

    const a = service.checkout([
      { product_id: phone, quantity: 1, unit_price_cents: 100, sn: 'SN001' }
    ])
    expect(stockOf(phone)).toBe(inStockSnCount(phone))
    const b = service.checkout([
      { product_id: phone, quantity: 1, unit_price_cents: 100, sn: 'SN002' }
    ])
    expect(stockOf(phone)).toBe(inStockSnCount(phone))
    expect(stockOf(phone)).toBe(1)

    service.voidSale(a.id)
    expect(stockOf(phone)).toBe(inStockSnCount(phone))
    service.voidSale(b.id)
    expect(stockOf(phone)).toBe(inStockSnCount(phone))
    expect(stockOf(phone)).toBe(3)
  })
})
