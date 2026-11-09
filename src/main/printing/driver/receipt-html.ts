/**
 * 收据 HTML 生成器（driver 通道载荷，纯函数零 I/O——G6）。
 *
 * 为什么存在 driver 通道（真机结论）：得力 DL-5801PW 等「云打印」热敏机的
 * RAW 通道把任意原始字节当 UTF-8 文本渲染——GBK 中文双字节流是非法 UTF-8
 * 被静默丢弃，ESC/POS 光栅指令（GS v 0）更不被云固件支持；但同一台机器走
 * Windows 打印机驱动（GDI 渲染，即 Word 打印的同一条路径）中文与图片都
 * 完美。因此 driver 通道不再发原始字节，而是把模板渲染成完整 HTML 文档，
 * 交给隐藏 BrowserWindow 的 webContents.print（silent + deviceName）由
 * 驱动完成光栅化——对「云固件吃字节」的机型是 100% 兼容兜底。
 *
 * G7 同源第三渲染器：与 ESC/POS 生成器（escpos-generator.ts）、HTML 预览
 * （ReceiptPreview.vue）消费同一 shared/receipt 网格数学——文本行
 * interpolate → wrapToGrid → padLine（char-grid 冻结顺序），items 行
 * wrapToGrid/padLine 逐格组合（与 buildItemLines 同一数学，恒等降级），
 * SN 副行 buildSnLines；段落语义镜像 escpos-generator（header → items →
 * totals → footer；text/image/divider；size/bold/align），视觉样式镜像
 * ReceiptPreview（mono-cjk 12px 字格、221/307px 纸宽、scaleY/scaleX 放大、
 * 虚线分隔线、dataURL Logo）。模板 JSON 仍是唯一事实源。
 *
 * 产物为完整独立文档（doctype + charset + 内联 style，零外部资源——离线
 * 可渲染）；body 带 data-paper-width="58mm|80mm"（driver 通道 executeJavaScript
 * 读取该属性定页宽微米）。所有插值文本经 HTML 转义（& < > " '——收据
 * 内容不得注入标记）。
 */

import {
  PAPER_COLUMNS,
  padLine,
  wrapToGrid,
  type LineAlign,
  type PaperWidth
} from '../../../shared/receipt/char-grid'
import {
  buildSnLines,
  resolveColumnWidths,
  type ItemColumnWidths,
  type ReceiptItemLine,
  type SaleReceiptData
} from '../../../shared/receipt/item-columns'
import {
  interpolateVariables,
  type ReceiptTemplate,
  type ReceiptVars,
  type Section,
  type SectionSize
} from '../../../shared/receipt/template-schema'

/** 纸张物理宽度（px，96dpi 圆整）：80mm≈307px、58mm≈221px——与 ReceiptPreview 同值（几何同源） */
const PAPER_WIDTH_PX: Record<PaperWidth, number> = { '58mm': 221, '80mm': 307 }

/** 12px 字号下半角字符宽（全角 12px/半角 6px）——Logo 最大宽换算基准（同 ReceiptPreview） */
const HALF_CHAR_PX = 6

/** HTML 转义：& < > " '（全部插值文本必经——店名/商品名/变量值不得注入标记） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行 class 串（bold + size 放大——类名与 ReceiptPreview 逐字同源，视觉一致） */
function lineClasses(line: { bold?: boolean; size?: SectionSize }): string {
  const classes = ['receipt-line']
  if (line.bold ?? false) classes.push('receipt-line--bold')
  if (line.size === 'doubleHeight') classes.push('receipt-line--double-height')
  if (line.size === 'doubleWidth') classes.push('receipt-line--double-width')
  if (line.size === 'quad') classes.push('receipt-line--quad')
  return classes.join(' ')
}

/**
 * 行内联样式（同 ReceiptPreview.lineStyle）：align → text-align（pad 已做
 * 字符级对齐，text-align 为 CSS 层同语义映射）；放大尺寸的 transform-origin
 * 按对齐方向锚定；倍高/quad 的 scaleY 视觉翻倍但不占布局——margin-bottom
 * 1.35em 补偿防行叠压（打印侧高度测量 scrollHeight 同此布局高度）。
 */
function lineStyle(line: { align?: LineAlign; size?: SectionSize }): string {
  const align = line.align ?? 'left'
  const decls = [`text-align: ${align}`]
  if (line.size === 'doubleHeight' || line.size === 'quad') {
    decls.push(`transform-origin: ${align} top`, 'margin-bottom: 1.35em')
  } else if (line.size === 'doubleWidth') {
    decls.push(`transform-origin: ${align} center`)
  }
  return decls.join('; ')
}

/** text/total 行文本（多行）：interpolate → wrap → pad（char-grid 冻结顺序，与预览/打印侧同序） */
function lineTexts(raw: string, align: LineAlign, cols: number): string[] {
  return wrapToGrid(raw, cols).map((line) => padLine(line, cols, align))
}

/** text 行 → div（逐行；pad 空格经 white-space:pre 原样渲染——同源视觉） */
function textLinesHtml(
  text: string,
  line: { align?: LineAlign; bold?: boolean; size?: SectionSize },
  cols: number
): string {
  return lineTexts(text, line.align ?? 'left', cols)
    .map(
      (l) =>
        `<div class="${lineClasses(line)}" style="${lineStyle(line)}">${escapeHtml(l)}</div>`
    )
    .join('')
}

/**
 * header/footer 段落 → HTML（镜像 escpos-generator.renderSection 语义）：
 * text → 多行 div；image → dataURL img（logoId 未指定或 logoBuffers 无此
 * id → 静默跳过，同 ESC/POS 与预览）；divider → 虚线 div（对应打印侧 '-' × cols）。
 */
function sectionHtml(
  section: Section,
  vars: ReceiptVars,
  cols: number,
  logoBuffers: Map<number, Buffer>
): string {
  switch (section.type) {
    case 'text':
      return textLinesHtml(interpolateVariables(section.content ?? '', vars), section, cols)
    case 'image': {
      const logo = section.logoId !== undefined ? logoBuffers.get(section.logoId) : undefined
      if (!logo) return ''
      // base64 字符集不含 & < > " '，src 无需转义；max-width 与 ReceiptPreview
      // 同基准（cols × 6px），CSS 侧另有 max-width:100% 兜底
      return `<img class="receipt-logo" src="data:image/png;base64,${logo.toString(
        'base64'
      )}" style="max-width: ${cols * HALF_CHAR_PX}px" alt="店铺 Logo">`
    }
    case 'divider':
      return '<div class="receipt-divider"></div>'
  }
}

// ─────────────────────── items 表（char-grid 四列，ReceiptPreview 同构） ───────────────────────

/** items 单行四格（名称左对齐，数量/单价/小计右对齐——pad 后文本 + CSS text-align 同语义） */
interface ItemCell {
  text: string
  cssAlign: LineAlign
}

/**
 * 明细行多行化：与打印侧 buildItemLines 逐格等价（恒等降级 → wrap → pad，
 * char-grid 冻结顺序）。名称列 wrapToGrid(item.name, w.name) 折 N 行：首行
 * 四格齐备，续行右侧三列空白；每格 padLine 到列宽，行宽恰为 PAPER_COLUMNS。
 */
function itemCells(item: ReceiptItemLine, w: ItemColumnWidths): ItemCell[][] {
  return wrapToGrid(item.name, w.name).map((nameLine, idx): ItemCell[] => {
    if (idx === 0) {
      return [
        { text: padLine(nameLine, w.name), cssAlign: 'left' },
        { text: padLine(item.quantity, w.qty, 'right'), cssAlign: 'right' },
        { text: padLine(item.unitPrice, w.price, 'right'), cssAlign: 'right' },
        { text: padLine(item.subtotal, w.subtotal, 'right'), cssAlign: 'right' }
      ]
    }
    return [
      { text: padLine(nameLine, w.name), cssAlign: 'left' },
      { text: padLine('', w.qty, 'right'), cssAlign: 'right' },
      { text: padLine('', w.price, 'right'), cssAlign: 'right' },
      { text: padLine('', w.subtotal, 'right'), cssAlign: 'right' }
    ]
  })
}

/** 四格 → 一行 tr（td 逐格 text-align；white-space:pre 渲染 pad） */
function itemRowHtml(cells: ItemCell[]): string {
  const tds = cells
    .map((c) => `<td style="text-align: ${c.cssAlign}">${escapeHtml(c.text)}</td>`)
    .join('')
  return `<tr class="receipt-line">${tds}</tr>`
}

/** 列宽（格数）→ %（与 ReceiptPreview.itemCols 同换算，colgroup 定列宽基准） */
function colPercents(w: ItemColumnWidths, cols: number): string[] {
  const pct = (n: number): string => `${Number(((n / cols) * 100).toFixed(2))}%`
  return [pct(w.name), pct(w.qty), pct(w.price), pct(w.subtotal)]
}

/**
 * items 表 → table（镜像 escpos-generator.renderItems 语义 + ReceiptPreview
 * 结构）：showHeader 列头行（label 超长同样折行）→ 明细行（含 SN 副行，
 * colspan 全宽行，pad 已含缩进空格）。无列头且无明细 → 整表不渲染（同预览）。
 */
function itemsTableHtml(template: ReceiptTemplate, data: SaleReceiptData): string {
  const showHeader = template.items.showHeader ?? true
  if (!showHeader && data.items.length === 0) return ''

  const cols = PAPER_COLUMNS[template.paperWidth]
  const w = resolveColumnWidths(template.paperWidth, template.items.columnWidths)
  const rows: string[] = []

  if (showHeader) {
    const headerCells = itemCells(
      {
        name: template.items.nameLabel ?? '商品',
        quantity: template.items.qtyLabel ?? '数量',
        unitPrice: template.items.priceLabel ?? '单价',
        subtotal: template.items.subtotalLabel ?? '小计'
      },
      w
    )
    for (const cells of headerCells) rows.push(itemRowHtml(cells))
  }
  for (const item of data.items) {
    for (const cells of itemCells(item, w)) rows.push(itemRowHtml(cells))
    // SN 副行（D-SN12）：sn 非空即渲染——buildSnLines 同源数学，恒为常规字号
    for (const sn of buildSnLines(item.sn, template.paperWidth)) {
      rows.push(
        `<tr class="receipt-line receipt-line--sn"><td colspan="4" style="text-align: left">${escapeHtml(
          sn
        )}</td></tr>`
      )
    }
  }

  const colgroup = colPercents(w, cols)
    .map((pct) => `<col style="width: ${pct}">`)
    .join('')
  return `<table class="receipt-items"><colgroup>${colgroup}</colgroup><tbody>${rows.join(
    ''
  )}</tbody></table>`
}

// ─────────────────────── 文档骨架（完整独立 HTML） ───────────────────────

/**
 * 内联样式（ReceiptPreview scoped 样式的独立文档版）：mono-cjk 字体栈
 * （NSimSun/SimSun——全角恰 2× 半角的等宽 CJK，网格 pad 对齐的前提）、
 * 12px 字格、1.35 行高、221/307px 纸宽容器、scaleY/scaleX 放大、虚线分隔线。
 * 打印路径零外部资源（无字体/图片外链）——data: URL 载入 + 离线渲染。
 */
const RECEIPT_CSS = `
html, body { margin: 0; padding: 0; background: #ffffff; }
.receipt-paper {
  box-sizing: border-box;
  padding: 12px 9px;
  background: #ffffff;
  color: #14161a;
  font-family: "NSimSun", "SimSun", monospace;
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
}
.receipt-line { white-space: pre; font-weight: 400; }
.receipt-items { width: 100%; border-collapse: collapse; table-layout: fixed; }
.receipt-items td { white-space: pre; padding: 0; font-weight: inherit; overflow: hidden; }
.receipt-items tr.receipt-line--bold { font-weight: 700; }
.receipt-line--bold { font-weight: 700; }
.receipt-line--double-height { display: inline-block; transform: scaleY(2); }
.receipt-line--double-width { display: inline-block; transform: scaleX(2); }
.receipt-line--quad { display: inline-block; transform: scale(2); }
.receipt-divider { margin: 6px 0; border-top: 1px dashed #5a5f66; }
.receipt-logo { display: block; margin: 2px auto; max-width: 100%; }
.receipt-cut { margin: 10px 0 2px; border-top: 1px dashed #9aa0a8; position: relative; }
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
`.trim()

/**
 * 纯函数：模板 + 明细 + 变量 + Logo → 完整收据 HTML 文档。
 * 同输入必产出同文档（重打幂等）；零 I/O（Logo PNG 由调用方经 logoBuffers
 * 注入 Buffer——G6）。渲染顺序镜像 escpos-generator：header → items →
 * totals → footer → 剪切示意（cutPaper）。
 */
export function generateReceiptHtml(
  template: ReceiptTemplate,
  data: SaleReceiptData,
  vars: ReceiptVars,
  logoBuffers: Map<number, Buffer>
): string {
  const cols = PAPER_COLUMNS[template.paperWidth]
  const paperWidthPx = PAPER_WIDTH_PX[template.paperWidth]

  const header = template.header
    .map((s) => sectionHtml(s, vars, cols, logoBuffers))
    .join('')
  const items = itemsTableHtml(template, data)
  const totals = template.totals
    .map((t) => textLinesHtml(interpolateVariables(t.label, vars), t, cols))
    .join('')
  const footer = template.footer
    .map((s) => sectionHtml(s, vars, cols, logoBuffers))
    .join('')
  // cutPaper：剪切示意线（HTML 不切纸——驱动渲染路径无 GS V 指令，仅视觉对齐预览）
  const cut = template.cutPaper ? '<div class="receipt-cut" aria-hidden="true"></div>' : ''

  const body = [header, items, totals, footer, cut].filter((part) => part !== '').join('')

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>小票</title>',
    `<style>${RECEIPT_CSS}</style>`,
    '</head>',
    // data-paper-width：driver 通道读取该属性定页宽微米（58mm→58000 / 80mm→80000）
    `<body data-paper-width="${template.paperWidth}">`,
    `<div class="receipt-paper" style="width: ${paperWidthPx}px">`,
    body,
    '</div>',
    '</body>',
    '</html>'
  ].join('\n')
}
