<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Search } from '@element-plus/icons-vue'
import type { Product } from '../../../shared/types'

/**
 * 商品管理页（Task 8）：搜索（防抖 300ms）+ 新增/编辑（元↔分边界转换）+
 * 删除（willOrphan 引用提示）+ 负库存标红（D2）+ 前端分页 20/页。
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
}

const form = reactive<ProductFormState>({ barcode: '', name: '', stock: 0, price: null })

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

/** 剥去 Electron invoke 错误包装前缀，取用户可读的中文 message */
function extractIpcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const matched = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return matched ? matched[1]! : raw
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
  Object.assign(form, { barcode: '', name: '', stock: 0, price: null })
  dialogVisible.value = true
}

function openEdit(row: ProductRow): void {
  dialogMode.value = 'edit'
  editingRow.value = row
  Object.assign(form, {
    barcode: row.barcode ?? '',
    name: row.name,
    stock: row.stock,
    price: centsToYuan(row.default_price_cents)
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
        stock: form.stock
      })
      ElMessage.success('商品已创建')
    } else {
      const row = editingRow.value!
      await window.api.products.update({
        id: row.id,
        name: form.name.trim(),
        default_price_cents: cents
      })
      if (form.stock !== row.stock) {
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

// ── 删除（D15 硬删 + 快照存活；弹窗明示引用数与库存废弃）──

function deleteMessage(row: ProductRow): ReturnType<typeof h> {
  return h('div', { class: 'delete-confirm' }, [
    h('p', null, `确定删除商品「${row.name}」吗？`),
    row.willOrphan > 0
      ? h(
          'p',
          { class: 'delete-confirm__warn' },
          `该商品关联 ${row.willOrphan} 条历史单据：删除后单据保留商品快照，商品引用将解除。`
        )
      : null,
    h('p', { class: 'delete-confirm__warn' }, '库存及库存流水将废弃，此操作不可恢复。')
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

/** 负库存行标红（D2：允许负值，不阻断，仅视觉警示） */
function rowClassName({ row }: { row: ProductRow }): string {
  return row.stock < 0 ? 'stock-negative' : ''
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
      class="products-table"
      height="100%"
    >
      <el-table-column label="条码" width="180">
        <template #default="{ row }">
          <span class="cell-barcode" :class="{ 'cell-barcode--empty': row.barcode === null }">
            {{ row.barcode ?? '— 无条码 —' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="cell-name">{{ row.name }}</span>
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
        <el-form-item :label="dialogMode === 'create' ? '初始库存' : '调整为库存'">
          <el-input-number v-model="form.stock" :precision="0" :step="1" class="form-number" />
          <div class="form-hint">允许负值（盘点差异可记负，行标红提示）</div>
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
