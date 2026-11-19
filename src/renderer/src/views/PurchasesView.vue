<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import PurchaseCreateDialog from '@renderer/components/purchases/PurchaseCreateDialog.vue'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type { PurchaseOrderWithItems } from '../../../shared/types/domain'

/**
 * 进货管理（Task 9 + SN T2.B）：列表 + 明细弹窗编排。
 *
 * 拆分（巨型视图治理批次 2）：新建进货单弹窗（混排动态行 + SN 录入 +
 * 扫码桥订阅 + 提交入库全链路）→ components/purchases/PurchaseCreateDialog.vue
 * （自治组件，created 后本页刷新列表）。金额铁律 G1：DB/IPC 全程整数分；
 * 元↔分换算只发生在弹窗输入/本页明细显示边界。
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

// ── 新建进货单弹窗（表单/扫码/提交链路在 PurchaseCreateDialog 内闭环）──
const createDialogVisible = ref(false)

function openCreateDialog(): void {
  createDialogVisible.value = true
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

    <PurchaseCreateDialog v-model:visible="createDialogVisible" @created="refreshOrders" />

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
          <el-table-column label="SN" min-width="135">
            <template #default="{ row }">{{ row.sn ?? '—' }}</template>
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

.detail__meta {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
