<script setup lang="ts">
import { computed } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import { useCartStore } from '@renderer/stores/cart.store'
import { formatMoney } from '../../../../shared/utils/money'
import type { CartItem } from '../../../../shared/types'

/**
 * 购物车面板（Task 11）：行编辑（数量/单价）+ 行小计 + 合计 + 清空 + 结账。
 *
 * 金额边界（G1）：本组件是唯一出现「元」浮点的购物车边界——单价用
 * el-input-number（元，precision 2），blur 提交时 Math.round(yuan * 100)
 * 入分（3.5×100=350.00000000000006 必须 round——T8 实证）；显示经
 * shared/utils/money formatMoney（恰好 2 位小数）。store 内部全程整数分。
 *
 * 单价必须走 @change（blur/Enter 提交）而非 @update:model-value（逐键触发）：
 * 行 key = product_id + unit_price_cents（D16 分行语义），逐键改价会让 key
 * 变化 → Vue 销毁重建整行 DOM → 输入框立刻失焦（每敲一个字符丢一次焦）。
 * blur 时才落 store，key 只在焦点离开后变化，输入体验完好。
 */

const props = defineProps<{ checkingOut: boolean }>()
const emit = defineEmits<{ checkout: [] }>()

const cart = useCartStore()

const empty = computed(() => cart.items.length === 0)
/** 总件数（Σquantity，与 sales.item_count 口径一致） */
const pieceCount = computed(() => cart.items.reduce((n, it) => n + it.quantity, 0))

/** 库存不足提示（D2：仅提示不阻断，允许负库存结账） */
function isOverStock(item: CartItem): boolean {
  const stock = cart.stockByProduct[item.product_id]
  return stock !== undefined && item.quantity > stock
}

function onQtyChange(index: number, value: number | undefined): void {
  cart.updateQty(index, Number(value))
}

/** 元浮点 → 整数分（UI 边界唯一转换点；清除/非法时返回 NaN 由 store 守卫拒绝） */
function yuanToCents(yuan: number | undefined): number {
  return Math.round(Number(yuan) * 100)
}

function onPriceChange(index: number, yuan: number | undefined): void {
  cart.updatePrice(index, yuanToCents(yuan))
}
</script>

<template>
  <aside class="cart-panel">
    <header class="cart-panel__header">
      <div class="cart-panel__title">
        <h3 class="cart-panel__title-text">购物车</h3>
        <span class="cart-panel__count">{{ pieceCount }} 件</span>
      </div>
      <el-button
        class="cart-clear-btn"
        text
        size="small"
        :disabled="empty"
        @click="cart.clear()"
      >
        清空
      </el-button>
    </header>

    <div class="cart-panel__body">
      <div v-if="empty" class="cart-empty">
        <el-empty description="扫码或双击商品加入购物车" :image-size="96" />
      </div>
      <div v-else class="cart-list">
        <div
          v-for="(item, index) in cart.items"
          :key="`${item.product_id}-${item.unit_price_cents}`"
          class="cart-row"
        >
          <div class="cart-row__name">
            <span class="cart-row__name-text" :title="item.name">{{ item.name }}</span>
            <span v-if="isOverStock(item)" class="cart-row__warn">
              库存不足(负库存将产生)
            </span>
          </div>
          <el-input-number
            class="cart-row__qty"
            size="small"
            :model-value="item.quantity"
            :min="1"
            :step="1"
            :precision="0"
            @update:model-value="(v: number | undefined) => onQtyChange(index, v)"
          />
          <el-input-number
            class="cart-row__price"
            size="small"
            :model-value="item.unit_price_cents / 100"
            :min="0"
            :step="0.5"
            :precision="2"
            :controls="false"
            @change="(v: number | undefined) => onPriceChange(index, v)"
          />
          <span class="cart-row__subtotal">¥{{ formatMoney(cart.subtotalCents(item)) }}</span>
          <el-button
            class="cart-row__remove"
            text
            type="danger"
            :icon="Delete"
            :title="`删除 ${item.name}`"
            @click="cart.removeItem(index)"
          />
        </div>
      </div>
    </div>

    <footer class="cart-panel__footer">
      <div class="cart-panel__total">
        <span class="cart-panel__total-label">合计</span>
        <span class="cart-panel__total-value">¥{{ formatMoney(cart.totalCents) }}</span>
      </div>
      <el-button
        class="cart-panel__checkout"
        type="warning"
        size="large"
        :disabled="empty"
        :loading="props.checkingOut"
        @click="emit('checkout')"
      >
        结账
      </el-button>
    </footer>
  </aside>
</template>

<style scoped>
.cart-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color-light);
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-light);
  overflow: hidden;
}

/* ── 头部：标题 + 件数 + 清空 ── */
.cart-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.cart-panel__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cart-panel__title-text {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.cart-panel__count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

/* ── 行列表（可滚动，POS 密度）── */
.cart-panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px;
}

.cart-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cart-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cart-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px 78px 76px 28px;
  align-items: center;
  gap: 6px;
  padding: 7px 6px;
  border-radius: var(--el-border-radius-small);
  transition: background-color 0.15s;
}

.cart-row:hover {
  background: var(--el-fill-color-light);
}

.cart-row__name {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cart-row__name-text {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 库存不足行内黄条（D2：警示但不阻断结账） */
.cart-row__warn {
  font-size: 11px;
  line-height: 1.3;
  color: var(--el-color-warning);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cart-row__qty {
  width: 96px;
}

.cart-row__price {
  width: 78px;
}

.cart-row__price :deep(input) {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px;
  text-align: right;
}

.cart-row__subtotal {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
  text-align: right;
  white-space: nowrap;
}

.cart-row__remove {
  padding: 4px;
  margin: 0;
}

/* ── 底部：合计 + 结账（收银台主 CTA，琥珀强调）── */
.cart-panel__footer {
  flex-shrink: 0;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--el-border-color-lighter);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cart-panel__total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.cart-panel__total-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.cart-panel__total-value {
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  color: var(--el-color-warning);
}

.cart-panel__checkout {
  width: 100%;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.2em;
}
</style>
