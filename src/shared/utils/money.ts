/**
 * 金额格式化纯函数（display-ready 约定的唯一实现，G1）。
 *
 * 「整数分存储、UI/导出层格式化」的格式化端：全应用统一经本模块完成
 * 分 ↔ 元字符串换算（T15 组装 ReceiptVars / T12 预览 demo / T18 报表导出）。
 *
 * 格式定案：**'12.50' 形态——恰好 2 位小数、无千分位分隔符**。
 * 零浮点金额运算：整数十进制搬移（字符串拼接 + 整数取模）。
 * **纯函数，零 Node/Electron/DOM 依赖**，主/渲染两侧可 import。
 */

/**
 * 整数分 → 元字符串（'12.50'；负数 '-12.50'）。
 * 非整数分输入按 Math.trunc 截断（防御性文档化行为；入参契约仍为整数分）。
 */
export function formatMoney(cents: number): string {
  // 先 trunc 再判符号：-0.5 → trunc -0 → 符号为空（避免 '-0.00' 伪负零）
  const t = Math.trunc(cents)
  const sign = t < 0 ? '-' : ''
  const abs = Math.abs(t)
  const yuan = Math.floor(abs / 100)
  const fen = abs % 100
  return `${sign}${yuan}.${String(fen).padStart(2, '0')}`
}

/**
 * 元字符串 → 整数分（'12.50' → 1250；'12.5'/'12' 容忍；trim 容忍）。
 * 非法输入（含千分位/全角/3 位小数/空串等）返回 **NaN**。
 * 整数十进制搬移，零浮点运算（G1）。
 */
export function parseMoneyToCents(yuan: string): number {
  const t = yuan.trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return Number.NaN
  const [intPart, decPart = ''] = t.split('.')
  const dec = decPart.padEnd(2, '0')
  return Number(intPart + dec)
}
