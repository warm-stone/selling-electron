import { defineStore } from 'pinia'
import type { CartItem, Product } from '../../../shared/types'

/**
 * 购物车 store（Task 11，renderer 内存态，不落库——D21）。
 *
 * 铁律 G1：行内金额一律整数分（unit_price_cents），元单位浮点只存在于
 * 组件层的输入/显示边界（CartPanel 用 shared/utils/money 做元↔分转换）。
 *
 * 合并规则（D16）：批量计行 key = product_id + unit_price_cents——同 key
 * 重复加购 qty+1 合并单行；改价后再加购视为不同 key 分行（service 侧不合并
 * 且逐行落库，合并是渲染层购物车的职责——T10 语义确认）。
 *
 * SN 行（D-SN7）：行 key 含 sn——**禁合并**（同商品不同 SN 各一行）、
 * quantity 恒 1（updateQty 对 SN 行忽略）；同一 SN 重复加购 addItem 抛
 * Error（文案「该 SN 已在购物车中」，调用方捕获后负责 ElMessage 展示）。
 * updatePrice 对 SN 行照常生效（独立价格）。
 *
 * 库存快照 stockByProduct：加购时点各商品库存，行内「库存不足（负库存将
 * 产生）」提示的数据源——仅提示不阻断（D2 负库存允许，结账不拦截）。
 */

/** 加购入参：商品行的最小字段集（products:list 行 / 搜索结果行的子集） */
export type CartAddSource = Pick<
  Product,
  'id' | 'name' | 'barcode' | 'default_price_cents' | 'stock'
>

export const useCartStore = defineStore('cart', {
  state: () => ({
    items: [] as CartItem[],
    /** 各商品加购时点库存（行内库存不足提示用；每次加购刷新为最新值） */
    stockByProduct: {} as Record<number, number>
  }),

  getters: {
    /** 合计（整数分乘加——G1：渲染层零浮点金额累计） */
    totalCents: (state): number =>
      state.items.reduce((sum, it) => sum + it.quantity * it.unit_price_cents, 0)
  },

  actions: {
    /**
     * 加购：新行单价预填 default_price_cents（可空→0 待手输）。
     * - 批量计行（sn 空缺）：同 product_id + unit_price_cents 的既有行
     *   qty+1 合并（D16）。
     * - SN 行（sn 非空，trim 后判定）：quantity=1 恒定、禁合并；同一 SN
     *   已在购物车 → 抛 Error('该 SN 已在购物车中')，由调用方展示（D-SN7）。
     */
    addItem(product: CartAddSource, sn?: string | null): void {
      this.stockByProduct[product.id] = product.stock

      const unitPriceCents = product.default_price_cents ?? 0
      const snValue = typeof sn === 'string' ? sn.trim() : ''
      if (snValue.length > 0) {
        if (this.items.some((it) => it.sn === snValue)) {
          throw new Error('该 SN 已在购物车中')
        }
        this.items.push({
          product_id: product.id,
          name: product.name,
          barcode: product.barcode,
          quantity: 1,
          unit_price_cents: unitPriceCents,
          sn: snValue
        })
        return
      }

      const existing = this.items.find(
        (it) => it.product_id === product.id && it.unit_price_cents === unitPriceCents
      )
      if (existing) {
        existing.quantity += 1
        return
      }
      this.items.push({
        product_id: product.id,
        name: product.name,
        barcode: product.barcode,
        quantity: 1,
        unit_price_cents: unitPriceCents,
        sn: null
      })
    },

    /**
     * 改数量：仅接受 ≥1 的整数；无效输入（清空/负/小数/越界）忽略不动。
     * SN 行 quantity 恒 1（D-SN7），任何入参一律忽略。
     */
    updateQty(index: number, quantity: number): void {
      const item = this.items[index]
      if (!item) return
      if (item.sn !== null) return
      if (!Number.isInteger(quantity) || quantity < 1) return
      item.quantity = quantity
    },

    /** 改单价（整数分）：仅接受 ≥0 整数；无效输入忽略不动 */
    updatePrice(index: number, unitPriceCents: number): void {
      const item = this.items[index]
      if (!item) return
      if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) return
      item.unit_price_cents = unitPriceCents
    },

    /** 按行下标删除 */
    removeItem(index: number): void {
      this.items.splice(index, 1)
    },

    /** 清空购物车与库存快照 */
    clear(): void {
      this.items = []
      this.stockByProduct = {}
    },

    /** 行小计（整数分乘加） */
    subtotalCents(item: CartItem): number {
      return item.quantity * item.unit_price_cents
    }
  }
})
