import { describe, expect, it } from 'vitest'
import { BreakLine, PrinterTypes, ThermalPrinter } from 'node-thermal-printer'
import { PNG } from 'pngjs'

import { buildLogoRaster, PAPER_DOTS } from '../../../src/main/printing/escpos/raster'

/**
 * raster.ts（Logo 光栅自研装配）单元测试矩阵。
 *
 * 维度：m=0x00 规范头（1d 76 30 00）/ 16×16 已知图逐字节 / 与库
 * printImageBuffer 数据段逐字节交叉验证（观感不变）/ 超宽钳制 384/576
 * 等比下采样 / 8 点向下对齐 / 小图零放大（纸宽内不缩放）/ 宽 <8 钳最小
 * 光栅宽 8 / 阈值语义逐位镜像库 epson.js / 高度 16 位 yL+yH（Logo 均
 * 小图，无需拆段——此处以 yH≠0 用例留档单条指令即可覆盖）。
 */

// ─────────────────────────── 测试辅助 ───────────────────────────

/** 十六进制字节序列断言辅助：seq(0x1d, 0x76, 0x30, 0x00) */
function seq(...bytes: number[]): Buffer {
  return Buffer.from(bytes)
}

/** 纯黑 / 纯白像素（RGBA） */
const BLACK: readonly number[] = [0, 0, 0, 255]
const WHITE: readonly number[] = [255, 255, 255, 255]

/** 确定性 PNG：paint(x, y) → [r, g, b, a]（像素固定 → 光栅字节跨环境稳定） */
function makePng(
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly number[]
): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y)
      const idx = (y * width + x) * 4
      png.data[idx] = r
      png.data[idx + 1] = g
      png.data[idx + 2] = b
      png.data[idx + 3] = a
    }
  }
  return PNG.sync.write(png)
}

/** 左半黑右半白（竖分割）：等比重采样后分割仍居中——x 映射错必现半侧翻转/偏移 */
function vSplit(width: number): (x: number, _y: number) => readonly number[] {
  return (x, _y) => (x < width / 2 ? BLACK : WHITE)
}

/** 竖分割图的期望光栅数据：每行前半字节 0xFF、后半 0x00 */
function expectedVSplitData(bytesPerRow: number, rows: number): Buffer {
  const row = Buffer.concat([Buffer.alloc(bytesPerRow / 2, 0xff), Buffer.alloc(bytesPerRow / 2, 0x00)])
  return Buffer.concat(Array.from({ length: rows }, () => row))
}

// ═════════════════════════════════════════════════════════════════

describe('raster.ts PAPER_DOTS（纸宽打印头点数）', () => {
  it('58mm=384 / 80mm=576（12 点/字符列 × PAPER_COLUMNS 32/48 同源几何）', () => {
    expect(PAPER_DOTS).toEqual({ '58mm': 384, '80mm': 576 })
  })
})

describe('raster.ts buildLogoRaster（纯函数：PNG → GS v 0）', () => {
  it('光栅头模式 m 发规范值 0x00（1d 76 30 00）；库默认 0x30（Epson ASCII 别名）不得出现', () => {
    const raster = buildLogoRaster(makePng(16, 8, vSplit(16)), '80mm')
    expect(raster.subarray(0, 4)).toEqual(seq(0x1d, 0x76, 0x30, 0x00))
    expect(raster.includes(seq(0x1d, 0x76, 0x30, 0x30))).toBe(false)
  })

  it('16×16 已知图（上半黑下半白）逐字节精确：头 1d 76 30 00 02 00 10 00 + FF×16 + 00×16', () => {
    const png = makePng(16, 16, (_x, y) => (y < 8 ? BLACK : WHITE))
    const expected = Buffer.concat([
      seq(0x1d, 0x76, 0x30, 0x00, 0x02, 0x00, 0x10, 0x00),
      Buffer.alloc(16, 0xff), // 上半 8 行 × 每行 2 字节全黑
      Buffer.alloc(16, 0x00) // 下半 8 行 × 每行 2 字节全白
    ])
    expect(Buffer.compare(buildLogoRaster(png, '58mm'), expected)).toBe(0)
    expect(Buffer.compare(buildLogoRaster(png, '80mm'), expected)).toBe(0)
  })

  it('已对齐小图与库 printImageBuffer 数据段逐字节一致（观感不变交叉验证），仅 m 字节差异 00 vs 30', async () => {
    // 16×8 棋盘（与 escpos-generator.test.ts 同款确定性图）
    const checker = (x: number, y: number): readonly number[] =>
      (x + y) % 2 === 0 ? BLACK : WHITE
    const png = makePng(16, 8, checker)
    const lib = await new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: 'file',
      width: 48,
      breakLine: BreakLine.NONE
    }).printImageBuffer(png)
    const mine = buildLogoRaster(png, '80mm')
    // 库头 1d 76 30 30 …，自研头 1d 76 30 00 …——xL xH yL yH 与数据段全同
    expect(lib.subarray(0, 4)).toEqual(seq(0x1d, 0x76, 0x30, 0x30))
    expect(mine.subarray(3, 4)).toEqual(seq(0x00))
    expect(mine.subarray(4)).toEqual(lib.subarray(4))
  })

  // ── 超宽钳制（纸宽点数上限）+ 等比下采样 ──

  it('58mm 超宽钳制：768×256 → 384 宽（xL=48）、等比高度 128（yL=0x80），竖分割居中保持', () => {
    const mine = buildLogoRaster(makePng(768, 256, vSplit(768)), '58mm')
    const expected = Buffer.concat([
      seq(0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 0x80, 0x00),
      expectedVSplitData(48, 128)
    ])
    expect(mine.length).toBe(8 + 48 * 128)
    expect(Buffer.compare(mine, expected)).toBe(0)
  })

  it('80mm 超宽钳制：1152×384 → 576 宽（xL=72=0x48）、等比高度 192（yL=0xc0）', () => {
    const mine = buildLogoRaster(makePng(1152, 384, vSplit(1152)), '80mm')
    expect(mine.subarray(0, 8)).toEqual(seq(0x1d, 0x76, 0x30, 0x00, 0x48, 0x00, 0xc0, 0x00))
    expect(mine.length).toBe(8 + 72 * 192)
  })

  it('等比高度舍入：58mm 400×123 → 384 宽、高度 round(123 × 384/400)=118（yL=0x76）', () => {
    const mine = buildLogoRaster(makePng(400, 123, vSplit(400)), '58mm')
    expect(mine.subarray(0, 8)).toEqual(seq(0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 0x76, 0x00))
    expect(mine.length).toBe(8 + 48 * 118)
  })

  // ── 8 点向下对齐 ──

  it('纸宽内未对齐：100×40 → 向下对齐 96 宽（xL=12）、高度 round(40 × 0.96)=38', () => {
    const mine = buildLogoRaster(makePng(100, 40, vSplit(100)), '58mm')
    expect(mine.subarray(0, 8)).toEqual(seq(0x1d, 0x76, 0x30, 0x00, 0x0c, 0x00, 0x26, 0x00))
    expect(mine.length).toBe(8 + 12 * 38)
  })

  it('对齐与 yH 组合：390×390（80mm 纸宽内）→ 对齐 384 宽、高 384 → yL=0x80 yH=0x01 单条指令（高度不拆段）', () => {
    const mine = buildLogoRaster(makePng(390, 390, vSplit(390)), '80mm')
    expect(mine.subarray(0, 8)).toEqual(seq(0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 0x80, 0x01))
    expect(mine.length).toBe(8 + 48 * 384)
  })

  // ── 小图零放大（纸宽内不缩放，不拉伸到全纸宽）──

  it('64×32 小图（80mm）→ 原尺寸 64×32（xL=8/yL=0x20），不放大到 576', () => {
    const mine = buildLogoRaster(makePng(64, 32, vSplit(64)), '80mm')
    const expected = Buffer.concat([
      seq(0x1d, 0x76, 0x30, 0x00, 0x08, 0x00, 0x20, 0x00),
      expectedVSplitData(8, 32)
    ])
    expect(mine.length).toBe(8 + 8 * 32)
    expect(Buffer.compare(mine, expected)).toBe(0)
  })

  it('32×8 小图（58mm）→ 原尺寸（xL=4/yL=8）', () => {
    const mine = buildLogoRaster(makePng(32, 8, vSplit(32)), '58mm')
    expect(mine.subarray(0, 8)).toEqual(seq(0x1d, 0x76, 0x30, 0x00, 0x04, 0x00, 0x08, 0x00))
    expect(mine.length).toBe(8 + 4 * 8)
  })

  it('宽 <8 极小图：4×2 纯黑 → 最小光栅宽 8、等比放大 8×4（光栅最小 1 字节/行）', () => {
    const mine = buildLogoRaster(makePng(4, 2, () => BLACK), '58mm')
    const expected = seq(0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x04, 0x00, 0xff, 0xff, 0xff, 0xff)
    expect(Buffer.compare(mine, expected)).toBe(0)
  })

  // ── 阈值语义（逐位镜像库 epson.js，保证升级前后观感一致）──

  it('alpha 阈值：alpha=126 透明（黑 RGB 也不印）、alpha=127 不透明黑 → 印', () => {
    const mine = buildLogoRaster(
      makePng(16, 1, (x, _y) => (x < 8 ? [0, 0, 0, 126] : [0, 0, 0, 127])),
      '80mm'
    )
    expect(mine.subarray(0, 8)).toEqual(seq(0x1d, 0x76, 0x30, 0x00, 0x02, 0x00, 0x01, 0x00))
    expect(mine.subarray(8)).toEqual(seq(0x00, 0xff))
  })

  it('灰度阈值：灰 127（0.2126R+0.7152G+0.0722B 截断=127）< 128 黑；灰 128 不黑', () => {
    const mine = buildLogoRaster(
      makePng(16, 1, (x, _y) => (x < 8 ? [127, 127, 127, 255] : [128, 128, 128, 255])),
      '80mm'
    )
    expect(mine.subarray(8)).toEqual(seq(0xff, 0x00))
  })

  it('高度 16 位路径：8×600 → yL=0x58 yH=0x02（600 行单条 GS v 0，Logo 小图无需拆段）', () => {
    const mine = buildLogoRaster(makePng(8, 600, () => BLACK), '58mm')
    expect(mine.subarray(0, 8)).toEqual(seq(0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x58, 0x02))
    expect(mine.length).toBe(8 + 600)
  })
})
