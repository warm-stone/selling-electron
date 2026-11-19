<script setup lang="ts">
import { computed } from 'vue'
import ReceiptPreview from '@renderer/components/receipt/ReceiptPreview.vue'
import type { ReceiptVars } from '../../../../shared/receipt/template-schema'
import type { SaleReceiptData } from '../../../../shared/receipt/item-columns'
import type { ReceiptTemplate } from '../../../../shared/receipt/template-schema'
import { formatMoney, parseMoneyToCents } from '../../../../shared/utils/money'

/**
 * 模板编辑器·底部实时预览面板（TemplateEditorView 拆分批次 4）。
 *
 * 数据流：表单 draft → 视图 previewTemplate（computed，**不保存也即时刷新**）
 * → 本组件 ReceiptPreview（T12 组件同源渲染）。样例数据自包含（虚构店铺 +
 * 三行商品，含超长中文名验证名称列折行；金额经 shared/utils/money 组装——G1）；
 * logo id → dataURL 映射由父视图下发（image 段落按 logoId 选用渲染）。
 */

defineProps<{
  template: ReceiptTemplate
  /** logo id → dataURL 映射（ReceiptPreview 预览渲染用） */
  logoUrls: Record<number, string>
}>()

// ── 实时预览样例数据（虚构店铺 + 三行商品，含超长中文名验证名称列折行）──
const SAMPLE_ITEMS: SaleReceiptData = {
  items: [
    { name: '经典奶茶（大杯）', quantity: '2', unitPrice: '15.00', subtotal: '30.00' },
    { name: '现烤菠萝包', quantity: '1', unitPrice: '6.50', subtotal: '6.50' },
    { name: '招牌秘制香辣鸡腿堡超级套餐（含饮品小食各一份）', quantity: '1', unitPrice: '39.90', subtotal: '39.90' }
  ]
}

const sampleVars = computed<ReceiptVars>(() => {
  const cents = SAMPLE_ITEMS.items.reduce((s, it) => s + parseMoneyToCents(it.subtotal), 0)
  const count = SAMPLE_ITEMS.items.reduce((s, it) => s + Number(it.quantity), 0)
  return {
    shopName: '测试商店',
    shopPhone: '138-0000-0000',
    receiptNote: '欢迎再次光临',
    saleNo: '20261101-0001',
    datetime: '2026-11-01 12:30:00',
    total: formatMoney(cents),
    itemCount: String(count)
  }
})
</script>

<template>
  <section class="tpl-preview">
    <div class="tpl-preview__head">
      <span class="tpl-preview__title">实时预览</span>
      <span class="tpl-preview__hint">编辑即时刷新，无需保存 · 样例数据（{{ sampleVars.shopName }}）</span>
    </div>
    <div class="tpl-preview__stage">
      <ReceiptPreview
        :template="template"
        :data="SAMPLE_ITEMS"
        :vars="sampleVars"
        :logo-urls="logoUrls"
      />
    </div>
  </section>
</template>

<style scoped>
/* ── 实时预览（底部常驻，T12 ReceiptPreview 同源渲染） ── */
.tpl-preview {
  flex: 0 0 auto;
  padding: 10px 20px 14px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-darker);
}

.tpl-preview__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
}

.tpl-preview__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.tpl-preview__hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tpl-preview__stage {
  display: flex;
  justify-content: center;
  max-height: 400px;
  overflow: auto;
  padding: 12px 0;
}
</style>
