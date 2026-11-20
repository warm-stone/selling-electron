<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ProductChangeEntry, ProductChangeLog, ProductRow } from '../../../../shared/types'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'

/**
 * 商品改动记录弹窗（ProductsView「记录」按钮打开；自治组件——ProductFormDialog
 * 先例模式）：打开即取最近 N 条（listChangeLogs，limit 默认 100，不翻页——定案），
 * 展示 时间 / 动作 / 逐字段旧→新 / 原因。软删商品的记录仍可查（审计链完整）。
 *
 * 金额铁律 G1：changes 内 default_price_cents 为整数分，元浮点仅在本组件
 * 显示边界格式化。
 */

const props = defineProps<{
  visible: boolean
  /** 目标商品（visible=true 时必传；标题与取数用） */
  row: ProductRow | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const LIMIT = 100

const logs = ref<ProductChangeLog[]>([])
const loading = ref(false)

watch(
  () => props.visible,
  (visible) => {
    if (!visible || props.row === null) return
    void load(props.row.id)
  }
)

async function load(productId: number): Promise<void> {
  loading.value = true
  try {
    logs.value = await window.api.products.listChangeLogs(productId, LIMIT)
  } catch (err) {
    logs.value = []
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    loading.value = false
  }
}

// ── 显示映射 ──

const ACTION_LABELS: Record<ProductChangeLog['action'], string> = {
  update: '编辑',
  stock: '库存调整',
  delete: '删除商品',
  sn_delete: '删除 SN'
}

const ACTION_TAG_TYPES: Record<ProductChangeLog['action'], 'primary' | 'warning' | 'danger' | 'info'> = {
  update: 'primary',
  stock: 'warning',
  delete: 'danger',
  sn_delete: 'danger'
}

const FIELD_LABELS: Record<ProductChangeEntry['field'], string> = {
  name: '名称',
  default_price_cents: '默认售价',
  sn_prefix: 'SN 前缀',
  stock: '库存',
  sn: 'SN'
}

/** 单值显示：分为元（仅售价字段）、null/空串占位 */
function formatValue(field: ProductChangeEntry['field'], value: string | number | null): string {
  if (value === null) return '—'
  if (field === 'default_price_cents') {
    return typeof value === 'number' ? `¥${(value / 100).toFixed(2)}` : String(value)
  }
  if (field === 'sn_prefix' && value === '') return '（空）'
  return String(value)
}

/** 单字段明细文案：「名称：可乐 → 雪碧」 */
function formatEntry(entry: ProductChangeEntry): string {
  return `${FIELD_LABELS[entry.field] ?? entry.field}：${formatValue(entry.field, entry.old)} → ${formatValue(entry.field, entry.new)}`
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="row ? `改动记录 · ${row.name}` : '改动记录'"
    width="640px"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:visible', v)"
  >
    <p class="log-dialog__hint">
      仅显示最近 {{ LIMIT }} 条记录（最新在前）；所有改动均含必填原因与时间。
    </p>
    <el-table
      v-loading="loading"
      :data="logs"
      size="small"
      max-height="420"
      data-testid="change-log-table"
    >
      <el-table-column
        prop="created_at"
        label="时间"
        width="160"
      />
      <el-table-column
        label="动作"
        width="96"
        align="center"
      >
        <template #default="{ row: log }">
          <el-tag
            :type="ACTION_TAG_TYPES[log.action as ProductChangeLog['action']]"
            effect="plain"
            size="small"
            disable-transitions
          >
            {{ ACTION_LABELS[log.action as ProductChangeLog['action']] ?? log.action }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column
        label="改动内容"
        min-width="220"
      >
        <template #default="{ row: log }">
          <div
            v-if="(log.changes as ProductChangeEntry[]).length === 0"
            class="log-dialog__empty-changes"
          >
            —
          </div>
          <div
            v-for="(entry, index) in log.changes as ProductChangeEntry[]"
            :key="index"
            class="log-dialog__entry"
          >
            {{ formatEntry(entry) }}
          </div>
        </template>
      </el-table-column>
      <el-table-column
        prop="reason"
        label="原因"
        min-width="150"
        show-overflow-tooltip
      />
      <template #empty>
        <el-empty
          description="暂无改动记录"
          :image-size="80"
        />
      </template>
    </el-table>
  </el-dialog>
</template>

<style scoped>
.log-dialog__hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.log-dialog__entry {
  line-height: 1.6;
  font-size: 12.5px;
}

.log-dialog__empty-changes {
  color: var(--el-text-color-placeholder);
}
</style>
