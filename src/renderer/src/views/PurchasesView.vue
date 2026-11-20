<script setup lang="ts">
import { h, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PurchaseCreateDialog from '@renderer/components/purchases/PurchaseCreateDialog.vue'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type { PurchaseOrderWithItems } from '../../../shared/types/domain'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'

/**
 * 进货管理（Task 9 + SN T2.B + 整单作废）：列表（状态列/作废行置灰）+
 * 明细弹窗（含作废时间/原因）+ 作废编排（prompt 富文本警示 + 原因必填）。
 *
 * 作废定案：批量计已售部分不阻止作废，库存冲减可为负（D2）；SN 单存在
 * 已售 SN 拒绝整单（主进程守卫，文案含 SN 与销售单号）；作废不物理删除行。
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

// ── 整单作废（prompt 富文本警示 + 原因必填；主进程守卫见 purchase.repo voidOrder）──

/** 作废行置灰（视觉与销售记录页 voided 惯例一致） */
function rowClassName({ row }: { row: PurchaseOrderWithItems }): string {
  return row.status === 'voided' ? 'order-voided' : ''
}

function voidMessage(order: PurchaseOrderWithItems): ReturnType<typeof h> {
  const snCount = order.items.filter((item) => item.sn != null).length
  return h('div', { class: 'void-confirm' }, [
    h('p', null, `确定作废进货单「${order.order_no}」吗？`),
    h(
      'p',
      { class: 'void-confirm__warn' },
      `本单 ${order.items.length} 行商品的入库库存将被冲减（已卖出部分不阻止作废，库存可冲成负值，列表标红）。`
    ),
    snCount > 0
      ? h(
          'p',
          { class: 'void-confirm__warn' },
          `本单含 ${snCount} 个 SN：在库 SN 将移出台账（可重新进货）；若存在已售 SN，作废将被拒绝并提示对应销售单号。`
        )
      : null,
    h('p', null, '作废后单据保留可查，此操作不可撤销。')
  ])
}

/** 原因必填输入校验（service 层 assertValidVoidReason 兜底） */
function reasonValidator(value: string | undefined): true | string {
  return typeof value === 'string' && value.trim().length > 0 ? true : '作废原因不能为空'
}

async function handleVoid(order: PurchaseOrderWithItems): Promise<void> {
  const result = await ElMessageBox.prompt(voidMessage(order), '作废进货单', {
    type: 'warning',
    confirmButtonText: '作废',
    cancelButtonText: '取消',
    confirmButtonClass: 'el-button--danger',
    autofocus: false,
    inputType: 'textarea',
    inputPlaceholder: '作废原因（必填，将随单据留档）',
    inputValidator: reasonValidator,
    inputErrorMessage: '作废原因不能为空'
  }).catch(() => null)
  if (result === null) return
  const reason = (result.value ?? '').trim()

  try {
    await typedInvoke('purchases:void', { order_id: order.id, reason })
    ElMessage.success(`进货单 ${order.order_no} 已作废`)
    await refreshOrders()
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  }
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
        <h2 class="purchases-view__title">
          进货管理
        </h2>
        <p class="purchases-view__sub">
          入库自动累加库存并记录流水，明细保留商品快照；录错可整单作废留档
        </p>
      </div>
      <el-button
        type="primary"
        data-testid="create-purchase"
        @click="openCreateDialog"
      >
        新建进货单
      </el-button>
    </header>

    <el-table
      v-loading="loadingOrders"
      :data="orders"
      :row-class-name="rowClassName"
      class="purchases-view__table"
      row-key="id"
    >
      <el-table-column
        prop="order_no"
        label="单号"
        min-width="130"
      />
      <el-table-column
        prop="created_at"
        label="时间"
        min-width="165"
      />
      <el-table-column
        label="状态"
        width="90"
        align="center"
      >
        <template #default="{ row }">
          <el-tag
            v-if="row.status === 'voided'"
            type="danger"
            effect="plain"
            size="small"
            disable-transitions
            data-testid="order-status-voided"
          >
            已作废
          </el-tag>
          <el-tag
            v-else
            type="success"
            effect="plain"
            size="small"
            disable-transitions
          >
            正常
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column
        label="品种数"
        width="90"
        align="center"
      >
        <template #default="{ row }">
          {{ row.items.length }}
        </template>
      </el-table-column>
      <el-table-column
        prop="note"
        label="备注"
        min-width="140"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          {{ row.note ?? '—' }}
        </template>
      </el-table-column>
      <el-table-column
        label="操作"
        width="170"
        align="center"
      >
        <template #default="{ row }">
          <el-button
            link
            type="primary"
            @click="openDetailDialog(row)"
          >
            查看明细
          </el-button>
          <el-button
            v-if="row.status === 'completed'"
            link
            type="danger"
            data-testid="void-purchase"
            @click="handleVoid(row)"
          >
            作废
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          description="暂无进货单，点击右上角「新建进货单」开始入库"
          :image-size="100"
        />
      </template>
    </el-table>

    <PurchaseCreateDialog
      v-model:visible="createDialogVisible"
      @created="refreshOrders"
    />

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
        <p
          v-if="currentOrder.status === 'voided'"
          class="detail__voided"
          data-testid="detail-voided-info"
        >
          本单已作废 · {{ currentOrder.voided_at }} · 原因：{{ currentOrder.void_reason ?? '—' }}
        </p>
        <el-table
          :data="currentOrder.items"
          size="small"
        >
          <el-table-column
            prop="product_name"
            label="商品名（快照）"
            min-width="170"
          />
          <el-table-column
            label="条码"
            min-width="135"
          >
            <template #default="{ row }">
              {{ row.barcode ?? '—' }}
            </template>
          </el-table-column>
          <el-table-column
            label="SN"
            min-width="135"
          >
            <template #default="{ row }">
              {{ row.sn ?? '—' }}
            </template>
          </el-table-column>
          <el-table-column
            prop="quantity"
            label="数量"
            width="70"
            align="center"
          />
          <el-table-column
            label="成本价（元）"
            width="110"
            align="right"
          >
            <template #default="{ row }">
              {{ centsToYuan(row.cost_price_cents) }}
            </template>
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

/* ── 作废行置灰（与销售记录页 voided 视觉惯例一致）── */
.purchases-view__table :deep(.order-voided) {
  --el-table-tr-bg-color: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}

.detail__meta {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

/* ── 明细弹窗作废信息（时间 + 原因——用户定案：作废留档展示）── */
.detail__voided {
  margin: -6px 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-danger);
}

/* ── 作废确认文案（ElMessageBox VNode 内容）── */
:global(.void-confirm) {
  line-height: 1.7;
}

:global(.void-confirm p) {
  margin: 0 0 4px;
}

:global(.void-confirm__warn) {
  color: var(--el-color-danger);
  font-size: 13px;
}
</style>
