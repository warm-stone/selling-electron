import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { closeDatabase, initDatabase } from '../../../src/main/db/database'
import {
  CustomerServiceError,
  createCustomerService
} from '../../../src/main/services/customer.service'
import { rmTempDirSync } from '../../helpers/cleanup'
import type { Customer } from '../../../src/shared/types'

// ── 测试脚手架 ──────────────────────────────────────────────

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-customer-service-'))
  db = initDatabase(dir)
})

afterEach(() => {
  // initDatabase 是模块级单例：不关闭则 Windows 上删 temp 目录 EBUSY
  closeDatabase()
  rmTempDirSync(dir)
})

function svc(): ReturnType<typeof createCustomerService> {
  return createCustomerService(db)
}

/** 建客户快捷方式（走 service.create 全归一——测试数据与生产同一条路径） */
function mkCustomer(name: string, phone: string): Customer {
  return svc().create({ name, phone, address: '', note: '' })
}

/** 断言 fn 抛 CustomerServiceError：非该类型/未抛均转为显式失败；返回错误供 code/message 断言 */
function expectErr(fn: () => unknown): CustomerServiceError {
  try {
    fn()
  } catch (err) {
    if (err instanceof CustomerServiceError) return err
    throw new Error(`预期 CustomerServiceError，实际抛出：${String(err)}`)
  }
  throw new Error('预期抛出 CustomerServiceError，实际正常返回')
}

// ── 用例 ────────────────────────────────────────────────────

describe('customer.service（计划任务 7：客户管理业务核心）', () => {
  it('create 成功：四字段 trim 后落库并回读（" 13800138000 " → "13800138000"）', () => {
    const c = svc().create({
      name: ' 张三 ',
      phone: ' 13800138000 ',
      address: ' 北京市海淀区 ',
      note: ' VIP 客户 '
    })
    expect(c.name).toBe('张三')
    expect(c.phone).toBe('13800138000')
    expect(c.address).toBe('北京市海淀区')
    expect(c.note).toBe('VIP 客户')
    expect(c.id).toBeGreaterThan(0)
    expect(c.created_at).toBeTruthy()
    // 落库形态（非仅返回值——防 service 返回与 DB 脱节）
    const row = db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(c.id) as {
      name: string
      phone: string
    }
    expect(row).toEqual({ name: '张三', phone: '13800138000' })
  })

  it('create 电话冲突：CUSTOMER_PHONE_EXISTS + message 内嵌现有客户姓名「张三」', () => {
    mkCustomer('张三', '13800138000')
    const err = expectErr(() =>
      svc().create({ name: '李四', phone: ' 13800138000 ', address: '', note: '' })
    )
    expect(err.code).toBe('CUSTOMER_PHONE_EXISTS')
    expect(err.message).toBe('该电话已被客户「张三」使用')
    expect(err.name).toBe('CustomerServiceError')
  })

  it('create phone 空串/纯空白 → CUSTOMER_PHONE_REQUIRED（DB 侧空串可插一次，service 必须前置拦截）', () => {
    const empty = expectErr(() =>
      svc().create({ name: '张三', phone: '', address: '', note: '' })
    )
    expect(empty.code).toBe('CUSTOMER_PHONE_REQUIRED')
    expect(empty.message).toBe('客户电话不能为空')
    // 纯空白 trim 后同为空串
    const blank = expectErr(() =>
      svc().create({ name: '张三', phone: '   ', address: '', note: '' })
    )
    expect(blank.code).toBe('CUSTOMER_PHONE_REQUIRED')
    // 拦截发生在 INSERT 前：零落库
    expect(countCustomers()).toBe(0)
  })

  it('create 非手机号格式 → CUSTOMER_PHONE_INVALID（座机/短号/含字母），零落库', () => {
    for (const phone of ['05718888888', '138', '138001380001', '1380013800a']) {
      const err = expectErr(() =>
        svc().create({ name: '张三', phone, address: '', note: '' })
      )
      expect(err.code).toBe('CUSTOMER_PHONE_INVALID')
      expect(err.message).toBe('请输入正确的手机号（1 开头 11 位）')
    }
    expect(countCustomers()).toBe(0)
  })

  it('update 电话实际变更但非手机号格式 → CUSTOMER_PHONE_INVALID', () => {
    const c = mkCustomer('张三', '13800138000')
    const err = expectErr(() => svc().update(c.id, { phone: '12345678901' }))
    expect(err.code).toBe('CUSTOMER_PHONE_INVALID')
    expect(err.message).toBe('请输入正确的手机号（1 开头 11 位）')
    // 拦截在写入前：原电话未动
    expect(svc().list('13800138000').total).toBe(1)
  })

  it('update 电话未变（存量座机等旧格式档案）→ 格式校验放行，可改其他字段', () => {
    // SQL 直插旧格式档案（service.create 已拦截座机——存量数据模拟走 DB 直写）
    db.prepare(
      "INSERT INTO customers (name, phone, address, note) VALUES ('老客户', '05718888888', '', '')"
    ).run()
    const legacy = db
      .prepare('SELECT id FROM customers WHERE phone = ?')
      .get('05718888888') as { id: number }

    // 电话原值重传 + 改名：未变放行
    const updated = svc().update(legacy.id, {
      name: '老客户（改名）',
      phone: '05718888888'
    })
    expect(updated.name).toBe('老客户（改名）')
    expect(updated.phone).toBe('05718888888')
  })

  it('update 改名成功：phone 不传不动（动态 SET 只刷出现键）', () => {
    const c = mkCustomer('张三', '13800138000')
    const updated = svc().update(c.id, { name: '张三丰' })
    expect(updated.name).toBe('张三丰')
    expect(updated.phone).toBe('13800138000')
    expect(updated.address).toBe('')
  })

  it('update 自己电话传原值 → 不冲突（查重排除自身 hit.id !== id）', () => {
    const c = mkCustomer('张三', '13800138000')
    const updated = svc().update(c.id, { phone: ' 13800138000 ' })
    expect(updated.phone).toBe('13800138000')
    expect(updated.name).toBe('张三')
    // 排除自身后未误伤他人查重：同电话另一客户仍在
    expect(svc().list('13800138000').total).toBe(1)
  })

  it('update 电话撞他人 → CUSTOMER_PHONE_EXISTS + message 内嵌「李四」', () => {
    const zhang = mkCustomer('张三', '13800138000')
    mkCustomer('李四', '13900139000')
    const err = expectErr(() => svc().update(zhang.id, { phone: '13900139000' }))
    expect(err.code).toBe('CUSTOMER_PHONE_EXISTS')
    expect(err.message).toBe('该电话已被客户「李四」使用')
  })

  it('update 不存在 id → CUSTOMER_NOT_FOUND（repo.update 静默 0 行，service 回读校验兜底）', () => {
    const err = expectErr(() => svc().update(99999, { name: '幽灵' }))
    expect(err.code).toBe('CUSTOMER_NOT_FOUND')
    expect(err.message).toBe('客户不存在（可能已被删除）')
  })

  it('list 搜索：『张』→ 1 行（name 命中）、『138』→ 1 行（phone 命中）、『』→ 全量 total', () => {
    mkCustomer('张三', '13800138000')
    mkCustomer('李四', '13900139000')

    const byName = svc().list('张')
    expect(byName.items).toHaveLength(1)
    expect(byName.items[0]!.name).toBe('张三')
    expect(byName.total).toBe(1)

    const byPhone = svc().list('138')
    expect(byPhone.items).toHaveLength(1)
    expect(byPhone.items[0]!.phone).toBe('13800138000')

    const all = svc().list('', 20, 0)
    expect(all.items).toHaveLength(2)
    expect(all.total).toBe(2)
  })

  it('list 分页与归一：keyword trim 命中；limit/offset 生效；缺省 limit 20 / offset 0', () => {
    mkCustomer('张三', '13800138000')
    mkCustomer('李四', '13900139000')
    mkCustomer('王五', '13700137000')

    // keyword 带空白 → trim 后 LIKE 命中（'  李  ' → '李'）
    expect(svc().list('  李  ').items).toHaveLength(1)

    // limit 2 + offset 0 → 2 行；total 与分页无关
    const page1 = svc().list('', 2, 0)
    expect(page1.items).toHaveLength(2)
    expect(page1.total).toBe(3)
    // offset 2 → 尾页 1 行（ORDER BY id DESC）
    const page2 = svc().list('', 2, 2)
    expect(page2.items).toHaveLength(1)

    // 全缺省（undefined limit/offset → 20/0）返回全部 3 行
    expect(svc().list().items).toHaveLength(3)

    // 非法 limit/offset 回落缺省与 0（clamp 不炸）
    expect(svc().list('', 0, -5).items).toHaveLength(3)
  })
})

function countCustomers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n
}
