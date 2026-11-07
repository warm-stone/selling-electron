import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { createCustomerRepo } from '../../../src/main/db/repositories/customer.repo'
import { rmTempDirSync } from '../../helpers/cleanup'

let dir: string

/** 本文件打开的连接登记（Windows 不可删打开中的文件：afterEach 先逐一 close 再删目录） */
const openDbs: Database.Database[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-customer-repo-'))
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

/** 本地日期 YYYY-MM-DD（datetime('now','localtime') 产出值的前缀断言用） */
function localDateStr(): string {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')
}

describe('customer.repo：客户 DAL（customers 表，005 迁移）', () => {
  it('insert + findByPhone 精确命中：回读完整行、id 一致', () => {
    const repo = createCustomerRepo(freshDb())
    const created = repo.insert({
      name: '张三',
      phone: '13800138000',
      address: '幸福路 1 号',
      note: 'VIP'
    })

    // 回读即完整行：id 已分配、DEFAULT 生成的两个时间戳为 localtime
    expect(created.id).toBeGreaterThan(0)
    expect(created.name).toBe('张三')
    expect(created.phone).toBe('13800138000')
    expect(created.address).toBe('幸福路 1 号')
    expect(created.note).toBe('VIP')
    expect(created.created_at.startsWith(localDateStr())).toBe(true)
    expect(created.updated_at.startsWith(localDateStr())).toBe(true)

    const found = repo.findByPhone('13800138000')
    expect(found).toBeDefined()
    expect(found!.id).toBe(created.id)
    expect(found!.name).toBe('张三')
  })

  it('findByPhone 精确匹配：带空格（前/后）的号码不命中（trim 是上层职责）', () => {
    const repo = createCustomerRepo(freshDb())
    repo.insert({ name: '张三', phone: '13800138000', address: '', note: '' })

    expect(repo.findByPhone(' 13800138000')).toBeUndefined()
    expect(repo.findByPhone('13800138000 ')).toBeUndefined()
  })

  it('findByPhone 不存在的号码 → undefined', () => {
    const repo = createCustomerRepo(freshDb())
    expect(repo.findByPhone('13900139000')).toBeUndefined()
  })

  it('update patch 单键：只改 name，phone/address/note 原样，updated_at 刷新', () => {
    const db = freshDb()
    const repo = createCustomerRepo(db)
    const created = repo.insert({
      name: '张三',
      phone: '13800138000',
      address: '幸福路 1 号',
      note: 'VIP'
    })
    // 回拨 updated_at 到过去：datetime 秒级分辨率下「刷新」断言才有确定性
    db.prepare("UPDATE customers SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(
      created.id
    )

    repo.update(created.id, { name: '张三丰' })

    const after = repo.getById(created.id)!
    expect(after.name).toBe('张三丰')
    expect(after.phone).toBe('13800138000')
    expect(after.address).toBe('幸福路 1 号')
    expect(after.note).toBe('VIP')
    expect(after.updated_at).not.toBe('2000-01-01 00:00:00')
    expect(after.updated_at.startsWith(localDateStr())).toBe(true)
  })

  it('update 多键 patch：同时改 phone/address/note，未涉及键原样', () => {
    const repo = createCustomerRepo(freshDb())
    const created = repo.insert({
      name: '李四',
      phone: '13900139000',
      address: '旧地址',
      note: '旧备注'
    })

    repo.update(created.id, { phone: '13900139001', address: '新地址', note: '新备注' })

    const after = repo.getById(created.id)!
    expect(after.name).toBe('李四')
    expect(after.phone).toBe('13900139001')
    expect(after.address).toBe('新地址')
    expect(after.note).toBe('新备注')
  })

  it('update 不存在的 id：静默无异常、无行变化', () => {
    const db = freshDb()
    const repo = createCustomerRepo(db)
    const created = repo.insert({ name: '张三', phone: '13800138000', address: '', note: '' })

    expect(() => repo.update(999, { name: '幽灵' })).not.toThrow()

    // 既有行原样、表内未新增行
    const after = repo.getById(created.id)!
    expect(after.name).toBe('张三')
    const n = (db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n
    expect(n).toBe(1)
    expect(repo.getById(999)).toBeUndefined()
  })

  it('list：keyword 匹配 name（张）/ phone（138）；空 keyword 全部 + total；ORDER BY id DESC', () => {
    const repo = createCustomerRepo(freshDb())
    const a = repo.insert({ name: '张三', phone: '13800138000', address: '', note: '' })
    const b = repo.insert({ name: '李四', phone: '13900139000', address: '', note: '' })
    const c = repo.insert({ name: '王五', phone: '13700137000', address: '', note: '' })

    // keyword 命中 name 子串
    const byName = repo.list('张', 10, 0)
    expect(byName.items.map((x) => x.id)).toEqual([a.id])
    expect(byName.total).toBe(1)

    // keyword 命中 phone 子串
    const byPhone = repo.list('138', 10, 0)
    expect(byPhone.items.map((x) => x.phone)).toEqual(['13800138000'])
    expect(byPhone.total).toBe(1)

    // 空 keyword：全部返回、total 正确、最新在前（id DESC）
    const all = repo.list('', 10, 0)
    expect(all.items.map((x) => x.id)).toEqual([c.id, b.id, a.id])
    expect(all.total).toBe(3)
  })

  it('list 分页：limit/offset 翻页正确，keyword + 分页叠加，total 恒为过滤总数', () => {
    const repo = createCustomerRepo(freshDb())
    const zhang1 = repo.insert({ name: '张三', phone: '13800138000', address: '', note: '' })
    const li = repo.insert({ name: '李四', phone: '13900139000', address: '', note: '' })
    const zhang2 = repo.insert({ name: '张飞', phone: '13811138000', address: '', note: '' })
    const wang = repo.insert({ name: '王五', phone: '13700137000', address: '', note: '' })

    // 全量分页（id DESC：王五 → 张飞 → 李四 → 张三）
    const page1 = repo.list('', 2, 0)
    expect(page1.items.map((x) => x.id)).toEqual([wang.id, zhang2.id])
    expect(page1.total).toBe(4)
    const page2 = repo.list('', 2, 2)
    expect(page2.items.map((x) => x.id)).toEqual([li.id, zhang1.id])
    expect(page2.total).toBe(4)
    // 越界页：空 items、total 不受分页影响
    const page3 = repo.list('', 2, 4)
    expect(page3.items).toEqual([])
    expect(page3.total).toBe(4)

    // keyword + 分页叠加（张三/张飞 命中「张」，id DESC：张飞 → 张三）
    const zhangPage1 = repo.list('张', 1, 0)
    expect(zhangPage1.items.map((x) => x.id)).toEqual([zhang2.id])
    expect(zhangPage1.total).toBe(2)
    const zhangPage2 = repo.list('张', 1, 1)
    expect(zhangPage2.items.map((x) => x.id)).toEqual([zhang1.id])
    expect(zhangPage2.total).toBe(2)
  })

  it('getById 往返：insert 返回行再取同行；不存在 id → undefined', () => {
    const repo = createCustomerRepo(freshDb())
    const created = repo.insert({
      name: '李四',
      phone: '13900139000',
      address: '解放路 2 号',
      note: ''
    })

    expect(repo.getById(created.id)).toEqual(created)
    expect(repo.getById(created.id + 100)).toBeUndefined()
  })

  it('phone UNIQUE 兜底：同号二插抛 UNIQUE constraint failed（repo 不拦截、错误上浮 service）', () => {
    const repo = createCustomerRepo(freshDb())
    repo.insert({ name: '张三', phone: '13800138000', address: '', note: '' })

    expect(() =>
      repo.insert({ name: '冒名张三', phone: '13800138000', address: '', note: '' })
    ).toThrowError(/UNIQUE constraint failed/)
  })
})
