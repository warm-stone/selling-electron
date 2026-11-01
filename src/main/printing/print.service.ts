import { isPrintChannelKind, type PrintChannel, type PrintChannelKind } from './channels/print-channel'
import { SerialChannel, DEFAULT_SERIAL_PORT } from './channels/serial.channel'
import { SpoolerChannel } from './channels/spooler.channel'
import { TcpChannel } from './channels/tcp.channel'

/**
 * Task 7 — print.service（通道编排部分）。
 *
 * 本文件当前只含：getChannel 分发 + 串行队列。
 * T15（打印编排集成）在此基础上加入：模板+销售 → generateReceiptBytes → enqueuePrintJob 全链。
 * T19（设置页）消费 getChannel 校验与 listSystemPrinters。
 */

/** 打印相关设置（settings 表键名与 ER 设计逐字一致） */
export interface PrintSettings {
  /** 'spooler' | 'tcp' | 'serial'；缺省默认 spooler（D5 主通道） */
  printer_channel?: PrintChannelKind
  /** spooler 通道：系统打印机名 */
  printer_name?: string
  /** tcp 通道：打印机 IP */
  tcp_host?: string
  /** tcp 通道：端口（默认 9100） */
  tcp_port?: number
  /** serial 通道：串口设备路径（默认 \\.\COM1） */
  com_port?: string
}

/**
 * 按设置分发通道实例。
 * 注意：printer_channel 值来自 DB 字符串，运行时校验（脏数据抛可诊断错误）。
 */
export function getChannel(settings: PrintSettings): PrintChannel {
  const kind = settings.printer_channel ?? 'spooler'
  if (!isPrintChannelKind(kind)) {
    throw new Error(`未知的打印通道：${String(kind)}（可选：spooler / tcp / serial）`)
  }
  switch (kind) {
    case 'spooler':
      return new SpoolerChannel({ printerName: settings.printer_name ?? '' })
    case 'tcp':
      return new TcpChannel({ host: settings.tcp_host ?? '', port: settings.tcp_port })
    case 'serial':
      return new SerialChannel({ port: settings.com_port ?? DEFAULT_SERIAL_PORT })
  }
}

/**
 * 打印任务串行队列（连续结账不交叠）：
 *  - Promise 链保证 job 严格按入队顺序执行，前一个 settle 后一个才开始；
 *  - 失败自动重试 1 次（同一字节重发）；
 *  - 二次失败：向调用方 reject（UI 引导重打，销售已落库不受影响——G3），队列继续。
 */
export class PrintQueue {
  private queueTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly channel: PrintChannel) {}

  enqueuePrintJob(bytes: Uint8Array): Promise<void> {
    const run = this.queueTail.then(() => this.sendWithRetry(bytes))
    // ★ 队尾吞掉失败：确保后续 job 不被前序 rejection 阻断（死锁防线）；
    //   失败本身仍通过返回的 run 交给调用方。
    this.queueTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async sendWithRetry(bytes: Uint8Array): Promise<void> {
    try {
      await this.channel.send(bytes)
    } catch {
      try {
        await this.channel.send(bytes)
      } catch (secondError) {
        const detail = secondError instanceof Error ? secondError.message : String(secondError)
        throw new Error(`打印任务失败（已自动重试 1 次）：${detail}`)
      }
    }
  }
}
