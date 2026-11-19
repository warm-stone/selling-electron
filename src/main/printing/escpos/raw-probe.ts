/**
 * RAW 编码探针字节装配（F1 / v2）——纯函数零 I/O（G6）。
 *
 * 一张纸上按顺序打八段，每段验证一种固件能力假设；纸上结果直接决定 spooler 通道的
 * 修法（判读表在 shared/printing/raw-probe.ts，与本模块共用段标签常量）。
 *
 * 装配方式与生产链路同源：同样用 node-thermal-printer 的 EPSON 装配器
 * （breakLine NONE + 列宽由 PAPER_COLUMNS 派生），S3 走 `setCharacterSet(CHINA)`
 * + `FS &` + `println(中文)`——库内部按 EUC-CN 逐字转码，产出的字节与应用当前
 * spooler 打印链逐字节相同（实测 `中文测试 A1` → d6d0 cec4 b2e2 cad4 20 41 31）。
 * S2/S5/S6 用 `add(Buffer)` 直发 UTF-8 绕开库的码页转码；S4/S8 复用 buildLogoRaster
 * （Logo 打印同一条 GS v 0 路径）。
 *
 * **v1（S1–S4）与 v2（S5–S8）的分工**——v1 只测了「汉字模式 × 编码」矩阵的对角线：
 *
 * | 发的字节 | 汉字模式 OFF | 汉字模式 ON（GB18030） | 汉字模式 ON（UTF-8） |
 * |---|---|---|---|
 * | GBK    | —          | **S3** | 错配（不必测） |
 * | UTF-8  | **S2**     | **S6**（v2 补齐：固件可能不看声明、自行识别 UTF-8） | **S5**（v2 核心） |
 *
 * 得力 DL-5801PW 的 v1 实测（20261118）：S1 ASCII 正常、S4 光栅黑块正常，S2/S3 的中文
 * 都不出且 `A1` 前空白格数 ≈ 该段高位字节数（S2 18 / S3 12）→ 高位字节被吃掉不画点。
 * 但「空白」有两种成因（解码器缺失 / 字库缺字），v1 分不开；v2 用三段把它切开：
 *  - **S5**：`FS #`（UTF-8 汉字模式）+ 与 S2 逐字节相同的 UTF-8 流 → 出真中文 = 有字库、
 *    只是主机侧用错汉字模式（修法 = 生产链路改发 `FS #` + UTF-8，无需光栅）；出**空心
 *    方框** = 解码正常但字库缺字（无中文字库的铁证）；纯空白 = `FS #` 被当无效指令忽略。
 *  - **S7**：直发 PC866 的 0x80–0x8F（自检页显示该机当前单字节页就是 PC866），不发任何
 *    模式指令、也不切代码页 → 出西里尔字母 = 单字节高位能出墨，则 S2/S3 的空白只能来自
 *    双字节路径；仍空白 = 固件对所有 ≥0x80 一律不出墨。
 *  - **S8**：满宽光栅尺寸阶梯（32 / 170 / 400 行）→ 夹出单条 `GS v 0` 的数据量上限
 *    （克隆固件常见限制 `(宽×高)/8` 小于 8K，384 点宽时约 170 行），决定将来做全页
 *    光栅时的分带高度。S4 那块 96×32（384 字节）太小，证明不了大光栅能过。
 *
 * 载荷体积（v2 实测）：58mm = 30064 字节 / 80mm = 44672 字节，base64 后分别为
 * 40088 / 59564 字符，**均超过 `SPOOLER_STDIN_BASE64_LIMIT`(24000)** → 探针在真机走
 * spooler 的 stdin 传输分支（`[Console]::In.ReadToEnd()`），不再内联在命令行里。
 * 该分支此前只有 fake execFile 的单测覆盖，探针纸是它的首个真机验证载体。
 */
import { BreakLine, CharacterSet, PrinterTypes, ThermalPrinter } from 'node-thermal-printer'
import { PNG } from 'pngjs'
import { PAPER_COLUMNS, type PaperWidth } from '../../../shared/receipt/char-grid'
import { RAW_PROBE_SEGMENT_LABELS } from '../../../shared/printing/raw-probe'
import {
  feedLines,
  FS_HANZI_MODE,
  FS_HANZI_MODE_OFF,
  FS_KANJI_UTF8_MODE,
  HW_INIT
} from './commands'
import { buildLogoRaster, PAPER_DOTS } from './raster'

/** S2/S3/S5/S6 用同一句样本：纸上四段逐字相同，差异只可能来自编码与汉字模式声明 */
const CJK_SAMPLE = '中文测试 你好 A1'

/** S1 的英文样本（截到列宽内——超宽会折行，干扰「尺子在哪被截断」的判读） */
const ASCII_SAMPLE = 'The quick brown fox 0123456789'

/** S4 黑块尺寸（点）：203dpi 下约 12mm×4mm，肉眼不会看漏；宽度须 ≤ PAPER_DOTS */
const RASTER_WIDTH_DOTS = 96
const RASTER_HEIGHT_DOTS = 32

/**
 * S8 尺寸阶梯行数（满宽）：58mm 下 32 行 = 1.5KB（基线，必出）、
 * 170 行 = 8160B（刚好卡在 8KB 限制**之内**）、400 行 = 19.2KB（刚好在其**外**）
 * ——一次打印即可把单条 `GS v 0` 的阈值夹出来。不取更大值：满幅黑块连续加热会触发
 * 打印头热保护（后半段变淡），干扰「固件拒收」与「热保护」的判读。
 */
const RASTER_LADDER_ROWS: readonly number[] = [32, 170, 400]

/**
 * S7 单字节高位样本：PC866 的 0x80–0x8F 应打成 `А Б В Г Д Е Ж З И Й К Л М Н О П`。
 * **刻意不发 `ESC t n` 切代码页**——克隆机的 PC866 编号不统一（AURES 表 n=17、
 * RD 表 n=10），自检页已证明当前页就是 PC866，切页反而引入新变量。
 */
const PC866_HIGH_BYTES = Buffer.from([
  0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f
])

/** 末尾走纸行数（不切纸——见 commands.feedLines） */
const TRAILER_FEED_LINES = 4

/** 全黑 PNG（RGBA 逐点填黑）：S4 的小黑块与 S8 的满宽阶梯共用 */
function blackPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height })
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
  // S2/S5/S6 共用的 UTF-8 字节（三段必须逐字节相同，差异只可能来自模式指令）
  const utf8Sample = Buffer.from(CJK_SAMPLE, 'utf8')
  const dots = PAPER_DOTS[paperWidth]

  printer.add(HW_INIT)

  // ── S1 ASCII 基线（通道/走纸/右边界的前提验证）──
  printer.println(border)
  printer.println(RAW_PROBE_SEGMENT_LABELS.ascii)
  printer.println(ruler)
  printer.println(ASCII_SAMPLE.slice(0, cols))

  // ── S2 UTF-8 原字节，不进任何汉字模式 ──
  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.utf8)
  printer.add(utf8Sample)
  printer.newLine()

  // ── S3 GBK + FS &（与应用生产 spooler 链逐字节同源）──
  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.gbk)
  printer.setCharacterSet(CharacterSet.CHINA)
  printer.add(FS_HANZI_MODE)
  printer.println(CJK_SAMPLE)
  printer.add(FS_HANZI_MODE_OFF)

  // ── S4 光栅基线（96×32 小黑块）：必须是整页**第一条** GS v 0（单测按首条定位）──
  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.raster)
  printer.add(buildLogoRaster(blackPng(RASTER_WIDTH_DOTS, RASTER_HEIGHT_DOTS), paperWidth))

  // ── S5 UTF-8 + FS #（UTF-8 汉字模式）：v2 核心段 ──
  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.utf8FsHash)
  printer.add(FS_KANJI_UTF8_MODE)
  printer.add(utf8Sample)
  printer.newLine()
  printer.add(FS_HANZI_MODE_OFF)

  // ── S6 UTF-8 + FS &（声明 GB18030 但喂 UTF-8）：补齐矩阵错配格 ──
  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.utf8FsAmp)
  printer.add(FS_HANZI_MODE)
  printer.add(utf8Sample)
  printer.newLine()
  printer.add(FS_HANZI_MODE_OFF)

  // ── S7 单字节高位出墨验证（PC866 0x80–0x8F，不切代码页、不进汉字模式）──
  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.highBytes)
  printer.add(PC866_HIGH_BYTES)
  printer.newLine()

  // ── S8 满宽光栅尺寸阶梯（夹出单条 GS v 0 的数据量上限 → 全页光栅的分带高度）──
  printer.println(divider)
  printer.println(RAW_PROBE_SEGMENT_LABELS.rasterLadder)
  RASTER_LADDER_ROWS.forEach((rows, i) => {
    // 子标签只含 ASCII（32 列内），纸上据此对号每块黑条的行数
    printer.println(`[S8${String.fromCharCode(97 + i)}] ${rows} rows x ${dots} dots`)
    printer.add(buildLogoRaster(blackPng(dots, rows), paperWidth))
  })

  printer.println(border)
  printer.println('END OF PROBE')
  printer.add(feedLines(TRAILER_FEED_LINES))

  return new Uint8Array(printer.getBuffer())
}
