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
  it('全新 DB 迁移后 user_version=1 且 8 张用户表按具名断言齐全', () => {
    const db = newDb()
    migrate(db)

    expect(db.pragma('user_version', { simple: true })).toBe(1)

    const names = tableNames(db)
    for (const t of USER_TABLES) {
      expect(names, `缺少用户表 ${t}`).toContain(t)
    }
    expect(namedUserTables(db)).toHaveLength(8)
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

describe('database：连接初始化', () => {
  it('initDatabase 在参数化目录建库：WAL + foreign_keys=ON + 迁移完成', () => {
    const db = initDatabase(dir)

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    expect(namedUserTables(db)).toHaveLength(8)
  })

  it('initDatabase 同目录重复调用幂等（复用同一连接）', () => {
    const a = initDatabase(dir)
    const b = initDatabase(dir)
    expect(b).toBe(a)
    expect(namedUserTables(b)).toHaveLength(8)
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
