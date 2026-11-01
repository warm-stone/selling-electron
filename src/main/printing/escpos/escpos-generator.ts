/**
 * ESC/POS 纯函数生成器（Task 4，G6 生命线）。
 *
 * `generateReceiptBytes(template, sale, vars) → Promise<Uint8Array>`：
 * 模板 + 销售数据 + 变量 → 完整 ESC/POS 字节流。**内部零 I/O**——
 * 用 node-thermal-printer 的 `interface: 'file'` 模式只装配指令缓冲，
 * 从不发送（无网络 / 无打印机 / 无文件读取）；Logo PNG 由调用方经
 * `vars.logoBuffer` 注入（Buffer 只来自参数——G6）。
 *
 * 渲染顺序（任务契约）：
 * `ESC @` 初始化 → `ESC R 15` 中文页 → header 段落 → items 表 →
 * totals → footer → `GS V 66 0` 切纸（cutPaper=true 时）→ 取 buffer。
 *
 * 对齐/截断全部走 shared/receipt/char-grid（G7：与 HTML 预览同源数学）。
 * 文本先经 degradeToGbk 降级再进 ThermalPrinter（见 gb2312-encoder）。
 */

import { BreakLine, CharacterSet, PrinterTypes, ThermalPrinter } from 'node-thermal-printer'

import {
  PAPER_COLUMNS,
  padLine,
  truncateToGrid,
  type LineAlign,
  type PaperWidth
} from '../../../shared/receipt/char-grid'
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
 * 小票明细行（display-ready：数量/单价/小计均为**已格式化字符串**，
 * 由打印编排层 T15 在组装时完成整数分 → 元的格式化——与 ReceiptVars
 * 同一约定，模板/生成器层零金额运算，G1）。
 */
export interface ReceiptItemLine {
  /** 商品名（快照；GBK 外字符在本生成器内降级为 '?'） */
  name: string
  /** 数量（已格式化，如 '2'） */
  quantity: string
  /** 单价（元，已格式化，如 '3.50'） */
  unitPrice: string
  /** 小计（元，已格式化） */
  subtotal: string
}

/** 小票打印数据（明细行集合；单号/时间等经 vars 插槽传入） */
export interface SaleReceiptData {
  items: ReceiptItemLine[]
}

/**
 * ReceiptVars 的打印侧扩展形态：额外携带 `logoBuffer`（PNG Buffer）。
 * ReceiptVars 的字符串索引签名（T3 冻结契约）容不下 Buffer，TS2411 也不允许
 * 接口扩展改宽索引类型，故在此独立声明；普通 ReceiptVars 对象可直接赋值给它。
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
  /** Logo PNG（调用方读文件/设置后注入；生成器内部零文件读取——G6） */
  logoBuffer?: Buffer
  [key: string]: string | Buffer | undefined
}

// ═════════════════════ items 四列网格（G7） ═════════════════════

/** items 表四列的网格列宽（名称左对齐，数量/单价/小计右对齐） */
export interface ItemColumnWidths {
  name: number
  qty: number
  price: number
  subtotal: number
}

/**
 * items 表列宽（name + qty + price + subtotal = PAPER_COLUMNS）。
 * ⚠️ G7 契约缺口：HTML 预览（T12）须用同一组常量——本模块在主进程侧，
 * renderer 无法 import；已记录 .omo/notepads/pos-electron-app/issues.md，
 * T12 落地前应将此常量上提到 src/shared/receipt/。
 */
export const ITEM_COLUMN_WIDTHS: Record<PaperWidth, ItemColumnWidths> = {
  // 58mm：12 + 4 + 8 + 8 = 32 列
  '58mm': { name: 12, qty: 4, price: 8, subtotal: 8 },
  // 80mm：24 + 4 + 10 + 10 = 48 列
  '80mm': { name: 24, qty: 4, price: 10, subtotal: 10 }
}

// ═════════════════════ 指令常量（规范字节直发） ═════════════════════

/** `ESC @`：初始化/清除模式（库 initHardware 未暴露在 .d.ts，add 字节等价直发） */
const HW_INIT = Buffer.from([0x1b, 0x40])

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
  // logoBuffer 仅 image 段落消费；文本插槽视图与 ReceiptVars 兼容（字符串值）
  const textVars = vars as ReceiptVars

  // 渲染顺序（任务契约）：ESC @ → 中文页 → header → items → totals → footer → 切纸
  printer.add(HW_INIT)
  printer.setCharacterSet(CharacterSet.CHINA)

  for (const section of template.header) {
    await renderSection(printer, section, vars, cols)
  }
  renderItems(printer, template, sale)
  for (const line of template.totals) {
    renderTotalLine(printer, line, textVars)
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
    // breakLine NONE：行折叠交给 char-grid（padLine/truncateToGrid）同源数学；
    // 禁用库内按 UTF-16 码元数的 _fold——它会把已对齐的网格行错误折断
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
      printer.println(text)
      if (section.bold) printer.bold(false)
      break
    }
    case 'image': {
      const logo = vars.logoBuffer
      if (logo) await appendLogoRaster(printer, logo, cols)
      break // 未配置 Logo（vars 无 logoBuffer）→ 静默跳过
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
  const widths = ITEM_COLUMN_WIDTHS[template.paperWidth]
  resetBodyState(printer)
  if (section.showHeader ?? true) {
    printer.println(
      composeItemRow(
        section.nameLabel ?? '商品',
        section.qtyLabel ?? '数量',
        section.priceLabel ?? '单价',
        section.subtotalLabel ?? '小计',
        widths
      )
    )
  }
  for (const item of sale.items) {
    printer.println(composeItemRow(item.name, item.quantity, item.unitPrice, item.subtotal, widths))
  }
}

/**
 * 组合一行 items 网格行：先降级（GBK 外字符 → '?'）→ 再 truncate → 再 pad，
 * 拼接后恰为 PAPER_COLUMNS 宽（打印侧几何自洽；与 HTML 预览共用 shared
 * char-grid 同一顺序组合——G7）。
 */
function composeItemRow(
  name: string,
  qty: string,
  price: string,
  subtotal: string,
  w: ItemColumnWidths
): string {
  return (
    padLine(truncateToGrid(degradeToGbk(name), w.name), w.name) +
    padLine(truncateToGrid(degradeToGbk(qty), w.qty), w.qty, 'right') +
    padLine(truncateToGrid(degradeToGbk(price), w.price), w.price, 'right') +
    padLine(truncateToGrid(degradeToGbk(subtotal), w.subtotal), w.subtotal, 'right')
  )
}

// ─────────────────────── totals 行 ───────────────────────

function renderTotalLine(printer: ThermalPrinter, line: TotalLine, vars: ReceiptVars): void {
  applyTextState(printer, line.size, line.bold ?? false, line.align)
  printer.println(degradeToGbk(interpolateVariables(line.label, vars)))
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
 * 修正：库把光栅头第 4 字节（模式 m）固定发 0x30（'0'，非规范值 0-3），
 * 按 Epson 规范改为 m=0x00（正常尺寸光栅）——字节级 golden 契约锁定
 * `1d 76 30 00`（真机联调若遇异常见 learnings 记录）。
 */
async function appendLogoRaster(printer: ThermalPrinter, png: Buffer, cols: number): Promise<void> {
  const scratch = createEpsonPrinter(cols)
  const raster = await scratch.printImageBuffer(png)
  if (raster.length >= 4 && raster[3] === 0x30) {
    raster[3] = 0x00
  }
  printer.add(raster)
  printer.newLine()
}
