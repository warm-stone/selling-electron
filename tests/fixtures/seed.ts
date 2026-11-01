import type Database from 'better-sqlite3'

export interface SeedProduct {
  barcode: string | null
  name: string
  default_price_cents: number | null
  stock: number
}

export interface SeedSummary {
  productIds: number[]
  purchaseOrderId: number
  saleId: number
}

export const SEED_PRODUCTS: SeedProduct[] = [
  { barcode: '6901234567890', name: '可乐 330ml', default_price_cents: 350, stock: 0 },
  { barcode: '6902345678901', name: '雪碧 330ml', default_price_cents: 350, stock: 0 },
  { barcode: '6903456789012', name: '矿泉水 550ml', default_price_cents: 200, stock: 0 },
  { barcode: null, name: '早餐面包（无条码）', default_price_cents: 450, stock: 0 }
]

export function insertProduct(db: Database.Database, product: SeedProduct): number {
  const result = db
    .prepare(
      'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
    )
    .run(product.barcode, product.name, product.default_price_cents, product.stock)
  return Number(result.lastInsertRowid)
}

export function seedSettings(db: Database.Database): void {
  const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
  insert.run('shop_name', '测试便利店')
  insert.run('shop_phone', '13800000000')
  insert.run('receipt_note', '谢谢惠顾，欢迎再次光临')
}

export function seedDefaultTemplate(db: Database.Database): number {
  const result = db
    .prepare(
      `INSERT INTO print_templates (name, paper_width, config_json, is_default)
       VALUES (?, '80mm', ?, 1)`
    )
    .run('默认小票（80mm）', JSON.stringify({ paperWidth: '80mm', cutPaper: true }))
  return Number(result.lastInsertRowid)
}

export function seedDatabase(db: Database.Database): SeedSummary {
  const productIds = SEED_PRODUCTS.map((p) => insertProduct(db, p))

  const insertMovement = db.prepare(
    `INSERT INTO stock_movements (product_id, change_qty, before_stock, after_stock, source, source_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  const seedAll = db.transaction(() => {
    const purchaseResult = db
      .prepare('INSERT INTO purchase_orders (order_no, note) VALUES (?, ?)')
      .run('20261101-0001', '首批进货')
    const purchaseOrderId = Number(purchaseResult.lastInsertRowid)

    const insertPurchaseItem = db.prepare(
      `INSERT INTO purchase_items (order_id, product_id, product_name, barcode, quantity, cost_price_cents)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    insertPurchaseItem.run(purchaseOrderId, productIds[0], '可乐 330ml', '6901234567890', 24, 200)
    insertPurchaseItem.run(purchaseOrderId, productIds[1], '雪碧 330ml', '6902345678901', 18, 210)
    insertPurchaseItem.run(purchaseOrderId, productIds[2], '矿泉水 550ml', '6903456789012', 30, 120)
    for (const [id, qty] of [
      [productIds[0], 24],
      [productIds[1], 18],
      [productIds[2], 30]
    ] as Array<[number, number]>) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, id)
      insertMovement.run(id, qty, 0, qty, 'purchase', purchaseOrderId)
    }

    insertMovement.run(productIds[3], 6, 0, 6, 'manual', null)
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(6, productIds[3])

    const saleResult = db
      .prepare('INSERT INTO sales (sale_no, total_cents, item_count) VALUES (?, ?, ?)')
      .run('20261101-0001', 1050, 3)
    const saleId = Number(saleResult.lastInsertRowid)

    const insertSaleItem = db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insertSaleItem.run(saleId, productIds[0], '可乐 330ml', '6901234567890', 2, 350, 700)
    insertSaleItem.run(saleId, productIds[1], '雪碧 330ml', '6902345678901', 1, 350, 350)
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(2, productIds[0])
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(1, productIds[1])
    insertMovement.run(productIds[0], -2, 24, 22, 'sale', saleId)
    insertMovement.run(productIds[1], -1, 18, 17, 'sale', saleId)

    seedSettings(db)
    seedDefaultTemplate(db)

    return { productIds, purchaseOrderId, saleId }
  })

  return seedAll()
}
