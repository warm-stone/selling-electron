import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { closeDatabase, initDatabase, getDatabase } from '../../../src/main/db/database'
import { rmTempDirSync } from '../../helpers/cleanup'

const USER_TABLES = [
  'products',
  'purchase_orders',
  'purchase_items',
  'sales',
  'sale_items',
  'stock_movements',
  'product_sns',
  'product_change_logs',
  'customers',
  'sale_extras',
  'logos',
  'print_templates',
  'settings'
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

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
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

describe('migrator：迁移执行器（合并版单文件初始化）', () => {
  it('全新 DB 迁移后 user_version=1 且 13 张用户表按具名断言齐全', () => {
    const db = newDb()
    migrate(db)

    expect(db.pragma('user_version', { simple: true })).toBe(1)

    const names = tableNames(db)
    for (const t of USER_TABLES) {
      expect(names, `缺少用户表 ${t}`).toContain(t)
    }
    expect(namedUserTables(db)).toHaveLength(13)
  })

  it('幂等：同一文件二次迁移不重复建表、user_version 保持 1', () => {
    const dbPath = join(dir, 'pos.db')

    const first = new Database(dbPath)
    migrate(first)
    first.close()

    const second = newDb()
    migrate(second)

    expect(second.pragma('user_version', { simple: true })).toBe(1)
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

// ══════════════ 旧库守卫（合并迁移定案：无线上数据，旧增量库一律拒绝）══════════════

describe('migrator：旧增量库启动守卫', () => {
  it('user_version=5 的旧增量库 → 抛错并指引删库', () => {
    const db = newDb()
    db.pragma('user_version = 5')

    expect(() => migrate(db)).toThrowError(/旧版本数据库/)
    expect(() => migrate(db)).toThrowError(/pos\.db/)
  })

  it('user_version=2~4 的旧增量库同样拒绝', () => {
    for (const version of [2, 3, 4]) {
      const path = join(dir, `legacy-v${version}.db`)
      const db = new Database(path)
      openDbs.push(db)
      db.pragma(`user_version = ${version}`)
      expect(() => migrate(db), `v${version} 应被拒绝`).toThrowError(/旧版本数据库/)
    }
  })

  it('user_version=1 但缺哨兵表 product_change_logs（旧 001 时代库）→ 抛错', () => {
    const db = newDb()
    db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    db.pragma('user_version = 1')

    expect(() => migrate(db)).toThrowError(/旧版本数据库/)
  })

  it('合并版新库（user_version=1 + 哨兵表在）二次 migrate 正常通过', () => {
    const db = newDb()
    migrate(db)

    expect(() => migrate(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(1)
  })
})

// ══════════════ 合并 schema 保真（原 003/005 行为断言 + 本次新增结构）══════════════

describe('migrator：合并 schema 保真', () => {
  it('products 直接含 tracking/sn_prefix/deleted 列（默认值兜底，新行免显式赋值）', () => {
    const db = newDb()
    migrate(db)

    const cols = columns(db, 'products')
    expect(cols).toContain('tracking')
    expect(cols).toContain('sn_prefix')
    expect(cols).toContain('deleted')

    db.prepare('INSERT INTO products (name) VALUES (?)').run('默认值抽查')
    const row = db
      .prepare('SELECT tracking, sn_prefix, deleted FROM products WHERE name = ?')
      .get('默认值抽查') as { tracking: string; sn_prefix: string; deleted: number }
    expect(row.tracking).toBe('quantity')
    expect(row.sn_prefix).toBe('')
    expect(row.deleted).toBe(0)
  })

  it('product_sns：partial unique index 存在；active 行同 SN 唯一、deleted 行可重入', () => {
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

  it('purchase_orders 直接含 status/voided_at/void_reason；新单默认 completed', () => {
    const db = newDb()
    migrate(db)

    const cols = columns(db, 'purchase_orders')
    expect(cols).toContain('status')
    expect(cols).toContain('voided_at')
    expect(cols).toContain('void_reason')

    db.prepare("INSERT INTO purchase_orders (order_no, note) VALUES ('20261101-0001', NULL)").run()
    const row = db
      .prepare('SELECT status, voided_at, void_reason FROM purchase_orders WHERE id = 1')
      .get() as { status: string; voided_at: string | null; void_reason: string | null }
    expect(row.status).toBe('completed')
    expect(row.voided_at).toBeNull()
    expect(row.void_reason).toBeNull()

    expect(() =>
      db
        .prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = 1")
        .run()
    ).toThrowError(/CHECK constraint failed/)
  })

  it("stock_movements source 五值 CHECK：'void' 被拒，'sale_void'/'purchase_void' 可写", () => {
    const db = newDb()
    migrate(db)
    db.prepare('INSERT INTO products (name, stock) VALUES (?, 10)').run('流水校验')
    const insert = db.prepare(
      `INSERT INTO stock_movements (product_id, change_qty, before_stock, after_stock, source, source_id)
       VALUES (1, -1, 10, 9, ?, NULL)`
    )

    for (const source of ['sale', 'purchase', 'manual', 'sale_void', 'purchase_void']) {
      expect(() => insert.run(source), `source=${source} 应合法`).not.toThrow()
    }
    expect(() => insert.run('void')).toThrowError(/CHECK constraint failed/)
  })

  it('product_change_logs：列齐全、action CHECK 约束、changes_json 默认空数组', () => {
    const db = newDb()
    migrate(db)

    expect(columns(db, 'product_change_logs')).toEqual([
      'id',
      'product_id',
      'action',
      'reason',
      'changes_json',
      'created_at'
    ])

    db.prepare('INSERT INTO products (name) VALUES (?)').run('改动记录抽查')
    db.prepare(
      "INSERT INTO product_change_logs (product_id, action, reason) VALUES (1, 'delete', '测试')"
    ).run()
    const row = db
      .prepare('SELECT changes_json FROM product_change_logs WHERE product_id = 1')
      .get() as { changes_json: string }
    expect(row.changes_json).toBe('[]')

    expect(() =>
      db
        .prepare("INSERT INTO product_change_logs (product_id, action, reason) VALUES (1, 'rename', '测试')")
        .run()
    ).toThrowError(/CHECK constraint failed/)
    expect(() =>
      db.prepare('INSERT INTO product_change_logs (product_id, action, reason) VALUES (1, NULL)')
        .run()
    ).toThrow()
  })

  it('customers 7 列 / sale_extras 5 列（DTO↔DB snake_case 一一对应）', () => {
    const db = newDb()
    migrate(db)

    expect(columns(db, 'customers')).toEqual([
      'id',
      'name',
      'phone',
      'address',
      'note',
      'created_at',
      'updated_at'
    ])

    expect(columns(db, 'sale_extras')).toEqual([
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
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    expect(namedUserTables(db)).toHaveLength(13)
  })

  it('initDatabase 同目录重复调用幂等（复用同一连接）', () => {
    const a = initDatabase(dir)
    const b = initDatabase(dir)
    expect(b).toBe(a)
    expect(namedUserTables(b)).toHaveLength(13)
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
      db
        .prepare(
          `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price_cents, subtotal_cents)
          VALUES (1, NULL, '零数量', 0, 100, 0)`
        )
        .run()
    ).toThrowError(/CHECK constraint failed/)
  })
})
