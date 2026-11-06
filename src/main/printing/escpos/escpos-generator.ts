/**
 * ESC/POS 纯函数生成器（Task 4，G6 生命线）。
 *
 * `generateReceiptBytes(template, sale, vars) → Promise<Uint8Array>`：
 * 模板 + 销售数据 + 变量 → 完整 ESC/POS 字节流。**内部零 I/O**——
 * 用 node-thermal-printer 的 `interface: 'file'` 模式只装配指令缓冲，
 * 从不发送（无网络 / 无打印机 / 无文件读取）；Logo PNG 由调用方经
 * `vars.logoBuffers`（image 段落 logoId → Buffer）注入（Buffer 只来自
 * 参数——G6）。
 *
 * 渲染顺序（任务契约）：
 * `ESC @` 初始化 → `ESC R 15` 中文页 + `FS &` 汉字模式 → header 段落 →
 * items 表 → totals → footer → `GS V 66 0` 切纸（cutPaper=true 时）→
 * 取 buffer。
 *
 * 汉字链路（真机修复，国产 ESC/POS 80mm 机验证方案）：
 * `setCharacterSet(CharacterSet.CHINA)` 发出的 `ESC R 15` 是 ESC/POS
 * 「国际字符集」指令，大多数国产打印机忽略它——必须再补 `FS &`
 * （进入汉字模式）后续 GBK 双字节流才被固件接受（官方 issue #75 验证）。
 * setCharacterSet 调用本身**必须保留**：它设置库实例的 codePage='CHINA'，
 * 使 append() 用 EUC-CN 逐字符编码且不触发库内代码页回退污染
 * （JAPAN-first 陷阱），其发出的 `ESC R 15` 字节无害。
 *
 * 对齐/折行全部走 shared/receipt/char-grid（G7：与 HTML 预览同源数学）。
 * 文本先经 degradeToGbk 降级再进 ThermalPrinter（见 gb2312-encoder）。
 */

import { BreakLine, CharacterSet, PrinterTypes, ThermalPrinter } from 'node-thermal-printer'

import {
  PAPER_COLUMNS,
  wrapToGrid,
  type LineAlign
} from '../../../shared/receipt/char-grid'
import {
  buildItemLines,
  ITEM_COLUMN_WIDTHS,
  type ItemColumnWidths,
  type ReceiptItemLine,
  type SaleReceiptData
} from '../../../shared/receipt/item-columns'
import {
  interpolateVariables,
  type ReceiptTemplate,
  type ReceiptVars,
  type Section,
  type SectionSize,
  type TotalLine
} from '../../../shared/receipt/template-schema'
import { degradeToGbk } from './gb2312-encoder'

// ═════════════════════ 数据契约（打印侧） ═════════════════════

/**
 * 小票变量插槽的打印侧扩展形态：额外携带 `logoBuffers`（image 段落
 * logoId → PNG Buffer 的映射）。ReceiptVars 的字符串索引签名（T3 冻结
 * 契约）容不下 Buffer/Map，TS2411 也不允许接口扩展改宽索引类型，故在此
 * 独立声明；普通 ReceiptVars 对象可直接赋值给它。
 */
export interface ReceiptPrintVars {
  shopName: string
  shopPhone: string
  receiptNote: string
  saleNo: string
  datetime: string
  total: string
  itemCount: string
  companyFooter?: string
  /** Logo PNG 集合（image 段落 logoId → Buffer；调用方读文件后注入，生成器内部零文件读取——G6） */
  logoBuffers?: Map<number, Buffer>
  [key: string]: string | Buffer | Map<number, Buffer> | undefined
}

// items 四列网格契约（列宽/明细行 display-ready 类型/buildItemLines 组合语义）
// 已上提 src/shared/receipt/item-columns.ts（Task 12，G7 契约缺口闭合）——
// 此处 re-export 维持本模块既有导入面（HTML 预览与 golden 测试同源消费 shared）。
export { ITEM_COLUMN_WIDTHS }
export type { ItemColumnWidths, ReceiptItemLine, SaleReceiptData }

// ═════════════════════ 指令常量（规范字节直发） ═════════════════════

/** `ESC @`：初始化/清除模式（库 initHardware 未暴露在 .d.ts，add 字节等价直发） */
const HW_INIT = Buffer.from([0x1b, 0x40])

/**
 * `FS &`（1c 26）：进入汉字模式（ESC/POS 标准汉字指令，官方 issue #75
 * 验证方案）。国产打印机大多忽略 `ESC R 15`（国际字符集指令），只有
 * `FS &` 能让固件接受后续 GBK 双字节流；在 setCharacterSet(CHINA)
 * 之后追加，与其发出的 `ESC R 15` 共存无害。
 */
const FS_HANZI_MODE = Buffer.from([0x1c, 0x26])

/**
 * `GS ! 0x00`（倍宽/倍高放大归一）。按规范字节直发的原因：
 * 库的 setTextSize 把十进制数字当十六进制拼装（(1,1)→0x11 = 2×2），
 * 语义错误，不能用于尺寸控制。
 */
const GS_MAGNIFICATION_RESET = Buffer.from([0x1d, 0x21, 0x00])

/** `GS V 66 0`：走纸 0 单位后全切（任务契约的切纸字节序列；库 cut() 发 1d 56 00） */
const FULL_CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00])

// ═════════════════════ 生成器主体 ═════════════════════

/**
 * 纯函数：模板 + 销售 + 变量 → ESC/POS 字节流。
 * 同输入必产出同字节（重打幂等，golden .bin 基准锁定）。
 */
export async function generateReceiptBytes(
  template: ReceiptTemplate,
  sale: SaleReceiptData,
  vars: ReceiptPrintVars
): Promise<Uint8Array> {
  const cols = PAPER_COLUMNS[template.paperWidth]
  const printer = createEpsonPrinter(cols)
  // logoBuffers 仅 image 段落消费；文本插槽视图与 ReceiptVars 兼容（字符串值）
  const textVars = vars as ReceiptVars

  // 渲染顺序（任务契约）：ESC @ → 中文页 + 汉字模式 → header → items → totals → footer → 切纸
  printer.add(HW_INIT)
  printer.setCharacterSet(CharacterSet.CHINA)
  printer.add(FS_HANZI_MODE)

  for (const section of template.header) {
    await renderSection(printer, section, vars, cols)
  }
  renderItems(printer, template, sale)
  for (const line of template.totals) {
    renderTotalLine(printer, line, textVars, cols)
  }
  for (const section of template.footer) {
    await renderSection(printer, section, vars, cols)
  }

  if (template.cutPaper) {
    // 切纸前走纸 2 行，避免真机裁刀切到正文
    printer.newLine()
    printer.newLine()
    printer.add(FULL_CUT)
  }

  // 拷贝脱离库内部缓冲（调用方持有的快照不受后续任何操作影响）
  return new Uint8Array(printer.getBuffer())
}

/** epson 指令装配器：interface 'file' 仅装配缓冲，从不发送（G6） */
function createEpsonPrinter(width: number): ThermalPrinter {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: 'file',
    width,
    // breakLine NONE：行折叠交给 char-grid（wrapToGrid/padLine/truncateToGrid）
    // 同源数学；禁用库内按 UTF-16 码元数的 _fold——它会把已对齐的网格行错误折断
    breakLine: BreakLine.NONE
  })
}

// ─────────────────────── header / footer 段落 ───────────────────────

async function renderSection(
  printer: ThermalPrinter,
  section: Section,
  vars: ReceiptPrintVars,
  cols: number
): Promise<void> {
  switch (section.type) {
    case 'text': {
      applyTextState(printer, section.size, section.bold ?? false, section.align)
      const text = degradeToGbk(interpolateVariables(section.content ?? '', vars as ReceiptVars))
      // 超宽折行（wrapToGrid 同源数学），逐行 println——不 padLine：
      // 对齐继续靠 ESC a 段落状态（每行 println 继承 applyTextState 设置）
      for (const line of wrapToGrid(text, cols)) {
        printer.println(line)
      }
      if (section.bold) printer.bold(false)
      break
    }
    case 'image': {
      const logo =
        section.logoId !== undefined ? vars.logoBuffers?.get(section.logoId) : undefined
      if (logo) await appendLogoRaster(printer, logo, cols)
      break // 未指定 logoId / logoBuffers 无此 id → 静默跳过
    }
    case 'divider': {
      resetBodyState(printer)
      printer.drawLine() // '-' × cols + 换行（库 lineCharacter 默认 '-'）
      break
    }
  }
}

// ─────────────────────── items 表（char-grid 四列） ───────────────────────

function renderItems(printer: ThermalPrinter, template: ReceiptTemplate, sale: SaleReceiptData): void {
  const section = template.items
  resetBodyState(printer)
  if (section.showHeader ?? true) {
    const headerLines = buildItemLines(
      section.nameLabel ?? '商品',
      section.qtyLabel ?? '数量',
      section.priceLabel ?? '单价',
      section.subtotalLabel ?? '小计',
      template.paperWidth,
      degradeToGbk,
      section.columnWidths
    )
    for (const line of headerLines) printer.println(line)
  }
  for (const item of sale.items) {
    const lines = buildItemLines(
      item.name,
      item.quantity,
      item.unitPrice,
      item.subtotal,
      template.paperWidth,
      degradeToGbk,
      section.columnWidths
    )
    for (const line of lines) printer.println(line)
  }
}

// ─────────────────────── totals 行 ───────────────────────

function renderTotalLine(
  printer: ThermalPrinter,
  line: TotalLine,
  vars: ReceiptVars,
  cols: number
): void {
  applyTextState(printer, line.size, line.bold ?? false, line.align)
  const text = degradeToGbk(interpolateVariables(line.label, vars))
  // 超宽折行（与 renderSection text 分支同源）；倍宽/quad 行的换行宽度仍用
  // cols（维持现状，不处理缩放列宽）
  for (const wrapped of wrapToGrid(text, cols)) {
    printer.println(wrapped)
  }
  if (line.bold) printer.bold(false)
}

// ─────────────────────── 段落状态块（ESC/POS 文本态） ───────────────────────

/**
 * 每个文本段落自含完整状态块（不依赖前一节的残留态）：
 * GS ! 归一 → ESC ! 字号 → ESC E 粗体 → ESC a 对齐。
 * 段落结束后粗体显式关闭；字号/对齐由下一段落自己的状态块覆盖。
 */
function applyTextState(
  printer: ThermalPrinter,
  size: SectionSize | undefined,
  bold: boolean,
  align: LineAlign | undefined
): void {
  printer.add(GS_MAGNIFICATION_RESET)
  switch (size) {
    case 'doubleHeight':
      printer.setTextDoubleHeight() // ESC ! 10
      break
    case 'doubleWidth':
      printer.setTextDoubleWidth() // ESC ! 20
      break
    case 'quad':
      printer.setTextQuadArea() // ESC ! 30
      break
    default:
      printer.setTextNormal() // ESC ! 00
  }
  if (bold) printer.bold(true) // ESC E 01
  applyAlign(printer, align)
}

/** 网格内容（divider / items）的基准态：常规字号 + 非粗体 + 左对齐 */
function resetBodyState(printer: ThermalPrinter): void {
  printer.add(GS_MAGNIFICATION_RESET)
  printer.setTextNormal()
  printer.bold(false)
  printer.alignLeft()
}

function applyAlign(printer: ThermalPrinter, align: LineAlign | undefined): void {
  if (align === 'center') printer.alignCenter()
  else if (align === 'right') printer.alignRight()
  else printer.alignLeft()
}

// ─────────────────────── Logo 光栅（GS v 0） ───────────────────────

/**
 * 追加 Logo 光栅字节：借一次性 scratch 打印机产出 `GS v 0` 光栅
 * （printImageBuffer 内部 pngjs 解码 PNG → 位图打包），再 add 进主管线。
 *
 * 光栅头第 4 字节（模式 m）保留库默认 0x30：大量国产打印机固件只认
 * m=0x30（'0'），改发规范值 0x00 反而导致光栅指令解析失败、图片被
 * 跳过（真机联调结论，见 learnings）——字节级 golden 契约锁定
 * `1d 76 30 30`。
 */
async function appendLogoRaster(printer: ThermalPrinter, png: Buffer, cols: number): Promise<void> {
  const scratch = createEpsonPrinter(cols)
  const raster = await scratch.printImageBuffer(png)
  printer.add(raster)
  printer.newLine()
}
