import { describe, expect, it, vi } from 'vitest'
import { PrintQueue, getChannel } from '../../../src/main/printing/print.service'
import type { PrintChannel, PrintChannelKind } from '../../../src/main/printing/channels/print-channel'
import { SerialChannel } from '../../../src/main/printing/channels/serial.channel'
import { SpoolerChannel } from '../../../src/main/printing/channels/spooler.channel'
import { TcpChannel } from '../../../src/main/printing/channels/tcp.channel'

/**
 * Task 7 — print.service（通道编排部分）单元测试：
 * getChannel 按 printer_channel 分发 + enqueuePrintJob 串行 Promise 队列 + 失败重试 1 次。
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** 可编排的 mock 通道：记录事件顺序 + 可控完成时机 */
function createScriptedChannel(script: {
  outcomes: Array<{ delayMs?: number; error?: Error }>
}): { channel: PrintChannel; sendMock: ReturnType<typeof vi.fn>; events: string[] } {
  const events: string[] = []
  let call = 0
  const sendMock = vi.fn(async (_bytes: Uint8Array) => {
    const outcome = script.outcomes[call] ?? script.outcomes[script.outcomes.length - 1]
    events.push(`start:${call}`)
    if (outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs))
    events.push(`end:${call}`)
    call += 1
    if (outcome.error) throw outcome.error
  })
  return { channel: { name: 'spooler', send: sendMock }, sendMock, events }
}

describe('getChannel（按 settings.printer_channel 分发）', () => {
  it('printer_channel=tcp → TcpChannel（host/port 注入）', () => {
    const ch = getChannel({ printer_channel: 'tcp', tcp_host: '192.168.1.50', tcp_port: 9101 })
    expect(ch).toBeInstanceOf(TcpChannel)
    if (!(ch instanceof TcpChannel)) throw new Error('expected TcpChannel')
    expect(ch.host).toBe('192.168.1.50')
    expect(ch.port).toBe(9101)
  })

  it('printer_channel=serial → SerialChannel（com_port 注入）', () => {
    const ch = getChannel({ printer_channel: 'serial', com_port: '\\\\.\\COM3' })
    expect(ch).toBeInstanceOf(SerialChannel)
    if (!(ch instanceof SerialChannel)) throw new Error('expected SerialChannel')
    expect(ch.port).toBe('\\\\.\\COM3')
  })

  it('printer_channel=serial 缺省 com_port → 默认 \\\\.\\COM1', () => {
    const ch = getChannel({ printer_channel: 'serial' })
    if (!(ch instanceof SerialChannel)) throw new Error('expected SerialChannel')
    expect(ch.port).toBe('\\\\.\\COM1')
  })

  it('printer_channel=spooler → SpoolerChannel（printer_name 注入）', () => {
    const ch = getChannel({ printer_channel: 'spooler', printer_name: 'POS-80' })
    expect(ch).toBeInstanceOf(SpoolerChannel)
    if (!(ch instanceof SpoolerChannel)) throw new Error('expected SpoolerChannel')
    expect(ch.printerName).toBe('POS-80')
  })

  it('printer_channel 缺省 → 默认 spooler（D5 主通道）', () => {
    const ch = getChannel({})
    expect(ch).toBeInstanceOf(SpoolerChannel)
  })

  it('未知通道值（DB 脏数据）→ 抛可诊断错误', () => {
    expect(() => getChannel({ printer_channel: 'bluetooth' as PrintChannelKind })).toThrow(
      /bluetooth/
    )
  })
})

describe('PrintQueue（串行队列 + 重试）', () => {
  it('两个 job 严格串行：job2 的 send 在 job1 完成之后才开始（事件顺序断言）', async () => {
    const gate = createDeferred<void>()
    const events: string[] = []
    let call = 0
    const sendMock = vi.fn(async (bytes: Uint8Array) => {
      const n = call++
      events.push(`start:${n}:${Buffer.from(bytes).toString('hex')}`)
      if (n === 0) await gate.promise // job1 挂起，直到测试放行
      events.push(`end:${n}`)
    })
    const queue = new PrintQueue({ name: 'spooler', send: sendMock })

    const jobA = queue.enqueuePrintJob(new Uint8Array([0x1b, 0x40]))
    const jobB = queue.enqueuePrintJob(new Uint8Array([0x1d, 0x56, 0x42, 0x00]))
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 20))

    // job1 尚未放行 → job2 必须还在等（串行证明）
    expect(events).toEqual(['start:0:1b40'])

    gate.resolve()
    await jobA
    await jobB
    expect(events).toEqual([
      'start:0:1b40',
      'end:0',
      'start:1:1d564200',
      'end:1'
    ])
  })

  it('失败自动重试 1 次后成功：send 被调 2 次且最终 resolve', async () => {
    const { channel, sendMock } = createScriptedChannel({
      outcomes: [{ error: new Error('ECONNRESET: broken pipe') }, {}]
    })
    const queue = new PrintQueue(channel)
    await expect(queue.enqueuePrintJob(new Uint8Array([0x1b]))).resolves.toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(sendMock).toHaveBeenNthCalledWith(1, new Uint8Array([0x1b]))
    expect(sendMock).toHaveBeenNthCalledWith(2, new Uint8Array([0x1b])) // 重试发送同一字节
  })

  it('两次全部失败 → enqueue reject（含重试标记），且队列不被阻塞', async () => {
    // 前 2 次（job1 的首试+重试）失败，第 3 次起恢复
    const { channel, sendMock } = createScriptedChannel({
      outcomes: [{ error: new Error('spooler offline') }, { error: new Error('spooler offline') }, {}]
    })
    const queue = new PrintQueue(channel)

    await expect(queue.enqueuePrintJob(new Uint8Array([0x1b]))).rejects.toThrow(
      /已自动重试 1 次.*spooler offline/s
    )
    expect(sendMock).toHaveBeenCalledTimes(2)

    // 队列继续：后续 job 正常执行
    await expect(queue.enqueuePrintJob(new Uint8Array([0x40]))).resolves.toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(3)
  })

  it('连续失败的两个 job：第一个双败 reject，第二个仍被执行（队列不死锁）', async () => {
    let call = 0
    const sendMock = vi.fn(async () => {
      call += 1
      if (call <= 2) throw new Error('printer down') // 仅 job1 的两次尝试失败
    })
    const queue = new PrintQueue({ name: 'tcp', send: sendMock })

    const p1 = queue.enqueuePrintJob(new Uint8Array([0x01]))
    const p2 = queue.enqueuePrintJob(new Uint8Array([0x02]))
    await expect(p1).rejects.toThrow('已自动重试 1 次')
    await expect(p2).resolves.toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(3)
  })

  it('并发 enqueue：各 job 收到自己的字节（不串数据）', async () => {
    const received: string[] = []
    const sendMock = vi.fn(async (bytes: Uint8Array) => {
      await new Promise((r) => setTimeout(r, 10))
      received.push(Buffer.from(bytes).toString('hex'))
    })
    const queue = new PrintQueue({ name: 'tcp', send: sendMock })
    await Promise.all([
      queue.enqueuePrintJob(new Uint8Array([0xaa])),
      queue.enqueuePrintJob(new Uint8Array([0xbb])),
      queue.enqueuePrintJob(new Uint8Array([0xcc]))
    ])
    expect(received).toEqual(['aa', 'bb', 'cc'])
  })
})
