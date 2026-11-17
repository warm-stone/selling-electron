import { describe, expect, it } from 'vitest'
import { encodeGbk } from '../../../src/main/printing/escpos/gb2312-encoder'
import { buildRawProbeBytes } from '../../../src/main/printing/escpos/raw-probe'
import { PAPER_DOTS } from '../../../src/main/printing/escpos/raster'
import { PAPER_COLUMNS } from '../../../src/shared/receipt/char-grid'
import {
  RAW_PROBE_READINGS,
  RAW_PROBE_SEGMENT_LABELS,
  RAW_PROBE_VERDICTS
} from '../../../src/shared/printing/raw-probe'

/** S2/S3 的样本句（与 builder 内部常量同值——两段必须逐字相同，差异只可能来自编码） */
const CJK_SAMPLE = '中文测试 你好 A1'

const FS_HANZI_ON = Buffer.from([0x1c, 0x26])
const FS_HANZI_OFF = Buffer.from([0x1c, 0x2e])
const GS_RASTER = Buffer.from([0x1d, 0x76, 0x30])
const FULL_CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00])
const FEED_4_LINES = Buffer.from([0x1b, 0x64, 0x04])

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

describe('RAW 编码探针（F1——一张纸四段编码假设）', () => {
  it('四段按 S1→S2→S3→S4 顺序出现，且判读表逐段能在纸上找到（不留无解说的段）', () => {
    const bytes = buildRawProbeBytes('58mm')
    let prev = -1
    for (const id of ['ascii', 'utf8', 'gbk', 'raster'] as const) {
      const at = labelOffset(bytes, id, prev + 1)
      expect(at, `段 ${id} 的标题必须在上一段之后`).toBeGreaterThan(prev)
      prev = at
    }
    expect(RAW_PROBE_READINGS.map((r) => r.id)).toEqual(['ascii', 'utf8', 'gbk', 'raster'])
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
