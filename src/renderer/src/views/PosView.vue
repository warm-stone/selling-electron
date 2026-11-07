<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import BarcodeInput from '@renderer/components/scanner/BarcodeInput.vue'
import CartPanel from '@renderer/components/cart/CartPanel.vue'
import CheckoutDialog from '@renderer/components/cart/CheckoutDialog.vue'
import ReceiptPreviewDialog from '@renderer/components/receipt/ReceiptPreviewDialog.vue'
import SnEntryDialog from '@renderer/components/pos/SnEntryDialog.vue'
import { useCartStore } from '@renderer/stores/cart.store'
import { usePrintingStore } from '@renderer/stores/printing.store'
import { createTypedInvoke } from '../../../shared/types/ipc'
import { formatMoney } from '../../../shared/utils/money'
import type { CheckoutExtrasInput, Product } from '../../../shared/types'

/**
 * 收银台（Task 11）：扫码枪（主进程桥推送）+ 搜索双击加购 → 购物车 → 结账。
 *
 * 金额铁律 G1：全程整数分；元单位只存在于 CartPanel 输入/显示边界
 * （shared/utils/money 整数十进制搬移，零浮点运算）。
 *
 * 扫码链路（D-SN5：SN 台账优先）：preload.onBarcode（before-input-event
 * 检测桥，绕过 IME，焦点在购物车任意输入框都生效）→ products:findSn 精查
 * → 命中在库即加 SN 行（qty=1）/ 已售警告终止；未命中走 products:list
 * 精确条码命中 → addItem（SN 商品转 SN 输入弹窗，批量计直接加购）。
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

/**
 * SN 加购弹窗（D-SN5 第二入口）：双击 SN 商品 / 扫商品码命中 SN 商品时，
 * 先录 SN 再加购（弹窗内走 findSn 校验 + 扫码枪扫入）。
 */
const snDialogVisible = ref(false)
const snDialogProduct = ref<Product | null>(null)

function openSnDialog(product: Product): void {
  snDialogProduct.value = product
  snDialogVisible.value = true
}

/**
 * 加购唯一汇聚点。SN 商品无 SN 入参（双击/扫商品码命中）→ 转 SN 输入弹窗；
 * 带 SN 入参（扫 SN 台账命中）→ 直接加 SN 行（同 SN 重复由 store 抛错拒绝）；
 * 批量计商品 → 原 D16 合并逻辑不变。
 */
function addToCart(product: Product, sn?: string | null): void {
  if (product.tracking === 'sn' && !sn) {
    openSnDialog(product)
    return
  }
  try {
    cart.addItem(product, sn)
  } catch (err) {
    // 同 SN 已在购物车中（D-SN7；批量计行 addItem 不会抛错）
    ElMessage.error(err instanceof Error ? err.message : String(err))
    return
  }
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
  // 结账弹窗打开期间忽略扫码：模态输入客户/订单信息中，扫码不应加购或
  // 抖动背后搜索框（弹窗自身无扫码目标）；关闭弹窗后恢复原链路
  if (checkoutDialogVisible.value) return
  searchText.value = code
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadProducts(), SEARCH_DEBOUNCE_MS)
  // SN 弹窗打开期间，扫码由弹窗自订阅的 onBarcode 消费（录 SN 自动确认）；
  // 本视图跳过查询，防同一次扫码双路径重复处理（R2）
  if (snDialogVisible.value) return
  void lookupBarcode(code)
}

/**
 * 扫码路由（D-SN5：SN 台账第一优先级，商品码第二）：
 * ① findSn 命中在库 → 直接加 SN 行；命中已售 → 警告并终止；
 * ② 未命中 → 原商品码链路（SN 商品经 addToCart 分流进 SN 弹窗）。
 */
async function lookupBarcode(code: string): Promise<void> {
  try {
    const snHit = await window.api.products.findSn(code)
    if (snHit) {
      if (snHit.sn.status === 'in_stock') {
        addToCart(snHit.product, code)
      } else {
        ElMessage.warning(`该 SN 已售出（单号 ${snHit.sn.sale_no ?? '—'}）`)
      }
      return
    }
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

// ── 结账（Task 10：弹窗收集客户/订单附加信息；Task 15：成功回调 → printing:preview）──

const checkingOut = ref(false)
const printing = usePrintingStore()

/** 结账弹窗开关（Task 10 改造：CartPanel 结账 → 本弹窗；取消零 IPC 零落库） */
const checkoutDialogVisible = ref(false)

/**
 * 结账入口：购物车非空 → 打开结账弹窗（客户/国补/订单备注/销售人员）。
 * sales:checkout 的 IPC 调用移入弹窗确认回调（onCheckoutConfirm），
 * 成功后链路（清车/预览/刷新）语义与旧直连结账完全一致。
 */
function checkout(): void {
  if (cart.items.length === 0) return
  checkoutDialogVisible.value = true
}

/** 弹窗确认回调：表单 extras + 购物车 items → sales:checkout；失败弹窗不关可改后重试 */
async function onCheckoutConfirm(extras: CheckoutExtrasInput | undefined): Promise<void> {
  checkingOut.value = true
  try {
    const items = cart.items.map((it) => ({
      product_id: it.product_id,
      quantity: it.quantity,
      unit_price_cents: it.unit_price_cents,
      sn: it.sn
    }))
    const sale = await window.api.sales.checkout(items, extras)
    // 销售已落库（G3 基线）：关弹窗/清车/刷新先于预览——预览或打印失败绝不影响已保存销售
    checkoutDialogVisible.value = false
    cart.clear()
    void printing.openPreview(sale.id)
    await loadProducts()
  } catch (err) {
    // SaleServiceError 经 IPC rejected 为中文 message；弹窗不关，可修改后重试
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

    <CartPanel class="pos-right" :checking-out="checkingOut" @checkout="checkout()" />

    <!-- Task 15：结账成功 → 小票预览弹窗（与销售记录重打共用，printing store 全局状态） -->
    <ReceiptPreviewDialog />

    <!-- SN 商品加购弹窗（双击 / 扫商品码命中 → 录 SN——D-SN5，T2.A） -->
    <SnEntryDialog v-model:visible="snDialogVisible" :product="snDialogProduct" />

    <!-- Task 10：结账弹窗（客户/订单附加信息；确认回调走 sales:checkout 原成功链路） -->
    <CheckoutDialog
      v-model:visible="checkoutDialogVisible"
      :submitting="checkingOut"
      @confirm="onCheckoutConfirm"
    />
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
</style>
