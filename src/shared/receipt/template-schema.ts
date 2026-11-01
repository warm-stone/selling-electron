/**
 * 小票模板 JSON 契约（D7 段落制模板）。
 *
 * 模板是打印子系统的唯一事实源：同一份 ReceiptTemplate JSON
 * 供 ESC/POS 生成器（字节流）与 HTML 预览（ReceiptPreview）消费，
 * 两侧共享 char-grid 网格数学（G7 同源）。
 * **纯类型 + 纯函数，零 Node/Electron/DOM 依赖**，主/渲染两侧可 import。
 */

import type { LineAlign, PaperWidth } from './char-grid'

/** 段落类型：文本 / 图片（Logo）/ 分隔线 */
export type SectionType = 'text' | 'image' | 'divider'

/** 字符尺寸（ESC/POS GS ! n 语义的抽象，两种渲染器各自映射） */
export type SectionSize = 'normal' | 'doubleHeight' | 'doubleWidth' | 'quad'

/**
 * 模板段落（header/footer 数组元素）。
 * - type='text'：content 为文案，可含 `{变量}` 插槽
 * - type='image'：content 为 Logo 图片标识/路径（读取由渲染编排层负责）
 * - type='divider'：按纸宽打印分隔线
 */
export interface Section {
  type: SectionType
  content?: string
  align?: LineAlign
  size?: SectionSize
  bold?: boolean
}

/**
 * 商品明细表段落（固定四列：名称/数量/单价/小计——收银小票固有结构）。
 * 仅开放段落级配置（G14：不做逐行/逐列拖拽编辑）。
 */
export interface ItemsSection {
  type: 'items'
  /** 是否打印列头行，默认 true */
  showHeader?: boolean
  /** 列头文案（默认 商品/数量/单价/小计） */
  nameLabel?: string
  qtyLabel?: string
  priceLabel?: string
  subtotalLabel?: string
}

/** 合计区行（label 可含 `{变量}` 插槽，如 `合计: ￥{total}`） */
export interface TotalLine {
  type: 'total'
  label: string
  align?: LineAlign
  bold?: boolean
  size?: SectionSize
}

/** 小票模板（print_templates.config_json 的 JSON 结构） */
export interface ReceiptTemplate {
  /** 纸宽：决定网格列数（58mm=32 列 / 80mm=48 列，见 char-grid） */
  paperWidth: PaperWidth
  header: Section[]
  items: ItemsSection
  totals: TotalLine[]
  footer: Section[]
  /** 是否自动切纸（ESC/POS GS V） */
  cutPaper: boolean
}

/**
 * 小票变量插槽值（金额/数量均为**已格式化字符串**——整数分 → 元
 * 的格式化由渲染编排层在 vars 组装时完成，模板层只做文本替换，G1）。
 * 额外变量可经 index signature 扩展（如 companyFooter）。
 */
export interface ReceiptVars {
  shopName: string
  shopPhone: string
  receiptNote: string
  saleNo: string
  datetime: string
  /** 合计金额（元，已格式化，如 '12.00'） */
  total: string
  /** 总件数（已格式化） */
  itemCount: string
  companyFooter?: string
  [key: string]: string | undefined
}

/**
 * `{变量}` 插槽替换：已知插槽替换为 vars 值，未知插槽保留原文。
 * 使用 function replacer——变量值中的 `$&`/`$1` 等 replace 元字符
 * 按字面量插入，不被二次解释。
 */
export function interpolateVariables(content: string, vars: ReceiptVars): string {
  return content.replace(/\{(\w+)\}/g, (original, name: string) => {
    const value = vars[name]
    return value !== undefined ? value : original
  })
}
