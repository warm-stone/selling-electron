/**
 * 收据 HTML 生成器（driver 通道载荷，纯函数零 I/O——G6）。
 *
 * 为什么存在 driver 通道（真机结论）：得力 DL-5801PW 等「云打印」热敏机的固件
 * **没有中文字模**——RAW 通道对每个 ≥0x80 字节「吃掉 + 推进一个半角空位 +
 * 不画点」，UTF-8 与 GBK+FS & 两种编码同样打不出中文（20261118 F1 探针实证：
 * S1 ASCII 正常、S4 `GS v 0` 光栅黑块正常，坏的只有 CJK 字形层）；但同一台
 * 机器走 Windows 打印机驱动（GDI 渲染，即 Word 打印的同一条路径）中文与图片
 * 都完美——驱动替它光栅化了。因此 driver 通道不再发原始字节，而是把模板渲染成
 * 完整 HTML 文档，交给隐藏 BrowserWindow 的 webContents.print（silent +
 * deviceName）由驱动完成光栅化——对「无中文字模」的机型是 100% 兼容兜底。
 *
 * G7 同源第三渲染器：与 ESC/POS 生成器（escpos-generator.ts）、HTML 预览
 * （ReceiptPreview.vue）消费同一 shared/receipt 网格数学——文本行
 * interpolate → wrapToGrid → padLine（char-grid 冻结顺序），items 行
 * wrapToGrid/padLine 逐格组合（与 buildItemLines 同一数学，恒等降级），
 * SN 副行 buildSnLines；段落语义镜像 escpos-generator（header → items →
 * totals → footer；text/image/divider；size/bold/align）。模板 JSON 仍是唯一事实源。
 *
 * **版面几何不镜像 ReceiptPreview**（真机 20261117 结论）：预览是屏幕仿真，按纸宽
 * 221/307px + 12px 字格排版；打印必须按**物理可打印宽**排版，否则最右几列落在
 * 打印头之外（详见 RECEIPT_PRINT_GEOMETRY 头注）。G7 同源冻结的是网格数学
 * （列数/折行/pad 组合顺序），不是 CSS 像素——两侧行集逐字一致的契约不受影响。
 *
 * **纯黑单色**（真机 20261117 结论）：热敏机是 1 位色深，任何非纯黑都会被驱动
 * 抖动成灰阶网点，纸面表现就是「字里行间很多小白点」。打印侧一律 #000。
 *
 * 产物为完整独立文档（doctype + charset + 内联 style，零外部资源——离线
 * 可渲染）；body 带 data-paper-width="58mm|80mm"（纸张规格留档）与
 * data-page-width-microns（driver 通道 executeJavaScript 读取该属性定页宽微米）。
 * 所有插值文本经 HTML 转义（& < > " '——收据内容不得注入标记）。
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

/** mm → CSS px（Chromium 96dpi：1mm = 96/25.4 px） */
const MM_TO_PX = 96 / 25.4

/**
 * 热敏纸**可打印**宽度（mm）：58mm 纸 → 48mm（384 点）、80mm 纸 → 72mm（576 点）
 * ——@203dpi 的行业通用值，纸张两侧各有约 5mm/4mm 的物理不可打印边。
 *
 * 为什么按可打印宽而不是纸宽排版（真机 20261117 右截断根因之一）：旧版把
 * .receipt-paper 定成纸宽 221px（≈58.5mm）、网格 32 列 × 6px = 192px（≈50.8mm），
 * 比 48mm 可打印区宽出近 3mm——最右两列半落在打印头之外，右对齐的合计行
 * 最后一个数字首当其冲。得力 DL-5801PW 的驱动 DEVMODE 也印证了这一点：它上报
 * 的页宽正是 48000μm，而不是模板声称的 58000μm。
 */
const PRINTABLE_WIDTH_MM: Record<PaperWidth, number> = { '58mm': 48, '80mm': 72 }

/** 行高倍数：3mm 字号 × 1.25 = 3.75mm = 30 点 @203dpi，与 ESC/POS 默认行距逐点同值 */
const LINE_HEIGHT = 1.25

/** driver 通道打印版面几何（唯一事实源——driver.channel / diagnostics / 测试共用） */
export interface ReceiptPrintGeometry {
  /** 页面宽（= 可打印宽），mm：.receipt-paper 容器宽 */
  pageWidthMm: number
  /** 页面宽，μm：driver 通道 pageSize.width（与驱动 DEVMODE 同基准，不再被驱动忽略） */
  pageWidthMicrons: number
  /** 页面宽，CSS px（96dpi 圆整）：render-check 水平溢出比对基准 */
  pageWidthPx: number
  /** 正文字号，mm：半角列宽 = pageWidthMm / PAPER_COLUMNS，全角恰占 2 列 */
  fontSizeMm: number
  /** .receipt-paper 的 padding（诊断 templateFacts.cssPadding 同源上报） */
  cssPadding: string
}

/**
 * 按纸宽派生几何。fontSizeMm 由「半角推进量 = 0.5em」反推（2 × 列宽）：
 * 58mm/80mm 都得 3mm ≈ 24 点 @203dpi，恰是 ESC/POS 标准 24×24 点阵字、每列 12 点
 * ——字形边界落在打印头点阵上，抗锯齿灰阶最少（灰阶越少，驱动抖动出的小白点越少）。
 */
function buildGeometry(paper: PaperWidth): ReceiptPrintGeometry {
  const pageWidthMm = PRINTABLE_WIDTH_MM[paper]
  return {
    pageWidthMm,
    pageWidthMicrons: Math.round(pageWidthMm * 1000),
    pageWidthPx: Math.round(pageWidthMm * MM_TO_PX),
    fontSizeMm: (2 * pageWidthMm) / PAPER_COLUMNS[paper],
    // 可打印区就是物理边界：左右不留白（留白等于白扔可用点数），上下给 1mm 呼吸位
    cssPadding: '1mm 0'
  }
}

/** 各纸宽的打印版面几何（driver 通道页宽/字号、诊断溢出比对基准的共同来源） */
export const RECEIPT_PRINT_GEOMETRY: Record<PaperWidth, ReceiptPrintGeometry> = {
  '58mm': buildGeometry('58mm'),
  '80mm': buildGeometry('80mm')
}

/**
 * 版面自适应脚本体（driver.channel 与 render-check 共用——生产打印与诊断测量必须
 * 走同一条「先适配、再测量」路径，否则诊断报的溢出与真机裁切对不上）。
 *
 * 为什么需要（真机 20261117 右截断根因之二）：网格数学假设半角推进量 = 0.5em，
 * 只有 NSimSun 这类等宽 CJK 字体成立。实测反推：诊断样本内容宽 228px / 32 列 =
 * 7.125px = **0.594em**，比假设宽 18.75%——说明该机 ASCII/数字逐字回退到了
 * monospace（Courier New 一类 0.6em）而汉字仍走 NSimSun：版面看着正常，但每行都偏宽，
 * 顶在最右端的合计行金额尾数就被 overflow:hidden 吃掉。字体回退、合成粗体加宽、
 * 逐字亚像素取整都无法在生成期预知，此处按实测比例回缩字号直到不溢出
 * （最多 8 轮，线性收敛通常 1-2 轮），把「字体度量假设」从前提降级为兜底。
 *
 * 自带块级作用域（`{ ... }`）：可安全内联进任何 IIFE，不与宿主的 `el` 等标识符冲突。
 */
export const FIT_TO_WIDTH_BODY =
  "{ const fitEl = document.querySelector('.receipt-paper'); if (fitEl) { for (let i = 0; i < 8 && fitEl.scrollWidth > fitEl.clientWidth + 1; i++) { const fs = parseFloat(getComputedStyle(fitEl).fontSize); if (!(fs > 0)) break; fitEl.style.fontSize = (fs * fitEl.clientWidth / fitEl.scrollWidth).toFixed(4) + 'px'; } } }"

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
 * 补一个行高防行叠压（打印侧高度测量 scrollHeight 同此布局高度）。
 */
function lineStyle(line: { align?: LineAlign; size?: SectionSize }): string {
  const align = line.align ?? 'left'
  const decls = [`text-align: ${align}`]
  if (line.size === 'doubleHeight' || line.size === 'quad') {
    decls.push(`transform-origin: ${align} top`, `margin-bottom: ${LINE_HEIGHT}em`)
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
  logoBuffers: Map<number, Buffer>,
  geom: ReceiptPrintGeometry
): string {
  switch (section.type) {
    case 'text':
      return textLinesHtml(interpolateVariables(section.content ?? '', vars), section, cols)
    case 'image': {
      const logo = section.logoId !== undefined ? logoBuffers.get(section.logoId) : undefined
      if (!logo) return ''
      // base64 字符集不含 & < > " '，src 无需转义；max-width 用物理可打印宽
      // （mm 单位——与容器同基准，字号被自适应回缩时不受 px 假设影响），
      // CSS 侧另有 max-width:100% 兜底
      return `<img class="receipt-logo" src="data:image/png;base64,${logo.toString(
        'base64'
      )}" style="max-width: ${geom.pageWidthMm}mm" alt="店铺 Logo">`
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
 * 内联样式（打印文档专用，**不是** ReceiptPreview scoped 样式的拷贝）：
 * - 字体栈 NSimSun/SimSun——全角恰 2× 半角的等宽 CJK，网格 pad 对齐的前提；
 *   该假设在目标机不成立时由 FIT_TO_WIDTH_BODY 实测回缩兜底（见其头注）。
 * - 尺寸一律 mm 而不用 px：热敏机是点阵设备（203dpi → 1 点 = 0.125mm），用 mm
 *   排版才能让「1 列 = 12 点、字高 = 24 点、行距 = 30 点」落在整数点上；px 排版
 *   会被 96dpi→203dpi 的 2.1146 倍非整数缩放重采样，字形边缘出灰阶（再被
 *   1 位色深抖动成小白点）。
 * - 一律纯黑：旧版正文 #14161a、分隔线 #5a5f66、剪切线 #9aa0a8 全是屏幕灰，
 *   到热敏机上全部变成抖动网点。
 * 打印路径零外部资源（无字体/图片外链）——data: URL 载入 + 离线渲染。
 */
function receiptCss(g: ReceiptPrintGeometry): string {
  return `
html, body { margin: 0; padding: 0; background: #ffffff; }
.receipt-paper {
  box-sizing: border-box;
  width: ${g.pageWidthMm}mm;
  padding: ${g.cssPadding};
  background: #ffffff;
  color: #000000;
  font-family: "NSimSun", "SimSun", monospace;
  font-size: ${g.fontSizeMm}mm;
  line-height: ${LINE_HEIGHT};
  overflow: hidden;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.receipt-line { white-space: pre; font-weight: 400; }
.receipt-items { width: 100%; border-collapse: collapse; table-layout: fixed; }
.receipt-items td { white-space: pre; padding: 0; font-weight: inherit; overflow: hidden; }
.receipt-items tr.receipt-line--bold { font-weight: 700; }
.receipt-line--bold { font-weight: 700; }
.receipt-line--double-height { display: inline-block; transform: scaleY(2); }
.receipt-line--double-width { display: inline-block; transform: scaleX(2); }
.receipt-line--quad { display: inline-block; transform: scale(2); }
.receipt-divider { margin: 1.5mm 0; border-top: 1px dashed #000000; }
.receipt-logo { display: block; margin: 0.5mm auto; max-width: 100%; }
.receipt-cut { margin: 2.5mm 0 0.5mm; border-top: 1px dashed #000000; position: relative; }
.receipt-cut::after {
  content: '✂';
  position: absolute;
  right: 0;
  top: -0.75em;
  font-size: 1em;
  color: #000000;
  background: #ffffff;
  padding: 0 0.17em;
}
`.trim()
}

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
  const geom = RECEIPT_PRINT_GEOMETRY[template.paperWidth]

  const header = template.header
    .map((s) => sectionHtml(s, vars, cols, logoBuffers, geom))
    .join('')
  const items = itemsTableHtml(template, data)
  const totals = template.totals
    .map((t) => textLinesHtml(interpolateVariables(t.label, vars), t, cols))
    .join('')
  const footer = template.footer
    .map((s) => sectionHtml(s, vars, cols, logoBuffers, geom))
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
    `<style>${receiptCss(geom)}</style>`,
    '</head>',
    // data-paper-width：纸张规格留档（诊断报告可读）；data-page-width-microns：
    // driver 通道据此定 pageSize.width = 可打印宽（与驱动 DEVMODE 同基准——旧版
    // 下发纸宽 58000 而驱动实际用 48000，是右截断的根）
    `<body data-paper-width="${template.paperWidth}" data-page-width-microns="${geom.pageWidthMicrons}">`,
    '<div class="receipt-paper">',
    body,
    '</div>',
    '</body>',
    '</html>'
  ].join('\n')
}
