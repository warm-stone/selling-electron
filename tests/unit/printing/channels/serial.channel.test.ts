import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SerialChannel } from '../../../../src/main/printing/channels/serial.channel'

/**
 * Task 7 — serial.channel 单元测试。
 * fs.createWriteStream 对文件路径与 Windows 设备路径（\\.\COM1）行为一致，
 * 故在 Linux 上用临时文件路径做跨平台等价验证（G11）。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-serial-test-'))

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SerialChannel', () => {
  it('name 为 serial，端口名参数化', () => {
    const ch = new SerialChannel('\\\\.\\COM3')
    expect(ch.name).toBe('serial')
    expect(ch.port).toBe('\\\\.\\COM3')
  })

  it('写入完整字节：临时文件内容与发送字节逐字节一致（drain 后关闭）', async () => {
    const target = path.join(tmpDir, 'com1-sim')
    const ch = new SerialChannel(target)
    const payload = new Uint8Array([0x1b, 0x40, 0xd6, 0xd0, 0x0a, 0x1d, 0x56, 0x42, 0x00])
    await ch.send(payload)
    const written = fs.readFileSync(target)
    expect(written.equals(Buffer.from(payload))).toBe(true)
  })

  it('错误上抛：路径不可达 → 拒绝并给出可诊断错误', async () => {
    const ch = new SerialChannel(path.join(tmpDir, 'no-such-dir', 'com1'))
    await expect(ch.send(new Uint8Array([0x1b]))).rejects.toThrow(/serial/i)
  })
})
