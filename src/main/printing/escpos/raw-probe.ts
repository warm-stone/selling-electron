/**
 * RAW 编码探针字节装配（F1）——纯函数零 I/O（G6）。
 *
 * 一张纸上按顺序打四段，每段验证一种编码假设；纸上结果直接决定 spooler 通道的
 * 修法（判读表在 shared/printing/raw-probe.ts，与本模块共用段标签常量）。
 *
 * 装配方式与生产链路同源：同样用 node-thermal-printer 的 EPSON 装配器
 * （breakLine NONE + 列宽由 PAPER_COLUMNS 派生），S3 走 `setCharacterSet(CHINA)`
 * + `FS &` + `println(中文)`——库内部按 EUC-CN 逐字转码，产出的字节与应用当前
 * spooler 打印链逐字节相同（实测 `中文测试 A1` → d6d0 cec4 b2e2 cad4 20 41 31）。
 * S2 用 `add(Buffer)` 直发 UTF-8 绕开库的码页转码；S4 复用 buildLogoRaster
 * （Logo 打印同一条 GS v 0 路径）。
 */
import { BreakLine, CharacterSet, PrinterTypes, ThermalPrinter } from 'node-thermal-printer'
import { PNG } from 'pngjs'
import { PAPER_COLUMNS, type PaperWidth } from '../../../shared/receipt/char-grid'
import { RAW_PROBE_SEGMENT_LABELS } from '../../../shared/printing/raw-probe'
import { feedLines, FS_HANZI_MODE, FS_HANZI_MODE_OFF, HW_INIT } from './commands'
import { buildLogoRaster } from './raster'

/** S2/S3 用同一句样本：纸上两段逐字相同，差异只可能来自编码 */
const CJK_SAMPLE = '中文测试 你好 A1'

/** S1 的英文样本（截到列宽内——超宽会折行，干扰「尺子在哪被截断」的判读） */
const ASCII_SAMPLE = 'The quick brown fox 0123456789'

/** S4 黑块尺寸（点）：203dpi 下约 12mm×4mm，肉眼不会看漏；宽度须 ≤ PAPER_DOTS */
const RASTER_WIDTH_DOTS = 96
const RASTER_HEIGHT_DOTS = 32

/** 末尾走纸行数（不切纸——见 commands.feedLines） */
const TRAILER_FEED_LINES = 4

function blackBlockPng(): Buffer {
  const png = new PNG({ width: RASTER_WIDTH_DOTS, height: RASTER_HEIGHT_DOTS })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0
    png.data[i + 1] = 0
    png.data[i + 2] = 0
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

export function buildRawProbeBytes(paperWidth: PaperWidth): Uint8Array {
  const cols = PAPER_COLUMNS[paperWidth]
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: 'file',
    width: cols,
    breakLine: BreakLine.NONE
  })
  const border = '='.repeat(cols)
  const divider = '-'.repeat(cols)
  // 列尺：数字循环填满整行——纸上被截断的位置就是该机 RAW 通道的实际右边界
  const ruler = '1234567890'.repeat(Math.ceil(cols / 10)).slice(0, cols)

  printer.add(HW_INIT)

  printer.println(border)
  printer.println(RAW_PROBE_SEGMENT_LABELS.ascii)
  printer.println(ruler)
  printer.println(ASCII_SAMPLE.slice(0, cols))

  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.utf8)
  printer.add(Buffer.from(CJK_SAMPLE, 'utf8'))
  printer.newLine()

  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.gbk)
  printer.setCharacterSet(CharacterSet.CHINA)
  printer.add(FS_HANZI_MODE)
  printer.println(CJK_SAMPLE)
  printer.add(FS_HANZI_MODE_OFF)

  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.raster)
  printer.add(buildLogoRaster(blackBlockPng(), paperWidth))

  printer.println(border)
  printer.println('END OF PROBE')
  printer.add(feedLines(TRAILER_FEED_LINES))

  return new Uint8Array(printer.getBuffer())
}
