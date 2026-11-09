/**
 * pngjs（7.x）最小环境类型声明。
 *
 * pngjs 无自带 .d.ts 也无 @types 包；本仓库已将 pngjs 声明为显式依赖
 * （node-thermal-printer 的传递依赖不可依赖——phantom dependency），
 * 打印子系统只消费与库 epson.js `const { PNG } = require('pngjs')`
 * 同一 API 面：PNG 构造器 + PNG.sync.read（解码恒返回 RGBA）。
 *
 * 位置说明：放 src/shared/（tsconfig.node 与 tsconfig.web 的 include 公共区）——
 * web 程序经 tests/unit/components/ReceiptPreview.test.ts → escpos-generator
 * → raster.ts 的既有同源验证 import 链同样触达 pngjs；main-only 目录下的
 * 声明文件对 web 编译不可见（TS7016）。两侧程序与 vitest 测试均从此获类型。
 */

declare module 'pngjs' {
  /** 解码后的 RGBA 位图（pngjs 对调色板/灰度源恒转 RGBA） */
  interface PNGImage {
    width: number
    height: number
    data: Buffer
  }

  interface PNGConstructor {
    new (options: { width: number; height: number }): PNGImage
    sync: {
      read(buffer: Buffer): PNGImage
      write(image: PNGImage): Buffer
    }
  }

  export const PNG: PNGConstructor
}
