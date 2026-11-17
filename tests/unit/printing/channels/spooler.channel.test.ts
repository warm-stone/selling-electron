import { describe, expect, it } from 'vitest'
import {
  SPOOLER_STDIN_BASE64_LIMIT,
  SpoolerChannel,
  buildSpoolerPrintCommand,
  escapePowerShellSingleQuoted,
  sendRawToPrinter,
  type ExecFileFn
} from '../../../../src/main/printing/channels/spooler.channel'

/**
 * Task 7 — spooler.channel 单元测试。
 * 验证：Linux 明确报错（G11）、PS 命令结构纯函数拼装（打印机名/base64 注入 + 引号转义）、
 * win32 路径的 execFile 编排（注入 fake execFile，不实际执行 PowerShell）。
 */

/** 供 win32 路径测试用的最小 fake（type 断言由 isSpoolerExecFile 保证） */
function makeFakeExecFile(
  behavior: 'ok' | 'fail' | 'never-called',
  calls: Array<{ file: string; args: readonly string[]; stdinPayload?: string }>
): ExecFileFn {
  const impl = (file: string, args: readonly string[], _options: never, callback: never): unknown => {
    calls.push({ file, args })
    if (behavior === 'ok') {
      ;(callback as (e: Error | null, out: string, err: string) => void)(null, '', '')
    } else if (behavior === 'fail') {
      const err = Object.assign(new Error('exit code 2'), { code: 2 }) as Error & { code: number }
      ;(callback as (e: Error | null, out: string, err: string) => void)(
        err,
        '',
        'RAW send failed, win32=1801'
      )
    }
    return { stdin: null }
  }
  return impl as unknown as ExecFileFn
}

/**
 * 大载荷路径的 fake：返回可读写的 stdin（makeFakeExecFile 返回 null，永不进
 * `child.stdin.end()` 分支），并记录写入载荷 / end 调用 / error 处理器。
 */
function makeStdinFakeExecFile(behavior: 'ok' | 'fail'): {
  fn: ExecFileFn
  written: string[]
  ended: () => boolean
  emitStdinError: (err: Error) => void
} {
  const written: string[] = []
  let ended = false
  let errorHandler: ((err: Error) => void) | null = null
  type StdinFake = {
    on: (event: string, handler: (err: Error) => void) => StdinFake
    end: (payload: string) => StdinFake
  }
  const stdin: StdinFake = {
    on: (event, handler) => {
      if (event === 'error') errorHandler = handler
      return stdin
    },
    end: (payload) => {
      written.push(payload)
      ended = true
      return stdin
    }
  }
  const impl = (
    _file: string,
    _args: readonly string[],
    _options: never,
    callback: never
  ): unknown => {
    // 与真实 execFile 一致：回调异步触发（stdin 写入发生在 execFileFn 同步返回之后）
    setTimeout(() => {
      const cb = callback as (e: Error | null, out: string, err: string) => void
      if (behavior === 'ok') {
        cb(null, '', '')
      } else {
        const err = Object.assign(new Error('exit code 2'), { code: 2 })
        cb(err, '', 'RAW send failed, win32=1801')
      }
    }, 0)
    return { stdin }
  }
  return {
    fn: impl as unknown as ExecFileFn,
    written,
    ended: () => ended,
    emitStdinError: (err) => errorHandler?.(err)
  }
}

describe('escapePowerShellSingleQuoted', () => {
  it('PS 单引号字符串内的单引号翻倍转义', () => {
    expect(escapePowerShellSingleQuoted("O'Brien's")).toBe("O''Brien''s")
    expect(escapePowerShellSingleQuoted('无引号')).toBe('无引号')
    expect(escapePowerShellSingleQuoted('')).toBe('')
  })
})

describe('buildSpoolerPrintCommand（纯函数，不执行）', () => {
  it('命令结构：powershell.exe + -NoProfile -NonInteractive -Command', () => {
    const spec = buildSpoolerPrintCommand('POS-80', new Uint8Array([0x1b, 0x40]))
    expect(spec.file).toBe('powershell.exe')
    expect(spec.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command'
    ])
    expect(spec.args).toHaveLength(6)
    expect(spec.stdinPayload).toBeUndefined()
  })

  it("base64 参数正确注入：[0x1b,0x40] → '$B64 = 'G0A=''", () => {
    const spec = buildSpoolerPrintCommand('POS-80', new Uint8Array([0x1b, 0x40]))
    const script = spec.args[5]
    expect(script).toContain("$B64 = 'G0A='")
  })

  it('base64 可从命令中提取并 round-trip 还原原字节', () => {
    const bytes = new Uint8Array([0x1b, 0x40, 0xd6, 0xd0, 0x1d, 0x56, 0x42, 0x00])
    const spec = buildSpoolerPrintCommand('POS-80', bytes)
    const script = spec.args[5]
    const m = script.match(/\$B64 = '([A-Za-z0-9+/=]+)'/)
    expect(m).not.toBeNull()
    expect(Buffer.from(m![1], 'base64').equals(Buffer.from(bytes))).toBe(true)
  })

  it('打印机名正确注入：中文名原样保留', () => {
    const spec = buildSpoolerPrintCommand('前台小票打印机', new Uint8Array([0x1b]))
    expect(spec.args[5]).toContain("$PrinterName = '前台小票打印机'")
  })

  it('打印机名含单引号 → 翻倍转义后注入', () => {
    const spec = buildSpoolerPrintCommand("Pos '前台' 58mm", new Uint8Array([0x1b]))
    const script = spec.args[5]
    expect(script).toContain("$PrinterName = 'Pos ''前台'' 58mm'")
    expect(script).not.toContain("'Pos '前台' 58mm'")
  })

  it('脚本包含 RawPrinterHelper 关键要素：OpenPrinterW / RAW / Add-Type / exit code 约定', () => {
    const spec = buildSpoolerPrintCommand('POS-80', new Uint8Array([0x1b]))
    const script = spec.args[5]
    expect(script).toContain('Add-Type -TypeDefinition $Src')
    expect(script).toContain('OpenPrinterW') // W 系 API 支持中文打印机名
    expect(script).toContain('di.pDataType = "RAW"') // spooler RAW 数据类型
    expect(script).toContain('SendBytesToPrinter')
    expect(script).toContain('exit 2')
    expect(script).toContain('exit 0')
    // here-string 闭合 '@ 必须顶行（PS 语法要求）
    expect(script).toContain("\n'@\n")
  })

  it(`大载荷（base64 > ${SPOOLER_STDIN_BASE64_LIMIT} 字符）→ 改走 stdin，脚本从 stdin 读取`, () => {
    // 18001 字节 → base64 24004 字符 > 24000 上限
    const bigBytes = new Uint8Array(18001).fill(0x41)
    const b64 = Buffer.from(bigBytes).toString('base64')
    expect(b64.length).toBeGreaterThan(SPOOLER_STDIN_BASE64_LIMIT)
    const spec = buildSpoolerPrintCommand('POS-80', bigBytes)
    const script = spec.args[5]
    expect(spec.stdinPayload).toBe(b64)
    expect(script).toContain('$B64 = [Console]::In.ReadToEnd()')
    expect(script).not.toContain(b64) // 内联 base64 必须消失（否则撑爆 32K 命令行）
  })

  it('小载荷不启用 stdin', () => {
    const spec = buildSpoolerPrintCommand('POS-80', new Uint8Array(64).fill(0x1b))
    expect(spec.stdinPayload).toBeUndefined()
    expect(spec.args[5]).not.toContain('[Console]::In.ReadToEnd()')
  })
})

describe('sendRawToPrinter', () => {
  it('Linux/非 win32 → 抛明确错误『仅 Windows』（不产生 ENOENT）', async () => {
    const platform = process.platform === 'win32' ? 'linux' : process.platform
    await expect(
      sendRawToPrinter('POS-80', new Uint8Array([0x1b]), { platform: platform as NodeJS.Platform })
    ).rejects.toThrow('spooler channel 仅 Windows 可用')
  })

  it('本机平台为 Linux 时直接抛『仅 Windows』', async () => {
    if (process.platform === 'win32') return // Windows CI 上本用例由上方用例覆盖反向分支
    await expect(
      sendRawToPrinter('POS-80', new Uint8Array([0x1b]))
    ).rejects.toThrow('spooler channel 仅 Windows 可用')
  })

  it('win32 + fake execFile → 调用 powershell.exe 且透传拼装命令，成功 resolve', async () => {
    const calls: Array<{ file: string; args: readonly string[]; stdinPayload?: string }> = []
    const fake = makeFakeExecFile('ok', calls)
    await sendRawToPrinter('测试打印机', new Uint8Array([0x1b, 0x40]), {
      platform: 'win32',
      execFileFn: fake
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('powershell.exe')
    expect(calls[0].args[0]).toBe('-NoProfile')
    const script = calls[0].args[5]
    expect(script).toContain("$PrinterName = '测试打印机'")
    expect(script).toContain("$B64 = 'G0A='")
  })

  it('win32 + execFile 失败（exit 2）→ 拒绝并携带 stderr 详情', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const fake = makeFakeExecFile('fail', calls)
    await expect(
      sendRawToPrinter('POS-80', new Uint8Array([0x1b]), { platform: 'win32', execFileFn: fake })
    ).rejects.toThrow(/POS-80.*RAW send failed, win32=1801/s)
  })

  it('win32 + 缺打印机名 → 拒绝并提示配置 printer_name', async () => {
    await expect(
      sendRawToPrinter('', new Uint8Array([0x1b]), {
        platform: 'win32',
        execFileFn: makeFakeExecFile('never-called', [])
      })
    ).rejects.toThrow('printer_name')
  })

  it('大载荷（走 stdin）→ base64 原样写入 child.stdin 并 end，字节零改写', async () => {
    const bigBytes = new Uint8Array(18001).map((_, i) => i % 251)
    const spec = buildSpoolerPrintCommand('POS-80', bigBytes)
    expect(spec.stdinPayload).toBeDefined()
    const fake = makeStdinFakeExecFile('ok')

    await sendRawToPrinter('POS-80', bigBytes, { platform: 'win32', execFileFn: fake.fn })

    expect(fake.ended()).toBe(true)
    expect(fake.written).toHaveLength(1)
    expect(fake.written[0]).toBe(spec.stdinPayload)
    // round-trip：PS 侧 [Convert]::FromBase64String 拿到的就是原字节（传输层不经字符串编码）
    expect(Array.from(Buffer.from(fake.written[0] ?? '', 'base64'))).toEqual(Array.from(bigBytes))
  })

  it('stdin 写入报 EPIPE + 进程 exit 2 → 仍按 exit code 兜底拒绝并携带 stderr（不因 stdin error 未处理而崩）', async () => {
    const fake = makeStdinFakeExecFile('fail')

    const pending = sendRawToPrinter('POS-80', new Uint8Array(18001).fill(0x41), {
      platform: 'win32',
      execFileFn: fake.fn
    })
    fake.emitStdinError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))

    await expect(pending).rejects.toThrow(/POS-80.*RAW send failed, win32=1801/s)
  })
})

describe('SpoolerChannel', () => {
  it('name 为 spooler，printerName 参数化', async () => {
    const ch = new SpoolerChannel({ printerName: 'POS-80' })
    expect(ch.name).toBe('spooler')
    expect(ch.printerName).toBe('POS-80')
  })

  it('send 委托 sendRawToPrinter（Linux 下抛仅 Windows 错误）', async () => {
    if (process.platform === 'win32') return
    const ch = new SpoolerChannel({ printerName: 'POS-80' })
    await expect(ch.send(new Uint8Array([0x1b]))).rejects.toThrow('spooler channel 仅 Windows 可用')
  })
})
