/**
 * checkout 附加信息 + updateExtra + getDetail.extras 测试（计划任务 8）。
 *
 * 脚手架照存量 sale.service.test.ts 模式（mkdtemp + initDatabase + 商品预置），
 * 本文件只覆盖附加信息扩展面——主流程（单号/快照/SN/库存/流水）回归由存量
 * sale.service.test.ts 保证。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { closeDatabase, initDatabase } from '../../../src/main/db/database'
import {
  SaleServiceError,
  createSaleService
} from '../../../src/main/services/sale.service'
import type { SaleErrorCode } from '../../../src/main/services/sale.service'
import {
  RECENT_SALESPERSONS_KEY,
  parseRecentSalespersons
} from '../../../src/main/services/salesperson-history'
import { createSettingsRepo } from '../../../src/main/db/repositories/settings.repo'
import { rmTempDirSync } from '../../helpers/cleanup'
import type { CheckoutExtrasInput } from '../../../src/shared/types'

// ── 测试脚手架（复用存量模式）────────────────────────────────

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-sale-extras-'))
  db = initDatabase(dir)
})

afterEach(() => {
  closeDatabase()
  rmTempDirSync(dir)
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

/** SN 商品建档 + SN 入库（快照/台账构造照存量模式） */
function addSnProductWithSn(name: string, sn: string): void {
  const r = db
    .prepare(
      "INSERT INTO products (barcode, name, default_price_cents, stock, tracking) VALUES (NULL, ?, 100, 0, 'sn')"
    )
    .run(name)
  const productId = Number(r.lastInsertRowid)
  db.prepare('INSERT INTO product_sns (product_id, sn) VALUES (?, ?)').run(
    productId,
    sn
  )
  db.prepare('UPDATE products SET stock = stock + 1 WHERE id = ?').run(
    productId
  )
}

function count(table: string, where = '', ...params: unknown[]): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
    .get(...params) as { n: number }
  return row.n
}

function recentSalespersons(): string[] {
  return parseRecentSalespersons(
    createSettingsRepo(db).get(RECENT_SALESPERSONS_KEY)
  )
}

function expectReject(
  fn: () => unknown,
  code: SaleErrorCode,
  message?: string
): void {
  try {
    fn()
    expect.unreachable(`应抛 ${code}`)
  } catch (e) {
    expect(e).toBeInstanceOf(SaleServiceError)
    expect((e as SaleServiceError).code).toBe(code)
    if (message != null) {
      expect((e as SaleServiceError).message).toBe(message)
    }
  }
}

/** sale_extras 原始行（INTEGER 形态直读） */
function extraRow(saleId: number): {
  customer_id: number | null
  is_national_subsidy: number
  order_note: string | null
  salesperson: string | null
} {
  return db
    .prepare('SELECT * FROM sale_extras WHERE sale_id = ?')
    .get(saleId) as {
    customer_id: number | null
    is_national_subsidy: number
    order_note: string | null
    salesperson: string | null
  }
}

function customerRow(id: number): {
  name: string
  phone: string
  address: string
  note: string
} {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as {
    name: string
    phone: string
    address: string
    note: string
  }
}

// ── 1. assertValidExtras：service 层镜像校验 ──────────────────

describe('checkout：附加信息校验（service 层镜像校验）', () => {
  it('customer.name 有 phone 无 → SALE_EXTRAS_PHONE_REQUIRED，零落库', () => {
    const cola = addProduct('可乐', { barcode: 'EX01', stock: 10 })
    expectReject(
      () =>
        svc().checkout(
          [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
          {
            customer: { name: '王五', phone: '   ', address: '', note: '' }
          }
        ),
      'SALE_EXTRAS_PHONE_REQUIRED',
      '填写客户信息时，电话不能为空'
    )
    expect(count('sales')).toBe(0)
    expect(count('customers')).toBe(0)
    expect(count('sale_extras')).toBe(0)
  })

  it('customer.address 有 phone 无 → SALE_EXTRAS_PHONE_REQUIRED（地址同规则）', () => {
    const cola = addProduct('可乐', { barcode: 'EX02', stock: 10 })
    expectReject(
      () =>
        svc().checkout(
          [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
          {
            customer: { name: '', phone: '', address: '幸福路 1 号', note: '' }
          }
        ),
      'SALE_EXTRAS_PHONE_REQUIRED'
    )
    expect(count('sales')).toBe(0)
    expect(count('customers')).toBe(0)
  })

  it('★customer.note 有 phone 无 → SALE_EXTRAS_PHONE_REQUIRED（备注缝隙 L2），零落库', () => {
    const cola = addProduct('可乐', { barcode: 'EX02N', stock: 10 })
    expectReject(
      () =>
        svc().checkout(
          [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
          {
            customer: { name: '', phone: '', address: '', note: 'VIP 备注' }
          }
        ),
      'SALE_EXTRAS_PHONE_REQUIRED',
      '填写客户信息时，电话不能为空'
    )
    expect(count('sales')).toBe(0)
    expect(count('customers')).toBe(0)
    expect(count('sale_extras')).toBe(0)
  })

  it('★customer.note + phone → 合法（客户建档，note 有载体）', () => {
    const cola = addProduct('可乐', { barcode: 'EX02P', stock: 10 })
    const receipt = svc().checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '', phone: '13800005678', address: '', note: 'VIP 备注' }
      }
    )
    expect(count('customers')).toBe(1)
    expect(customerRow(1)).toMatchObject({
      phone: '13800005678',
      note: 'VIP 备注'
    })
    expect(extraRow(receipt.id).customer_id).toBe(1)
  })

  it('subsidy=true 无 name → SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER（有电话也不行），零落库', () => {
    const cola = addProduct('可乐', { barcode: 'EX03', stock: 10 })
    expectReject(
      () =>
        svc().checkout(
          [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
          {
            customer: { name: '', phone: '13800001234', address: '', note: '' },
            is_national_subsidy: true
          }
        ),
      'SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER',
      '参与国补需填写客户姓名和电话'
    )
    expect(count('sales')).toBe(0)
    expect(count('customers')).toBe(0)
    expect(count('sale_extras')).toBe(0)
  })

  it('subsidy=true 无 customer → SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER', () => {
    const cola = addProduct('可乐', { barcode: 'EX04', stock: 10 })
    expectReject(
      () =>
        svc().checkout(
          [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
          { is_national_subsidy: true, order_note: '国补单' }
        ),
      'SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER'
    )
    expect(count('sales')).toBe(0)
  })

  it('customer 四字段全空 + subsidy=false → 合法（视为无客户信息）', () => {
    const cola = addProduct('可乐', { barcode: 'EX05', stock: 10 })
    expect(() =>
      svc().checkout(
        [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
        {
          customer: { name: ' ', phone: '', address: '', note: '' },
          is_national_subsidy: false
        }
      )
    ).not.toThrow()
  })
})

// ── 2. 快单路径（散客——零附加行，与现状完全一致）──────────────

describe('checkout：快单路径（零附加写入）', () => {
  it('extras undefined → 落库成功、sale_extras 0 行、customers 0 行、返回 extras=null', () => {
    const cola = addProduct('可乐', { barcode: 'EX06', stock: 10 })
    const receipt = svc().checkout([
      { product_id: cola, quantity: 2, unit_price_cents: 350, sn: null }
    ])
    expect(count('sales')).toBe(1)
    expect(count('sale_extras')).toBe(0)
    expect(count('customers')).toBe(0)
    expect(receipt.extras).toBeNull()
  })

  it('extras 全空对象 {} → 同上不写附加行', () => {
    const cola = addProduct('可乐', { barcode: 'EX07', stock: 10 })
    svc().checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {}
    )
    expect(count('sale_extras')).toBe(0)
    expect(count('customers')).toBe(0)
    expect(count('sales')).toBe(1)
  })

  it('customer 四字段全空对象 + 无其它附加 → 不建档不写附加行（快单变体）', () => {
    const cola = addProduct('可乐', { barcode: 'EX08', stock: 10 })
    svc().checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      { customer: { name: '', phone: '', address: '', note: '' } }
    )
    expect(count('sale_extras')).toBe(0)
    expect(count('customers')).toBe(0)
    expect(count('sales')).toBe(1)
  })
})

// ── 3. 附加信息落库（客户 find-or-create + sale_extras + trim）──

describe('checkout：附加信息落库', () => {
  it('新电话+姓名 → customers 1 行、extras customer_id 正确、国补/备注/销售人员落库正确（全字段 trim）', () => {
    const cola = addProduct('可乐', { barcode: 'EX09', stock: 10 })
    const extras: CheckoutExtrasInput = {
      customer: {
        name: ' 王五 ',
        phone: ' 13800001234 ',
        address: ' 幸福路 1 号 ',
        note: ' VIP '
      },
      is_national_subsidy: true,
      order_note: ' 开发票 ',
      salesperson: ' 赵六 '
    }
    const receipt = svc().checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      extras
    )

    // customers：1 行，四字段 trim 后落库
    expect(count('customers')).toBe(1)
    const customer = customerRow(1)
    expect(customer).toMatchObject({
      name: '王五',
      phone: '13800001234',
      address: '幸福路 1 号',
      note: 'VIP'
    })

    // sale_extras：customer_id 关联 + 国补 INTEGER 1 + trim 后备注/销售人员
    const row = extraRow(receipt.id)
    expect(row).toEqual({
      sale_id: receipt.id,
      customer_id: 1,
      is_national_subsidy: 1,
      order_note: '开发票',
      salesperson: '赵六'
    })

    // 返回结构：extras 平铺（含 customer 引用）
    expect(receipt.extras).toMatchObject({
      sale_id: receipt.id,
      customer_id: 1,
      is_national_subsidy: true,
      order_note: '开发票',
      salesperson: '赵六',
      customer: { id: 1, name: '王五', phone: '13800001234' }
    })

    // 销售人员历史：settings recent_salespersons 含 ['赵六']
    expect(recentSalespersons()).toEqual(['赵六'])
  })

  it('customer 全空 + order_note → 不建档（customer_id=null）但写附加行（note-only 已被 L2 校验拒绝，此为合法等价形态）', () => {
    const cola = addProduct('可乐', { barcode: 'EX10', stock: 10 })
    const receipt = svc().checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '', phone: '', address: '', note: '' },
        order_note: '回头客'
      }
    )
    expect(count('customers')).toBe(0)
    expect(extraRow(receipt.id)).toEqual({
      sale_id: receipt.id,
      customer_id: null,
      is_national_subsidy: 0,
      order_note: '回头客',
      salesperson: null
    })
  })

  it('同电话二次结账 → customers 仍 1 行、两单 extras 同一 customer_id、档案 PUT 更新', () => {
    const cola = addProduct('可乐', { barcode: 'EX11', stock: 10 })
    const service = svc()
    const first = service.checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '张三', phone: '13811112222', address: '', note: '备注1' }
      }
    )
    const second = service.checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: {
          name: '张三丰',
          phone: '13811112222',
          address: '新地址',
          note: ''
        }
      }
    )
    expect(count('customers')).toBe(1)
    const customerId = extraRow(first.id).customer_id
    expect(extraRow(second.id).customer_id).toBe(customerId)
    // PUT 全量覆盖：name/address 更新、note 清空、phone 不动
    expect(customerRow(customerId as number)).toMatchObject({
      name: '张三丰',
      phone: '13811112222',
      address: '新地址',
      note: ''
    })
  })

  it('预填客户（SQL 直插）被改 name/address/清空 note → 档案 PUT 更新、phone 未变', () => {
    const cola = addProduct('可乐', { barcode: 'EX12', stock: 10 })
    db.prepare(
      "INSERT INTO customers (name, phone, address, note) VALUES ('李原始', '13700001111', '旧地址', '旧备注')"
    ).run()
    const before = customerRow(1)
    expect(before.phone).toBe('13700001111')

    const receipt = svc().checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '李更新', phone: '13700001111', address: '新地址', note: '' }
      }
    )

    expect(count('customers')).toBe(1)
    expect(extraRow(receipt.id).customer_id).toBe(1)
    // PUT 更新 + phone 永不 UPDATE（Q1 定案：电话只读查找键）
    expect(customerRow(1)).toMatchObject({
      name: '李更新',
      phone: '13700001111',
      address: '新地址',
      note: ''
    })
  })
})

// ── 4. 销售人员最近输入（settings 事务内写入）──────────────────

describe('checkout：销售人员最近输入（recent_salespersons）', () => {
  it("salesperson='张三' 结账 → settings recent_salespersons 含 ['张三']", () => {
    const cola = addProduct('可乐', { barcode: 'EX13', stock: 10 })
    svc().checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      { salesperson: '张三' }
    )
    expect(recentSalespersons()).toEqual(['张三'])
  })

  it('连续 11 个不同名字 → 队列长度 10（最旧逐出、最新置顶）', () => {
    const cola = addProduct('可乐', { barcode: 'EX14', stock: 100 })
    const service = svc()
    for (let i = 1; i <= 11; i++) {
      service.checkout(
        [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
        { salesperson: `销售${String(i).padStart(2, '0')}` }
      )
    }
    const list = recentSalespersons()
    expect(list).toHaveLength(10)
    expect(list[0]).toBe('销售11')
    expect(list).not.toContain('销售01')
  })
})

// ── 5. 回滚原子性（★验收主测试）──────────────────────────────

describe('checkout：附加信息回滚原子性（G2 单事务）', () => {
  it('extras 全填 + SN 已售触发 SALE_SN_SOLD → sales/customers/sale_extras/settings 四表零残留', () => {
    addSnProductWithSn('红米手机', 'SN001')
    // 直接 SQL 预置已售台账（不经 checkout——保证 sales 初始 0 行）
    db.prepare("UPDATE product_sns SET status = 'sold' WHERE sn = 'SN001'").run()
    const phoneId = (
      db.prepare('SELECT id FROM products LIMIT 1').get() as { id: number }
    ).id

    expectReject(
      () =>
        svc().checkout(
          [{ product_id: phoneId, quantity: 1, unit_price_cents: 299900, sn: 'SN001' }],
          {
            customer: { name: '回滚客户', phone: '13611112222', address: '', note: '' },
            is_national_subsidy: true,
            order_note: '回滚备注',
            salesperson: '回滚销售'
          }
        ),
      'SALE_SN_SOLD'
    )

    expect(count('sales')).toBe(0)
    expect(count('customers')).toBe(0)
    expect(count('sale_extras')).toBe(0)
    expect(
      createSettingsRepo(db).get(RECENT_SALESPERSONS_KEY)
    ).toBeNull()
  })
})

// ── 6. updateExtra（Q4/Q5 定案语义）──────────────────────────

describe('updateExtra：修改销售附加信息', () => {
  it('单不存在 → SALE_NOT_FOUND', () => {
    expectReject(() => svc().updateExtra(99999, {}), 'SALE_NOT_FOUND')
  })

  it('voided 单 → SALE_ALREADY_VOIDED（Q4 定案），零写入', () => {
    const cola = addProduct('可乐', { barcode: 'EX15', stock: 10 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])
    service.voidSale(receipt.id)

    expectReject(
      () =>
        service.updateExtra(receipt.id, {
          customer: { name: '王五', phone: '13800001234', address: '', note: '' }
        }),
      'SALE_ALREADY_VOIDED',
      '该销售单已作废'
    )
    expect(count('sale_extras')).toBe(0)
    expect(count('customers')).toBe(0)
  })

  it('旧单（无 extras 行）勾国补 + 补姓名电话 → upsert 建行成功', () => {
    const cola = addProduct('可乐', { barcode: 'EX16', stock: 10 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])
    expect(count('sale_extras')).toBe(0)

    const updated = service.updateExtra(receipt.id, {
      is_national_subsidy: true,
      customer: { name: '钱七', phone: '13733334444', address: '', note: '' }
    })

    expect(count('sale_extras')).toBe(1)
    expect(count('customers')).toBe(1)
    expect(extraRow(receipt.id)).toEqual({
      sale_id: receipt.id,
      customer_id: 1,
      is_national_subsidy: 1,
      order_note: null,
      salesperson: null
    })
    expect(updated.extras).toMatchObject({
      is_national_subsidy: true,
      customer: { name: '钱七', phone: '13733334444' }
    })
  })

  it('customer: null → customer_id 置 NULL（解绑），行保留其余字段不动', () => {
    const cola = addProduct('可乐', { barcode: 'EX17', stock: 10 })
    const service = svc()
    const receipt = service.checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '王五', phone: '13800001234', address: '', note: '' },
        salesperson: '李四'
      }
    )
    expect(extraRow(receipt.id).customer_id).toBe(1)

    const updated = service.updateExtra(receipt.id, { customer: null })

    const row = extraRow(receipt.id)
    expect(row.customer_id).toBeNull()
    expect(row.salesperson).toBe('李四') // 行保留：未提供的键不动
    expect(updated.extras?.customer).toBeNull()
    expect(count('customers')).toBe(1) // 解绑不删客户档案
  })

  it('customer 电话 trim 空（四字段空对象）→ 同样解绑', () => {
    const cola = addProduct('可乐', { barcode: 'EX18', stock: 10 })
    const service = svc()
    const receipt = service.checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '王五', phone: '13800001234', address: '', note: '' }
      }
    )
    service.updateExtra(receipt.id, {
      customer: { name: '', phone: '   ', address: '', note: '' }
    })
    expect(extraRow(receipt.id).customer_id).toBeNull()
  })

  it('新电话 → find-or-create 建档 + 关联（旧客户档案保留）', () => {
    const cola = addProduct('可乐', { barcode: 'EX19', stock: 10 })
    const service = svc()
    const receipt = service.checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '客户A', phone: '13800000001', address: '', note: '' }
      }
    )

    const updated = service.updateExtra(receipt.id, {
      customer: { name: '孙八', phone: '13900000002', address: '新城市', note: '' }
    })

    expect(count('customers')).toBe(2) // A 保留 + 新建 B
    expect(extraRow(receipt.id).customer_id).toBe(2)
    expect(updated.extras?.customer).toMatchObject({
      id: 2,
      name: '孙八',
      phone: '13900000002'
    })
  })

  it('旧单勾国补但无客户 → SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER（Q5：综合 final 状态），零写入', () => {
    const cola = addProduct('可乐', { barcode: 'EX20', stock: 10 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])

    expectReject(
      () => service.updateExtra(receipt.id, { is_national_subsidy: true }),
      'SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER'
    )
    expect(count('sale_extras')).toBe(0)
  })

  it('旧单已勾国补 + 解绑客户（customer:null）→ 同样拦截（final 状态校验）', () => {
    const cola = addProduct('可乐', { barcode: 'EX21', stock: 10 })
    const service = svc()
    const receipt = service.checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '王五', phone: '13800001234', address: '', note: '' },
        is_national_subsidy: true
      }
    )

    expectReject(
      () => service.updateExtra(receipt.id, { customer: null }),
      'SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER'
    )
    // 校验先于写入：原行不动
    expect(extraRow(receipt.id).customer_id).toBe(1)
    expect(extraRow(receipt.id).is_national_subsidy).toBe(1)
  })

  it('patch.customer name 非空 phone 空 → SALE_EXTRAS_PHONE_REQUIRED', () => {
    const cola = addProduct('可乐', { barcode: 'EX22', stock: 10 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])

    expectReject(
      () =>
        service.updateExtra(receipt.id, {
          customer: { name: '赵九', phone: '', address: '', note: '' }
        }),
      'SALE_EXTRAS_PHONE_REQUIRED',
      '填写客户信息时，电话不能为空'
    )
  })

  it('★patch.customer 只带 note 无 phone → SALE_EXTRAS_PHONE_REQUIRED（备注缝隙 L2，与 checkout 同规则）', () => {
    const cola = addProduct('可乐', { barcode: 'EX22N', stock: 10 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])

    expectReject(
      () =>
        service.updateExtra(receipt.id, {
          customer: { name: '', phone: '   ', address: '', note: '老客户' }
        }),
      'SALE_EXTRAS_PHONE_REQUIRED',
      '填写客户信息时，电话不能为空'
    )
    // 校验先于写入：未建档、未写附加行
    expect(count('customers')).toBe(0)
    expect(count('sale_extras')).toBe(0)
  })

  it('salesperson 非空 → sale_extras 更新 + recent_salespersons 写入（事务内）', () => {
    const cola = addProduct('可乐', { barcode: 'EX23', stock: 10 })
    const service = svc()
    const receipt = service.checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])

    const updated = service.updateExtra(receipt.id, { salesperson: '王销售' })

    expect(extraRow(receipt.id).salesperson).toBe('王销售')
    expect(recentSalespersons()).toEqual(['王销售'])
    expect(updated.extras?.salesperson).toBe('王销售')
  })

  it('order_note 修改：trim 后空 → null（清空）', () => {
    const cola = addProduct('可乐', { barcode: 'EX24', stock: 10 })
    const service = svc()
    const receipt = service.checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      { order_note: '原始备注' }
    )
    expect(extraRow(receipt.id).order_note).toBe('原始备注')

    service.updateExtra(receipt.id, { order_note: '   ' })
    expect(extraRow(receipt.id).order_note).toBeNull()
  })
})

// ── 7. getDetail：extras 两态 ─────────────────────────────────

describe('getDetail：extras 两态（T2 契约——无行为 null）', () => {
  it('有 extras 行（含客户）→ 完整平铺；无行（快单）→ null', () => {
    const cola = addProduct('可乐', { barcode: 'EX25', stock: 10 })
    const service = svc()
    const quick = service.checkout([
      { product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }
    ])
    const full = service.checkout(
      [{ product_id: cola, quantity: 1, unit_price_cents: 100, sn: null }],
      {
        customer: { name: '周十', phone: '13666667777', address: '南京路', note: '老客' },
        is_national_subsidy: true,
        order_note: '保修一年',
        salesperson: '吴销售'
      }
    )

    // 快单：无 sale_extras 行 → extras 整体 null（禁止空对象冒充）
    expect(count('sale_extras')).toBe(1)
    expect(service.getDetail(quick.id).extras).toBeNull()

    // 全填单：extras 行 + 平铺客户（引用非快照）
    const extras = service.getDetail(full.id).extras
    expect(extras).toEqual({
      sale_id: full.id,
      customer_id: 1,
      is_national_subsidy: true,
      order_note: '保修一年',
      salesperson: '吴销售',
      customer: {
        id: 1,
        name: '周十',
        phone: '13666667777',
        address: '南京路',
        note: '老客',
        created_at: expect.any(String),
        updated_at: expect.any(String)
      }
    })
  })
})
