/**
 * 客户 DAL（计划任务 4）：customers 表（005 迁移，7 列）读写。
 *
 * 事务边界（与 product.repo 的内嵌事务惯例**刻意相反**——D-SN8 跨 repo 豁免前提）：
 * - 全部方法各自单条语句、**无自有 db.transaction**：insert/update 将被结账事务
 *   （T8）整体包裹调用（customers + sales + sale_extras 跨 repo 原子），
 *   repo 层不嵌套事务/SAVEPOINT，保证外层事务语义纯净。
 * - insert = 单 INSERT + 单 SELECT 回读（无事务包裹；同连接读己之写，
 *   调用方事务内外均安全）。
 *
 * 职责边界（纯 SQL，无业务规则）：
 * - phone 精确等值匹配——trim/归一化是 service 层职责，repo 收到什么查什么；
 * - update 动态 SET 只刷 patch 中出现的键（列名走白名单，值全参数绑定，无拼接注入面）；
 *   id 不存在静默（存在性校验是 service 职责）；
 * - 本期无 delete、无订单数/消费额聚合列（契约 customers:list 只有表列）。
 */

import type Database from 'better-sqlite3'
import type { Customer } from '../../../shared/types'

/** 新客户（落库前形态；四 TEXT 列均必给——phone 无 DEFAULT，NOT NULL 必须显式给值） */
export interface NewCustomer {
  name: string
  phone: string
  address: string
  note: string
}

/** 客户部分更新（update 动态 SET 的键白名单，列名与表列一一对应） */
export interface CustomerPatch {
  name?: string
  phone?: string
  address?: string
  note?: string
}

const CUSTOMER_COLUMNS = 'id, name, phone, address, note, created_at, updated_at'

/** 可更新列（update 动态 SET 白名单；键序即 SET 序） */
const UPDATE_KEYS = ['name', 'phone', 'address', 'note'] as const

type UpdatableKey = (typeof UPDATE_KEYS)[number]

/** LIKE 通配符按字面匹配（用户输入 % _ \ 不做模糊语义——照 products:list 模式） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * 行→Customer 映射（row 结构即 Customer，snake_case 一致）。
 * 集中一处转型：列形态若演进（如 JOIN 附加列）只改这里。
 */
function toCustomer(row: unknown): Customer | undefined {
  return row as Customer | undefined
}

export function createCustomerRepo(db: Database.Database) {
  const getByIdStmt = db.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ?`)
  const findByPhoneStmt = db.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE phone = ?`)
  // phone 无 DEFAULT 且 NOT NULL：四列显式给值；created_at/updated_at 走 DEFAULT（localtime）
  const insertStmt = db.prepare(
    'INSERT INTO customers (name, phone, address, note) VALUES (?, ?, ?, ?)'
  )
  // keyword 命中：name OR phone 子串 LIKE %kw%（通配符转义照 products:list）
  const listStmt = db.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers
     WHERE (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')
     ORDER BY id DESC
     LIMIT ? OFFSET ?`
  )
  const listAllStmt = db.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers
     ORDER BY id DESC
     LIMIT ? OFFSET ?`
  )
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM customers
     WHERE (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')`
  )
  const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM customers')

  /** patch 中出现的键（值非 undefined；类型上 string | undefined，白名单过滤后运行时必为 string） */
  function keysOfPatch(patch: CustomerPatch): UpdatableKey[] {
    return UPDATE_KEYS.filter((k) => patch[k] !== undefined)
  }

  /** 键组合 → 预编译 UPDATE 语句（非空子集至多 15 个，逐组合缓存；列名白名单无注入面） */
  const updateStmtCache = new Map<string, Database.Statement>()

  function updateStmtFor(keys: UpdatableKey[]): Database.Statement {
    const cacheKey = keys.join(',')
    let stmt = updateStmtCache.get(cacheKey)
    if (!stmt) {
      const sets = keys.map((k) => `${k} = ?`).join(', ')
      stmt = db.prepare(
        `UPDATE customers SET ${sets}, updated_at = datetime('now','localtime') WHERE id = ?`
      )
      updateStmtCache.set(cacheKey, stmt)
    }
    return stmt
  }

  function rowById(id: number): Customer | undefined {
    return toCustomer(getByIdStmt.get(id))
  }

  return {
    /** 按电话精查（等值匹配；trim 责任在上层——带空格的输入不命中即 undefined） */
    findByPhone(phone: string): Customer | undefined {
      return toCustomer(findByPhoneStmt.get(phone))
    },

    /**
     * 新建客户并回读完整行（含 DEFAULT 生成的 created_at/updated_at）。
     * phone NOT NULL UNIQUE：散客空串占位只可插一行，二插抛
     * `UNIQUE constraint failed: customers.phone`（service 层防重）。
     */
    insert(data: NewCustomer): Customer {
      const result = insertStmt.run(data.name, data.phone, data.address, data.note)
      return rowById(Number(result.lastInsertRowid))!
    },

    /**
     * 部分更新：只 SET patch 中出现的键，updated_at 同步刷新（localtime）。
     * id 不存在静默（0 行受影响；存在性校验是 service 职责）；空 patch no-op。
     */
    update(id: number, patch: CustomerPatch): void {
      const keys = keysOfPatch(patch)
      if (keys.length === 0) return
      updateStmtFor(keys).run(...keys.map((k) => patch[k]), id)
    },

    getById(id: number): Customer | undefined {
      return rowById(id)
    },

    /**
     * 关键字列表：keyword 同时 LIKE 匹配 name OR phone（%kw%，空串不加 WHERE）；
     * ORDER BY id DESC（最新在前）；total 为过滤后总数（与分页参数无关）。
     */
    list(keyword: string, limit: number, offset: number): { items: Customer[]; total: number } {
      if (keyword === '') {
        const items = listAllStmt.all(limit, offset).map((row) => toCustomer(row)) as Customer[]
        return { items, total: (countAllStmt.get() as { n: number }).n }
      }
      const like = `%${escapeLike(keyword)}%`
      const items = listStmt.all(like, like, limit, offset).map((row) =>
        toCustomer(row)
      ) as Customer[]
      return { items, total: (countStmt.get(like, like) as { n: number }).n }
    }
  }
}

export type CustomerRepo = ReturnType<typeof createCustomerRepo>
