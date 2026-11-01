<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type { Product, PurchaseOrderWithItems } from '../../../shared/types/domain'

/**
 * 进货管理（Task 9）：列表 + 新建进货单（动态行表格）+ 明细弹窗。
 * 金额铁律 G1：DB/IPC 全程整数分；元↔分换算只发生在本页输入/显示边界。
 */
const typedInvoke = createTypedInvoke(window.api.invoke)

// ── 列表 ──
const orders = ref<PurchaseOrderWithItems[]>([])
const loadingOrders = ref(false)

async function refreshOrders(): Promise<void> {
  loadingOrders.value = true
  try {
    orders.value = await typedInvoke('purchases:list', {})
  } catch (err) {
    ElMessage.error(errorMessage(err))
  } finally {
    loadingOrders.value = false
  }
}

// ── 商品下拉数据源（经 products:list 拉取，T8 契约通道）──
const products = ref<Product[]>([])
const productOptions = computed(() =>
  products.value.map((p) => ({
    value: p.id,
    label: p.barcode ? `${p.name} · ${p.barcode}` : `${p.name} · 无条码`
  }))
)

async function loadProducts(): Promise<void> {
  try {
    products.value = await typedInvoke('products:list', {})
  } catch (err) {
    products.value = []
    ElMessage.error(`商品列表加载失败：${errorMessage(err)}`)
  }
}

// ── 新建进货单：动态行表格 ──
interface PurchaseFormRow {
  productId: number | null
  quantity: number
  costYuan: number
}

const createDialogVisible = ref(false)
const formRows = ref<PurchaseFormRow[]>([])
const noteInput = ref('')
const submitting = ref(false)

function openCreateDialog(): void {
  formRows.value = [{ productId: null, quantity: 1, costYuan: 0 }]
  noteInput.value = ''
  createDialogVisible.value = true
  void loadProducts()
}

function addRow(): void {
  formRows.value.push({ productId: null, quantity: 1, costYuan: 0 })
}

function removeRow(index: number): void {
  formRows.value.splice(index, 1)
}

async function submitCreate(): Promise<void> {
  const rows = formRows.value
  if (rows.length === 0) {
    ElMessage.warning('请至少添加一行商品')
    return
  }
  for (const [index, row] of rows.entries()) {
    const label = `第 ${index + 1} 行`
    if (row.productId === null) {
      ElMessage.warning(`${label}：请选择商品`)
      return
    }
    if (!Number.isInteger(row.quantity) || row.quantity <= 0) {
      ElMessage.warning(`${label}：数量必须是正整数`)
      return
    }
    if (row.costYuan < 0) {
      ElMessage.warning(`${label}：成本价不能为负`)
      return
    }
  }
  submitting.value = true
  try {
    const created = await typedInvoke('purchases:create', {
      note: noteInput.value.trim() === '' ? null : noteInput.value.trim(),
      items: rows.map((row) => ({
        product_id: row.productId as number,
        quantity: row.quantity,
        cost_price_cents: Math.round(row.costYuan * 100)
      }))
    })
    ElMessage.success(`入库成功：${created.order_no}`)
    createDialogVisible.value = false
    await refreshOrders()
  } catch (err) {
    ElMessage.error(errorMessage(err))
  } finally {
    submitting.value = false
  }
}

// ── 明细弹窗（读快照列，商品改名不影响历史明细）──
const detailDialogVisible = ref(false)
const currentOrder = ref<PurchaseOrderWithItems | null>(null)

function openDetailDialog(order: PurchaseOrderWithItems): void {
  currentOrder.value = order
  detailDialogVisible.value = true
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

onMounted(() => {
  void refreshOrders()
})
</script>

<template>
  <section class="purchases-view">
    <header class="purchases-view__header">
      <div>
        <h2 class="purchases-view__title">进货管理</h2>
        <p class="purchases-view__sub">入库自动累加库存并记录流水，明细保留商品快照</p>
      </div>
      <el-button type="primary" data-testid="create-purchase" @click="openCreateDialog">
        新建进货单
      </el-button>
    </header>

    <el-table
      v-loading="loadingOrders"
      :data="orders"
      class="purchases-view__table"
      row-key="id"
    >
      <el-table-column prop="order_no" label="单号" min-width="130" />
      <el-table-column prop="created_at" label="时间" min-width="165" />
      <el-table-column label="品种数" width="90" align="center">
        <template #default="{ row }">{{ row.items.length }}</template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.note ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110" align="center">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetailDialog(row)">查看明细</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          description="暂无进货单，点击右上角「新建进货单」开始入库"
          :image-size="100"
        />
      </template>
    </el-table>

    <el-dialog
      v-model="createDialogVisible"
      title="新建进货单"
      width="740px"
      :close-on-click-modal="false"
    >
      <el-table :data="formRows" class="create-form__table" row-key-class-name="form-row">
        <el-table-column label="商品（可搜名称/条码）" min-width="280">
          <template #default="{ row }">
            <el-select
              v-model="row.productId"
              filterable
              placeholder="搜索名称/条码选择商品"
              style="width: 100%"
            >
              <el-option
                v-for="opt in productOptions"
                :key="opt.value"
                :value="opt.value"
                :label="opt.label"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="150">
          <template #default="{ row }">
            <el-input-number
              v-model="row.quantity"
              :min="1"
              :step="1"
              step-strictly
              style="width: 100%"
            />
          </template>
        </el-table-column>
        <el-table-column label="成本价（元）" width="170">
          <template #default="{ row }">
            <el-input-number
              v-model="row.costYuan"
              :min="0"
              :precision="2"
              :step="0.5"
              style="width: 100%"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80" align="center">
          <template #default="{ $index }">
            <el-button
              link
              type="danger"
              :disabled="formRows.length <= 1"
              @click="removeRow($index)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="create-form__actions">
        <el-button @click="addRow">+ 添加行</el-button>
      </div>
      <el-form label-width="64px" class="create-form__note" @submit.prevent>
        <el-form-item label="备注">
          <el-input
            v-model="noteInput"
            placeholder="选填，如：供应商名称、批次"
            maxlength="200"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">
          提交入库
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="detailDialogVisible"
      :title="currentOrder ? `进货明细 · ${currentOrder.order_no}` : '进货明细'"
      width="660px"
    >
      <template v-if="currentOrder">
        <p class="detail__meta">
          单号 {{ currentOrder.order_no }} · {{ currentOrder.created_at }}
          <span v-if="currentOrder.note"> · 备注：{{ currentOrder.note }}</span>
        </p>
        <el-table :data="currentOrder.items" size="small">
          <el-table-column prop="product_name" label="商品名（快照）" min-width="170" />
          <el-table-column label="条码" min-width="135">
            <template #default="{ row }">{{ row.barcode ?? '—' }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="70" align="center" />
          <el-table-column label="成本价（元）" width="110" align="right">
            <template #default="{ row }">{{ centsToYuan(row.cost_price_cents) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.purchases-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px 24px;
  box-sizing: border-box;
  gap: 16px;
}

.purchases-view__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}

.purchases-view__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}

.purchases-view__sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.purchases-view__table {
  flex: 1;
}

.create-form__table :deep(.el-form-item) {
  margin: 0;
}

.create-form__actions {
  margin-top: 10px;
}

.create-form__note {
  margin-top: 14px;
}

.detail__meta {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
