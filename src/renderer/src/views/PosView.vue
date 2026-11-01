<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import BarcodeInput from '@renderer/components/scanner/BarcodeInput.vue'
import CartPanel from '@renderer/components/cart/CartPanel.vue'
import { useCartStore } from '@renderer/stores/cart.store'
import { createTypedInvoke } from '../../../shared/types/ipc'
import { formatMoney } from '../../../shared/utils/money'
import type { Product, SaleDetail } from '../../../shared/types'

/**
 * 收银台（Task 11）：扫码枪（主进程桥推送）+ 搜索双击加购 → 购物车 → 结账。
 *
 * 金额铁律 G1：全程整数分；元单位只存在于 CartPanel 输入/显示边界
 * （shared/utils/money 整数十进制搬移，零浮点运算）。
 *
 * 扫码链路：preload.onBarcode（before-input-event 检测桥，绕过 IME，焦点
 * 在购物车任意输入框都生效）→ products:list 精确条码命中 → addItem。
 * 回调即时返回、查询后台进行，不阻塞 UI。
 */

/** 商品列表行（products:list res 的运行时结构超集，含 willOrphan——无害附加字段） */
interface ProductRow extends Product {
  willOrphan: number
}

const typedInvoke = createTypedInvoke((channel, payload) =>
  window.api.invoke(channel, payload)
)
const cart = useCartStore()

// ── 商品搜索（扫码锚点框 + 结果表格双入口）──

const searchText = ref('')
const searchMiss = ref(false)
const products = ref<ProductRow[]>([])
const loading = ref(false)

const SEARCH_DEBOUNCE_MS = 300
const MISS_FLASH_MS = 1200

let searchTimer: ReturnType<typeof setTimeout> | undefined
let missTimer: ReturnType<typeof setTimeout> | undefined

function extractIpcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const matched = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return matched ? matched[1]! : raw
}

async function loadProducts(): Promise<void> {
  loading.value = true
  try {
    const kw = searchText.value.trim()
    products.value = (await typedInvoke('products:list', {
      keyword: kw.length > 0 ? kw : undefined
    })) as ProductRow[]
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    loading.value = false
  }
}

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadProducts(), SEARCH_DEBOUNCE_MS)
}

// ── 加购（双击结果行 / 扫码命中共用入口）──

function addToCart(product: ProductRow): void {
  cart.addItem(product)
  ElMessage.success(`已加入购物车：${product.name}`)
}

function onRowDblClick(row: ProductRow): void {
  addToCart(row)
}

/** 负库存行标红（D2：允许但不掩饰） */
function rowClassName({ row }: { row: ProductRow }): string {
  return row.stock < 0 ? 'stock-negative' : ''
}

// ── 扫码回调（async 查询不阻塞：回调即时返回）──

function handleBarcode(code: string): void {
  searchText.value = code
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadProducts(), SEARCH_DEBOUNCE_MS)
  void lookupBarcode(code)
}

async function lookupBarcode(code: string): Promise<void> {
  try {
    const rows = await typedInvoke('products:list', { keyword: code })
    if (rows.length === 1 && rows[0]!.barcode === code) {
      addToCart(rows[0]! as ProductRow)
      return
    }
    flashSearchMiss()
    ElMessage.error('未找到条码商品')
  } catch (err) {
    flashSearchMiss()
    ElMessage.error(extractIpcErrorMessage(err))
  }
}

function flashSearchMiss(): void {
  searchMiss.value = true
  if (missTimer) clearTimeout(missTimer)
  missTimer = setTimeout(() => {
    searchMiss.value = false
  }, MISS_FLASH_MS)
}

// ── 结账（占位成功 dialog——Task 15 替换为 printing:preview 真预览窗口）──

const checkingOut = ref(false)
const saleDialogVisible = ref(false)
const lastSale = ref<SaleDetail | null>(null)

async function checkout(): Promise<void> {
  if (cart.items.length === 0) return
  checkingOut.value = true
  try {
    const items = cart.items.map((it) => ({
      product_id: it.product_id,
      quantity: it.quantity,
      unit_price_cents: it.unit_price_cents
    }))
    const sale = (await typedInvoke('sales:checkout', { items })) as SaleDetail
    lastSale.value = sale
    saleDialogVisible.value = true
    cart.clear()
    await loadProducts()
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    checkingOut.value = false
  }
}

// ── 生命周期：订阅扫码推送 + 离开时退订防泄漏 ──

let unsubscribeBarcode: (() => void) | undefined

onMounted(() => {
  void loadProducts()
  unsubscribeBarcode = window.api.onBarcode(handleBarcode)
})

onBeforeUnmount(() => {
  unsubscribeBarcode?.()
  if (searchTimer) clearTimeout(searchTimer)
  if (missTimer) clearTimeout(missTimer)
})
</script>

<template>
  <section class="pos-page">
    <div class="pos-left">
      <header class="pos-left__header">
        <h2 class="pos-left__title">收银台</h2>
        <span class="pos-left__hint">扫码即加购 · 双击商品行加入购物车</span>
      </header>

      <BarcodeInput
        v-model="searchText"
        :miss="searchMiss"
        class="pos-left__search"
        @update:model-value="onSearchInput"
        @clear="onSearchInput"
      />

      <el-table
        v-loading="loading"
        :data="products"
        class="pos-products-table"
        height="100%"
        :row-class-name="rowClassName"
        @row-dblclick="onRowDblClick"
      >
        <el-table-column prop="name" label="名称" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="cell-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="条码" width="160">
          <template #default="{ row }">
            <span class="cell-barcode" :class="{ 'cell-barcode--empty': row.barcode === null }">
              {{ row.barcode ?? '— 无条码 —' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="stock" label="库存" width="86" align="center">
          <template #default="{ row }">
            <span class="cell-stock">{{ row.stock }}</span>
          </template>
        </el-table-column>
        <el-table-column label="默认售价" width="104" align="right">
          <template #default="{ row }">
            <span class="cell-price">
              {{ row.default_price_cents === null ? '—' : `¥${formatMoney(row.default_price_cents)}` }}
            </span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            :description="searchText.trim().length > 0 ? '未找到匹配商品' : '暂无商品，先到「商品管理」建档'"
            :image-size="100"
          />
        </template>
      </el-table>
    </div>

    <CartPanel class="pos-right" :checking-out="checkingOut" @checkout="void checkout()" />

    <!-- 占位：结账成功 dialog（Task 15 替换为 printing:preview 真预览窗口 + 立即打印） -->
    <el-dialog
      v-model="saleDialogVisible"
      title="结账成功"
      width="440px"
      align-center
      destroy-on-close
    >
      <div v-if="lastSale" class="sale-summary">
        <div class="sale-summary__no">单号 {{ lastSale.sale_no }}</div>
        <div class="sale-summary__total">¥{{ formatMoney(lastSale.total_cents) }}</div>
        <div class="sale-summary__count">共 {{ lastSale.item_count }} 件</div>
        <pre class="sale-summary__json">{{ JSON.stringify(lastSale, null, 2) }}</pre>
      </div>
      <template #footer>
        <el-button type="warning" @click="saleDialogVisible = false">完成</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.pos-page {
  height: 100%;
  display: flex;
  gap: 16px;
  padding: 20px 24px;
  box-sizing: border-box;
}

/* ── 左侧 60%：搜索 + 结果表格（双击加购）── */
.pos-left {
  flex: 6;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pos-left__header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-shrink: 0;
}

.pos-left__title {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}

.pos-left__hint {
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
}

.pos-left__search {
  flex-shrink: 0;
}

.pos-products-table {
  flex: 1;
  min-height: 0;
}

.pos-products-table :deep(.el-table__row) {
  cursor: pointer;
}

.cell-name {
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.cell-barcode {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px;
  letter-spacing: 0.03em;
  color: var(--el-text-color-regular);
}

.cell-barcode--empty {
  color: var(--el-text-color-placeholder);
  font-family: inherit;
  letter-spacing: normal;
}

.cell-stock,
.cell-price {
  font-variant-numeric: tabular-nums;
}

/* 负库存标红（D2：允许但不掩饰） */
.pos-products-table :deep(.stock-negative) {
  --el-table-tr-bg-color: var(--el-color-danger-light-9);
}

.pos-products-table :deep(.stock-negative .cell-stock) {
  color: var(--el-color-danger);
  font-weight: 700;
}

/* ── 右侧 40%：购物车 ── */
.pos-right {
  flex: 4;
  min-width: 0;
}

/* ── 结账成功占位（T15 替换点）── */
.sale-summary {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.sale-summary__no {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: 0.04em;
}

.sale-summary__total {
  font-size: 30px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--el-color-warning);
}

.sale-summary__count {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.sale-summary__json {
  align-self: stretch;
  margin: 10px 0 0;
  padding: 10px 12px;
  box-sizing: border-box;
  max-height: 220px;
  overflow: auto;
  border-radius: var(--el-border-radius-small);
  background: var(--el-fill-color-light);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--el-text-color-regular);
}
</style>
