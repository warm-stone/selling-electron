/**
 * items 四列网格契约（G7 双渲染器同源，Task 12 上提）。
 *
 * 历史：ITEM_COLUMN_WIDTHS 与组合语义原定义于主进程侧 escpos-generator.ts
 * （Task 4，G7 契约缺口已记录 .omo/notepads/pos-electron-app/issues.md）——
 * HTML 预览（renderer）无法 import。本模块将其上提到 shared，ESC/POS 生成器
 * 与 ReceiptPreview（HTML）自此共用同一函数与列宽常量。
 *
 * **纯函数，零 Node/Electron/DOM 依赖**（iconv 等降级实现不可出现在此——
 * GBK 降级经 `degrade` 参数由调用方注入：生成器传 degradeToGbk，
 * 预览默认恒等，见 buildItemLine）。
 */

import { padLine, truncateToGrid, type PaperWidth } from './char-grid'

// ═════════════════════ 数据契约（打印/预览共用，display-ready） ═════════════════════

/**
 * 小票明细行（display-ready：数量/单价/小计均为**已格式化字符串**，
 * 由打印编排层（T15）组装时经 shared/utils/money formatMoney 完成
 * 整数分 → 元的格式化——模板/生成器层零金额运算，G1）。
 */
export interface ReceiptItemLine {
  /** 商品名（快照；打印侧生成器注入 GBK 降级，预览侧原样渲染） */
  name: string
  /** 数量（已格式化，如 '2'） */
  quantity: string
  /** 单价（元，已格式化，如 '3.50'） */
  unitPrice: string
  /** 小计（元，已格式化） */
  subtotal: string
}

/** 小票打印数据（明细行集合；单号/时间等经 ReceiptVars 插槽传入） */
export interface SaleReceiptData {
  items: ReceiptItemLine[]
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
 * items 表列宽（name + qty + price + subtotal = PAPER_COLUMNS，T4 冻结值）。
 * 两种渲染器共用（列宽换算 %、行组合、golden 字节几何均以此为唯一基准）。
 */
export const ITEM_COLUMN_WIDTHS: Record<PaperWidth, ItemColumnWidths> = {
  // 58mm：12 + 4 + 8 + 8 = 32 列
  '58mm': { name: 12, qty: 4, price: 8, subtotal: 8 },
  // 80mm：24 + 4 + 10 + 10 = 48 列
  '80mm': { name: 24, qty: 4, price: 10, subtotal: 10 }
}

/**
 * 文本降级函数：字符集降级（如 GBK 外字符 → '?'）由调用方注入。
 * 降级会改变显示宽度（宽字符 → 半角 '?'），必须发生在截断之前，
 * 见 buildItemLine 的组合顺序。
 */
export type TextDegrader = (text: string) => string

/**
 * 组合一行 items 网格行（G7 同源：ESC/POS 生成器与 HTML 预览的唯一实现）。
 *
 * 组合顺序（char-grid 冻结契约）：**降级 → truncate → pad**。
 * 拼接后行宽恰为 PAPER_COLUMNS（打印侧几何自洽；与共享 char-grid 同一
 * 顺序组合——两种渲染路径产物几何一致）。
 *
 * - `degrade` 默认恒等：renderer 预览无 iconv（G8 零 Node 依赖），
 *   GBK 外字符按原文渲染（与打印侧 '?' 降级的差异已文档化——
 *   GBK 内业务文本两侧行集完全一致）；
 *   ESC/POS 生成器传入 degradeToGbk（gb2312-encoder）。
 * - 名称列左对齐，数量/单价/小计列右对齐。
 */
export function buildItemLine(
  name: string,
  qty: string,
  price: string,
  subtotal: string,
  paperWidth: PaperWidth,
  degrade: TextDegrader = (s) => s
): string {
  const w = ITEM_COLUMN_WIDTHS[paperWidth]
  return (
    padLine(truncateToGrid(degrade(name), w.name), w.name) +
    padLine(truncateToGrid(degrade(qty), w.qty), w.qty, 'right') +
    padLine(truncateToGrid(degrade(price), w.price), w.price, 'right') +
    padLine(truncateToGrid(degrade(subtotal), w.subtotal), w.subtotal, 'right')
  )
}
