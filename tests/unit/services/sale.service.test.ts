import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../../src/main/db/database'
import {
  SaleServiceError,
  createSaleService
} from '../../../src/main/services/sale.service'
import type { Sale, StockMovement } from '../../../src/shared/types'

// ── 测试脚手架 ──────────────────────────────────────────────

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-sale-service-'))
  db = initDatabase(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
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
      { product_id: cola, quantity: 2, unit_price_cents: 350 },
      { product_id: water, quantity: 1, unit_price_cents: 500 } // 改价售出（快照记录实际成交价）
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
      subtotal_cents: 700
    })
    expect(itemRows[1]).toEqual({
      id: 2,
      sale_id: saleRow.id,
      product_id: water,
      product_name: '农夫山泉 550ml',
      barcode: '6903456789012',
      quantity: 1,
      unit_price_cents: 500,
      subtotal_cents: 500
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
      { product_id: cola, quantity: 1, unit_price_cents: 350 },
      { product_id: cola, quantity: 3, unit_price_cents: 300 }
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
      svc().checkout([{ product_id: cola, quantity: 10, unit_price_cents: 100 }])
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
      { product_id: cola, quantity: 2, unit_price_cents: 350 },
      { product_id: water, quantity: 1, unit_price_cents: 200 }
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
    const a = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100 }])
    service.voidSale(a.id)
    const b = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100 }])
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
      { product_id: cola, quantity: 1, unit_price_cents: 100 }
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
        { product_id: cola, quantity: 2, unit_price_cents: 350 },
        { product_id: water, quantity: 1, unit_price_cents: 200 }
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
        { product_id: cola, quantity: 2, unit_price_cents: 350 },
        { product_id: 999999, quantity: 1, unit_price_cents: 100 } // 商品在加购后被硬删（D15 场景）
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

    const first = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100 }])
    const second = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100 }])

    expect(first.sale_no).toBe(`${todayPrefix()}-0001`)
    expect(second.sale_no).toBe(`${todayPrefix()}-0002`)
  })

  it('跨日重置：直接 SQL 插入旧日期单（昨日 5 单）不影响今日从 0001 开始', () => {
    const cola = addProduct('可乐', { barcode: '6911', stock: 10 })
    db.prepare(
      "INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20200101-0005', 100, 1)"
    ).run()

    const receipt = svc().checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100 }
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
      { product_id: cola, quantity: 1, unit_price_cents: 100 }
    ])
    expect(receipt.sale_no).toBe(`${todayPrefix()}-0003`)
  })

  it('repo.dailyCount：只按 sale_no LIKE 前缀计数（与 purchase order_no 序列互相独立）', () => {
    db.prepare(
      'INSERT INTO purchase_orders (order_no, note) VALUES (?, NULL)'
    ).run(`${todayPrefix()}-0009`) // 进货单同日前缀不应干扰销售序列
    const cola = addProduct('可乐', { barcode: '6913', stock: 10 })

    const receipt = svc().checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100 }
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
      svc().checkout([{ product_id: cola, ...bad }])
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
      { product_id: cola, quantity: 2, unit_price_cents: 350 },
      { product_id: bread, quantity: 1, unit_price_cents: 450 }
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
    const a = service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100 }])
    const b = service.checkout([{ product_id: cola, quantity: 2, unit_price_cents: 100 }])
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
      service.checkout([{ product_id: cola, quantity: 1, unit_price_cents: 100 }])
    }
    const page1 = service.list({})
    expect(page1).toHaveLength(3)
    // 倒序：最新在前
    expect(page1[0]?.sale_no).toBe(`${todayPrefix()}-0003`)
    expect(page1[2]?.sale_no).toBe(`${todayPrefix()}-0001`)
  })
})
