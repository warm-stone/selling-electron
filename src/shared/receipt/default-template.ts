/**
 * 内置默认小票模板（80mm 主 + 58mm 变体，D8 双纸宽）。
 *
 * 作为 print_templates 表的出厂默认与「恢复默认」基准。
 * 金额用全角人民币符号 '￥'（U+FFE5，GBK 0xA3A4 确定可编码，
 * 避免半角 '¥' U+00A5 触发 GBK 降级 '?'——D20）。
 */

import type { PaperWidth } from './char-grid'
import type { ReceiptTemplate } from './template-schema'

/** 80mm 默认模板（48 列） */
export const DEFAULT_TEMPLATE_80MM: ReceiptTemplate = {
  paperWidth: '80mm',
  header: [
    { type: 'text', content: '{shopName}', align: 'center', size: 'doubleHeight', bold: true },
    { type: 'text', content: '{shopPhone}', align: 'center' },
    { type: 'divider' }
  ],
  items: { type: 'items', showHeader: true },
  totals: [
    { type: 'total', label: '件数: {itemCount}', align: 'right' },
    { type: 'total', label: '合计: ￥{total}', align: 'right', bold: true }
  ],
  footer: [
    { type: 'text', content: '{datetime}', align: 'center' },
    { type: 'text', content: '谢谢惠顾', align: 'center' }
  ],
  cutPaper: true
}

/** 58mm 默认模板变体（32 列，段落结构与 80mm 同构） */
export const DEFAULT_TEMPLATE_58MM: ReceiptTemplate = {
  paperWidth: '58mm',
  header: [
    { type: 'text', content: '{shopName}', align: 'center', size: 'doubleHeight', bold: true },
    { type: 'text', content: '{shopPhone}', align: 'center' },
    { type: 'divider' }
  ],
  items: { type: 'items', showHeader: true },
  totals: [
    { type: 'total', label: '件数: {itemCount}', align: 'right' },
    { type: 'total', label: '合计: ￥{total}', align: 'right', bold: true }
  ],
  footer: [
    { type: 'text', content: '{datetime}', align: 'center' },
    { type: 'text', content: '谢谢惠顾', align: 'center' }
  ],
  cutPaper: true
}

/** 按纸宽取默认模板（出厂 seed / 恢复默认用） */
export const DEFAULT_TEMPLATES: Record<PaperWidth, ReceiptTemplate> = {
  '58mm': DEFAULT_TEMPLATE_58MM,
  '80mm': DEFAULT_TEMPLATE_80MM
}
