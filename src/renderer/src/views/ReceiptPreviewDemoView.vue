<script setup lang="ts">
import { computed, ref } from 'vue'
import ReceiptPreview from '@renderer/components/receipt/ReceiptPreview.vue'
import type { PaperWidth } from '../../../shared/receipt/char-grid'
import { DEFAULT_TEMPLATES } from '../../../shared/receipt/default-template'
import type { SaleReceiptData } from '../../../shared/receipt/item-columns'
import type { ReceiptTemplate, ReceiptVars } from '../../../shared/receipt/template-schema'
import { formatMoney, parseMoneyToCents } from '../../../shared/utils/money'

/**
 * 小票预览 demo 页（#/receipt-preview-demo）。
 *
 * 开发调试与 E2E 专用（不进侧边菜单）：纸宽/样例数据/Logo 段落切换，
 * 驱动 ReceiptPreview 的同源渲染路径。vars 金额经 shared/utils/money
 * 组装（display-ready 约定，G1）。
 */
type SampleKey = 'normal' | 'longName' | 'empty'

const SAMPLES: Record<SampleKey, SaleReceiptData> = {
  normal: {
    items: [
      { name: '可口可乐330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' },
      { name: '蓝月亮洗衣液', quantity: '1', unitPrice: '45.00', subtotal: '45.00' }
    ]
  },
  longName: {
    items: [
      {
        name: '超长商品名称测试一二三四五六七八九十甲乙丙丁戊己庚辛壬癸',
        quantity: '1',
        unitPrice: '1.00',
        subtotal: '1.00'
      },
      { name: '短名', quantity: '3', unitPrice: '2.50', subtotal: '7.50' }
    ]
  },
  empty: { items: [] }
}

/** 1×1 PNG dataURL（Logo 段落渲染示意；生产路径经设置页上传，T19） */
const LOGO_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const paperWidth = ref<PaperWidth>('80mm')
const sampleKey = ref<SampleKey>('normal')
const withLogo = ref(false)

const data = computed<SaleReceiptData>(() => SAMPLES[sampleKey.value])

const template = computed<ReceiptTemplate>(() => {
  const base = DEFAULT_TEMPLATES[paperWidth.value]
  const t = JSON.parse(JSON.stringify(base)) as ReceiptTemplate
  if (withLogo.value) t.header.unshift({ type: 'image' })
  return t
})

const vars = computed<ReceiptVars>(() => {
  const items = data.value.items
  const totalCents = items.reduce((sum, it) => sum + parseMoneyToCents(it.subtotal), 0)
  const itemCount = items.reduce((sum, it) => sum + Number(it.quantity), 0)
  return {
    shopName: '中文测试收银',
    shopPhone: '13800001111',
    receiptNote: '谢谢惠顾',
    saleNo: '20261101-0001',
    datetime: '2026-11-01 21:00:00',
    total: formatMoney(totalCents),
    itemCount: String(itemCount)
  }
})
</script>

<template>
  <div class="demo-page">
    <aside class="demo-panel">
      <h2 class="demo-panel__title">小票预览 Demo</h2>
      <p class="demo-panel__hint">同源渲染（G7）：文本行 = char-grid padLine / items 行 = buildItemLine，与 ESC/POS 字节流同一数学。</p>

      <el-form label-position="top">
        <el-form-item label="纸宽（网格列数）">
          <el-radio-group v-model="paperWidth" data-testid="demo-paper">
            <el-radio value="80mm" data-testid="demo-paper-80">80mm（48 列）</el-radio>
            <el-radio value="58mm" data-testid="demo-paper-58">58mm（32 列）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="样例数据">
          <el-radio-group v-model="sampleKey" data-testid="demo-sample">
            <el-radio value="normal" data-testid="demo-sample-normal">常规</el-radio>
            <el-radio value="longName" data-testid="demo-sample-long">超长商品名</el-radio>
            <el-radio value="empty" data-testid="demo-sample-empty">空明细</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="Logo 段落（image）">
          <el-switch v-model="withLogo" data-testid="demo-logo" />
        </el-form-item>
      </el-form>

      <dl class="demo-panel__vars">
        <dt>vars.total</dt>
        <dd>{{ vars.total }}</dd>
        <dt>vars.itemCount</dt>
        <dd>{{ vars.itemCount }}</dd>
      </dl>
    </aside>

    <section class="demo-stage">
      <div class="demo-stage__inner">
        <ReceiptPreview
          :template="template"
          :data="data"
          :vars="vars"
          :logo-url="withLogo ? LOGO_DATA_URL : undefined"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.demo-page {
  display: flex;
  height: 100%;
  min-height: 480px;
}

.demo-panel {
  flex: 0 0 280px;
  box-sizing: border-box;
  padding: 20px;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}

.demo-panel__title {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 600;
}

.demo-panel__hint {
  margin: 0 0 16px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.demo-panel__vars {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 12px 0 0;
  font-size: 12px;
}

.demo-panel__vars dt {
  color: var(--el-text-color-secondary);
}

.demo-panel__vars dd {
  margin: 0;
  font-family: "NSimSun", "SimSun", monospace;
}

.demo-stage {
  flex: 1;
  overflow: auto;
  background: var(--el-fill-color-darker);
}

.demo-stage__inner {
  display: flex;
  justify-content: center;
  padding: 28px 16px;
}
</style>
