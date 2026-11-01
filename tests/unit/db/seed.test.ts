import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../../../src/main/db/database'
import { SEED_PRODUCTS, seedDatabase } from '../../fixtures/seed'
import type Database from 'better-sqlite3'

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-seed-'))
  db = initDatabase(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('fixtures/seed：种子数据', () => {
  it('商品 4 条且库存终态正确（进货-销售-手工 全链一致）', () => {
    seedDatabase(db)

    const rows = db
      .prepare('SELECT name, stock FROM products ORDER BY id')
      .all() as Array<{ name: string; stock: number }>
    expect(rows).toHaveLength(SEED_PRODUCTS.length)
    expect(rows.map((r) => r.stock)).toEqual([22, 17, 30, 6])
  })

  it('库存流水审计链完整：6 条、before/after 与库存终态衔接', () => {
    seedDatabase(db)

    const movements = db
      .prepare(
        'SELECT product_id, change_qty, before_stock, after_stock, source FROM stock_movements ORDER BY id'
      )
      .all() as Array<{
      product_id: number
      change_qty: number
      before_stock: number
      after_stock: number
      source: string
    }>
    expect(movements).toHaveLength(6)

    const bySource = movements.reduce<Record<string, number>>((acc, m) => {
      acc[m.source] = (acc[m.source] ?? 0) + 1
      return acc
    }, {})
    expect(bySource).toEqual({ purchase: 3, sale: 2, manual: 1 })

    for (const m of movements) {
      expect(m.after_stock).toBe(m.before_stock + m.change_qty)
    }

    const finalStocks = db
      .prepare('SELECT id, stock FROM products ORDER BY id')
      .all() as Array<{ id: number; stock: number }>
    for (const p of finalStocks) {
      const last = movements.filter((m) => m.product_id === p.id).at(-1)
      if (last) expect(p.stock).toBe(last.after_stock)
    }
  })

  it('销售单与明细快照一致：总额 1050、3 件、2 行明细', () => {
    seedDatabase(db)

    const sale = db
      .prepare('SELECT sale_no, total_cents, item_count, status FROM sales')
      .get() as { sale_no: string; total_cents: number; item_count: number; status: string }
    expect(sale).toEqual({
      sale_no: '20261101-0001',
      total_cents: 1050,
      item_count: 3,
      status: 'completed'
    })

    const items = db
      .prepare(
        'SELECT product_name, quantity, unit_price_cents, subtotal_cents FROM sale_items ORDER BY id'
      )
      .all() as Array<{
      product_name: string
      quantity: number
      unit_price_cents: number
      subtotal_cents: number
    }>
    expect(items).toEqual([
      { product_name: '可乐 330ml', quantity: 2, unit_price_cents: 350, subtotal_cents: 700 },
      { product_name: '雪碧 330ml', quantity: 1, unit_price_cents: 350, subtotal_cents: 350 }
    ])
    expect(
      items.reduce((sum, i) => sum + i.subtotal_cents, 0)
    ).toBe(sale.total_cents)
  })

  it('进货单 1 张 3 行明细；设置 3 项；默认模板 1 张', () => {
    seedDatabase(db)

    const order = db
      .prepare('SELECT order_no, note FROM purchase_orders')
      .get() as { order_no: string; note: string }
    expect(order).toEqual({ order_no: '20261101-0001', note: '首批进货' })
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM purchase_items').get() as { n: number }).n
    ).toBe(3)

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n
    ).toBe(3)

    const template = db
      .prepare('SELECT name, paper_width, is_default FROM print_templates')
      .get() as { name: string; paper_width: string; is_default: number }
    expect(template).toEqual({ name: '默认小票（80mm）', paper_width: '80mm', is_default: 1 })
  })
})
