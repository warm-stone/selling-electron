<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ReceiptPreviewDialog from '@renderer/components/receipt/ReceiptPreviewDialog.vue'
import { usePrintingStore } from '@renderer/stores/printing.store'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type { IpcChannels } from '../../../shared/types/ipc'
import type {
  Customer,
  Sale,
  SaleDetail,
  SaleListItem,
  SaleStatus
} from '../../../shared/types/domain'
import { isValidMobilePhone, INVALID_PHONE_MESSAGE } from '../../../shared/utils/phone'

/**
 * 销售记录查询（Task 13）：日期范围 + 状态筛选 + 列表 + 明细（快照列）+ 作废 + 重打入口。
 *
 * - 金额铁律 G1：IPC 全程整数分；元换算只发生在本页显示边界（(cents/100).toFixed(2)）。
 * - 明细读 T10 sales:detail 返回的快照列（product_name/barcode），不实时 join products——
 *   商品改名/删除不影响历史明细（G4；删除为软删——004 迁移，快照列恒可读）。
 * - 分页为本地分页（T10 sales:list IPC 未暴露 page 参数，单次最多返回 50 条；
 *   POS 场景按日筛选下足够，真正服务端分页待契约扩展）。
 * - 列表平铺附加五列 + 三筛选（需求变更 W1，契约 sales:list req/res 已扩展）：
 *   姓名/电话/是否国补/销售人员/订单备注（SaleListItem 平铺列；null → '—' 占位；
 *   国补照 ReportsView 惯例 true 才 el-tag，false 纯文本「否」——保 .el-tag 计数）。
 *   筛选 customer_name/customer_phone trim 后非空才传、is_national_subsidy 三态
 *   （'all' 整键不传）；文本输入 300ms 防抖触发（CustomersView 搜索先例），
 *   国补 select 一次成型选择与 status radio 同走 watch 直触。
 * - 重打为 T15 打印编排的挂接点：按钮 + saleId 传递；printing:preview 通道 T15 才实装。
 * - 明细弹窗附加信息区（customer-order-extras 计划任务 12）：
 *   - 展示区：客户信息（extras.customer 引用最新——改档案后重开立即反映，与商品
 *     快照列刻意对照）+ 订单附加（国补 tag 渲染照 ReportsView 惯例：true 才有
 *     el-tag，false 纯文本「否」——保 .el-tag 计数）。
 *   - 编辑区（仅 completed 单可见；voided 前置隐藏——Q4，后端还会拒）：国补 /
 *     客户电话（失焦查全等项：命中「将关联」/清空「将解绑」——Q5）/ 销售人员
 *     （filterable+allow-create，选项来自 recent_salespersons）/ 订单备注。
 *   - 保存走 sales:updateExtra patch 语义：undefined=不动（未变字段不进 patch）、
 *     customer:null=显式解绑、customer 裸值=按电话 find-or-create（传命中档案
 *     原值回传，避免 PUT 覆盖丢数据）。
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
    ElMessage.error(`销售记录加载失败：${errorMessage(err)}`)
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

// ── 明细弹窗（双击行 / 操作按钮；行读快照列——G4）──

const detailVisible = ref(false)
const detail = ref<SaleDetail | null>(null)

async function openDetail(sale: Sale): Promise<void> {
  try {
    const d = await typedInvoke('sales:detail', { sale_id: sale.id })
    detail.value = d
    initExtraEdit(d)
    // 编辑区选项仅 completed 单需要（voided 无编辑入口，不多打一次 IPC）
    if (d.status === 'completed') {
      void loadSalespersonOptions()
    }
    detailVisible.value = true
  } catch (err) {
    ElMessage.error(errorMessage(err))
  }
}

// ── 附加信息编辑区（customer-order-extras 任务 12；仅 completed 单渲染）──

/** sales:updateExtra patch 形状（与 preload SalesApi.updateExtra 第二参同源派生） */
type SaleExtraPatch = Omit<IpcChannels['sales:updateExtra']['req'], 'sale_id'>

/** 编辑区四字段（初值=当前值快照，diff 后才进 patch——undefined=不动语义） */
interface ExtraEditState {
  isSubsidy: boolean
  orderNote: string
  salesperson: string
  customerPhone: string
}

const extraForm = reactive<ExtraEditState>({
  isSubsidy: false,
  orderNote: '',
  salesperson: '',
  customerPhone: ''
})

/** 打开/保存后重拍的初值快照（非响应式即可——比较只依赖 extraForm 的变化） */
let extraInitial: ExtraEditState = { isSubsidy: false, orderNote: '', salesperson: '', customerPhone: '' }

const extraSaving = ref(false)
const salespersonOptions = ref<string[]>([])

// ── 客户电话联想（Q5：失焦查全等项；命中「将关联」/清空「将解绑」/不变不提示）──

type PhoneHintKind = 'match' | 'unbind' | 'new' | 'invalid'

const phoneHintKind = ref<PhoneHintKind | null>(null)
const phoneMatch = ref<Customer | null>(null)

const phoneHintText = computed<string>(() => {
  switch (phoneHintKind.value) {
    case 'match':
      return `将关联：${phoneMatch.value?.name ?? ''}`
    case 'unbind':
      return '将解绑客户（保存后生效）'
    case 'new':
      return `将以「${extraForm.customerPhone.trim()}」新建客户`
    case 'invalid':
      return INVALID_PHONE_MESSAGE
    default:
      return ''
  }
})

/** 编辑区初值 = 当前附加值（旧单 extras null 全走默认散客态） */
function initExtraEdit(d: SaleDetail): void {
  const e = d.extras
  extraForm.isSubsidy = e?.is_national_subsidy ?? false
  extraForm.orderNote = e?.order_note ?? ''
  extraForm.salesperson = e?.salesperson ?? ''
  extraForm.customerPhone = e?.customer?.phone ?? ''
  extraInitial = {
    isSubsidy: extraForm.isSubsidy,
    orderNote: extraForm.orderNote,
    salesperson: extraForm.salesperson,
    customerPhone: extraForm.customerPhone
  }
  phoneHintKind.value = null
  phoneMatch.value = null
}

/** 最近销售人员下拉（settings:getRecentSalespersons）；失败静默清空——allow-create 手输兜底，不阻断编辑 */
async function loadSalespersonOptions(): Promise<void> {
  try {
    salespersonOptions.value = await window.api.settings.getRecentSalespersons()
  } catch {
    salespersonOptions.value = []
  }
}

const hasExtraChanges = computed(() => {
  if (detail.value?.status !== 'completed') return false
  return (
    extraForm.isSubsidy !== extraInitial.isSubsidy ||
    extraForm.orderNote.trim() !== extraInitial.orderNote ||
    extraForm.salesperson.trim() !== extraInitial.salesperson ||
    extraForm.customerPhone.trim() !== extraInitial.customerPhone
  )
})

/** 按 keyword 查客户列表后取电话全等命中（list 是子串匹配，全等才算关联） */
async function resolvePhoneMatch(phone: string): Promise<Customer | null> {
  const res = await window.api.customers.list({ keyword: phone })
  return res.items.find((c) => c.phone === phone) ?? null
}

async function onPhoneBlur(): Promise<void> {
  const phone = extraForm.customerPhone.trim()
  // 与当前关联一致（含同为空）→ 不动语义：无提示、不进 patch
  if (phone === extraInitial.customerPhone) {
    phoneHintKind.value = null
    phoneMatch.value = null
    return
  }
  if (phone === '') {
    // 走到这里必是「原有关联被清空」→ 显式解绑（保存时 customer: null）
    phoneHintKind.value = 'unbind'
    phoneMatch.value = null
    return
  }
  // 手机号格式不合法：红色提示，不查客户（合法格式才进入关联/新建判定）
  if (!isValidMobilePhone(phone)) {
    phoneHintKind.value = 'invalid'
    phoneMatch.value = null
    return
  }
  const hit = await resolvePhoneMatch(phone)
  // 查询期间输入又变了：过期结果不展示（下次失焦重新判定）
  if (extraForm.customerPhone.trim() !== phone) return
  phoneMatch.value = hit
  phoneHintKind.value = hit ? 'match' : 'new'
}

async function saveExtra(): Promise<void> {
  const current = detail.value
  if (!current || current.status !== 'completed' || extraSaving.value) return

  // patch 只含用户实际改动意图的字段（undefined=不动——后端部分键 upsert 语义）
  const patch: SaleExtraPatch = {}
  if (extraForm.isSubsidy !== extraInitial.isSubsidy) {
    patch.is_national_subsidy = extraForm.isSubsidy
  }
  if (extraForm.orderNote.trim() !== extraInitial.orderNote) {
    patch.order_note = extraForm.orderNote
  }
  if (extraForm.salesperson.trim() !== extraInitial.salesperson) {
    patch.salesperson = extraForm.salesperson
  }
  const phone = extraForm.customerPhone.trim()
  if (phone !== extraInitial.customerPhone) {
    if (phone === '') {
      patch.customer = null
    } else if (!isValidMobilePhone(phone)) {
      // 前端兜底（后端 SALE_EXTRAS_PHONE_INVALID 双防线）——免 IPC 往返直接提示
      ElMessage.error(INVALID_PHONE_MESSAGE)
      return
    } else {
      // 命中档案原值回传（后端 find-or-create 命中则 PUT 覆盖，同值覆写不丢数据）；
      // 未命中传空串 → 建裸电话客户（name 可后续在客户管理补录）
      const hit =
        phoneMatch.value?.phone === phone ? phoneMatch.value : await resolvePhoneMatch(phone)
      patch.customer = {
        name: hit?.name ?? '',
        phone,
        address: hit?.address ?? '',
        note: hit?.note ?? ''
      }
    }
  }

  if (Object.keys(patch).length === 0) return

  extraSaving.value = true
  try {
    // res 即更新后明细（头+items+extras）——赋值即刷新，展示区/表单立即对齐新值
    const updated = await window.api.sales.updateExtra(current.id, patch)
    detail.value = updated
    initExtraEdit(updated)
    ElMessage.success('附加信息已保存')
    // salesperson 改动会让后端记忆 recent 列表 → 重取下拉选项
    void loadSalespersonOptions()
  } catch (err) {
    // SALE_ALREADY_VOIDED / 国补需姓名电话等中文文案原样展示（弹窗保持编辑态可重试）
    ElMessage.error(errorMessage(err))
  } finally {
    extraSaving.value = false
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
        <el-option label="全部" value="all" />
        <el-option label="是" :value="true" />
        <el-option label="否" :value="false" />
      </el-select>
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
      <!-- 五新列（需求变更 W1）：插在「状态」后、「操作」前（操作列保持最右——UI 惯例；
           存量行级 E2E 不依赖列序）。null → '—' 占位；国补照 ReportsView 惯例
           true 才 el-tag（false 纯文本「否」——保 .el-tag 计数）。 -->
      <el-table-column label="姓名" min-width="100">
        <template #default="{ row }">
          <span data-testid="list-customer-name">{{ row.customer_name ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="电话" min-width="130">
        <template #default="{ row }">
          <span data-testid="list-customer-phone">{{ row.customer_phone ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="是否国补" width="90" align="center">
        <template #default="{ row }">
          <span data-testid="list-subsidy">
            <el-tag v-if="row.is_national_subsidy" type="success" disable-transitions>
              国补
            </el-tag>
            <span v-else>否</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column label="销售人员" min-width="100">
        <template #default="{ row }">
          <span data-testid="list-salesperson">{{ row.salesperson ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="订单备注" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">
          <span data-testid="list-order-note">{{ row.order_note ?? '—' }}</span>
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

        <!-- ── 附加信息展示区（T12：customer 为引用最新——改档案后重开立即反映）── -->
        <div class="sales-history__extras" data-testid="detail-extras">
          <div class="extras-panel">
            <div class="extras-panel__col">
              <h4 class="extras-panel__title">客户信息</h4>
              <template v-if="detail.extras?.customer">
                <div class="extras-panel__row">
                  <span class="extras-panel__label">姓名</span>
                  <span class="extras-panel__value" data-testid="detail-customer-name">{{
                    detail.extras.customer.name || '—'
                  }}</span>
                </div>
                <div class="extras-panel__row">
                  <span class="extras-panel__label">电话</span>
                  <span class="extras-panel__value" data-testid="detail-customer-phone">{{
                    detail.extras.customer.phone || '—'
                  }}</span>
                </div>
                <div class="extras-panel__row">
                  <span class="extras-panel__label">地址</span>
                  <span class="extras-panel__value" data-testid="detail-customer-address">{{
                    detail.extras.customer.address || '—'
                  }}</span>
                </div>
                <div class="extras-panel__row">
                  <span class="extras-panel__label">客户备注</span>
                  <span class="extras-panel__value" data-testid="detail-customer-note">{{
                    detail.extras.customer.note || '—'
                  }}</span>
                </div>
              </template>
              <p
                v-else
                class="extras-panel__placeholder"
                data-testid="detail-customer-placeholder"
              >
                散客（未填写客户信息）
              </p>
            </div>
            <div class="extras-panel__col">
              <h4 class="extras-panel__title">订单附加</h4>
              <div class="extras-panel__row">
                <span class="extras-panel__label">是否国补</span>
                <!-- true 才渲染 el-tag（ReportsView 惯例）：false 纯文本「否」——保 .el-tag 计数 -->
                <span class="extras-panel__value" data-testid="detail-subsidy">
                  <el-tag
                    v-if="detail.extras?.is_national_subsidy"
                    type="success"
                    disable-transitions
                  >
                    国补
                  </el-tag>
                  <span v-else>否</span>
                </span>
              </div>
              <div class="extras-panel__row">
                <span class="extras-panel__label">订单备注</span>
                <span class="extras-panel__value" data-testid="detail-order-note">{{
                  detail.extras?.order_note || '—'
                }}</span>
              </div>
              <div class="extras-panel__row">
                <span class="extras-panel__label">销售人员</span>
                <span class="extras-panel__value" data-testid="detail-salesperson">{{
                  detail.extras?.salesperson || '—'
                }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ── 附加信息编辑区（仅 completed 单可见；voided 前置隐藏——Q4）── -->
        <div
          v-if="detail.status === 'completed'"
          class="sales-history__extra-edit"
          data-testid="extra-edit"
        >
          <el-divider class="sales-history__edit-divider">修改附加信息</el-divider>
          <el-form class="sales-history__edit-form" label-width="96px">
            <el-form-item label="国补">
              <el-switch v-model="extraForm.isSubsidy" data-testid="extra-is-subsidy" />
            </el-form-item>
            <el-form-item label="客户电话">
              <el-input
                v-model="extraForm.customerPhone"
                maxlength="32"
                placeholder="输入新电话失焦自动匹配客户；清空即解绑"
                data-testid="extra-customer-phone"
                @blur="onPhoneBlur"
              />
              <div
                v-if="phoneHintKind"
                class="sales-history__phone-hint"
                :class="`sales-history__phone-hint--${phoneHintKind}`"
                data-testid="extra-phone-hint"
              >
                {{ phoneHintText }}
              </div>
            </el-form-item>
            <el-form-item label="销售人员">
              <el-select
                v-model="extraForm.salesperson"
                filterable
                allow-create
                default-first-option
                clearable
                placeholder="选择或输入销售人员"
                data-testid="extra-salesperson"
              >
                <el-option
                  v-for="name in salespersonOptions"
                  :key="name"
                  :label="name"
                  :value="name"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="订单备注">
              <el-input
                v-model="extraForm.orderNote"
                type="textarea"
                :rows="2"
                maxlength="200"
                show-word-limit
                data-testid="extra-order-note"
              />
            </el-form-item>
            <el-form-item>
              <el-button
                type="primary"
                :loading="extraSaving"
                :disabled="!hasExtraChanges"
                data-testid="extra-save"
                @click="saveExtra"
              >
                保存修改
              </el-button>
              <span class="sales-history__edit-scope">
                仅客户/国补/备注/销售人员可修改；金额与商品明细不可改
              </span>
            </el-form-item>
          </el-form>
        </div>
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

.sales-history__voided-alert {
  margin-bottom: 12px;
}

.sales-history__detail-meta {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

/* ── 明细弹窗：附加信息展示区（浅底双栏面板，延续 ProductsView 台账面板气质）── */
.sales-history__extras {
  margin-top: 12px;
}

.extras-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 28px;
  padding: 12px 14px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background-color: var(--el-fill-color-lighter);
}

.extras-panel__title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}

.extras-panel__row {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  font-size: 13px;
  line-height: 1.6;
}

.extras-panel__label {
  flex-shrink: 0;
  width: 60px;
  color: var(--el-text-color-secondary);
}

.extras-panel__value {
  min-width: 0;
  color: var(--el-text-color-primary);
  word-break: break-all;
}

.extras-panel__placeholder {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}

/* ── 明细弹窗：附加信息编辑区（仅 completed 单渲染）── */
.sales-history__edit-divider {
  margin: 16px 0 14px;
}

.sales-history__edit-form :deep(.el-select) {
  width: 100%;
}

.sales-history__phone-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.sales-history__phone-hint--match {
  color: var(--el-color-success);
}

.sales-history__phone-hint--unbind {
  color: var(--el-color-warning);
}

.sales-history__phone-hint--new {
  color: var(--el-color-primary);
}

.sales-history__phone-hint--invalid {
  color: var(--el-color-danger);
}

.sales-history__edit-scope {
  margin-left: 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
