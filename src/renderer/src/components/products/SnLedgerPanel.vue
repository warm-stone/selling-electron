<script setup lang="ts">
import { Delete } from '@element-plus/icons-vue'
import type { ProductRow, ProductSn } from '../../../../shared/types'

/**
 * 商品列表展开行的 SN 台账面板（D-SN16：默认在库、可切含已售；在库 SN 可删=
 * 逻辑删除 + manual 流水；不提供手动添加，一律进货录入——D-SN17 已售行走作废）。
 *
 * ProductsView 拆分的**受控展示组件**：台账数据/筛选态缓存留在父视图
 * （按商品 id 缓存于 snLedgers，toggle 状态跨列表刷新保留——原设计不变），
 * 本组件只渲染 + 上抛事件（筛选切换 / 删在库 SN 的确认与 IPC 也在父视图）。
 */

defineProps<{
  row: ProductRow
  sns: ProductSn[]
  loading: boolean
  /** false=仅在库（默认），true=含已售 */
  includeSold: boolean
}>()

const emit = defineEmits<{
  'filter-change': [value: boolean]
  'delete-sn': [sn: ProductSn]
}>()
</script>

<template>
  <!-- 防御兜底：批量计行箭头已隐藏（row-expandable disabled），正常不可达 -->
  <div v-if="row.tracking !== 'sn'" class="ledger-empty-hint">
    批量计商品无 SN 台账
  </div>
  <div v-else class="ledger-panel">
    <div class="ledger-panel__header">
      <div class="ledger-panel__title">
        <span class="ledger-panel__name">SN 台账</span>
        <span class="ledger-panel__count">共 {{ sns.length }} 条</span>
      </div>
      <el-radio-group
        :model-value="includeSold"
        size="small"
        data-testid="sn-ledger-filter"
        @change="(val: string | number | boolean | undefined) => emit('filter-change', val === true)"
      >
        <el-radio-button :value="false">仅在库</el-radio-button>
        <el-radio-button :value="true">含已售</el-radio-button>
      </el-radio-group>
    </div>
    <el-table
      v-loading="loading"
      :data="sns"
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
            @click="emit('delete-sn', sn)"
          >
            删除
          </el-button>
          <span v-else class="cell-dash">—</span>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          :description="includeSold ? '暂无 SN 记录' : '暂无在库 SN'"
          :image-size="60"
        />
      </template>
    </el-table>
    <div class="ledger-panel__hint">
      SN 一律从进货录入；删除在库 SN 将同步扣减库存并记录流水
    </div>
  </div>
</template>

<style scoped>
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
</style>
