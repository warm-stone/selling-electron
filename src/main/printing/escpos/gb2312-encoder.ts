/**
 * GBK（EUC-CN）编码与生僻字符降级（D20）。
 *
 * 链路与 node-thermal-printer 的 CHINA 代码页完全一致：
 * `setCharacterSet(CharacterSet.CHINA)` → epson-config `CODE_PAGES.CHINA: 'EUC-CN'`
 * → ThermalPrinter.append() 内部 iconv-lite 'EUC-CN' 逐字符编码。
 *
 * 关键约束：GBK 外字符若原样交给 ThermalPrinter，库内 append() 的回退逻辑会
 * 遍历全部代码页尝试改页编码（如 EUC-JP/Big5 命中时插入代码页切换指令），
 * 污染 GBK 字节流。因此打印文本必须**先经 degradeToGbk 降级**再交给库——
 * 降级后每个字符都确定可编码，库内回退分支永不触发，字节流确定、可重放。
 *
 * 纯函数，零 I/O（G6）。
 */

import * as iconv from 'iconv-lite'

/** CHINA 代码页在 iconv-lite 的编码名（与 node-thermal-printer 打印链路同一 codec） */
export const GBK_ENCODING = 'EUC-CN'

/** 单个字符是否可被 GBK（EUC-CN）编码（roundtrip 判定——与打印链路零偏差） */
function isCharGbkEncodable(ch: string): boolean {
  // iconv-lite 对无映射字符编码为 '?'（0x3F），roundtrip 不等即判为 GBK 外
  return iconv.decode(iconv.encode(ch, GBK_ENCODING), GBK_ENCODING) === ch
}

/**
 * 文本 → GBK 字节（诊断/测试辅助）。
 * 注意：直接对含 GBK 外字符的文本调用本函数会得到 '?'（0x3F）占位——
 * 生产路径一律走 degradeToGbk + ThermalPrinter（显式降级可审计）。
 */
export function encodeGbk(text: string): Buffer {
  return iconv.encode(text, GBK_ENCODING)
}

/** 检测文本是否含 GBK 外生僻字符（如 CJK 扩展 B '𠀀'、半角 '¥' U+00A5） */
export function detectNonGbk(text: string): boolean {
  for (const ch of text) {
    if (!isCharGbkEncodable(ch)) return true
  }
  return false
}

/**
 * D20 降级：GBK 外字符替换为 '?'（半角，显示宽 1）。
 * 降级后的文本交给 char-grid 计算列宽（padLine/truncateToGrid），
 * 保证打印侧几何自洽；按 code point 迭代，代理对整体替换为单个 '?'。
 */
export function degradeToGbk(text: string): string {
  if (!detectNonGbk(text)) return text
  let result = ''
  for (const ch of text) {
    result += isCharGbkEncodable(ch) ? ch : '?'
  }
  return result
}
