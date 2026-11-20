import { describe, expect, it, vi } from 'vitest'
import { PrintQueue, getChannel } from '../../../src/main/printing/print.service'
import type { PrintChannel, PrintChannelKind } from '../../../src/main/printing/channels/print-channel'
import { DriverChannel } from '../../../src/main/printing/channels/driver.channel'
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

  it('printer_channel=driver → DriverChannel（printer_name 注入——云热敏机驱动渲染兜底）', () => {
    const ch = getChannel({ printer_channel: 'driver', printer_name: '前台驱动打印机' })
    expect(ch).toBeInstanceOf(DriverChannel)
    if (!(ch instanceof DriverChannel)) throw new Error('expected DriverChannel')
    expect(ch.printerName).toBe('前台驱动打印机')
  })

  it('printer_channel=driver → 装配实验选项闭包（driver_dpi/driver_use_default_page_size 透传）', () => {
    // 实验键设置值 → 闭包产出（getDriverOptions 为 private——按契约形状 unknown cast 断言）
    const ch = getChannel({
      printer_channel: 'driver',
      printer_name: 'POS-58',
      driver_dpi: 203,
      driver_use_default_page_size: true
    })
    const getDriverOptions = (ch as unknown as { getDriverOptions: () => unknown }).getDriverOptions
    expect(getDriverOptions()).toEqual({ driverDpi: 203, useDefaultPageSize: true })

    // 缺省归一：两键缺席 → null/false（appSettingsToPrintSettings 透传的缺省形态）
    const chDefault = getChannel({ printer_channel: 'driver', printer_name: 'POS-58' })
    const getDefault = (chDefault as unknown as { getDriverOptions: () => unknown }).getDriverOptions
    expect(getDefault()).toEqual({ driverDpi: null, useDefaultPageSize: false })
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
    // omo 复核 #2：固定 sleep 改 vi.waitFor——waitFor 通过（events 恰为
    // ['start:0:1b40']）即同时证明 job1 已启动且 job2 还在等（串行）
    await vi.waitFor(() => expect(events).toEqual(['start:0:1b40']))

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

describe('PrintQueue.busy（在途计数——printer-diagnostics T9 busy 门禁的数据源）', () => {
  it('入队即 true；job 成功定局后回 false（吞链递减先于调用方 await 注册，再让一个微任务兜底）', async () => {
    const gate = createDeferred<void>()
    const sendMock = vi.fn(() => gate.promise)
    const queue = new PrintQueue({ name: 'spooler', send: sendMock })

    expect(queue.busy).toBe(false)
    const job = queue.enqueuePrintJob(new Uint8Array([0x1b]))
    expect(queue.busy).toBe(true)

    gate.resolve()
    await job
    await Promise.resolve()
    expect(queue.busy).toBe(false)
  })

  it('失败定局同样递减：双败 reject（含重试）后 busy 回 false', async () => {
    const sendMock = vi.fn(async () => {
      throw new Error('printer down')
    })
    const queue = new PrintQueue({ name: 'tcp', send: sendMock })

    const job = queue.enqueuePrintJob(new Uint8Array([0x01]))
    expect(queue.busy).toBe(true)
    await expect(job).rejects.toThrow('已自动重试 1 次')
    await Promise.resolve()
    expect(queue.busy).toBe(false)
  })

  it('串行两任务：busy 从首任务入队持续 true 到末任务定局（连续结账窗口全覆盖，无中间假空闲）', async () => {
    const gate1 = createDeferred<void>()
    const gate2 = createDeferred<void>()
    let call = 0
    const sendMock = vi.fn(() => {
      const gate = call === 0 ? gate1 : gate2
      call += 1
      return gate.promise
    })
    const queue = new PrintQueue({ name: 'spooler', send: sendMock })

    const jobA = queue.enqueuePrintJob(new Uint8Array([0x01]))
    const jobB = queue.enqueuePrintJob(new Uint8Array([0x02]))
    expect(queue.busy).toBe(true)

    gate1.resolve()
    await jobA
    expect(queue.busy).toBe(true) // jobA 已定局但 jobB 接棒在途

    gate2.resolve()
    await jobB
    await Promise.resolve()
    expect(queue.busy).toBe(false)
  })
})

describe('PrintQueue per-job 通道（P1-1：共享队列 + 各 job 走自己的通道）', () => {
  it('job A 挂起时 job B 不启动（串行）；A/B 字节各自命中自己的通道；busy 全程可见', async () => {
    const gateA = createDeferred<void>()
    const receivedA: string[] = []
    const receivedB: string[] = []
    const channelA: PrintChannel = {
      name: 'spooler',
      send: async (bytes) => {
        receivedA.push(Buffer.from(bytes).toString('hex'))
        await gateA.promise
      }
    }
    const sendB = vi.fn(async (bytes: Uint8Array) => {
      receivedB.push(Buffer.from(bytes).toString('hex'))
    })
    const channelB: PrintChannel = { name: 'tcp', send: sendB }

    // 无默认通道的共享实例（printing.ipc 装配形态：所有调用点显式传 per-job 通道）
    const queue = new PrintQueue()
    const jobA = queue.enqueuePrintJob(new Uint8Array([0xaa]), channelA)
    const jobB = queue.enqueuePrintJob(new Uint8Array([0xbb]), channelB)

    // omo 复核 #2：固定 sleep 改 vi.waitFor（正向条件=A 已启动收到字节）
    await vi.waitFor(() => expect(receivedA).toEqual(['aa']))
    // A 在途未放行 → B 必须还没启动（串行证明）；busy 对在途任务可见
    expect(sendB).not.toHaveBeenCalled()
    expect(queue.busy).toBe(true)

    gateA.resolve()
    await jobA
    await jobB
    // B 命中自己的通道而非 A 的（per-job 语义：testPrint 表单值不被共享队列冻结）
    expect(receivedB).toEqual(['bb'])
    expect(receivedA).toEqual(['aa'])
    await Promise.resolve()
    expect(queue.busy).toBe(false)
  })

  it('per-job 通道优先于构造默认通道；不传时回落默认（旧签名兼容）', async () => {
    const sendDefault = vi.fn(async () => {})
    const sendPerJob = vi.fn(async () => {})
    const queue = new PrintQueue({ name: 'spooler', send: sendDefault })

    await queue.enqueuePrintJob(new Uint8Array([0x01]), { name: 'tcp', send: sendPerJob })
    expect(sendPerJob).toHaveBeenCalledTimes(1)
    expect(sendDefault).not.toHaveBeenCalled()

    await queue.enqueuePrintJob(new Uint8Array([0x02]))
    expect(sendDefault).toHaveBeenCalledTimes(1)
  })

  it('per-job 通道上的重试语义不变：失败后同一通道重发 1 次', async () => {
    const send = vi.fn(async () => {
      throw new Error('probe timeout')
    })
    const queue = new PrintQueue()
    await expect(
      queue.enqueuePrintJob(new Uint8Array([0x1b]), { name: 'tcp', send })
    ).rejects.toThrow(/已自动重试 1 次.*probe timeout/s)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('默认与 per-job 通道均缺失 → 可诊断 reject（不同步抛、不挂起、busy 不回零假象）', async () => {
    const queue = new PrintQueue()
    await expect(queue.enqueuePrintJob(new Uint8Array([0x01]))).rejects.toThrow(
      /未配置打印通道/
    )
    await Promise.resolve()
    expect(queue.busy).toBe(false) // reject 发生在计数之前，队列可继续使用
  })
})
