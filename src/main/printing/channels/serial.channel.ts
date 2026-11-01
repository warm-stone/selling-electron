import fs from 'node:fs'
import type { PrintChannel } from './print-channel'

/**
 * Task 7 — serial 备通道（串口设备 \\.\COM1，fs 流写入）。
 *
 * 与 node-thermal-printer File 接口（lib/interfaces/file.js）同构：
 * 串口设备在 Windows 上表现为可写路径（\\.\COM1）；fs.createWriteStream 对
 * 设备路径与普通文件路径行为一致（Linux 单测用临时文件做等价验证，G11）。
 */

/** serial 通道配置 */
export interface SerialChannelOptions {
  /** 串口设备路径（Windows 形如 '\\\\.\\COM1'） */
  port?: string
  /** 写入整体超时（毫秒），默认 10000（防对端不读挂死；参考 ntp File 接口 5s 超时放宽） */
  timeoutMs?: number
}

/** 默认串口（与 node-thermal-printer 示例一致） */
export const DEFAULT_SERIAL_PORT = '\\\\.\\COM1'

export class SerialChannel implements PrintChannel {
  readonly name = 'serial' as const
  readonly port: string
  private readonly timeoutMs: number

  /** 便捷签名：new SerialChannel('\\\\.\\COM3') 或 new SerialChannel({ port, timeoutMs }) */
  constructor(options: string | SerialChannelOptions = {}) {
    const opts: SerialChannelOptions = typeof options === 'string' ? { port: options } : options
    this.port = opts.port ?? DEFAULT_SERIAL_PORT
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  send(bytes: Uint8Array): Promise<void> {
    const { port, timeoutMs } = this
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const stream = fs.createWriteStream(port, { flags: 'w' })

      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stream.destroy()
        reject(new Error(`serial channel 写入失败（${port}）：${err.message}`))
      }

      const timer = setTimeout(() => {
        fail(new Error(`写入超时（${timeoutMs}ms）`))
      }, timeoutMs)

      stream.on('error', (err: Error) => fail(err))

      stream.write(Buffer.from(bytes), (err) => {
        if (err) {
          fail(err as Error)
          return
        }
        stream.end(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        })
      })
    })
  }
}
