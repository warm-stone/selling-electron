<script setup lang="ts">
import SaleExtrasForm from './SaleExtrasForm.vue'
import type { SaleDetail } from '../../../../shared/types/domain'

/**
 * 销售明细弹窗（SalesHistoryView 拆分的受控展示组件）：作废警示 + 单据头 +
 * 明细表（快照列——G4：商品改名/删除不影响历史明细）+ 附加信息展示区
 * （T12：customer 为引用最新——改档案后重开立即反映，与商品快照列刻意对照；
 * 国补 tag 渲染照 ReportsView 惯例：true 才有 el-tag，false 纯文本「否」——
 * 保 .el-tag 计数）。
 *
 * 明细数据由父视图拉取传入（打开失败不弹窗的原时序不变）；保存附加信息
 * 成功后经 updated 事件由父链回写 detail——本组件与编辑区随之刷新。
 * 编辑区（仅 completed 单渲染——Q4）为自治子组件 SaleExtrasForm。
 */

defineProps<{
  visible: boolean
  detail: SaleDetail | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  updated: [detail: SaleDetail]
}>()

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="detail ? `销售明细 · ${detail.sale_no}` : '销售明细'"
    width="680px"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
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
      <el-table
        :data="detail.items"
        size="small"
      >
        <el-table-column
          prop="product_name"
          label="商品名（快照）"
          min-width="170"
        />
        <el-table-column
          label="条码（快照）"
          min-width="135"
        >
          <template #default="{ row }">
            {{ row.barcode ?? '—' }}
          </template>
        </el-table-column>
        <el-table-column
          label="SN"
          min-width="150"
          show-overflow-tooltip
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
          label="单价（元）"
          width="100"
          align="right"
        >
          <template #default="{ row }">
            {{ centsToYuan(row.unit_price_cents) }}
          </template>
        </el-table-column>
        <el-table-column
          label="小计（元）"
          width="100"
          align="right"
        >
          <template #default="{ row }">
            {{ centsToYuan(row.subtotal_cents) }}
          </template>
        </el-table-column>
      </el-table>

      <!-- ── 附加信息展示区（T12：customer 为引用最新——改档案后重开立即反映）── -->
      <div
        class="sales-history__extras"
        data-testid="detail-extras"
      >
        <div class="extras-panel">
          <div class="extras-panel__col">
            <h4 class="extras-panel__title">
              客户信息
            </h4>
            <template v-if="detail.extras?.customer">
              <div class="extras-panel__row">
                <span class="extras-panel__label">姓名</span>
                <span
                  class="extras-panel__value"
                  data-testid="detail-customer-name"
                >{{
                  detail.extras.customer.name || '—'
                }}</span>
              </div>
              <div class="extras-panel__row">
                <span class="extras-panel__label">电话</span>
                <span
                  class="extras-panel__value"
                  data-testid="detail-customer-phone"
                >{{
                  detail.extras.customer.phone || '—'
                }}</span>
              </div>
              <div class="extras-panel__row">
                <span class="extras-panel__label">地址</span>
                <span
                  class="extras-panel__value"
                  data-testid="detail-customer-address"
                >{{
                  detail.extras.customer.address || '—'
                }}</span>
              </div>
              <div class="extras-panel__row">
                <span class="extras-panel__label">客户备注</span>
                <span
                  class="extras-panel__value"
                  data-testid="detail-customer-note"
                >{{
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
            <h4 class="extras-panel__title">
              订单附加
            </h4>
            <div class="extras-panel__row">
              <span class="extras-panel__label">是否国补</span>
              <!-- true 才渲染 el-tag（ReportsView 惯例）：false 纯文本「否」——保 .el-tag 计数 -->
              <span
                class="extras-panel__value"
                data-testid="detail-subsidy"
              >
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
              <span
                class="extras-panel__value"
                data-testid="detail-order-note"
              >{{
                detail.extras?.order_note || '—'
              }}</span>
            </div>
            <div class="extras-panel__row">
              <span class="extras-panel__label">销售人员</span>
              <span
                class="extras-panel__value"
                data-testid="detail-salesperson"
              >{{
                detail.extras?.salesperson || '—'
              }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ── 附加信息编辑区（仅 completed 单可见——Q4；保存链路在子组件闭环）── -->
      <SaleExtrasForm
        v-if="detail.status === 'completed'"
        :detail="detail"
        @saved="(updated: SaleDetail) => emit('updated', updated)"
      />
    </template>
  </el-dialog>
</template>

<style scoped>
.sales-history__voided-alert {
  margin-bottom: 12px;
}

.sales-history__detail-meta {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.sales-history__amount {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ── 附加信息展示区（浅底双栏面板，延续 ProductsView 台账面板气质）── */
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
</style>
