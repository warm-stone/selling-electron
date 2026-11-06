/**
 * 字符网格数学（G7 双渲染器同源）。
 *
 * ESC/POS 生成器（src/main/printing/escpos/）与 HTML 预览
 * （src/renderer/.../receipt/）共用本模块做列宽对齐/截断计算，
 * 保证两种渲染路径产物几何一致。**纯函数，零 Node/Electron/DOM 依赖**，
 * 主进程与渲染进程两侧均可 import（这是 G7 的前提）。
 */

/** 纸宽物理列数：58mm 热敏纸 32 列 / 80mm 热敏纸 48 列（D8） */
export type PaperWidth = '58mm' | '80mm'

/** 行对齐方式（文本段落与网格行共用） */
export type LineAlign = 'left' | 'center' | 'right'

export const PAPER_COLUMNS: Record<PaperWidth, number> = {
  '58mm': 32,
  '80mm': 48
}

/**
 * 单个 Unicode code point 的显示宽度。
 * 全角（CJK/全角形式/emoji）= 2，半角 = 1，变体选择符 = 0。
 */
function codePointWidth(cp: number): number {
  // 变体选择符（U+FE0E 文本样式 / U+FE0F emoji 样式）：零宽组合标记
  if (cp === 0xfe0e || cp === 0xfe0f) return 0
  return isWideCodePoint(cp) ? 2 : 1
}

/** East Asian Wide/Fullwidth 判定（覆盖 POS 场景常见区间，emoji 按宽 2） */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首/康熙/注音/假名/CJK 统一表意/谚文兼容
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe10 && cp <= 0xfe19) || // 竖排形式
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式（ＡＢ、：等）
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号（￥ 等）
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji（UTF-16 代理对区，宽 2）
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // emoji 交通/符号
    (cp >= 0x1f900 && cp <= 0x1faff) || // emoji 补充
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以上（代理对区）
  )
}

/**
 * 字符串显示宽度：全角=2、半角=1（G7 同源数学）。
 * 按 code point 迭代（`for...of`），UTF-16 代理对安全：
 * emoji（如 U+1F600）与 CJK 扩展 B（如 U+20000）各按宽 2 计，
 * 不会把一个代理对拆成两个半宽 code unit。
 */
export function stringWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    width += codePointWidth(ch.codePointAt(0) as number)
  }
  return width
}

/**
 * 按显示宽度截断到 cols 列，不越界、不产生孤立代理对（半个字符）。
 * 尾部放不下的宽字符（全角/emoji）直接舍弃，剩余宽度留空。
 */
export function truncateToGrid(s: string, cols: number): string {
  if (stringWidth(s) <= cols) return s
  let width = 0
  let result = ''
  for (const ch of s) {
    const w = codePointWidth(ch.codePointAt(0) as number)
    if (width + w > cols) break
    width += w
    result += ch
  }
  return result
}

/**
 * 将行补齐到 cols 显示宽度（半角空格填充）。
 * - left（默认）：右侧补空格
 * - right：左侧补空格
 * - center：左右均分，奇数余量左少右多
 *
 * 注意：本函数不截断超宽输入（pad 语义），调用方需超宽截断时应先
 * `truncateToGrid(s, cols)` 再 `padLine`（ESC/POS 生成器与 HTML 预览
 * 必须按同一顺序组合，保证同源）。
 */
export function padLine(s: string, cols: number, align: LineAlign = 'left'): string {
  const padTotal = Math.max(0, cols - stringWidth(s))
  let left = 0
  let right = 0
  if (align === 'right') {
    left = padTotal
  } else if (align === 'center') {
    left = Math.floor(padTotal / 2)
    right = padTotal - left
  } else {
    right = padTotal
  }
  return ' '.repeat(left) + s + ' '.repeat(right)
}

/**
 * 按显示宽度折行（word-wrap）：空格分词、逐 token 贪婪填充，
 * 超行宽 token 逐字符硬断（宽字符不拆半）。空串输入返回 ['']。
 *
 * - 断行不吞非空格字符（与 truncateToGrid 的「丢弃尾部」语义互补：
 *   超长文本折成多行而非截断）；空格是断点，断点处吞并
 *   （连续空格折叠、词间换行不留尾随/前导空格）；
 * - 按 code point 迭代（复用 codePointWidth），UTF-16 代理对安全；
 * - 每行显示宽度 ≤ cols；单个超宽字符（如 cols<2 时的 emoji）独占
 *   一行越界（不吞字符优先于不越界）；
 * - cols<=0 防御返回 [s]（正常调用方保证 cols 为正，此为脏值兜底）。
 */
export function wrapToGrid(s: string, cols: number): string[] {
  if (cols <= 0) return [s]
  if (s === '') return ['']

  const lines: string[] = []
  let current = ''
  let currentWidth = 0

  /** 追加一段宽度确定 ≤ cols 的文本（current 非空时词间补单空格；放不下则断行） */
  const appendPiece = (piece: string, pieceWidth: number): void => {
    if (current === '') {
      current = piece
      currentWidth = pieceWidth
      return
    }
    if (currentWidth + 1 + pieceWidth <= cols) {
      current += ' ' + piece
      currentWidth += 1 + pieceWidth
      return
    }
    lines.push(current)
    current = piece
    currentWidth = pieceWidth
  }

  for (const token of s.split(' ')) {
    if (token === '') continue // 连续/前后空格：视为断点折叠
    const tokenWidth = stringWidth(token)
    if (tokenWidth <= cols) {
      appendPiece(token, tokenWidth)
      continue
    }
    // token 自身超行宽：逐字符硬断（不拆宽字符，行内不越界）
    let piece = ''
    let pieceWidth = 0
    for (const ch of token) {
      const w = codePointWidth(ch.codePointAt(0) as number)
      if (pieceWidth + w > cols) {
        if (piece !== '') appendPiece(piece, pieceWidth)
        piece = ch
        pieceWidth = w
      } else {
        piece += ch
        pieceWidth += w
      }
    }
    if (piece !== '') appendPiece(piece, pieceWidth)
  }
  lines.push(current)
  return lines
}
