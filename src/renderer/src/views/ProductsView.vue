<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Document, Edit, Plus, Search } from '@element-plus/icons-vue'
import ProductFormDialog from '@renderer/components/products/ProductFormDialog.vue'
import ProductChangeLogDialog from '@renderer/components/products/ProductChangeLogDialog.vue'
import SnLedgerPanel from '@renderer/components/products/SnLedgerPanel.vue'
import type { ProductRow, ProductSn } from '../../../shared/types'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'

/**
 * 商品管理页（Task 8 + SN Wave 3C + 改动记录）：搜索（防抖 300ms）+ 列表
 * （负库存标红 D2 + 前端分页 20/页）+ 删除（软删：willOrphan 引用提示 +
 * 在库 SN 守卫 D-SN15；原因必填落改动记录）+ 改动记录弹窗 + 展开行 SN 台账编排。
 *
 * 拆分（巨型视图治理批次 2）：
 * - 新增/编辑弹窗 → components/products/ProductFormDialog.vue（自治：表单态 +
 *   元分转换 + 原因必填 + update 单次调用闭环，saved 后本页刷新）
 * - 改动记录弹窗 → components/products/ProductChangeLogDialog.vue（自治取数）
 * - 展开行台账面板 → components/products/SnLedgerPanel.vue（受控展示：数据/
 *   筛选态缓存留本页 snLedgers——toggle 状态跨列表刷新保留的原设计不变）
 *
 * 金额铁律 G1：DB/IPC 一律整数分；元浮点只在弹窗输入/本页显示边界。
 */

const PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 300

const rows = ref<ProductRow[]>([])
const loading = ref(false)
const searchText = ref('')
const page = ref(1)

// ── 新增/编辑弹窗编排（表单态与保存链路在 ProductFormDialog 内闭环）──
const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const editingRow = ref<ProductRow | null>(null)

// ── 改动记录弹窗编排（取数与展示在 ProductChangeLogDialog 内闭环）──
const logDialogVisible = ref(false)
const logRow = ref<ProductRow | null>(null)

function openChangeLogs(row: ProductRow): void {
  logRow.value = row
  logDialogVisible.value = true
}

const total = computed(() => rows.value.length)
const pagedRows = computed(() =>
  rows.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE)
)
const emptyDescription = computed(() =>
  searchText.value.trim().length > 0 ? '未找到匹配商品，换个关键词试试' : '暂无商品，点击右上角「新增商品」开始建档'
)

// ── 显示边界转换（G1：仅 UI 层存在元浮点）──

function formatCents(cents: number | null): string {
  return cents === null ? '—' : `¥${(cents / 100).toFixed(2)}`
}

// ── 数据加载与搜索 ──

async function load(): Promise<void> {
  loading.value = true
  try {
    const keyword = searchText.value.trim()
    rows.value = await window.api.products.list(keyword.length > 0 ? keyword : undefined)
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    void load()
  }, SEARCH_DEBOUNCE_MS)
}

onMounted(() => {
  void load()
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

// ── 新增 / 编辑（表单初始化随弹窗打开在 ProductFormDialog 内完成）──

function openCreate(): void {
  dialogMode.value = 'create'
  editingRow.value = null
  dialogVisible.value = true
}

function openEdit(row: ProductRow): void {
  dialogMode.value = 'edit'
  editingRow.value = row
  dialogVisible.value = true
}

// ── 删除（软删：行保留、历史单据/审计链完整；prompt 明示引用数 + 原因必填落改动记录）──

function deleteMessage(row: ProductRow): ReturnType<typeof h> {
  return h('div', { class: 'delete-confirm' }, [
    h('p', null, `确定删除商品「${row.name}」吗？`),
    row.willOrphan > 0
      ? h(
          'p',
          { class: 'delete-confirm__warn' },
          `该商品关联 ${row.willOrphan} 条历史单据：删除后单据完整保留，可继续追溯。商品将从列表中移除。`
        )
      : null,
    h('p', { class: 'delete-confirm__warn' }, '商品将从列表中移除，历史单据与库存流水将完整保留，此操作不可恢复。')
  ])
}

/** 原因必填输入校验（ElMessageBox.prompt inputValidator；service 层 assertValidReason 兜底） */
function reasonValidator(value: string | undefined): true | string {
  return typeof value === 'string' && value.trim().length > 0 ? true : '改动原因不能为空'
}

const REASON_PROMPT_OPTIONS = {
  inputType: 'textarea' as const,
  inputPlaceholder: '改动原因（必填，将记入改动记录）',
  inputValidator: reasonValidator,
  inputErrorMessage: '改动原因不能为空'
}

async function handleDelete(row: ProductRow): Promise<void> {
  const result = await ElMessageBox.prompt(deleteMessage(row), '删除商品', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消',
    confirmButtonClass: 'el-button--danger',
    autofocus: false,
    ...REASON_PROMPT_OPTIONS
  }).catch(() => null)
  if (result === null) return
  const reason = (result.value ?? '').trim()

  try {
    await window.api.products.delete(row.id, reason)
    ElMessage.success('商品已删除')
    if (pagedRows.value.length === 0 && page.value > 1) page.value -= 1
    await load()
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  }
}

/** 负库存行标红（D2：允许负值，不阻断，仅视觉警示；SN 商品 stock=在库 SN 数，恒非负） */
function rowClassName({ row }: { row: ProductRow }): string {
  return row.stock < 0 ? 'stock-negative' : ''
}

/** 名称列溢出 tooltip 只显示纯名称（名称格内联 SN 标签，避免混入 tooltip 文本） */
function nameTooltip({ row }: { row: ProductRow }): string {
  return row.name
}

// ── SN 台账编排（D-SN16：渲染在 SnLedgerPanel；数据缓存/取数/删除留本页）──

/** 单商品台账浏览态（按商品 id 缓存，toggle 状态跨列表刷新保留） */
interface SnLedgerState {
  sns: ProductSn[]
  loading: boolean
  /** false=仅在库（默认），true=含已售 */
  includeSold: boolean
}

/** 渲染期兜底（正常不可达：expand-change 先于展开内容渲染建好状态） */
const EMPTY_LEDGER: SnLedgerState = { sns: [], loading: false, includeSold: false }

const snLedgers = reactive<Record<number, SnLedgerState>>({})

/** 渲染期只读访问，不在此创建（避免渲染期变更响应式状态） */
function ledger(row: ProductRow): SnLedgerState {
  return snLedgers[row.id] ?? EMPTY_LEDGER
}

function ensureLedger(row: ProductRow): SnLedgerState {
  let state = snLedgers[row.id]
  if (!state) {
    // 必须造响应式对象：普通对象存入 reactive Record 后仅读路径被代理，
    // fetchLedger 持有的原始引用写入不触发重渲染（首展空表——E2E 实证）
    state = reactive({ sns: [], loading: false, includeSold: false })
    snLedgers[row.id] = state
  }
  return state
}

/** 仅 SN 商品可展开台账（批量计行展开箭头由 row-expandable 置 disabled 后 CSS 隐藏） */
function isRowExpandable(row: ProductRow): boolean {
  return row.tracking === 'sn'
}

/** 展开即取最新（懒加载）；收起无动作 */
function onExpandChange(row: ProductRow, expandedRows: ProductRow[]): void {
  if (!expandedRows.some((r) => r.id === row.id)) return
  if (row.tracking !== 'sn') return
  void fetchLedger(row)
}

async function fetchLedger(row: ProductRow): Promise<void> {
  const state = ensureLedger(row)
  state.loading = true
  try {
    state.sns = await window.api.products.listSns(row.id, state.includeSold)
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    state.loading = false
  }
}

function onLedgerFilterChange(row: ProductRow, includeSold: boolean): void {
  const state = snLedgers[row.id]
  if (!state) return
  state.includeSold = includeSold
  void fetchLedger(row)
}

/** 删在库 SN：prompt 明示后果 + 原因必填 → deleteSn（主进程事务：逻辑删 + stock-1 + manual 流水 + 改动记录） */
async function handleDeleteSn(row: ProductRow, sn: ProductSn): Promise<void> {
  const result = await ElMessageBox.prompt(
    `确定删除 SN「${sn.sn}」吗？该商品库存将减 1，并记录一条手动库存流水与改动记录。`,
    '删除 SN',
    {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      autofocus: false,
      ...REASON_PROMPT_OPTIONS
    }
  ).catch(() => null)
  if (result === null) return
  const reason = (result.value ?? '').trim()

  try {
    await window.api.products.deleteSn(sn.id, reason)
    ElMessage.success('SN 已删除')
    // 刷新台账 + 外层列表（stock -1；row-key 使展开态在数据替换后保留）
    await Promise.all([fetchLedger(row), load()])
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  }
}
</script>

<template>
  <section class="products-page">
    <header class="page-header">
      <div class="page-title">
        <h2 class="page-title__text">
          商品管理
        </h2>
        <span class="page-title__count">共 {{ total }} 款商品</span>
      </div>
      <div class="page-actions">
        <el-input
          v-model="searchText"
          class="page-actions__search"
          placeholder="搜索名称或条码"
          clearable
          :prefix-icon="Search"
          @input="onSearchInput"
          @clear="onSearchInput"
        />
        <el-button
          type="warning"
          :icon="Plus"
          @click="openCreate"
        >
          新增商品
        </el-button>
      </div>
    </header>

    <el-table
      v-loading="loading"
      :data="pagedRows"
      :row-class-name="rowClassName"
      row-key="id"
      :row-expandable="isRowExpandable"
      class="products-table"
      height="100%"
      @expand-change="onExpandChange"
    >
      <el-table-column
        type="expand"
        width="36"
      >
        <template #default="{ row }">
          <SnLedgerPanel
            :row="row"
            :sns="ledger(row).sns"
            :loading="ledger(row).loading"
            :include-sold="ledger(row).includeSold"
            @filter-change="(val: boolean) => onLedgerFilterChange(row, val)"
            @delete-sn="(sn: ProductSn) => handleDeleteSn(row, sn)"
          />
        </template>
      </el-table-column>
      <el-table-column
        label="条码"
        width="180"
      >
        <template #default="{ row }">
          <span
            class="cell-barcode"
            :class="{ 'cell-barcode--empty': row.barcode === null }"
          >
            {{ row.barcode ?? '— 无条码 —' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column
        prop="name"
        label="名称"
        min-width="220"
        show-overflow-tooltip
        :tooltip-formatter="nameTooltip"
      >
        <template #default="{ row }">
          <span class="cell-name">{{ row.name }}</span>
          <el-tag
            v-if="row.tracking === 'sn'"
            class="cell-name__tag"
            type="warning"
            effect="plain"
            size="small"
            disable-transitions
          >
            SN
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column
        prop="stock"
        label="库存"
        width="110"
        align="center"
        sortable
      >
        <template #default="{ row }">
          <span class="cell-stock">{{ row.stock }}</span>
        </template>
      </el-table-column>
      <el-table-column
        label="默认售价"
        width="130"
        align="right"
      >
        <template #default="{ row }">
          <span class="cell-price">{{ formatCents(row.default_price_cents) }}</span>
        </template>
      </el-table-column>
      <el-table-column
        label="操作"
        width="220"
        align="center"
        fixed="right"
      >
        <template #default="{ row }">
          <el-button
            text
            type="primary"
            :icon="Edit"
            @click="openEdit(row)"
          >
            编辑
          </el-button>
          <el-button
            text
            type="info"
            :icon="Document"
            data-testid="open-change-logs"
            @click="openChangeLogs(row)"
          >
            记录
          </el-button>
          <el-button
            text
            type="danger"
            :icon="Delete"
            @click="handleDelete(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          :description="emptyDescription"
          :image-size="110"
        />
      </template>
    </el-table>

    <footer class="page-footer">
      <el-pagination
        v-model:current-page="page"
        background
        layout="total, prev, pager, next"
        :total="total"
        :page-size="PAGE_SIZE"
        :pager-count="7"
      />
    </footer>

    <ProductFormDialog
      v-model:visible="dialogVisible"
      :mode="dialogMode"
      :row="editingRow"
      @saved="load"
    />

    <ProductChangeLogDialog
      v-model:visible="logDialogVisible"
      :row="logRow"
    />
  </section>
</template>

<style scoped>
.products-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 24px 14px;
  box-sizing: border-box;
  gap: 14px;
}

/* ── 页头：标题 + 搜索 + 新增（延续侧栏琥珀点缀的零售台账气质）── */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
}

.page-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.page-title__text {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}

.page-title__count {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.page-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.page-actions__search {
  width: 260px;
}

/* ── 表格：撑满剩余空间（el-table height=100% 由 flex 撑高）── */
.products-table {
  flex: 1;
  min-height: 0;
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

.cell-name {
  font-weight: 500;
  color: var(--el-text-color-primary);
}

/* ── SN 类型标签（名称格内联；批量计行不显示，保持原视觉密度）── */
.cell-name__tag {
  margin-left: 6px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.cell-stock {
  font-variant-numeric: tabular-nums;
}

.cell-price {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

/* ── 负库存（D2：允许但不掩饰）── */
.products-table :deep(.stock-negative) {
  --el-table-tr-bg-color: var(--el-color-danger-light-9);
}

.products-table :deep(.stock-negative .cell-stock) {
  color: var(--el-color-danger);
  font-weight: 700;
}

/* ── 展开行：批量计行隐藏展开箭头（row-expandable 已置 disabled——D-SN16）── */
.products-table :deep(.el-table__expand-icon.is-disabled) {
  display: none;
}

/* ── 展开单元格：SN 台账面板容器（浅底衬托内嵌白底子表；面板本体在 SnLedgerPanel）── */
.products-table :deep(.el-table__expanded-cell) {
  padding: 10px 12px 12px;
  background-color: var(--el-fill-color-lighter);
}

/* ── 分页 ── */
.page-footer {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
}

/* ── 删除确认文案（ElMessageBox VNode 内容）── */
:global(.delete-confirm) {
  line-height: 1.7;
}

:global(.delete-confirm p) {
  margin: 0 0 4px;
}

:global(.delete-confirm__warn) {
  color: var(--el-color-danger);
  font-size: 13px;
}
</style>
