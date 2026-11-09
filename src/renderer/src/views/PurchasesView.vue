<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type {
  Product,
  ProductSn,
  PurchaseInputItem,
  PurchaseOrderWithItems
} from '../../../shared/types/domain'

/**
 * 进货管理（Task 9 + SN T2.B）：列表 + 新建进货单（批量计/SN 混排动态行）+ 明细弹窗。
 * 金额铁律 G1：DB/IPC 全程整数分；元↔分换算只发生在本页输入/显示边界。
 *
 * SN 行（D-SN9/10）：新建单默认 0 行；数量 = 已录 SN 个数（禁手填），行内单一
 * 成本价对全部 SN 生效（主进程展开为每 SN 一行同价 purchase_items）。
 *
 * 扫码录入（D-SN2/9）：新建弹窗打开期间订阅 onBarcode（主进程
 * before-input-event 桥，焦点在任意位置都能触发）。SN 输入框**不处理
 * Enter**——扫码枪的 Enter 终结键同样会到达聚焦输入框（桥不 preventDefault，
 * 枪击字符会落入输入框），双路径消费同一次扫码会造成重复录入（参照
 * BarcodeInput 的既有经验）；手动录入走「添加」按钮，扫码一律经桥单路径
 * 进入，桥消费后清空输入缓冲。扫码目标行 = 最近聚焦的 SN 行（行被删后
 * rid 失配，自动回退「仅一个 SN 行」规则）。
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

/** SN 商品带「· SN」后缀标识（两类行共用；帮助避免行类型选错商品） */
const productOptions = computed(() =>
  products.value.map((p) => ({
    value: p.id,
    label:
      p.tracking === 'sn'
        ? `${p.barcode ? `${p.name} · ${p.barcode}` : `${p.name} · 无条码`} · SN`
        : p.barcode
          ? `${p.name} · ${p.barcode}`
          : `${p.name} · 无条码`
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

// ── 新建进货单：混排动态行（批量计 / SN——D-SN9）──
interface QuantityFormRow {
  kind: 'quantity'
  productId: number | null
  quantity: number
  costYuan: number
}

interface SnFormRow {
  kind: 'sn'
  /** 行唯一标识：扫码聚焦追踪用（不随 blur 清空，「最近一次」语义） */
  rid: number
  productId: number | null
  sns: string[]
  /** 手输缓冲（扫码枪字符会落入此处，桥消费后清空） */
  snInput: string
  costYuan: number
  /** findSn 查重进行中：禁「添加」防双击竞态（await 后仍二次校验兜底） */
  checking: boolean
}

type PurchaseFormRow = QuantityFormRow | SnFormRow

const createDialogVisible = ref(false)
const formRows = ref<PurchaseFormRow[]>([])
const noteInput = ref('')
const submitting = ref(false)

/** 最近聚焦的 SN 行 rid（扫码目标） */
const activeSnRowRid = ref<number | null>(null)
let snRidSeed = 0

function openCreateDialog(): void {
  formRows.value = [] // D-SN9：新建单默认 0 行
  noteInput.value = ''
  activeSnRowRid.value = null
  createDialogVisible.value = true
  void loadProducts()
}

function addQuantityRow(): void {
  formRows.value.push({ kind: 'quantity', productId: null, quantity: 1, costYuan: 0 })
}

function addSnRow(): void {
  formRows.value.push({
    kind: 'sn',
    rid: ++snRidSeed,
    productId: null,
    sns: [],
    snInput: '',
    costYuan: 0,
    checking: false
  })
}

function removeRow(index: number): void {
  formRows.value.splice(index, 1)
}

function removeSn(row: SnFormRow, sn: string): void {
  const idx = row.sns.indexOf(sn)
  if (idx >= 0) row.sns.splice(idx, 1)
}

/** SN 行选中商品类型即时校验（批量计商品不能按 SN 入库——D-SN1） */
function onSnRowProductChange(row: SnFormRow): void {
  const productId = row.productId
  if (productId === null) return
  const p = products.value.find((x) => x.id === productId)
  if (p && p.tracking !== 'sn') {
    ElMessage.warning(`商品「${p.name}」不是 SN 商品，无法按 SN 入库`)
    row.productId = null
  }
}

function onSnInputFocus(row: SnFormRow): void {
  activeSnRowRid.value = row.rid
}

/** 本单内（跨所有 SN 行）查重 */
function snExistsInForm(sn: string): boolean {
  return formRows.value.some((r) => r.kind === 'sn' && r.sns.includes(sn))
}

/** D-SN2：按 SN 前缀本地匹配商品（非空前缀 startsWith；唯一命中才返回，0 或多个 → null） */
function matchProductBySnPrefix(sn: string): Product | null {
  const candidates = products.value.filter(
    (p) => p.tracking === 'sn' && p.sn_prefix !== '' && sn.startsWith(p.sn_prefix)
  )
  return candidates.length === 1 ? candidates[0]! : null
}

/**
 * SN 录入唯一汇聚点（手动「添加」/ 扫码桥共用）。
 * 即时查重：本单内同步查 → 台账 findSn 异步查（已在库/已售拒绝录入——D-SN6/17）。
 * 返回是否录入成功（手动路径成功后清空输入，失败保留原文便于修改重试）。
 */
async function addSnToRow(row: SnFormRow, rawSn: string, fromScanner: boolean): Promise<boolean> {
  const sn = rawSn.trim()
  if (sn === '') return false
  if (snExistsInForm(sn)) {
    ElMessage.warning(`本单内已存在该 SN：${sn}`)
    return false
  }
  row.checking = true
  try {
    let found: { sn: ProductSn; product: Product } | null = null
    try {
      found = await window.api.products.findSn(sn)
    } catch (err) {
      ElMessage.error(`SN 查询失败：${errorMessage(err)}`)
      return false
    }
    // await 后二次校验：防手输/扫码并发加入同一 SN 的竞态；行可能已被删除
    if (!formRows.value.includes(row)) return false
    if (snExistsInForm(sn)) {
      ElMessage.warning(`本单内已存在该 SN：${sn}`)
      return false
    }
    if (found !== null) {
      if (found.sn.status === 'in_stock') {
        ElMessage.error(`SN ${sn} 已在库（商品「${found.product.name}」）`)
      } else {
        const saleRef = found.sn.sale_no ?? (found.sn.sale_id !== null ? `#${found.sn.sale_id}` : '')
        ElMessage.error(
          saleRef !== ''
            ? `SN ${sn} 已售出（销售单 ${saleRef}），如需退货请作废原单`
            : `SN ${sn} 已售出，如需退货请作废原单`
        )
      }
      return false
    }
    row.sns.push(sn)
    row.snInput = ''
    if (fromScanner && row.productId === null) {
      // D-SN2：扫码且未选商品 → 前缀唯一命中自动填充
      const matched = matchProductBySnPrefix(sn)
      if (matched !== null) {
        row.productId = matched.id
        ElMessage.success(`已匹配商品：${matched.name}`)
      } else {
        ElMessage.warning('请手动选择商品')
      }
    }
    return true
  } finally {
    row.checking = false
    if (fromScanner) row.snInput = '' // 清掉枪击字符残留（无论成败）
  }
}

/** 手动「添加」按钮（SN 输入框不处理 Enter——见文件头注释的扫码双路径说明） */
function onManualAddSn(row: SnFormRow): void {
  void addSnToRow(row, row.snInput, false)
}

// ── 扫码桥（仅新建弹窗打开期间订阅，关闭即退订——参照 PosView 生命周期模式）──

/** 扫码目标行：最近聚焦的 SN 行；无聚焦记录时若恰只有一个 SN 行则用之 */
function resolveSnTargetRow(): SnFormRow | null {
  const snRows = formRows.value.filter((r): r is SnFormRow => r.kind === 'sn')
  const focused = snRows.find((r) => r.rid === activeSnRowRid.value)
  if (focused !== undefined) return focused
  return snRows.length === 1 ? snRows[0]! : null
}

function handleBarcode(code: string): void {
  if (!createDialogVisible.value) return
  const target = resolveSnTargetRow()
  if (target === null) {
    ElMessage.warning(
      formRows.value.some((r) => r.kind === 'sn')
        ? '多个 SN 行，请先点击要录入的 SN 输入框'
        : '请先添加 SN 商品行再扫码'
    )
    return
  }
  void addSnToRow(target, code, true)
}

let unsubscribeBarcode: (() => void) | undefined

watch(createDialogVisible, (open) => {
  unsubscribeBarcode?.()
  unsubscribeBarcode = undefined
  if (open) unsubscribeBarcode = window.api.onBarcode(handleBarcode)
})

onBeforeUnmount(() => {
  unsubscribeBarcode?.()
})

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
    if (row.kind === 'sn') {
      if (row.sns.length === 0) {
        ElMessage.warning(`${label}：请至少录入一个 SN`)
        return
      }
    } else if (!Number.isInteger(row.quantity) || row.quantity <= 0) {
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
    const items: PurchaseInputItem[] = rows.map((row) =>
      row.kind === 'quantity'
        ? {
            kind: 'quantity',
            product_id: row.productId as number,
            quantity: row.quantity,
            cost_price_cents: Math.round(row.costYuan * 100)
          }
        : {
            kind: 'sn',
            product_id: row.productId as number,
            // 展开为普通数组：row.sns 是 Vue 响应式 Proxy，跨 IPC 结构化克隆
            // 会抛「An object could not be cloned」整单提交失败（E2E 实证）
            sns: [...row.sns],
            cost_price_cents: Math.round(row.costYuan * 100)
          }
    )
    const created = await typedInvoke('purchases:create', {
      note: noteInput.value.trim() === '' ? null : noteInput.value.trim(),
      items
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
      width="880px"
      :close-on-click-modal="false"
    >
      <el-table :data="formRows" class="create-form__table" row-key-class-name="form-row">
        <el-table-column label="商品（可搜名称/条码）" min-width="380">
          <template #default="{ row }">
            <template v-if="row.kind === 'quantity'">
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
            <template v-else>
              <el-select
                v-model="row.productId"
                filterable
                placeholder="选择 SN 商品（扫码可自动匹配）"
                style="width: 100%"
                @change="() => onSnRowProductChange(row)"
              >
                <el-option
                  v-for="opt in productOptions"
                  :key="opt.value"
                  :value="opt.value"
                  :label="opt.label"
                />
              </el-select>
              <!-- SN 子区：输入框不处理 Enter（扫码枪终结键会到达此框，双路径会重复录入） -->
              <div class="sn-sub">
                <div class="sn-sub__entry">
                  <el-input
                    v-model="row.snInput"
                    placeholder="输入 SN 点「添加」，或扫码枪直接扫入"
                    @focus="onSnInputFocus(row)"
                  />
                  <el-button
                    data-testid="sn-add"
                    :disabled="row.checking"
                    @click="onManualAddSn(row)"
                  >
                    添加
                  </el-button>
                </div>
                <div v-if="row.sns.length > 0" class="sn-sub__tags">
                  <el-tag
                    v-for="sn in row.sns"
                    :key="sn"
                    closable
                    size="small"
                    @close="removeSn(row, sn)"
                  >
                    {{ sn }}
                  </el-tag>
                  <span class="sn-sub__count">已录 {{ row.sns.length }} 个</span>
                </div>
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="150">
          <template #default="{ row }">
            <el-input-number
              v-if="row.kind === 'quantity'"
              v-model="row.quantity"
              :min="1"
              :step="1"
              step-strictly
              style="width: 100%"
            />
            <!-- SN 行数量 = SN 个数（禁手填——D-SN9） -->
            <span v-else class="sn-qty">已录 {{ row.sns.length }} 个</span>
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
            <el-button link type="danger" @click="removeRow($index)">
              删除
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="请添加商品行" :image-size="60" />
        </template>
      </el-table>
      <div class="create-form__actions">
        <el-button data-testid="add-sn-row" @click="addSnRow">+ SN 商品</el-button>
        <el-button data-testid="add-quantity-row" @click="addQuantityRow">+ 批量计商品</el-button>
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

.create-form__table :deep(.el-form-item) {
  margin: 0;
}

.create-form__actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}

.create-form__note {
  margin-top: 14px;
}

/* ── SN 行子区（商品列内：录入框 + 标签列表）── */
.sn-sub {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sn-sub__entry {
  display: flex;
  gap: 8px;
}

.sn-sub__entry :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

.sn-sub__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

/* SN 等宽字体（与收银台条码展示一致的应用惯例） */
.sn-sub__tags :deep(.el-tag) {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
}

.sn-sub__count {
  margin-left: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 数量列的 SN 行替代表示（隐含数量） */
.sn-qty {
  font-size: 13px;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.detail__meta {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
