<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ReceiptPreviewDialog from '@renderer/components/receipt/ReceiptPreviewDialog.vue'
import SaleDetailDialog from '@renderer/components/sales/SaleDetailDialog.vue'
import { usePrintingStore } from '@renderer/stores/printing.store'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type { IpcChannels } from '../../../shared/types/ipc'
import type { Sale, SaleDetail, SaleListItem, SaleStatus } from '../../../shared/types/domain'

/**
 * 销售记录查询（Task 13）：日期范围 + 状态筛选 + 列表 + 明细（快照列）+ 作废 + 重打入口。
 *
 * - 金额铁律 G1：IPC 全程整数分；元换算只发生在本页显示边界（(cents/100).toFixed(2)）。
 * - 明细读 T10 sales:detail 返回的快照列（product_name/barcode），不实时 join products——
 *   商品改名/删除不影响历史明细（G4；删除为软删，快照列恒可读）。
 * - 分页为本地分页（T10 sales:list IPC 未暴露 page 参数，单次最多返回 50 条；
 *   POS 场景按日筛选下足够，真正服务端分页待契约扩展）。
 * - 列表平铺附加五列 + 三筛选（需求变更 W1，契约 sales:list req/res 已扩展）：
 *   姓名/电话/是否国补/销售人员/订单备注（SaleListItem 平铺列；null → '—' 占位；
 *   国补照 ReportsView 惯例 true 才 el-tag，false 纯文本「否」——保 .el-tag 计数）。
 *   筛选 customer_name/customer_phone trim 后非空才传、is_national_subsidy 三态
 *   （'all' 整键不传）；文本输入 300ms 防抖触发（CustomersView 搜索先例），
 *   国补 select 一次成型选择与 status radio 同走 watch 直触。
 * - 重打为 T15 打印编排的挂接点：按钮 + saleId 传递；printing:preview 通道 T15 才实装。
 *
 * 拆分（巨型视图治理批次 3）：明细弹窗（作废警示/明细表/附加信息展示区）→
 * components/sales/SaleDetailDialog.vue（受控：明细由本页拉取传入——打开失败
 * 不弹窗的原时序不变）；附加信息编辑区（含客户电话联想 Q5 与 updateExtra
 * patch 组装）→ components/sales/SaleExtrasForm.vue（自治，saved 后经
 * updated 回写本页 detail）。
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

/** 客户姓名/电话模糊筛选（trim 后空 = 不筛；文本输入防抖触发） */
const customerNameFilter = ref('')
const customerPhoneFilter = ref('')

/** 国补三态：'all'=全部（整键不传）/ true=是 / false=否（含无附加行旧单——与报表口径一致） */
const subsidyFilter = ref<'all' | boolean>('all')

/** 高频范围快捷入口（同时是 E2E 的日期交互路径——零日历面板操作） */
const rangeShortcuts = [
  { text: '今天', value: (): [Date, Date] => [dayDate(0), dayDate(0)] },
  { text: '昨天', value: (): [Date, Date] => [dayDate(-1), dayDate(-1)] },
  { text: '最近 7 天', value: (): [Date, Date] => [dayDate(-6), dayDate(0)] },
  { text: '最近 30 天', value: (): [Date, Date] => [dayDate(-29), dayDate(0)] }
]

// ── 列表（本地分页 20/页）──

const PAGE_SIZE = 20
const sales = ref<SaleListItem[]>([])
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
    const filters: IpcChannels['sales:list']['req'] = {
      date_from: range?.[0],
      date_to: range?.[1],
      status: statusFilter.value === 'all' ? undefined : statusFilter.value
    }
    // 三新筛选（需求变更 W1）：trim 后非空才传（整键不进 = 后端不过滤）；
    // 国补 'all'=全部 → 键整体不传（三态语义与 status 的 undefined 传法刻意区分——
    // 后端两键均归一，此处「不传键」保持 payload 形状与用户意图一致，便于测试/E2E 断言）
    const name = customerNameFilter.value.trim()
    if (name.length > 0) filters.customer_name = name
    const phone = customerPhoneFilter.value.trim()
    if (phone.length > 0) filters.customer_phone = phone
    if (subsidyFilter.value !== 'all') filters.is_national_subsidy = subsidyFilter.value
    sales.value = await typedInvoke('sales:list', filters)
    page.value = 1
  } catch (err) {
    ElMessage.error(`销售记录加载失败：${extractIpcErrorMessage(err)}`)
  } finally {
    loading.value = false
  }
}

// 一次成型选择（日期/状态/国补）watch 直触；文本输入经 300ms 防抖（onFilterInput）
watch([dateRange, statusFilter, subsidyFilter], () => {
  void refresh()
})

// ── 文本筛选防抖（300ms——CustomersView 搜索先例：clearTimeout + 重置）──

const FILTER_DEBOUNCE_MS = 300
let filterTimer: ReturnType<typeof setTimeout> | undefined

function onFilterInput(): void {
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    void refresh()
  }, FILTER_DEBOUNCE_MS)
}

onBeforeUnmount(() => {
  if (filterTimer) clearTimeout(filterTimer)
})

onMounted(() => {
  void refresh()
})

// ── 明细弹窗（双击行 / 操作按钮；行读快照列——G4。渲染在 SaleDetailDialog，
//    本页只负责拉取与回写：拉取失败不弹窗（原时序），saved 后回写即刷新展示区）──

const detailVisible = ref(false)
const detail = ref<SaleDetail | null>(null)

async function openDetail(sale: Sale): Promise<void> {
  try {
    detail.value = await typedInvoke('sales:detail', { sale_id: sale.id })
    detailVisible.value = true
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  }
}

function onDetailUpdated(updated: SaleDetail): void {
  detail.value = updated
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
    ElMessage.error(extractIpcErrorMessage(err))
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

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>

<template>
  <section class="sales-history">
    <header class="sales-history__header">
      <div>
        <h2 class="sales-history__title">
          销售记录
        </h2>
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
      <el-radio-group
        v-model="statusFilter"
        data-testid="status-filter"
      >
        <el-radio value="all">
          全部
        </el-radio>
        <el-radio value="completed">
          已完成
        </el-radio>
        <el-radio value="voided">
          已作废
        </el-radio>
      </el-radio-group>
      <!-- 三新筛选（需求变更 W1）：文本两框 300ms 防抖；国补三态 select 一次成型走 watch -->
      <el-input
        v-model="customerNameFilter"
        placeholder="客户姓名（模糊）"
        clearable
        class="sales-history__filter-input"
        data-testid="filter-customer-name"
        @input="onFilterInput"
        @clear="onFilterInput"
      />
      <el-input
        v-model="customerPhoneFilter"
        placeholder="电话（模糊）"
        clearable
        class="sales-history__filter-input"
        data-testid="filter-customer-phone"
        @input="onFilterInput"
        @clear="onFilterInput"
      />
      <el-select
        v-model="subsidyFilter"
        class="sales-history__subsidy-select"
        data-testid="filter-subsidy"
      >
        <el-option
          label="全部"
          value="all"
        />
        <el-option
          label="是"
          :value="true"
        />
        <el-option
          label="否"
          :value="false"
        />
      </el-select>
    </div>

    <el-table
      v-loading="loading"
      :data="pagedSales"
      class="sales-history__table"
      row-key="id"
      @row-dblclick="openDetail"
    >
      <el-table-column
        prop="sale_no"
        label="单号"
        min-width="130"
      />
      <el-table-column
        prop="created_at"
        label="时间"
        min-width="160"
      />
      <el-table-column
        prop="item_count"
        label="商品数"
        width="80"
        align="center"
      />
      <el-table-column
        label="合计（元）"
        width="110"
        align="right"
      >
        <template #default="{ row }">
          <span class="sales-history__amount">{{ centsToYuan(row.total_cents) }}</span>
        </template>
      </el-table-column>
      <el-table-column
        label="状态"
        width="90"
        align="center"
      >
        <template #default="{ row }">
          <el-tag
            :type="row.status === 'voided' ? 'danger' : 'primary'"
            disable-transitions
          >
            {{ row.status === 'voided' ? '已作废' : '已完成' }}
          </el-tag>
        </template>
      </el-table-column>
      <!-- 五新列（需求变更 W1）：插在「状态」后、「操作」前（操作列保持最右——UI 惯例；
           存量行级 E2E 不依赖列序）。null → '—' 占位；国补照 ReportsView 惯例
           true 才 el-tag（false 纯文本「否」——保 .el-tag 计数）。 -->
      <el-table-column
        label="姓名"
        min-width="100"
      >
        <template #default="{ row }">
          <span data-testid="list-customer-name">{{ row.customer_name ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column
        label="电话"
        min-width="130"
      >
        <template #default="{ row }">
          <span data-testid="list-customer-phone">{{ row.customer_phone ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column
        label="是否国补"
        width="90"
        align="center"
      >
        <template #default="{ row }">
          <span data-testid="list-subsidy">
            <el-tag
              v-if="row.is_national_subsidy"
              type="success"
              disable-transitions
            >
              国补
            </el-tag>
            <span v-else>否</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column
        label="销售人员"
        min-width="100"
      >
        <template #default="{ row }">
          <span data-testid="list-salesperson">{{ row.salesperson ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column
        label="订单备注"
        min-width="140"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          <span data-testid="list-order-note">{{ row.order_note ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column
        label="操作"
        width="200"
        align="center"
      >
        <template #default="{ row }">
          <el-button
            link
            type="primary"
            @click="openDetail(row)"
          >
            查看明细
          </el-button>
          <el-button
            link
            type="danger"
            :disabled="row.status !== 'completed'"
            @click="voidSale(row)"
          >
            作废
          </el-button>
          <el-button
            link
            type="primary"
            @click="reprint(row)"
          >
            重打小票
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          description="所选日期范围内暂无销售记录"
          :image-size="100"
        />
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

    <SaleDetailDialog
      v-model:visible="detailVisible"
      :detail="detail"
      @updated="onDetailUpdated"
    />
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

/* ── 三新筛选控件（需求变更 W1）：文本框定宽防撑行，国补 select 紧凑 ── */
.sales-history__filter-input {
  width: 180px;
}

.sales-history__subsidy-select {
  width: 110px;
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
</style>
