import { describe, expect, it } from 'vitest'
import { SPOOLER_STDIN_BASE64_LIMIT } from '../../../src/main/printing/channels/spooler.channel'
import { encodeGbk } from '../../../src/main/printing/escpos/gb2312-encoder'
import { buildRawProbeBytes } from '../../../src/main/printing/escpos/raw-probe'
import { PAPER_DOTS } from '../../../src/main/printing/escpos/raster'
import { PAPER_COLUMNS } from '../../../src/shared/receipt/char-grid'
import {
  RAW_PROBE_READINGS,
  RAW_PROBE_SEGMENT_LABELS,
  RAW_PROBE_VERDICTS
} from '../../../src/shared/printing/raw-probe'

/** S2/S3/S5/S6 的样本句（与 builder 内部常量同值——四段必须逐字相同，差异只可能来自编码与汉字模式声明） */
const CJK_SAMPLE = '中文测试 你好 A1'

const FS_HANZI_ON = Buffer.from([0x1c, 0x26])
const FS_KANJI_UTF8 = Buffer.from([0x1c, 0x23])
const FS_HANZI_OFF = Buffer.from([0x1c, 0x2e])
const GS_RASTER = Buffer.from([0x1d, 0x76, 0x30])
const ESC_T = Buffer.from([0x1b, 0x74])
const FULL_CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00])
const FEED_4_LINES = Buffer.from([0x1b, 0x64, 0x04])

/** S7 的 PC866 高位字节样本（与 builder 内部常量同值） */
const PC866_HIGH_BYTES = Buffer.from([
  0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f
])

/** S8 阶梯行数（与 builder 同值；170×48=8160B 卡在 8KB 内，400 行在其外） */
const LADDER_ROWS = [32, 170, 400] as const

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function labelOffset(bytes: Uint8Array, id: keyof typeof RAW_PROBE_SEGMENT_LABELS, from = 0): number {
  return indexOfBytes(bytes, Buffer.from(RAW_PROBE_SEGMENT_LABELS[id], 'utf8'), from)
}

/** GS v 0 头之后的位图几何（字节宽/行数） */
function rasterGeometry(bytes: Uint8Array): { at: number; bytesWide: number; rows: number } {
  const at = indexOfBytes(bytes, GS_RASTER)
  expect(at).toBeGreaterThan(0)
  return {
    at,
    bytesWide: (bytes[at + 4] ?? 0) + (bytes[at + 5] ?? 0) * 256,
    rows: (bytes[at + 6] ?? 0) + (bytes[at + 7] ?? 0) * 256
  }
}

describe('RAW 编码探针（F1/v2——一张纸八段固件能力假设）', () => {
  it('八段按 S1→…→S8 顺序出现，且判读表逐段能在纸上找到（不留无解说的段）', () => {
    const bytes = buildRawProbeBytes('58mm')
    let prev = -1
    for (const id of [
      'ascii',
      'utf8',
      'gbk',
      'raster',
      'utf8FsHash',
      'utf8FsAmp',
      'highBytes',
      'rasterLadder'
    ] as const) {
      const at = labelOffset(bytes, id, prev + 1)
      expect(at, `段 ${id} 的标题必须在上一段之后`).toBeGreaterThan(prev)
      prev = at
    }
    expect(RAW_PROBE_READINGS.map((r) => r.id)).toEqual([
      'ascii',
      'utf8',
      'gbk',
      'raster',
      'utf8FsHash',
      'utf8FsAmp',
      'highBytes',
      'rasterLadder'
    ])
    for (const r of RAW_PROBE_READINGS) {
      expect(labelOffset(bytes, r.id)).toBeGreaterThan(-1)
      expect(r.bytes).not.toBe('')
      expect(r.ifWorks).not.toBe('')
      expect(r.ifFails).not.toBe('')
    }
    expect(RAW_PROBE_VERDICTS.length).toBeGreaterThan(0)
  })

  it('S1 是纯 ASCII 基线：ESC @ 开头，到 S2 标题为止没有任何高位字节', () => {
    const bytes = buildRawProbeBytes('58mm')
    expect(bytes[0]).toBe(0x1b)
    expect(bytes[1]).toBe(0x40)
    const head = bytes.slice(0, labelOffset(bytes, 'utf8'))
    expect(head.every((b) => b < 0x80)).toBe(true)
  })

  it('S1 数字尺长度 = 该纸列数（纸上被截断处即该机 RAW 通道的实际右边界）', () => {
    for (const paper of ['58mm', '80mm'] as const) {
      const bytes = buildRawProbeBytes(paper)
      const cols = PAPER_COLUMNS[paper]
      const ruler = Buffer.from(
        '1234567890'.repeat(Math.ceil(cols / 10)).slice(0, cols),
        'utf8'
      )
      expect(ruler.length).toBe(cols)
      expect(indexOfBytes(bytes, ruler)).toBeGreaterThan(0)
    }
  })

  it('S2 发 UTF-8 原始字节且不进汉字模式（FS & 只出现在 S3 之后）', () => {
    const bytes = buildRawProbeBytes('58mm')
    const s2 = labelOffset(bytes, 'utf8')
    const s3 = labelOffset(bytes, 'gbk')
    const utf8Sample = Buffer.from(CJK_SAMPLE, 'utf8')
    const utf8At = indexOfBytes(bytes, utf8Sample)
    expect(utf8At).toBeGreaterThan(s2)
    expect(utf8At).toBeLessThan(s3)
    expect(indexOfBytes(bytes, FS_HANZI_ON)).toBeGreaterThan(s3)
  })

  it('S3 与应用 spooler 链路同源：ESC R 15 + FS & 进汉字模式 + GBK 双字节 + FS . 退出', () => {
    const bytes = buildRawProbeBytes('58mm')
    const s3 = labelOffset(bytes, 'gbk')
    // setCharacterSet(CHINA) 发出的国际字符集指令（与生产字节逐字一致）
    expect(indexOfBytes(bytes, Buffer.from([0x1b, 0x52, 0x0f]), s3)).toBeGreaterThan(s3)
    const hanziOn = indexOfBytes(bytes, FS_HANZI_ON, s3)
    expect(hanziOn).toBeGreaterThan(s3)
    const gbkSample = encodeGbk(CJK_SAMPLE)
    const gbkAt = indexOfBytes(bytes, gbkSample, hanziOn)
    expect(gbkAt).toBeGreaterThan(hanziOn)
    // 退出汉字模式必须在 GBK 文本之后——否则光栅段的判读会被双字节配对污染
    expect(indexOfBytes(bytes, FS_HANZI_OFF, hanziOn)).toBeGreaterThan(gbkAt)
    // GBK 与 UTF-8 是两套不同字节：同一句话在纸上出现两次，但字节串各自只出现一次
    expect(indexOfBytes(bytes, gbkSample)).not.toBe(indexOfBytes(bytes, Buffer.from(CJK_SAMPLE, 'utf8')))
  })

  it('S4 是 GS v 0 光栅：m 发规范值 0x00，宽度按 8 点对齐并钳在纸宽点数内', () => {
    for (const paper of ['58mm', '80mm'] as const) {
      const bytes = buildRawProbeBytes(paper)
      const { at, bytesWide, rows } = rasterGeometry(bytes)
      expect(bytes[at + 3]).toBe(0x00) // m=0x30 会被克隆固件整条丢弃（raster.ts 真机结论）
      expect(bytesWide * 8).toBeLessThanOrEqual(PAPER_DOTS[paper])
      expect(bytesWide * 8).toBeGreaterThan(0)
      expect(rows).toBeGreaterThan(0)
      // 全黑实心块：探针要的是「有图/无图」的二元判读，不是图案
      const data = bytes.slice(at + 8, at + 8 + bytesWide * rows)
      expect(data.length).toBe(bytesWide * rows)
      expect(data.every((b) => b === 0xff)).toBe(true)
    }
  })

  it('S5 = FS # 进 UTF-8 汉字模式 + 与 S2 逐字节相同的 UTF-8 样本 + FS . 退出（v2 核心段）', () => {
    const bytes = buildRawProbeBytes('58mm')
    const s5 = labelOffset(bytes, 'utf8FsHash')
    const modeAt = indexOfBytes(bytes, FS_KANJI_UTF8, s5)
    expect(modeAt, 'FS # 必须在 S5 标题之后').toBeGreaterThan(s5)
    const sampleAt = indexOfBytes(bytes, Buffer.from(CJK_SAMPLE, 'utf8'), modeAt)
    expect(sampleAt, 'UTF-8 样本必须紧跟 FS # 之后').toBeGreaterThan(modeAt)
    // 退出必须在文本之后——否则 S6/S7/S8 的判读会被汉字模式污染
    expect(indexOfBytes(bytes, FS_HANZI_OFF, sampleAt)).toBeGreaterThan(sampleAt)
  })

  it('S6 = FS & 进汉字模式（声明 GB18030）却喂 UTF-8 字节（矩阵错配格）', () => {
    const bytes = buildRawProbeBytes('58mm')
    const s6 = labelOffset(bytes, 'utf8FsAmp')
    const modeAt = indexOfBytes(bytes, FS_HANZI_ON, s6)
    expect(modeAt).toBeGreaterThan(s6)
    const sampleAt = indexOfBytes(bytes, Buffer.from(CJK_SAMPLE, 'utf8'), modeAt)
    expect(sampleAt).toBeGreaterThan(modeAt)
    expect(indexOfBytes(bytes, FS_HANZI_OFF, sampleAt)).toBeGreaterThan(sampleAt)
  })

  it('S2/S5/S6 的 UTF-8 样本逐字节相同（同一句话纸上出现三次，差异只可能来自模式指令）', () => {
    const bytes = buildRawProbeBytes('58mm')
    const sample = Buffer.from(CJK_SAMPLE, 'utf8')
    const first = indexOfBytes(bytes, sample)
    const second = indexOfBytes(bytes, sample, first + 1)
    const third = indexOfBytes(bytes, sample, second + 1)
    expect(first).toBeGreaterThan(labelOffset(bytes, 'utf8'))
    expect(second).toBeGreaterThan(labelOffset(bytes, 'utf8FsHash'))
    expect(third).toBeGreaterThan(labelOffset(bytes, 'utf8FsAmp'))
  })

  it('S7 直发 PC866 高位字节 80..8F：不切代码页（无 ESC t）、不进任何汉字模式', () => {
    const bytes = buildRawProbeBytes('58mm')
    const s7 = labelOffset(bytes, 'highBytes')
    const at = indexOfBytes(bytes, PC866_HIGH_BYTES, s7)
    expect(at, '16 个高位字节必须在 S7 标题之后').toBeGreaterThan(s7)
    // 标题到样本之间必须「什么都不发」：切页会引入克隆机 ESC t 编号不一致的新变量，
    // 进汉字模式则测的是双字节路径而非单字节表——两者都会让本段失去判读力
    const gap = bytes.slice(s7, at)
    expect(indexOfBytes(gap, ESC_T)).toBe(-1)
    expect(indexOfBytes(gap, FS_HANZI_ON)).toBe(-1)
    expect(indexOfBytes(gap, FS_KANJI_UTF8)).toBe(-1)
  })

  it('S8 尺寸阶梯：三条满宽全黑 GS v 0（32/170/400 行），且 S4 仍是整页第一条光栅', () => {
    for (const paper of ['58mm', '80mm'] as const) {
      const bytes = buildRawProbeBytes(paper)
      const s4 = labelOffset(bytes, 'raster')
      const s8 = labelOffset(bytes, 'rasterLadder')
      // rasterGeometry() 按**首条** GS v 0 定位 → S4 必须仍是第一条，阶梯不得插到它前面
      const firstRaster = indexOfBytes(bytes, GS_RASTER)
      expect(firstRaster).toBeGreaterThan(s4)
      expect(firstRaster).toBeLessThan(s8)

      let cursor = s8
      for (const rows of LADDER_ROWS) {
        const at = indexOfBytes(bytes, GS_RASTER, cursor)
        expect(at, `${rows} 行块必须存在`).toBeGreaterThan(cursor)
        expect(bytes[at + 3]).toBe(0x00) // m 一律发规范值 0x00
        const bytesWide = (bytes[at + 4] ?? 0) + (bytes[at + 5] ?? 0) * 256
        const rowCount = (bytes[at + 6] ?? 0) + (bytes[at + 7] ?? 0) * 256
        expect(bytesWide * 8, '阶梯必须满宽——否则测不出纸宽上限').toBe(PAPER_DOTS[paper])
        expect(rowCount).toBe(rows)
        const data = bytes.slice(at + 8, at + 8 + bytesWide * rowCount)
        expect(data.length).toBe(bytesWide * rowCount)
        expect(data.every((b) => b === 0xff)).toBe(true)
        cursor = at + 8 + bytesWide * rowCount
      }
    }
  })

  it('探针载荷跨过 spooler base64 内联上限 → 真机走 stdin 传输分支（58mm 30064B / 80mm 44672B）', () => {
    // v2 的 S8 阶梯让探针从 ~1KB 涨到 30~45KB：base64 后超过 SPOOLER_STDIN_BASE64_LIMIT，
    // 于是这张探针纸成了 stdin 分支（[Console]::In.ReadToEnd()）的首个真机验证载体。
    // 若将来缩小阶梯使本断言失败，需同步确认探针是否仍覆盖 stdin 路径。
    for (const paper of ['58mm', '80mm'] as const) {
      const b64Length = Buffer.from(buildRawProbeBytes(paper)).toString('base64').length
      expect(b64Length, `${paper} 探针载荷应超过内联上限`).toBeGreaterThan(
        SPOOLER_STDIN_BASE64_LIMIT
      )
    }
  })

  it('末尾走纸 4 行但不切纸（GS V 66 0 在无切刀机器上会打出乱字符，正好落在判读区）', () => {
    const bytes = buildRawProbeBytes('58mm')
    expect(Array.from(bytes.slice(bytes.length - FEED_4_LINES.length))).toEqual(
      Array.from(FEED_4_LINES)
    )
    expect(indexOfBytes(bytes, FULL_CUT)).toBe(-1)
  })

  it('零 I/O：同一入参两次调用产出逐字节相同（纯函数——G6）', () => {
    const a = buildRawProbeBytes('58mm')
    const b = buildRawProbeBytes('58mm')
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(Array.from(buildRawProbeBytes('80mm'))).not.toEqual(Array.from(a))
  })
})
