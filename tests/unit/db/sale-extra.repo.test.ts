import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { createSaleExtraRepo } from '../../../src/main/db/repositories/sale-extra.repo'
import { rmTempDirSync } from '../../helpers/cleanup'

let dir: string

/** 本文件打开的连接登记（Windows 不可删打开中的文件：afterEach 先逐一 close 再删目录） */
const openDbs: Database.Database[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-sale-extra-repo-'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
  rmTempDirSync(dir)
})

function freshDb(): Database.Database {
  const db = new Database(join(dir, 'pos.db'))
  openDbs.push(db)
  migrate(db)
  return db
}

/**
 * 插一条真实 sales 行（FK 实约束要求 sale_id 必须存在）。
 * 返回 sale_id（自增从 1 开始）。
 */
function insertSale(db: Database.Database, saleNo: string): number {
  const r = db
    .prepare(
      'INSERT INTO sales (sale_no, total_cents, item_count) VALUES (?, ?, ?)'
    )
    .run(saleNo, 700, 2)
  return Number(r.lastInsertRowid)
}

/** 插一条客户行（phone UNIQUE，每次给不同值避免冲突） */
function insertCustomer(db: Database.Database, phone: string): number {
  const r = db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, ?)')
    .run('张三', phone)
  return Number(r.lastInsertRowid)
}

describe('sale-extra.repo：订单附加信息 DAL', () => {
  it('引用语义（★需求核心定案）：insert 后改客户名，getWithCustomer 取到最新名（JOIN 非快照）', () => {
    const db = freshDb()
    const saleId = insertSale(db, '20261101-0001')
    const customerId = insertCustomer(db, '13800000001')
    const repo = createSaleExtraRepo(db)

    repo.insert(saleId, {
      customer_id: customerId,
      is_national_subsidy: true,
      order_note: '送货上门',
      salesperson: '李四'
    })

    // 改客户名（模拟事后编辑客户档案）
    db.prepare("UPDATE customers SET name = '张三丰' WHERE id = ?").run(
      customerId
    )

    const result = repo.getWithCustomer(saleId)
    expect(result).not.toBeNull()
    expect(result!.customer).not.toBeNull()
    // JOIN 取最新行，非 insert 时点的快照——引用语义定案
    expect(result!.customer!.name).toBe('张三丰')
  })

  it('insert 完整字段往返：getWithCustomer 返回 is_national_subsidy=true（1→boolean）、order_note/salesperson 正确', () => {
    const db = freshDb()
    const saleId = insertSale(db, '20261101-0002')
    const customerId = insertCustomer(db, '13800000002')
    const repo = createSaleExtraRepo(db)

    repo.insert(saleId, {
      customer_id: customerId,
      is_national_subsidy: true,
      order_note: '客户要求开发票',
      salesperson: '王五'
    })

    const result = repo.getWithCustomer(saleId)
    expect(result).toEqual({
      sale_id: saleId,
      customer_id: customerId,
      is_national_subsidy: true, // INTEGER 1 → boolean
      order_note: '客户要求开发票',
      salesperson: '王五',
      customer: {
        id: customerId,
        name: '张三',
        phone: '13800000002',
        address: '',
        note: '',
        created_at: expect.any(String),
        updated_at: expect.any(String)
      }
    })
  })

  it('getWithCustomer：无 sale_extras 行 → null；有行但 customer_id NULL → customer: null', () => {
    const db = freshDb()
    const saleId1 = insertSale(db, '20261101-0003')
    const saleId2 = insertSale(db, '20261101-0004')
    const repo = createSaleExtraRepo(db)

    // 无行
    expect(repo.getWithCustomer(saleId1)).toBeNull()

    // 有行但 customer_id NULL（散客无客户档案）
    repo.insert(saleId2, {
      customer_id: null,
      is_national_subsidy: false,
      order_note: null,
      salesperson: null
    })
    const result = repo.getWithCustomer(saleId2)
    expect(result).not.toBeNull()
    expect(result!.customer).toBeNull()
    expect(result!.customer_id).toBeNull()
    expect(result!.is_national_subsidy).toBe(false) // INTEGER 0 → boolean
  })

  it('upsert 幂等：同 sale_id 两次 upsert → COUNT=1 且第二次 patch 值生效（建行后更新）', () => {
    const db = freshDb()
    const saleId = insertSale(db, '20261101-0005')
    const repo = createSaleExtraRepo(db)

    // 第一次 upsert 建行
    repo.upsert(saleId, {
      is_national_subsidy: false,
      order_note: '初始备注',
      salesperson: '初始销售'
    })

    // 第二次 upsert 只改 patch 中的键
    repo.upsert(saleId, {
      is_national_subsidy: true,
      order_note: '更新后的备注'
    })

    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM sale_extras WHERE sale_id = ?').get(
        saleId
      ) as { n: number }
    ).n
    expect(count).toBe(1) // 1:1 旁挂，至多一行

    const result = repo.getWithCustomer(saleId)
    expect(result!.is_national_subsidy).toBe(true) // 第二次 patch 生效
    expect(result!.order_note).toBe('更新后的备注')
    expect(result!.salesperson).toBe('初始销售') // 未在第二次 patch 中，保持不变
  })

  it('upsert 部分键：建行时未提供的键走默认；二次 upsert 只改 order_note，其他列不变', () => {
    const db = freshDb()
    const saleId = insertSale(db, '20261101-0006')
    const repo = createSaleExtraRepo(db)

    // 建行只提供 order_note，其他键走默认（customer_id NULL/is_national_subsidy 0/salesperson NULL）
    repo.upsert(saleId, { order_note: '首次备注' })

    let result = repo.getWithCustomer(saleId)
    expect(result!.customer_id).toBeNull() // 默认值
    expect(result!.is_national_subsidy).toBe(false) // 默认值 0 → boolean
    expect(result!.order_note).toBe('首次备注')
    expect(result!.salesperson).toBeNull() // 默认值

    // 二次 upsert 只改 order_note，其他列保持
    repo.upsert(saleId, { order_note: '二次备注' })

    result = repo.getWithCustomer(saleId)
    expect(result!.customer_id).toBeNull()
    expect(result!.is_national_subsidy).toBe(false)
    expect(result!.order_note).toBe('二次备注')
    expect(result!.salesperson).toBeNull()
  })

  it('findBySaleIds：多 id 批量查询 + 空数组返回空 Map（不跑 SQL）', () => {
    const db = freshDb()
    const saleId1 = insertSale(db, '20261101-0007')
    const saleId2 = insertSale(db, '20261101-0008')
    const saleId3 = insertSale(db, '20261101-0009') // 无 sale_extras 行
    const repo = createSaleExtraRepo(db)

    repo.insert(saleId1, {
      customer_id: null,
      is_national_subsidy: true,
      order_note: '单1备注',
      salesperson: null
    })
    repo.insert(saleId2, {
      customer_id: null,
      is_national_subsidy: false,
      order_note: null,
      salesperson: '销售员A'
    })

    // 空数组 → 空 Map
    expect(repo.findBySaleIds([])).toBeInstanceOf(Map)
    expect(repo.findBySaleIds([]).size).toBe(0)

    // 多 id 批量：有行的进 Map、无行的不进
    const map = repo.findBySaleIds([saleId1, saleId2, saleId3])
    expect(map.size).toBe(2) // saleId3 无行不在 Map
    expect(map.get(saleId1)).toEqual({
      is_national_subsidy: true,
      order_note: '单1备注'
    })
    expect(map.get(saleId2)).toEqual({
      is_national_subsidy: false,
      order_note: null
    })
    expect(map.has(saleId3)).toBe(false)
  })

  it('FK 约束：insert 到不存在的 sale_id 抛 FOREIGN KEY constraint failed', () => {
    const db = freshDb()
    const repo = createSaleExtraRepo(db)

    // sale_id 999 在 sales 表不存在——foreign_keys=ON 实约束
    expect(() =>
      repo.insert(999, {
        customer_id: null,
        is_national_subsidy: false,
        order_note: null,
        salesperson: null
      })
    ).toThrowError(/FOREIGN KEY constraint failed/)
  })
})
