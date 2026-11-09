<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Search } from '@element-plus/icons-vue'
import type { Product, ProductSn, ProductTracking } from '../../../shared/types'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'

/**
 * 商品管理页（Task 8 + SN Wave 3C）：搜索（防抖 300ms）+ 新增/编辑（元↔分边界
 * 转换；双类型表单：批量计 / SN——D-SN1 建后不可转，SN 商品多【SN 前缀】D-SN2、
 * 禁初始库存与手动调库 D-SN11）+ 删除（软删——004 迁移：willOrphan 引用提示 +
 * 在库 SN 守卫 D-SN15，历史单据/审计链完整保留）+ 负库存标红（D2）+
 * 展开行 SN 台账浏览（D-SN16：默认在库、可切含已售；在库 SN 可删=逻辑删除+
 * manual 流水；不提供手动添加，一律进货录入）+ 前端分页 20/页。
 *
 * 金额铁律 G1：DB/IPC 一律整数分；元单位浮点只存在于本页输入/显示边界
 * （输入 Math.round(yuan * 100) 入分，显示 (cents / 100).toFixed(2)）。
 */

/** 列表行（与 preload ProductsApi.list 的 ProductRow 结构一致；不直接 import preload 模块以隔离 electron 依赖） */
interface ProductRow extends Product {
  /** 关联的 sale_items + purchase_items 行数（删除弹窗「N 条历史单据」文案用） */
  willOrphan: number
}

const PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 300

const rows = ref<ProductRow[]>([])
const loading = ref(false)
const searchText = ref('')
const page = ref(1)

const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const editingRow = ref<ProductRow | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()

interface ProductFormState {
  barcode: string
  name: string
  stock: number
  /** 默认售价（元，2 位小数；null=未设）——提交前转分 */
  price: number | null
  /** 计存类型：仅建档可选（D-SN1 建后不可转）；编辑时从行带入，仅作展示与分支 */
  tracking: ProductTracking
  /** SN 前缀（仅 SN 商品；提交前 trim，空串=不启用——D-SN2） */
  snPrefix: string
}

const form = reactive<ProductFormState>({
  barcode: '',
  name: '',
  stock: 0,
  price: null,
  tracking: 'quantity',
  snPrefix: ''
})

const rules: FormRules = {
  name: [
    {
      required: true,
      validator: (_rule, value: string, callback) => {
        if (typeof value !== 'string' || value.trim().length === 0) {
          callback(new Error('商品名称不能为空'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

const total = computed(() => rows.value.length)
const pagedRows = computed(() =>
  rows.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE)
)
const emptyDescription = computed(() =>
  searchText.value.trim().length > 0 ? '未找到匹配商品，换个关键词试试' : '暂无商品，点击右上角「新增商品」开始建档'
)

// ── 金额/显示边界转换（G1：仅 UI 层存在元浮点）──

function formatCents(cents: number | null): string {
  return cents === null ? '—' : `¥${(cents / 100).toFixed(2)}`
}

function yuanToCents(yuan: number | null): number | null {
  return yuan === null ? null : Math.round(yuan * 100)
}

function centsToYuan(cents: number | null): number | null {
  return cents === null ? null : cents / 100
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

// ── 新增 / 编辑 ──

function openCreate(): void {
  dialogMode.value = 'create'
  editingRow.value = null
  Object.assign(form, {
    barcode: '',
    name: '',
    stock: 0,
    price: null,
    tracking: 'quantity',
    snPrefix: ''
  })
  dialogVisible.value = true
}

function openEdit(row: ProductRow): void {
  dialogMode.value = 'edit'
  editingRow.value = row
  Object.assign(form, {
    barcode: row.barcode ?? '',
    name: row.name,
    stock: row.stock,
    price: centsToYuan(row.default_price_cents),
    tracking: row.tracking,
    snPrefix: row.sn_prefix
  })
  dialogVisible.value = true
}

async function save(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const cents = yuanToCents(form.price)
    if (dialogMode.value === 'create') {
      await window.api.products.create({
        barcode: form.barcode.trim().length > 0 ? form.barcode.trim() : null,
        name: form.name.trim(),
        default_price_cents: cents,
        // SN 商品库存恒 0（D-SN11：一律进货录入，主进程同侧强制）
        stock: form.tracking === 'sn' ? 0 : form.stock,
        tracking: form.tracking,
        // 仅 SN 商品带前缀（trim 后空串=不启用——D-SN2；冲突由 service 校验 D-SN14）
        ...(form.tracking === 'sn' ? { sn_prefix: form.snPrefix.trim() } : {})
      })
      ElMessage.success(
        form.tracking === 'sn' ? 'SN 商品已创建，SN 请从进货录入' : '商品已创建'
      )
    } else {
      const row = editingRow.value!
      await window.api.products.update({
        id: row.id,
        name: form.name.trim(),
        default_price_cents: cents,
        // update 契约：sn_prefix 省略=保持现值，显式传值（含 ''）才覆盖——SN 商品必传
        ...(row.tracking === 'sn' ? { sn_prefix: form.snPrefix.trim() } : {})
      })
      // SN 商品禁手动调库（D-SN11，主进程同侧拒绝）；批量计保持原逻辑
      if (row.tracking === 'quantity' && form.stock !== row.stock) {
        await window.api.products.updateStock({ id: row.id, stock: form.stock })
      }
      ElMessage.success('商品已保存')
    }
    dialogVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    submitting.value = false
  }
}

// ── 删除（软删：行保留、历史单据/审计链完整；弹窗明示引用数与不可恢复）──

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

async function handleDelete(row: ProductRow): Promise<void> {
  const confirmed = await ElMessageBox.confirm(deleteMessage(row), '删除商品', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消',
    confirmButtonClass: 'el-button--danger',
    autofocus: false
  })
    .then(() => true)
    .catch(() => false)
  if (!confirmed) return

  try {
    await window.api.products.delete(row.id)
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

// ── SN 台账浏览（D-SN16：el-table 展开行；只读 + 在库可删，无手动添加）──

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

function onLedgerFilterChange(
  row: ProductRow,
  val: string | number | boolean | undefined
): void {
  const state = snLedgers[row.id]
  if (!state) return
  state.includeSold = val === true
  void fetchLedger(row)
}

/** 删在库 SN：确认弹窗明示后果 → deleteSn（主进程事务：逻辑删 + stock-1 + manual 流水） */
async function handleDeleteSn(row: ProductRow, sn: ProductSn): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `确定删除 SN「${sn.sn}」吗？该商品库存将减 1，并记录一条手动库存流水。`,
    '删除 SN',
    {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      autofocus: false
    }
  )
    .then(() => true)
    .catch(() => false)
  if (!confirmed) return

  try {
    await window.api.products.deleteSn(sn.id)
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
        <h2 class="page-title__text">商品管理</h2>
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
        <el-button type="warning" :icon="Plus" @click="openCreate">新增商品</el-button>
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
      <el-table-column type="expand" width="36">
        <template #default="{ row }">
          <!-- 防御兜底：批量计行箭头已隐藏（row-expandable disabled），正常不可达 -->
          <div v-if="row.tracking !== 'sn'" class="ledger-empty-hint">
            批量计商品无 SN 台账
          </div>
          <div v-else class="ledger-panel">
            <div class="ledger-panel__header">
              <div class="ledger-panel__title">
                <span class="ledger-panel__name">SN 台账</span>
                <span class="ledger-panel__count">共 {{ ledger(row).sns.length }} 条</span>
              </div>
              <el-radio-group
                :model-value="ledger(row).includeSold"
                size="small"
                data-testid="sn-ledger-filter"
                @change="(val: string | number | boolean | undefined) => onLedgerFilterChange(row, val)"
              >
                <el-radio-button :value="false">仅在库</el-radio-button>
                <el-radio-button :value="true">含已售</el-radio-button>
              </el-radio-group>
            </div>
            <el-table
              v-loading="ledger(row).loading"
              :data="ledger(row).sns"
              size="small"
              class="ledger-panel__table"
              :max-height="320"
              data-testid="sn-ledger-table"
            >
              <el-table-column label="SN" min-width="200">
                <template #default="{ row: sn }">
                  <span class="cell-sn">{{ sn.sn }}</span>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="80" align="center">
                <template #default="{ row: sn }">
                  <el-tag
                    :type="sn.status === 'in_stock' ? 'success' : 'info'"
                    size="small"
                    disable-transitions
                  >
                    {{ sn.status === 'in_stock' ? '在库' : '已售' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="关联单号" min-width="130">
                <template #default="{ row: sn }">
                  <span v-if="sn.sale_no" class="cell-sn">{{ sn.sale_no }}</span>
                  <span v-else class="cell-dash">—</span>
                </template>
              </el-table-column>
              <el-table-column prop="created_at" label="入库时间" min-width="160" />
              <el-table-column label="操作" width="80" align="center">
                <template #default="{ row: sn }">
                  <!-- D-SN16：仅在库 SN 可删；已售行走作废流程（D-SN17） -->
                  <el-button
                    v-if="sn.status === 'in_stock'"
                    text
                    type="danger"
                    size="small"
                    :icon="Delete"
                    data-testid="sn-ledger-delete"
                    @click="handleDeleteSn(row, sn)"
                  >
                    删除
                  </el-button>
                  <span v-else class="cell-dash">—</span>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty
                  :description="ledger(row).includeSold ? '暂无 SN 记录' : '暂无在库 SN'"
                  :image-size="60"
                />
              </template>
            </el-table>
            <div class="ledger-panel__hint">
              SN 一律从进货录入；删除在库 SN 将同步扣减库存并记录流水
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="条码" width="180">
        <template #default="{ row }">
          <span class="cell-barcode" :class="{ 'cell-barcode--empty': row.barcode === null }">
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
      <el-table-column prop="stock" label="库存" width="110" align="center" sortable>
        <template #default="{ row }">
          <span class="cell-stock">{{ row.stock }}</span>
        </template>
      </el-table-column>
      <el-table-column label="默认售价" width="130" align="right">
        <template #default="{ row }">
          <span class="cell-price">{{ formatCents(row.default_price_cents) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" align="center" fixed="right">
        <template #default="{ row }">
          <el-button text type="primary" :icon="Edit" @click="openEdit(row)">编辑</el-button>
          <el-button text type="danger" :icon="Delete" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :description="emptyDescription" :image-size="110" />
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

    <el-dialog
      v-model="dialogVisible"
      :title="dialogMode === 'create' ? '新增商品' : '编辑商品'"
      width="480px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item v-if="dialogMode === 'create'" label="类型">
          <el-radio-group v-model="form.tracking" data-testid="product-tracking">
            <el-radio-button value="sn">SN 商品</el-radio-button>
            <el-radio-button value="quantity">批量计商品</el-radio-button>
          </el-radio-group>
          <div class="form-hint">商品类型创建后不可修改</div>
        </el-form-item>
        <!-- 编辑 SN 商品：只读类型标识（D-SN1 禁互转，不提供切换） -->
        <el-form-item v-if="dialogMode === 'edit' && form.tracking === 'sn'" label="类型">
          <el-tag type="warning" effect="plain">SN 商品</el-tag>
          <div class="form-hint">类型创建后不可修改；库存为在库 SN 数，从进货录入</div>
        </el-form-item>
        <el-form-item label="条码">
          <el-input
            v-model="form.barcode"
            :disabled="dialogMode === 'edit'"
            maxlength="64"
            placeholder="扫码或手动输入，可留空"
          />
          <div v-if="dialogMode === 'edit'" class="form-hint">条码创建后不可修改</div>
        </el-form-item>
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" maxlength="60" show-word-limit placeholder="商品名称" />
        </el-form-item>
        <!-- 批量计：初始库存/调整为库存（原逻辑逐字节不变）；SN 商品隐藏（D-SN11） -->
        <el-form-item
          v-if="form.tracking === 'quantity'"
          :label="dialogMode === 'create' ? '初始库存' : '调整为库存'"
        >
          <el-input-number v-model="form.stock" :precision="0" :step="1" class="form-number" />
          <div class="form-hint">允许负值（盘点差异可记负，行标红提示）</div>
        </el-form-item>
        <!-- SN 商品：SN 前缀（可改，影响以后进货匹配——D-SN2） -->
        <el-form-item v-if="form.tracking === 'sn'" label="SN 前缀">
          <el-input
            v-model="form.snPrefix"
            maxlength="32"
            placeholder="选填，进货扫 SN 自动匹配商品用"
            data-testid="product-sn-prefix"
          />
          <div class="form-hint">非空前缀不能与其他 SN 商品相同或互为前缀；留空表示不启用</div>
        </el-form-item>
        <el-form-item label="默认售价">
          <el-input-number
            v-model="form.price"
            :min="0"
            :precision="2"
            :step="0.5"
            :controls="false"
            class="form-number"
            placeholder="元"
          />
          <div class="form-hint">单位元；留空表示不设加购默认价</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="warning" :loading="submitting" @click="save()">保存</el-button>
      </template>
    </el-dialog>
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

/* ── 展开单元格：SN 台账面板容器（浅底衬托内嵌白底子表）── */
.products-table :deep(.el-table__expanded-cell) {
  padding: 10px 12px 12px;
  background-color: var(--el-fill-color-lighter);
}

.ledger-empty-hint {
  padding: 2px 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.ledger-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.ledger-panel__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ledger-panel__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.ledger-panel__count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.ledger-panel__table {
  background-color: var(--el-bg-color);
}

.ledger-panel__hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

/* ── 台账子表：SN/单号等宽字体（延续条码格气质）── */
.cell-sn {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px;
  letter-spacing: 0.03em;
  color: var(--el-text-color-regular);
}

.cell-dash {
  color: var(--el-text-color-placeholder);
}

/* ── 分页 ── */
.page-footer {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
}

/* ── 弹窗表单 ── */
.form-number {
  width: 200px;
}

.form-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
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
