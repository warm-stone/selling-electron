<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ReceiptPreviewDialog from '@renderer/components/receipt/ReceiptPreviewDialog.vue'
import { usePrintingStore } from '@renderer/stores/printing.store'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type { Sale, SaleDetail, SaleStatus } from '../../../shared/types/domain'

/**
 * 销售记录查询（Task 13）：日期范围 + 状态筛选 + 列表 + 明细（快照列）+ 作废 + 重打入口。
 *
 * - 金额铁律 G1：IPC 全程整数分；元换算只发生在本页显示边界（(cents/100).toFixed(2)）。
 * - 明细读 T10 sales:detail 返回的快照列（product_name/barcode），不实时 join products——
 *   商品改名/硬删不影响历史明细（G4）。
 * - 分页为本地分页（T10 sales:list IPC 未暴露 page 参数，单次最多返回 50 条；
 *   POS 场景按日筛选下足够，真正服务端分页待契约扩展）。
 * - 重打为 T15 打印编排的挂接点：按钮 + saleId 传递；printing:preview 通道 T15 才实装。
 */
const typedInvoke = createTypedInvoke(window.api.invoke)

// ── 筛选（日期范围默认今天；created_at 为本地时间语义，与 T10 repo date() 匹配一致）──

type StatusFilter = 'all' | SaleStatus

function localDateStr(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function dayDate(offsetDays: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d
}

const dateRange = ref<[string, string]>([localDateStr(), localDateStr()])
const statusFilter = ref<StatusFilter>('all')

/** 高频范围快捷入口（同时是 E2E 的日期交互路径——零日历面板操作） */
const rangeShortcuts = [
  { text: '今天', value: (): [Date, Date] => [dayDate(0), dayDate(0)] },
  { text: '昨天', value: (): [Date, Date] => [dayDate(-1), dayDate(-1)] },
  { text: '最近 7 天', value: (): [Date, Date] => [dayDate(-6), dayDate(0)] },
  { text: '最近 30 天', value: (): [Date, Date] => [dayDate(-29), dayDate(0)] }
]

// ── 列表（本地分页 20/页）──

const PAGE_SIZE = 20
const sales = ref<Sale[]>([])
const loading = ref(false)
const page = ref(1)
const total = computed(() => sales.value.length)
const pagedSales = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return sales.value.slice(start, start + PAGE_SIZE)
})

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const range = dateRange.value
    sales.value = await typedInvoke('sales:list', {
      date_from: range?.[0],
      date_to: range?.[1],
      status: statusFilter.value === 'all' ? undefined : statusFilter.value
    })
    page.value = 1
  } catch (err) {
    ElMessage.error(`销售记录加载失败：${errorMessage(err)}`)
  } finally {
    loading.value = false
  }
}

watch([dateRange, statusFilter], () => {
  void refresh()
})

onMounted(() => {
  void refresh()
})

// ── 明细弹窗（双击行 / 操作按钮；行读快照列——G4）──

const detailVisible = ref(false)
const detail = ref<SaleDetail | null>(null)

async function openDetail(sale: Sale): Promise<void> {
  try {
    detail.value = await typedInvoke('sales:detail', { sale_id: sale.id })
    detailVisible.value = true
  } catch (err) {
    ElMessage.error(errorMessage(err))
  }
}

// ── 作废（确认弹窗明示库存回滚 → sales:void 事务 → 刷新列表）──

async function voidSale(sale: Sale): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认作废销售单 ${sale.sale_no}？作废后该单将从报表中剔除，库存将回滚（已售商品数量加回库存）。`,
      '作废销售单',
      {
        type: 'warning',
        confirmButtonText: '确认作废',
        cancelButtonText: '取消',
        draggable: false
      }
    )
  } catch {
    return // 用户取消
  }
  try {
    const updated = await typedInvoke('sales:void', { sale_id: sale.id })
    ElMessage.success(`已作废：${updated.sale_no}`)
    await refresh()
  } catch (err) {
    ElMessage.error(errorMessage(err))
  }
}

// ── 重打小票（Task 15 接线：与收银台结账共用同一预览弹窗）──
// 原占位形态（window.api.printing?.preview 未暴露时 console.log + info toast）
// 已随 preload printing 段实装自然升级：printing:preview → ReceiptPreviewDialog。
// voided 单按钮保持可用（D19：主进程组装时模板 footer 前加印「已作废」段落）。

const printing = usePrintingStore()

async function reprint(sale: Sale): Promise<void> {
  await printing.openPreview(sale.id)
}

// ── 工具 ──

/** 剥除 Electron invoke 序列化前缀，取纯中文消息（T8 模式） */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const match = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return match ? match[1] : raw
}

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>

<template>
  <section class="sales-history">
    <header class="sales-history__header">
      <div>
        <h2 class="sales-history__title">销售记录</h2>
        <p class="sales-history__sub">
          按日期与状态查询历史销售，双击行查看明细；作废会回滚库存，作废单仍可重打小票
        </p>
      </div>
    </header>

    <div class="sales-history__filters">
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        :shortcuts="rangeShortcuts"
        :clearable="false"
        class="sales-history__date-range"
        data-testid="date-range"
      />
      <el-radio-group v-model="statusFilter" data-testid="status-filter">
        <el-radio value="all">全部</el-radio>
        <el-radio value="completed">已完成</el-radio>
        <el-radio value="voided">已作废</el-radio>
      </el-radio-group>
    </div>

    <el-table
      v-loading="loading"
      :data="pagedSales"
      class="sales-history__table"
      row-key="id"
      @row-dblclick="openDetail"
    >
      <el-table-column prop="sale_no" label="单号" min-width="130" />
      <el-table-column prop="created_at" label="时间" min-width="160" />
      <el-table-column prop="item_count" label="商品数" width="80" align="center" />
      <el-table-column label="合计（元）" width="110" align="right">
        <template #default="{ row }">
          <span class="sales-history__amount">{{ centsToYuan(row.total_cents) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag
            :type="row.status === 'voided' ? 'danger' : 'primary'"
            disable-transitions
          >
            {{ row.status === 'voided' ? '已作废' : '已完成' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" align="center">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">查看明细</el-button>
          <el-button
            link
            type="danger"
            :disabled="row.status !== 'completed'"
            @click="voidSale(row)"
          >
            作废
          </el-button>
          <el-button link type="primary" @click="reprint(row)">重打小票</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="所选日期范围内暂无销售记录" :image-size="100" />
      </template>
    </el-table>

    <div class="sales-history__pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="total"
        layout="total, prev, pager, next"
        background
      />
    </div>

    <el-dialog
      v-model="detailVisible"
      :title="detail ? `销售明细 · ${detail.sale_no}` : '销售明细'"
      width="680px"
    >
      <template v-if="detail">
        <el-alert
          v-if="detail.status === 'voided'"
          type="warning"
          :closable="false"
          show-icon
          class="sales-history__voided-alert"
        >
          该单已作废{{ detail.voided_at ? `（${detail.voided_at}）` : '' }}
        </el-alert>
        <p class="sales-history__detail-meta">
          单号 {{ detail.sale_no }} · {{ detail.created_at }} · 合计
          <span class="sales-history__amount">￥{{ centsToYuan(detail.total_cents) }}</span>
        </p>
        <el-table :data="detail.items" size="small">
          <el-table-column prop="product_name" label="商品名（快照）" min-width="170" />
          <el-table-column label="条码（快照）" min-width="135">
            <template #default="{ row }">{{ row.barcode ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="SN" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ row.sn ?? '—' }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="70" align="center" />
          <el-table-column label="单价（元）" width="100" align="right">
            <template #default="{ row }">{{ centsToYuan(row.unit_price_cents) }}</template>
          </el-table-column>
          <el-table-column label="小计（元）" width="100" align="right">
            <template #default="{ row }">{{ centsToYuan(row.subtotal_cents) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>
    <!-- Task 15：重打预览弹窗（与收银台结账共用，printing store 全局状态） -->
    <ReceiptPreviewDialog />
  </section>
</template>

<style scoped>
.sales-history {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px 24px;
  box-sizing: border-box;
  gap: 16px;
}

.sales-history__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}

.sales-history__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}

.sales-history__sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.sales-history__filters {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

.sales-history__table {
  flex: 1;
}

.sales-history__amount {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.sales-history__pagination {
  display: flex;
  justify-content: flex-end;
}

.sales-history__voided-alert {
  margin-bottom: 12px;
}

.sales-history__detail-meta {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
