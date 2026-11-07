<script setup lang="ts">
import { computed } from 'vue'
import {
  PAPER_COLUMNS,
  padLine,
  wrapToGrid,
  type LineAlign,
  type PaperWidth
} from '../../../../shared/receipt/char-grid'
import {
  buildSnLines,
  resolveColumnWidths,
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
 * 字节流解码文本按同一数学产出：text/total 行 = interpolate → wrapToGrid
 * 多行 → 逐行 padLine（char-grid 冻结顺序，超长文案换行不再截断），
 * items 行 = buildItemLines 的多行形态（恒等降级；名称列 wrapToGrid 折
 * N 行、数量/单价/小计只在首行、续行右侧三列空白——GBK 外字符在预览
 * 原样渲染、打印侧降级 '?'，GBK 内业务文本两侧行集完全一致，差异见
 * 模块 learnings）。
 *
 * 只渲染、不做打印动作（打印按钮由外层 T15 编排）。
 */
const props = defineProps<{
  template: ReceiptTemplate
  data: SaleReceiptData
  vars: ReceiptVars
  /**
   * logo id → dataURL 映射（image 段落按 logoId 取图；未指定 logoId 或
   * 无对应图时静默跳过——同 ESC/POS 行为。Buffer 不跨 IPC，值为 dataURL）
   */
  logoUrls?: Record<number, string>
}>()

/** 纸张物理宽度（px，96dpi 圆整）：80mm≈307px、58mm≈221px（E2E 容器宽度断言锚点） */
const PAPER_WIDTH_PX: Record<PaperWidth, number> = { '58mm': 221, '80mm': 307 }

/** .mono-cjk 12px 字号下半角字符宽（全角 12px/半角 6px）——网格列宽像素换算基准 */
const HALF_CHAR_PX = 6

const cols = computed(() => PAPER_COLUMNS[props.template.paperWidth])
const paperWidthPx = computed(() => PAPER_WIDTH_PX[props.template.paperWidth])
const logoMaxWidth = computed(() => `${cols.value * HALF_CHAR_PX}px`)

/**
 * items 四列宽：resolveColumnWidths（模板 columnWidths 覆盖合法则采用、
 * 否则回落纸宽默认）——G7：与打印侧 buildItemLines 同一列宽基准。
 */
const itemWidths = computed(() =>
  resolveColumnWidths(props.template.paperWidth, props.template.items.columnWidths)
)

/** items 四列宽（%）——itemWidths 换算（G7：与生成器同基准） */
const itemCols = computed(() => {
  const w = itemWidths.value
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

/**
 * 明细行多行化：与打印侧 buildItemLines 逐格等价（组合顺序恒等降级 →
 * wrap → padLine——打印侧 degrade 后 wrap、预览侧原文 wrap，GBK 内文本
 * 两侧行集一致）。名称列 wrapToGrid(item.name, w.name) 折 N 行：首行四格
 * [nameLine0, pad(qty,right), pad(price,right), pad(subtotal,right)]，
 * 续行 [pad(nameLineI), 空串 pad ×3]（右侧三列空白）；每格仍 padLine
 * 到列宽，拼接后每行宽恰为 PAPER_COLUMNS。
 */
function itemRows(item: ReceiptItemLine): ItemCell[][] {
  const w = itemWidths.value
  return wrapToGrid(item.name, w.name).map((nameLine, idx): ItemCell[] => {
    if (idx === 0) {
      return [
        { key: 'name', text: padLine(nameLine, w.name), cssAlign: 'left' },
        { key: 'qty', text: padLine(item.quantity, w.qty, 'right'), cssAlign: 'right' },
        { key: 'price', text: padLine(item.unitPrice, w.price, 'right'), cssAlign: 'right' },
        { key: 'subtotal', text: padLine(item.subtotal, w.subtotal, 'right'), cssAlign: 'right' }
      ]
    }
    return [
      { key: 'name', text: padLine(nameLine, w.name), cssAlign: 'left' },
      { key: 'qty', text: padLine('', w.qty, 'right'), cssAlign: 'right' },
      { key: 'price', text: padLine('', w.price, 'right'), cssAlign: 'right' },
      { key: 'subtotal', text: padLine('', w.subtotal, 'right'), cssAlign: 'right' }
    ]
  })
}

const showItemHeader = computed(() => props.template.items.showHeader ?? true)

/**
 * SN 副行（D-SN12/T3.1）：数据驱动——item.sn 非空才有行（G7 与打印侧
 * buildSnLines 同一组合数学，恒等降级——与 items 行同策略，GBK 内 SN
 * 两侧行集完全一致）；colspan 全宽行，pad 已含缩进空格
 */
function snLines(item: ReceiptItemLine): string[] {
  return buildSnLines(item.sn, props.template.paperWidth)
}

/** 列头行同样多行化（label 超长也换行）——复用明细行的同源组合数学 */
const headerRows = computed<ItemCell[][]>(() => {
  const s = props.template.items
  return itemRows({
    name: s.nameLabel ?? '商品',
    quantity: s.qtyLabel ?? '数量',
    unitPrice: s.priceLabel ?? '单价',
    subtotal: s.subtotalLabel ?? '小计'
  })
})

/**
 * text/total 行文本（多行）：interpolate → wrap → pad（char-grid 冻结
 * 顺序，与打印侧同序——超长文案换行多行渲染，不再截断）
 */
function lineTexts(raw: string, align: LineAlign): string[] {
  return wrapToGrid(raw, cols.value).map((line) => padLine(line, cols.value, align))
}

function sectionTexts(section: Section): string[] {
  return lineTexts(interpolateVariables(section.content ?? '', props.vars), section.align ?? 'left')
}

function totalTexts(line: TotalLine): string[] {
  return lineTexts(interpolateVariables(line.label, props.vars), line.align ?? 'left')
}

/**
 * image 段落命中的 logo dataURL（logoId 未指定或无对应图 → undefined；
 * 预览静默跳过，同打印侧语义）
 */
function logoSrcOf(s: Section): string | undefined {
  if (s.type !== 'image' || s.logoId === undefined) return undefined
  return props.logoUrls?.[s.logoId]
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
      <template v-if="s.type === 'text'">
        <div
          v-for="(line, j) in sectionTexts(s)"
          :key="`h-${i}-${j}`"
          class="receipt-line"
          :class="lineClasses(s)"
          :style="lineStyle(s)"
        >{{ line }}</div>
      </template>
      <img
        v-else-if="s.type === 'image' && logoSrcOf(s)"
        class="receipt-logo"
        :src="logoSrcOf(s)"
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
        <template v-if="showItemHeader">
          <tr v-for="(cells, j) in headerRows" :key="`hd-${j}`" class="receipt-line">
            <td v-for="c in cells" :key="c.key" :style="{ textAlign: c.cssAlign }">{{ c.text }}</td>
          </tr>
        </template>
        <template v-for="(item, i) in data.items" :key="`it-${i}`">
          <tr v-for="(cells, j) in itemRows(item)" :key="`it-${i}-${j}`" class="receipt-line">
            <td v-for="c in cells" :key="c.key" :style="{ textAlign: c.cssAlign }">{{ c.text }}</td>
          </tr>
          <tr
            v-for="(line, j) in snLines(item)"
            :key="`sn-${i}-${j}`"
            class="receipt-line receipt-line--sn"
            data-testid="receipt-item-sn"
          >
            <td colspan="4" style="text-align: left">{{ line }}</td>
          </tr>
        </template>
      </tbody>
    </table>

    <template v-for="(t, i) in template.totals" :key="`t-${i}`">
      <div
        v-for="(line, j) in totalTexts(t)"
        :key="`t-${i}-${j}`"
        class="receipt-line"
        :class="lineClasses(t)"
        :style="lineStyle(t)"
      >{{ line }}</div>
    </template>

    <template v-for="(s, i) in template.footer" :key="`f-${i}`">
      <template v-if="s.type === 'text'">
        <div
          v-for="(line, j) in sectionTexts(s)"
          :key="`f-${i}-${j}`"
          class="receipt-line"
          :class="lineClasses(s)"
          :style="lineStyle(s)"
        >{{ line }}</div>
      </template>
      <img
        v-else-if="s.type === 'image' && logoSrcOf(s)"
        class="receipt-logo"
        :src="logoSrcOf(s)"
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
