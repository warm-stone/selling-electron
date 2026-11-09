/**
 * Logo 光栅纯函数装配（`GS v 0`，得力 DL-5801PW 58mm 云打印机真机修复）。
 *
 * `buildLogoRaster(png, paperWidth) → Buffer`：PNG Buffer 进、`GS v 0`
 * 光栅指令字节出，**零 I/O**（pngjs `PNG.sync.read` 只解码内存 Buffer，
 * 不触文件系统——G6）。不再借 node-thermal-printer printImageBuffer——
 * 库实现有两处真机致命缺陷（该 58mm 云打印机症状：英文可打、Logo 不出）：
 *
 * 1. **模式 m 发 0x30**（'0'）：EPSON 规范接受 0/1 与 ASCII 别名 48/49，
 *    但大量克隆固件（含得力云打印机系列）只解析 m=0..3，遇 0x30 整条
 *    光栅指令被丢弃。此处发规范值 0x00——各固件普遍可解析。
 * 2. **原生像素宽度直发**：58mm 机是 384 点打印头，字节宽（xL）超过 48
 *    （384 点）的光栅指令整条拒收；Logo PNG 原生宽度（如 400px）一发
 *    即超限。此处先钳制到纸宽点数上限（PAPER_DOTS），再向下对齐 8 点
 *    （字节边界）。
 *
 * 位打包语义逐位镜像库 epson.js printImageBuffer（保证打印观感不变）：
 * 逐行 MSB first、每字节 8 点、bit=1 为打印；alpha>126 视为不透明，
 * 灰度 0.2126R+0.7152G+0.0722B（截断取整）< 128 视为黑点。
 *
 * 缩放只缩不放：超纸宽下采样到上限；纸宽内且已 8 对齐的图零重采样
 * （原像素直用，杜绝重采样损伤）；纸宽内未对齐的图轻度下采样对齐 8
 * 点；宽 <8 的极小图放大到 8 点（光栅最小字节宽 1，别无选择）。最近
 * 邻保持等比（targetH = max(1, round(srcH × targetW/srcW))）。
 *
 * 高度不拆段：Logo 均为小图，高度远不及 yL/yH 16 位上限（65535 行），
 * 无需 `GS v 0` 分段发送（注释留档，防止后续误加拆段逻辑）。
 */

import type { PaperWidth } from '../../../shared/receipt/char-grid'
import { PNG } from 'pngjs'

/**
 * 纸宽打印头点数：58mm 热敏 384 点 / 80mm 热敏 576 点
 * （每字符列 12 点 × PAPER_COLUMNS 32/48——与 char-grid 同源几何）。
 */
export const PAPER_DOTS: Record<PaperWidth, number> = {
  '58mm': 384,
  '80mm': 576
}

/**
 * 纯函数：Logo PNG → `GS v 0` 光栅指令（含头）。
 * `1D 76 30 00 xL xH yL yH d1..dk`：m=0x00 规范模式；
 * xL+xH×256 = 每行字节数（光栅宽/8）；yL+yH×256 = 光栅高度（行数）。
 */
export function buildLogoRaster(png: Buffer, paperWidth: PaperWidth): Buffer {
  const image = PNG.sync.read(png) // 恒 RGBA（调色板/灰度源亦转 RGBA）
  const limit = PAPER_DOTS[paperWidth]

  // 目标宽：min(原宽, 纸宽点数上限) 向下对齐 8 点；对齐结果 0（原宽 <8）取 8
  const clamped = Math.min(image.width, limit)
  let targetWidth = Math.floor(clamped / 8) * 8
  if (targetWidth === 0) targetWidth = 8

  let width: number
  let height: number
  let rgba: Buffer
  if (image.width <= limit && image.width % 8 === 0) {
    // 无需缩放（纸宽内且已 8 对齐）：原像素直用，跳过重采样
    width = image.width
    height = image.height
    rgba = image.data
  } else {
    // 最近邻等比重采样（超宽下采样 / 未对齐轻缩 / 宽 <8 放大到最小光栅宽）
    const scale = targetWidth / image.width
    width = targetWidth
    height = Math.max(1, Math.round(image.height * scale))
    rgba = resampleNearest(image, width, height)
  }

  const bytesPerRow = width >> 3 // 宽已 8 对齐，整除无余位
  const header = Buffer.from([
    0x1d, 0x76, 0x30, 0x00, // GS v 0，m=0x00（规范值，克隆固件普遍可解析）
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, // xL xH：每行字节数
    height & 0xff, (height >> 8) & 0xff // yL yH：光栅行数
  ])
  return Buffer.concat([header, packRasterBits(rgba, width, height)])
}

/** 最近邻重采样 RGBA（源索引数学上必在界内：x<dstW ⇒ floor(x·srcW/dstW) ≤ srcW-1，y 同理） */
function resampleNearest(
  src: { width: number; height: number; data: Buffer },
  dstWidth: number,
  dstHeight: number
): Buffer {
  const out = Buffer.alloc(dstWidth * dstHeight * 4)
  for (let y = 0; y < dstHeight; y++) {
    const srcY = Math.floor((y * src.height) / dstHeight)
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.floor((x * src.width) / dstWidth)
      const srcIdx = (srcY * src.width + srcX) << 2
      const dstIdx = (y * dstWidth + x) << 2
      out[dstIdx] = src.data[srcIdx]
      out[dstIdx + 1] = src.data[srcIdx + 1]
      out[dstIdx + 2] = src.data[srcIdx + 2]
      out[dstIdx + 3] = src.data[srcIdx + 3]
    }
  }
  return out
}

/**
 * RGBA → 光栅位数据（逐行 MSB first，每字节 8 点，bit=1 打印）。
 * 阈值与库 epson.js 逐位一致：alpha>126 不透明；灰度
 * 0.2126R+0.7152G+0.0722B（截断）<128 黑点。
 */
function packRasterBits(rgba: Buffer, width: number, height: number): Buffer {
  const bytesPerRow = width >> 3
  const out = Buffer.alloc(bytesPerRow * height)
  for (let y = 0; y < height; y++) {
    for (let j = 0; j < bytesPerRow; j++) {
      let byte = 0
      for (let k = 0; k < 8; k++) {
        const idx = (y * width + j * 8 + k) << 2
        if (rgba[idx + 3] > 126) {
          const grayscale = 0.2126 * rgba[idx] + 0.7152 * rgba[idx + 1] + 0.0722 * rgba[idx + 2]
          if (Math.floor(grayscale) < 128) byte |= 1 << (7 - k)
        }
      }
      out[y * bytesPerRow + j] = byte
    }
  }
  return out
}
