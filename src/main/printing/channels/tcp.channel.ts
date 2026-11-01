import net from 'node:net'
import type { PrintChannel } from './print-channel'

/**
 * Task 7 — tcp 辅通道（tcp://host:9100 直发热敏打印机网络口）。
 *
 * 与 node-thermal-printer Network 接口（lib/interfaces/network.js）同构的自实现：
 * connect → 写字节 → 刷新（write 回调）→ 干净关闭（end → close）。
 * 必须有超时（计划 MUST NOT：tcp 不得无超时防挂死）。
 */

/** tcp 通道配置 */
export interface TcpChannelOptions {
  host: string
  /** 打印机网络端口，默认 9100（ESC/POS 标准端口） */
  port?: number
  /** 连接超时（毫秒），默认 3000；该计时同时守护写阶段（对端不读时防挂死） */
  connectTimeoutMs?: number
}

export class TcpChannel implements PrintChannel {
  readonly name = 'tcp' as const
  readonly host: string
  readonly port: number
  readonly connectTimeoutMs: number

  constructor(options: TcpChannelOptions) {
    this.host = options.host
    this.port = options.port ?? 9100
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3000
  }

  send(bytes: Uint8Array): Promise<void> {
    const { host, port, connectTimeoutMs } = this
    if (!host) {
      return Promise.reject(
        new Error('tcp channel 需要配置打印机主机地址（settings.tcp_host 不能为空）')
      )
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let connected = false
      const socket = net.createConnection({ host, port })

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          socket.destroy()
          reject(error)
        } else {
          resolve()
        }
      }

      // 超时守护：连接阶段 + 写/关闭阶段（防对端不读导致永久挂死）
      const timer = setTimeout(() => {
        finish(
          new Error(
            `tcp channel ${connected ? '发送' : '连接'}超时（${host}:${port}，${connectTimeoutMs}ms）`
          )
        )
      }, connectTimeoutMs)

      socket.on('error', (err: Error) => {
        finish(new Error(`tcp channel 发送失败（${host}:${port}）：${err.message}`))
      })

      socket.on('connect', () => {
        connected = true
        // write 回调 = 该段字节已刷出（drain 语义）；随后主动半关闭发 FIN
        socket.write(Buffer.from(bytes), () => {
          socket.end()
        })
      })

      // 连接完全关闭（双方 FIN）→ 干净收尾
      socket.on('close', (hadError: boolean) => {
        if (!hadError) finish()
      })
    })
  }
}
