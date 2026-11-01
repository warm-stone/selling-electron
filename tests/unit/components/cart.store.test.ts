// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useCartStore } from '../../../src/renderer/src/stores/cart.store'

/**
 * Task 11 — 购物车 store（pinia）单元测试（TDD 先行）。
 *
 * 锁定行为：
 * - 合并规则（D16）：行 key = product_id + unit_price_cents，同 key 重复加购 qty+1 合并
 * - 合计（G1）：整数分乘加，渲染层零浮点金额累计
 * - 数量/单价编辑防御（无效输入忽略，不产生半状态）
 * - 删除行 / 清空（含库存快照重置）
 * - 库存快照 stockByProduct：行内「库存不足（负库存将产生）」提示的数据源（D2 不阻断）
 */

/** 加购入参样例（Product 的最小字段集，与 CartAddSource 一致） */
const COLA = {
  id: 1,
  name: '可口可乐 330ml',
  barcode: '6901234567890',
  default_price_cents: 350,
  stock: 100
}
const WATER = {
  id: 2,
  name: '农夫山泉 550ml',
  barcode: '6903456789012',
  default_price_cents: 200,
  stock: 1
}
/** 无条码 + 无默认售价商品（D17/D14 边界：靠搜索加购、待手输单价） */
const BREAD = {
  id: 3,
  name: '早餐面包',
  barcode: null,
  default_price_cents: null,
  stock: 6
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('cart.store 加购与合并规则（key=product_id+unit_price_cents）', () => {
  it('加购新行：默认售价预填、qty=1、快照字段复制', () => {
    const cart = useCartStore()
    cart.addItem(COLA)

    expect(cart.items).toHaveLength(1)
    expect(cart.items[0]).toEqual({
      product_id: 1,
      name: '可口可乐 330ml',
      barcode: '6901234567890',
      quantity: 1,
      unit_price_cents: 350
    })
  })

  it('无默认售价商品：unit_price_cents 预填 0（待手输）', () => {
    const cart = useCartStore()
    cart.addItem(BREAD)

    expect(cart.items).toHaveLength(1)
    expect(cart.items[0]!.unit_price_cents).toBe(0)
    expect(cart.items[0]!.quantity).toBe(1)
  })

  it('重复加购同商品同价：qty+1 合并为单行', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.addItem(COLA)

    expect(cart.items).toHaveLength(1)
    expect(cart.items[0]!.quantity).toBe(2)
  })

  it('改价后再加购同商品：不同 key 不合并（分行）', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.updatePrice(0, 500)
    cart.addItem(COLA)

    expect(cart.items).toHaveLength(2)
    expect(cart.items[0]).toMatchObject({ unit_price_cents: 500, quantity: 1 })
    expect(cart.items[1]).toMatchObject({ unit_price_cents: 350, quantity: 1 })
  })

  it('不同商品：各自行', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.addItem(WATER)

    expect(cart.items).toHaveLength(2)
    expect(cart.items.map((i) => i.product_id)).toEqual([1, 2])
  })

  it('加购时记录库存快照（后续加购刷新为最新值）', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    expect(cart.stockByProduct[1]).toBe(100)

    cart.addItem({ ...WATER, stock: 1 })
    expect(cart.stockByProduct[2]).toBe(1)

    // 再扫一次可乐（库存被外部更新过的行数据）
    cart.addItem({ ...COLA, stock: 97 })
    expect(cart.stockByProduct[1]).toBe(97)
  })
})

describe('cart.store 数量/单价编辑防御', () => {
  it('updateQty 合法整数生效', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.updateQty(0, 5)
    expect(cart.items[0]!.quantity).toBe(5)
  })

  it('updateQty 无效值忽略：0 / 负数 / 非整数 / 越界下标', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.updateQty(0, 0)
    cart.updateQty(0, -3)
    cart.updateQty(0, 2.5)
    cart.updateQty(0, Number.NaN)
    cart.updateQty(99, 5)
    expect(cart.items[0]!.quantity).toBe(1)
    expect(cart.items).toHaveLength(1)
  })

  it('updatePrice 合法整数分生效（含 0）', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.updatePrice(0, 0)
    expect(cart.items[0]!.unit_price_cents).toBe(0)
    cart.updatePrice(0, 455)
    expect(cart.items[0]!.unit_price_cents).toBe(455)
  })

  it('updatePrice 无效值忽略：负数 / 非整数 / 越界下标', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.updatePrice(0, -1)
    cart.updatePrice(0, 3.5)
    cart.updatePrice(99, 100)
    expect(cart.items[0]!.unit_price_cents).toBe(350)
  })
})

describe('cart.store 小计/合计（G1 整数分乘加）', () => {
  it('subtotalCents：行小计 = 数量 × 单价（分）', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.updateQty(0, 3)
    expect(cart.subtotalCents(cart.items[0]!)).toBe(1050)
  })

  it('totalCents：多行整数分乘加（3×350 + 5×200 = 2050）', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.updateQty(0, 3)
    cart.addItem(WATER)
    cart.updateQty(1, 5)
    expect(cart.totalCents).toBe(2050)
  })

  it('totalCents 空车为 0；0 分单价的行不贡献合计', () => {
    const cart = useCartStore()
    expect(cart.totalCents).toBe(0)
    cart.addItem(BREAD)
    cart.updateQty(0, 4)
    expect(cart.totalCents).toBe(0)
  })
})

describe('cart.store 删除与清空', () => {
  it('removeItem：按行下标删除', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.addItem(WATER)
    cart.removeItem(0)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0]!.product_id).toBe(2)
  })

  it('clear：清空行与库存快照', () => {
    const cart = useCartStore()
    cart.addItem(COLA)
    cart.addItem(WATER)
    cart.clear()
    expect(cart.items).toHaveLength(0)
    expect(cart.totalCents).toBe(0)
    expect(cart.stockByProduct).toEqual({})
  })
})
