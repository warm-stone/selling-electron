import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { closeDatabase, initDatabase, getDatabase } from '../../../src/main/db/database'
import { rmTempDirSync } from '../../helpers/cleanup'
import initSql from '../../../src/main/db/migrations/001_init.sql?raw'
import logosSql from '../../../src/main/db/migrations/002_logos.sql?raw'
import snProductsSql from '../../../src/main/db/migrations/003_sn_products.sql?raw'
import productSoftDeleteSql from '../../../src/main/db/migrations/004_product_soft_delete.sql?raw'

const USER_TABLES = [
  'products',
  'purchase_orders',
  'purchase_items',
  'sales',
  'sale_items',
  'stock_movements',
  'print_templates',
  'settings',
  'logos',
  'product_sns',
  'customers',
  'sale_extras'
] as const

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function namedUserTables(db: Database.Database): string[] {
  return tableNames(db).filter((n) => (USER_TABLES as readonly string[]).includes(n))
}

function countTable(db: Database.Database, name: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { n: number }
  return row.n
}

let dir: string

/** 本文件自建连接登记（Windows 不可删打开中的文件：afterEach 先逐一 close 再删目录） */
const openDbs: Database.Database[] = []

/** 自建连接统一入口：登记进 openDbs，由 afterEach 收尾关闭（免逐测试手写 close） */
function newDb(): Database.Database {
  const db = new Database(join(dir, 'pos.db'))
  openDbs.push(db)
  return db
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-migrator-'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
  // initDatabase 是模块级单例：不关闭则 Windows 上删 temp 目录 EBUSY
  closeDatabase()
  rmTempDirSync(dir)
})

describe('migrator：迁移执行器', () => {
  it('全新 DB 迁移后 user_version=5 且 12 张用户表按具名断言齐全（含 002 logos / 003 product_sns / 005 customers、sale_extras）', () => {
    const db = newDb()
    migrate(db)

    expect(db.pragma('user_version', { simple: true })).toBe(5)

    const names = tableNames(db)
    for (const t of USER_TABLES) {
      expect(names, `缺少用户表 ${t}`).toContain(t)
    }
    expect(namedUserTables(db)).toHaveLength(12)
  })

  it('幂等：同一文件二次迁移不重复建表、user_version 保持 5', () => {
    const dbPath = join(dir, 'pos.db')

    const first = new Database(dbPath)
    migrate(first)
    first.close()

    const second = newDb()
    migrate(second)

    expect(second.pragma('user_version', { simple: true })).toBe(5)
    for (const t of USER_TABLES) {
      expect(countTable(second, t), `${t} 应只存在一份`).toBe(1)
    }
  })

  it('DDL 保真：created_at 默认值走 localtime 而非 UTC', () => {
    const db = newDb()
    migrate(db)
    db.prepare('INSERT INTO products (name) VALUES (?)').run('本地时间抽查')

    const row = db
      .prepare('SELECT created_at FROM products WHERE name = ?')
      .get('本地时间抽查') as { created_at: string }

    const now = new Date()
    const localDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-')
    expect(row.created_at.startsWith(localDate)).toBe(true)
  })
})

// ══════════════ 003_sn_products（SN 商品：存量无感升级 + partial unique index）══════════════

/** 建一个停在 version=2 的存量库（001+002 已应用、003 未应用） */
function legacyDbV2(): Database.Database {
  const db = newDb()
  db.exec(initSql)
  db.exec(logosSql)
  db.pragma('user_version = 2')
  return db
}

describe('migrator：003_sn_products（存量升级）', () => {
  it("存量商品无感升级：tracking 全部 'quantity'、sn_prefix 空串；新列存在", () => {
    const db = legacyDbV2()
    const insertProduct = db.prepare(
      'INSERT INTO products (barcode, name, default_price_cents, stock) VALUES (?, ?, ?, ?)'
    )
    insertProduct.run('6901234567890', '可口可乐 330ml', 350, 24)
    insertProduct.run(null, '无码面包', null, -3)

    migrate(db)

    expect(db.pragma('user_version', { simple: true })).toBe(5)

    const productCols = (
      db.pragma('table_info(products)') as Array<{ name: string }>
    ).map((c) => c.name)
    expect(productCols).toContain('tracking')
    expect(productCols).toContain('sn_prefix')

    const rows = db
      .prepare('SELECT tracking, sn_prefix FROM products ORDER BY id')
      .all() as Array<{ tracking: string; sn_prefix: string }>
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.tracking).toBe('quantity')
      expect(row.sn_prefix).toBe('')
    }
  })

  it('存量明细行无感升级：sale_items.sn / purchase_items.sn 列存在且为 NULL', () => {
    const db = legacyDbV2()
    db.prepare('INSERT INTO products (barcode, name) VALUES (?, ?)').run('6901', '可乐')
    db.prepare(
      "INSERT INTO purchase_orders (order_no, note) VALUES ('20261101-0001', NULL)"
    ).run()
    db.prepare(
      `INSERT INTO purchase_items (order_id, product_id, product_name, barcode, quantity, cost_price_cents)
       VALUES (1, 1, '可乐', '6901', 24, 200)`
    ).run()
    db.prepare("INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-0001', 700, 2)").run()
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price_cents, subtotal_cents)
       VALUES (1, 1, '可乐', '6901', 2, 350, 700)`
    ).run()

    migrate(db)

    const saleCols = (db.pragma('table_info(sale_items)') as Array<{ name: string }>).map(
      (c) => c.name
    )
    const purchaseCols = (
      db.pragma('table_info(purchase_items)') as Array<{ name: string }>
    ).map((c) => c.name)
    expect(saleCols).toContain('sn')
    expect(purchaseCols).toContain('sn')

    const saleSn = db.prepare('SELECT sn FROM sale_items').get() as { sn: string | null }
    const purchaseSn = db.prepare('SELECT sn FROM purchase_items').get() as { sn: string | null }
    expect(saleSn.sn).toBeNull()
    expect(purchaseSn.sn).toBeNull()
  })

  it('product_sns 表 + partial unique index 存在；active 行同 SN 唯一、deleted 行可重入', () => {
    const db = newDb()
    migrate(db)

    expect(countTable(db, 'product_sns')).toBe(1)
    const indexRow = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_product_sns_sn_active') as { name: string; sql: string }
    expect(indexRow.sql).toContain('WHERE deleted = 0')

    db.prepare('INSERT INTO products (barcode, name) VALUES (?, ?)').run('6901', '可乐')
    const insertSn = db.prepare('INSERT INTO product_sns (product_id, sn) VALUES (1, ?)')

    // 两条 deleted=0 同 SN → 违反全局唯一（D-SN4）
    insertSn.run('SN-A')
    expect(() => insertSn.run('SN-A')).toThrowError(/UNIQUE constraint failed/)

    // 逻辑删除后同一 SN 可重新入库（partial index 只约束未删除行）
    db.prepare("UPDATE product_sns SET deleted = 1 WHERE sn = 'SN-A'").run()
    expect(() => insertSn.run('SN-A')).not.toThrow()
  })
})

// ══════════════ 004_product_soft_delete（商品软删：存量行无感升级）══════════════

/** 建一个停在 version=3 的存量库（001~003 已应用、004 未应用） */
function legacyDbV3(): Database.Database {
  const db = newDb()
  db.exec(initSql)
  db.exec(logosSql)
  db.exec(snProductsSql)
  db.pragma('user_version = 3')
  return db
}

describe('migrator：004_product_soft_delete（存量升级）', () => {
  it('products.deleted 列存在（NOT NULL DEFAULT 0）且存量行全部 deleted=0', () => {
    const db = legacyDbV3()
    const insertProduct = db.prepare(
      `INSERT INTO products (barcode, name, default_price_cents, stock, tracking, sn_prefix)
       VALUES (?, ?, ?, ?, 'quantity', '')`
    )
    insertProduct.run('6901234567890', '可口可乐 330ml', 350, 24)
    insertProduct.run(null, '无码面包', null, -3)

    migrate(db)

    expect(db.pragma('user_version', { simple: true })).toBe(5)

    const productCols = (
      db.pragma('table_info(products)') as Array<{ name: string; notnull: number; dflt_value: string | null }>
    ).find((c) => c.name === 'deleted')
    expect(productCols, 'products 应有 deleted 列').toBeDefined()
    expect(productCols!.notnull).toBe(1)
    expect(productCols!.dflt_value).toBe('0')

    const rows = db
      .prepare('SELECT deleted FROM products ORDER BY id')
      .all() as Array<{ deleted: number }>
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.deleted).toBe(0)
    }
  })

  it('全新 DB 迁移后 deleted 列同样就位（DEFAULT 0 兜底，新行免显式赋值）', () => {
    const db = newDb()
    migrate(db)

    db.prepare('INSERT INTO products (name) VALUES (?)').run('新行免赋值')
    const row = db
      .prepare('SELECT deleted FROM products WHERE name = ?')
      .get('新行免赋值') as { deleted: number }
    expect(row.deleted).toBe(0)
  })
})

// ══════════════ 005_customer_order_extras（结账客户信息 + 订单附加信息：sales 表零改动）══════════════

/** 建一个停在 version=4 的存量库（001~004 已应用、005 未应用） */
function legacyDbV4(): Database.Database {
  const db = newDb()
  db.exec(initSql)
  db.exec(logosSql)
  db.exec(snProductsSql)
  db.exec(productSoftDeleteSql)
  db.pragma('user_version = 4')
  return db
}

describe('migrator：005_customer_order_extras（客户档案 + 订单附加）', () => {
  it('空库 v0 直升 5：user_version=5 且 customers / sale_extras 两表存在', () => {
    const db = newDb()
    migrate(db)

    expect(db.pragma('user_version', { simple: true })).toBe(5)
    expect(countTable(db, 'customers')).toBe(1)
    expect(countTable(db, 'sale_extras')).toBe(1)
  })

  it('v4 存量库升级：001~004 数据原样、升 5 后两表同样就位（FK 实约束可用）', () => {
    const db = legacyDbV4()
    db.prepare('INSERT INTO products (barcode, name) VALUES (?, ?)').run('6901', '可乐')
    db.prepare(
      "INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-0001', 700, 2)"
    ).run()

    migrate(db)

    expect(db.pragma('user_version', { simple: true })).toBe(5)
    expect(countTable(db, 'customers')).toBe(1)
    expect(countTable(db, 'sale_extras')).toBe(1)

    // sales 表零改动：存量行原样保留
    const sale = db
      .prepare('SELECT sale_no, total_cents FROM sales')
      .get() as { sale_no: string; total_cents: number }
    expect(sale.sale_no).toBe('20261101-0001')
    expect(sale.total_cents).toBe(700)

    // FK 实约束：sale_extras 挂到真实 sale_id 可写入
    db.prepare(
      'INSERT INTO sale_extras (sale_id, is_national_subsidy, order_note, salesperson) VALUES (1, 0, ?, ?)'
    ).run('客户要求送货', '张三')
    const extra = db
      .prepare('SELECT order_note, salesperson FROM sale_extras WHERE sale_id = 1')
      .get() as { order_note: string; salesperson: string }
    expect(extra.order_note).toBe('客户要求送货')
    expect(extra.salesperson).toBe('张三')
  })

  it('列保真：customers 7 列 / sale_extras 5 列（DTO↔DB snake_case 一一对应）', () => {
    const db = newDb()
    migrate(db)

    const customerCols = (db.pragma('table_info(customers)') as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(customerCols).toEqual([
      'id',
      'name',
      'phone',
      'address',
      'note',
      'created_at',
      'updated_at'
    ])

    const saleExtraCols = (db.pragma('table_info(sale_extras)') as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(saleExtraCols).toEqual([
      'sale_id',
      'customer_id',
      'is_national_subsidy',
      'order_note',
      'salesperson'
    ])
  })

  it("phone UNIQUE 兜底：空串可插入一次（name/address/note 走 DEFAULT ''）、同值再插抛约束错误", () => {
    const db = newDb()
    migrate(db)
    const insert = db.prepare('INSERT INTO customers (phone) VALUES (?)')

    insert.run('')
    expect(() => insert.run('')).toThrowError(/UNIQUE constraint failed/)
  })
})

describe('database：连接初始化', () => {
  it('initDatabase 在参数化目录建库：WAL + foreign_keys=ON + 迁移完成', () => {
    const db = initDatabase(dir)

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('user_version', { simple: true })).toBe(5)
    expect(namedUserTables(db)).toHaveLength(12)
  })

  it('initDatabase 同目录重复调用幂等（复用同一连接）', () => {
    const a = initDatabase(dir)
    const b = initDatabase(dir)
    expect(b).toBe(a)
    expect(namedUserTables(b)).toHaveLength(12)
  })

  it('getDatabase 返回当前连接；未初始化的模块实例抛错', async () => {
    const db = initDatabase(dir)
    expect(getDatabase()).toBe(db)

    vi.resetModules()
    const fresh = await import('../../../src/main/db/database')
    expect(() => fresh.getDatabase()).toThrowError(/initDatabase/)
  })

  it('foreign_keys 生效：插入引用不存在 sale_id 的 sale_items 抛错', () => {
    const db = initDatabase(dir)
    const insert = db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price_cents, subtotal_cents)
       VALUES (999, NULL, '幽灵商品', 1, 100, 100)`
    )
    expect(() => insert.run()).toThrowError(/FOREIGN KEY constraint failed/)
  })

  it('ER 约束保真：条码 UNIQUE + sale_items.quantity CHECK', () => {
    const db = initDatabase(dir)

    db.prepare('INSERT INTO products (barcode, name) VALUES (?, ?)').run('6901001', '可乐')
    expect(() =>
      db.prepare('INSERT INTO products (barcode, name) VALUES (?, ?)').run('6901001', '山寨可乐')
    ).toThrowError(/UNIQUE constraint failed/)

    db.prepare(
      "INSERT INTO sales (sale_no, total_cents, item_count) VALUES ('20261101-0001', 100, 1)"
    ).run()
    expect(() =>
      db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price_cents, subtotal_cents)
         VALUES (1, NULL, '零数量', 0, 100, 0)`
      ).run()
    ).toThrowError(/CHECK constraint failed/)
  })
})
