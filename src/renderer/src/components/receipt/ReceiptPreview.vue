<script setup lang="ts">
import { computed } from 'vue'
import {
  PAPER_COLUMNS,
  padLine,
  truncateToGrid,
  type LineAlign,
  type PaperWidth
} from '../../../../shared/receipt/char-grid'
import {
  ITEM_COLUMN_WIDTHS,
  type ReceiptItemLine,
  type SaleReceiptData
} from '../../../../shared/receipt/item-columns'
import {
  interpolateVariables,
  type ReceiptTemplate,
  type ReceiptVars,
  type Section,
  type SectionSize,
  type TotalLine
} from '../../../../shared/receipt/template-schema'

/**
 * HTML 小票预览（G7 同源渲染，Task 12）。
 *
 * 与 ESC/POS 生成器（src/main/printing/escpos/）共消费 shared char-grid/
 * item-columns——预览的每一行文本（.receipt-line 的 textContent）与打印侧
 * 字节流解码文本按同一数学产出：text/total 行 = padLine(truncateToGrid(...))，
 * items 行 = buildItemLine（恒等降级；GBK 外字符在预览原样渲染、打印侧降级
 * '?'——GBK 内业务文本两侧行集完全一致，差异见模块 learnings）。
 *
 * 只渲染、不做打印动作（打印按钮由外层 T15 编排）。
 */
const props = defineProps<{
  template: ReceiptTemplate
  data: SaleReceiptData
  vars: ReceiptVars
  /** Logo dataURL（image 段落；未传则静默跳过——同 ESC/POS 行为。Buffer 不跨 IPC） */
  logoUrl?: string
}>()

/** 纸张物理宽度（px，96dpi 圆整）：80mm≈307px、58mm≈221px（E2E 容器宽度断言锚点） */
const PAPER_WIDTH_PX: Record<PaperWidth, number> = { '58mm': 221, '80mm': 307 }

/** .mono-cjk 12px 字号下半角字符宽（全角 12px/半角 6px）——网格列宽像素换算基准 */
const HALF_CHAR_PX = 6

const cols = computed(() => PAPER_COLUMNS[props.template.paperWidth])
const paperWidthPx = computed(() => PAPER_WIDTH_PX[props.template.paperWidth])
const logoMaxWidth = computed(() => `${cols.value * HALF_CHAR_PX}px`)

/** items 四列宽（%）——shared ITEM_COLUMN_WIDTHS 换算（G7：与生成器同基准） */
const itemCols = computed(() => {
  const w = ITEM_COLUMN_WIDTHS[props.template.paperWidth]
  const total = cols.value
  const pct = (n: number): string => `${Number(((n / total) * 100).toFixed(2))}%`
  return [
    { key: 'name', pct: pct(w.name) },
    { key: 'qty', pct: pct(w.qty) },
    { key: 'price', pct: pct(w.price) },
    { key: 'subtotal', pct: pct(w.subtotal) }
  ]
})

interface ItemCell {
  key: string
  text: string
  cssAlign: LineAlign
}

/** 明细行四格文本：与 buildItemLine 恒等降级路径逐格同源（拼接即整行） */
function cellsOf(item: ReceiptItemLine): ItemCell[] {
  const w = ITEM_COLUMN_WIDTHS[props.template.paperWidth]
  return [
    { key: 'name', text: padLine(truncateToGrid(item.name, w.name), w.name), cssAlign: 'left' },
    { key: 'qty', text: padLine(truncateToGrid(item.quantity, w.qty), w.qty, 'right'), cssAlign: 'right' },
    { key: 'price', text: padLine(truncateToGrid(item.unitPrice, w.price), w.price, 'right'), cssAlign: 'right' },
    { key: 'subtotal', text: padLine(truncateToGrid(item.subtotal, w.subtotal), w.subtotal, 'right'), cssAlign: 'right' }
  ]
}

const showItemHeader = computed(() => props.template.items.showHeader ?? true)

const headerCells = computed<ItemCell[]>(() => {
  const s = props.template.items
  return cellsOf({
    name: s.nameLabel ?? '商品',
    quantity: s.qtyLabel ?? '数量',
    unitPrice: s.priceLabel ?? '单价',
    subtotal: s.subtotalLabel ?? '小计'
  })
})

/** text/total 行文本：interpolate → truncate → pad（char-grid 冻结顺序） */
function lineText(raw: string, align: LineAlign): string {
  return padLine(truncateToGrid(raw, cols.value), cols.value, align)
}

function sectionText(section: Section): string {
  return lineText(interpolateVariables(section.content ?? '', props.vars), section.align ?? 'left')
}

function totalText(line: TotalLine): string {
  return lineText(interpolateVariables(line.label, props.vars), line.align ?? 'left')
}

function lineClasses(line: { bold?: boolean; size?: SectionSize }): Record<string, boolean> {
  return {
    'receipt-line--bold': line.bold ?? false,
    'receipt-line--double-height': line.size === 'doubleHeight',
    'receipt-line--double-width': line.size === 'doubleWidth',
    'receipt-line--quad': line.size === 'quad'
  }
}

/**
 * align → text-align（pad 已做字符级对齐，text-align 为 CSS 层同语义映射）；
 * 放大尺寸的 transform-origin 按对齐方向锚定（left 向右扩 / right 向左扩）。
 * 倍高/quad 的 scaleY 视觉翻倍但不占布局——margin-bottom 补偿防行叠压。
 */
function lineStyle(line: { align?: LineAlign; size?: SectionSize }): Record<string, string> {
  const align = line.align ?? 'left'
  const style: Record<string, string> = { textAlign: align }
  if (line.size === 'doubleHeight' || line.size === 'quad') {
    style.transformOrigin = `${align} top`
    style.marginBottom = '1.35em'
  } else if (line.size === 'doubleWidth') {
    style.transformOrigin = `${align} center`
  }
  return style
}
</script>

<template>
  <div
    class="receipt-paper mono-cjk"
    :class="`receipt-paper--${template.paperWidth}`"
    :style="{ width: `${paperWidthPx}px` }"
    data-testid="receipt-paper"
  >
    <template v-for="(s, i) in template.header" :key="`h-${i}`">
      <div v-if="s.type === 'text'" class="receipt-line" :class="lineClasses(s)" :style="lineStyle(s)">{{
        sectionText(s)
      }}</div>
      <img
        v-else-if="s.type === 'image' && logoUrl"
        class="receipt-logo"
        :src="logoUrl"
        :style="{ maxWidth: logoMaxWidth }"
        alt="店铺 Logo"
      />
      <div v-else-if="s.type === 'divider'" class="receipt-divider" />
    </template>

    <table v-if="showItemHeader || data.items.length > 0" class="receipt-items">
      <colgroup>
        <col v-for="c in itemCols" :key="c.key" :style="{ width: c.pct }" />
      </colgroup>
      <tbody>
        <tr v-if="showItemHeader" class="receipt-line">
          <td v-for="c in headerCells" :key="c.key" :style="{ textAlign: c.cssAlign }">{{ c.text }}</td>
        </tr>
        <tr v-for="(item, i) in data.items" :key="i" class="receipt-line">
          <td v-for="c in cellsOf(item)" :key="c.key" :style="{ textAlign: c.cssAlign }">{{ c.text }}</td>
        </tr>
      </tbody>
    </table>

    <div
      v-for="(t, i) in template.totals"
      :key="`t-${i}`"
      class="receipt-line"
      :class="lineClasses(t)"
      :style="lineStyle(t)"
    >{{ totalText(t) }}</div>

    <template v-for="(s, i) in template.footer" :key="`f-${i}`">
      <div v-if="s.type === 'text'" class="receipt-line" :class="lineClasses(s)" :style="lineStyle(s)">{{
        sectionText(s)
      }}</div>
      <img
        v-else-if="s.type === 'image' && logoUrl"
        class="receipt-logo"
        :src="logoUrl"
        :style="{ maxWidth: logoMaxWidth }"
        alt="店铺 Logo"
      />
      <div v-else-if="s.type === 'divider'" class="receipt-divider" />
    </template>

    <div v-if="template.cutPaper" class="receipt-cut" aria-hidden="true" />
  </div>
</template>

<style scoped>
/* ── 纸张：物理纸宽定容器（307/221px），墨迹网格区 48/32 列 × 6px ── */
.receipt-paper {
  box-sizing: border-box;
  padding: 12px 9px;
  background: #ffffff;
  color: #14161a;
  font-size: 12px;
  line-height: 1.35;
  /* 纸宽是物理边界：倍宽行溢出在此截断（模拟真机可打印区） */
  overflow: hidden;
}

/* ── 文本行：white-space: pre 让 char-grid 的 pad 空格原样渲染（同源视觉） ── */
.receipt-line {
  white-space: pre;
  font-weight: 400;
}

.receipt-items {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.receipt-items td {
  white-space: pre;
  padding: 0;
  font-weight: inherit;
  overflow: hidden;
}

.receipt-items tr.receipt-line--bold {
  font-weight: 700;
}

/* ── 段落属性映射 ── */
.receipt-line--bold {
  font-weight: 700;
}

.receipt-line--double-height {
  display: inline-block;
  transform: scaleY(2);
}

.receipt-line--double-width {
  display: inline-block;
  transform: scaleX(2);
}

.receipt-line--quad {
  display: inline-block;
  transform: scale(2);
}

/* ── divider：分隔线（视觉虚线，对应打印侧 '-' × cols）── */
.receipt-divider {
  margin: 6px 0;
  border-top: 1px dashed #5a5f66;
}

/* ── image ── */
.receipt-logo {
  display: block;
  margin: 2px auto;
}

/* ── cutPaper：底部剪切示意（HTML 不切纸）── */
.receipt-cut {
  margin: 10px 0 2px;
  border-top: 1px dashed #9aa0a8;
  position: relative;
}

.receipt-cut::after {
  content: '✂';
  position: absolute;
  right: 0;
  top: -9px;
  font-size: 12px;
  color: #9aa0a8;
  background: #ffffff;
  padding: 0 2px;
}
</style>
