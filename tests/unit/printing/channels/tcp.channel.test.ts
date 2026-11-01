import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TcpChannel } from '../../../../src/main/printing/channels/tcp.channel'

/**
 * Task 7 — tcp.channel 单元测试（回环 127.0.0.1:19910 mock server）。
 * 验证：字节完整到达、连接干净关闭、连接超时（防挂死）、错误上抛。
 */

const TEST_HOST = '127.0.0.1'
const TEST_PORT = 19910 // 计划指定端口

let server: net.Server
const receivedChunks: Buffer[] = []
let serverSocketClosed = false

beforeAll(async () => {
  server = net.createServer((socket) => {
    socket.on('data', (chunk: Buffer) => {
      receivedChunks.push(chunk)
    })
    // 客户端 FIN（end）后回 FIN，实现干净的双向关闭
    socket.on('end', () => socket.end())
    socket.on('error', () => {
      /* 测试环境噪音忽略 */
    })
    socket.on('close', () => {
      serverSocketClosed = true
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(TEST_PORT, TEST_HOST, () => resolve())
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('TcpChannel', () => {
  it('默认配置：port 9100、connectTimeoutMs 3000', () => {
    const ch = new TcpChannel({ host: '192.168.1.50' })
    expect(ch.name).toBe('tcp')
    expect(ch.host).toBe('192.168.1.50')
    expect(ch.port).toBe(9100)
    expect(ch.connectTimeoutMs).toBe(3000)
  })

  it('回环发送：mock server 收到完整 ESC/POS 字节且连接干净关闭', async () => {
    const ch = new TcpChannel({ host: TEST_HOST, port: TEST_PORT })
    // 模拟一段 ESC/POS 字节流：init + 居中 + 中文 GBK 字节 + 切纸
    const payload = new Uint8Array([
      0x1b, 0x40, // ESC @ init
      0x1b, 0x61, 0x01, // ESC a 1 居中
      0xd6, 0xd0, 0xce, 0xc4, // '中文' GBK
      0x0a,
      0x1d, 0x56, 0x42, 0x00 // GS V 切纸
    ])
    receivedChunks.length = 0
    serverSocketClosed = false

    await ch.send(payload)

    expect(Buffer.concat(receivedChunks).equals(Buffer.from(payload))).toBe(true)
    // 等待对端 close 事件传播，验证连接干净关闭（无悬挂）
    await new Promise((r) => setTimeout(r, 100))
    expect(serverSocketClosed).toBe(true)
  })

  it('连接拒绝（端口未监听）→ 错误上抛', async () => {
    // 先占用再释放一个端口，确保它是关闭状态
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, TEST_HOST, () => resolve()))
    const closedPort = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const ch = new TcpChannel({ host: TEST_HOST, port: closedPort, connectTimeoutMs: 2000 })
    await expect(ch.send(new Uint8Array([0x1b, 0x40]))).rejects.toThrow(/tcp/i)
  })

  it('连接超时（不可路由地址 + 短超时）→ 快速拒绝不挂死', async () => {
    // RFC 5737 TEST-NET-1，保证不可路由（SYN 被丢弃）
    const ch = new TcpChannel({ host: '192.0.2.1', port: 9100, connectTimeoutMs: 400 })
    const start = Date.now()
    await expect(ch.send(new Uint8Array([0x1b]))).rejects.toThrow()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(3000) // 不得挂死
  })

  it('未配置 host → send 拒绝并给出可诊断错误', async () => {
    const ch = new TcpChannel({ host: '' })
    await expect(ch.send(new Uint8Array([0x1b]))).rejects.toThrow(/tcp.*host|host.*tcp/i)
  })
})
