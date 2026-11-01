import { execFile } from 'node:child_process'
import type { PrintChannel } from './print-channel'

/**
 * Task 7 — spooler 主通道（Windows RAW 打印，零原生依赖）。
 *
 * 为什么不用 node-thermal-printer 的 `printer:名称` interface：
 * 其依赖老原生包 printer/electron-printer（driver 参数，2022 年停更、需 rebuild）
 * ——见 node_modules/node-thermal-printer/lib/interfaces/printer.js（构造时无 driver 即抛
 * 'No driver set!'）。本通道绕开原生包，改用 PowerShell RawPrinterHelper
 * （System.Drawing.Printing 经典方案，winspool.Drv P/Invoke）直接写 spooler RAW 任务。
 *
 * fallback 路线（未采用，留档）：若未来真机环境 PowerShell 受限，可退回
 * `new ThermalPrinter({ interface: 'printer:' + name, driver: require('printer') })`
 * 的 node-thermal-printer 原生 driver 方案（需引入原生包 + rebuild，违背零原生依赖目标）。
 */

/** execFile 注入点（单测 fake 用；生产默认真实 execFile） */
export type ExecFileError = (Error & { code?: string | number | null }) | null
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { windowsHide?: boolean; timeout?: number },
  callback: (error: ExecFileError, stdout: string, stderr: string) => void
) => { stdin?: NodeJS.WritableStream | null }

const defaultExecFile: ExecFileFn = (file, args, options, callback) =>
  execFile(
    file,
    [...args],
    { encoding: 'utf8', ...options },
    (error, stdout, stderr) => callback(error, stdout, stderr)
  )

/**
 * PowerShell 单引号字符串转义：内嵌单引号翻倍（' → ''）。
 * ★ 真机调试坑：PS 单引号字符串内唯一需要转义的字符就是单引号本身；双引号无需处理。
 */
export function escapePowerShellSingleQuoted(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * base64 内联上限：Windows CreateProcess 命令行 32767 字符，脚本本体约 4KB，
 * 留足余量；超过则改走 stdin 传输（[Console]::In.ReadToEnd()）。
 */
export const SPOOLER_STDIN_BASE64_LIMIT = 24000

/** PowerShell 进程整体超时（Add-Type 首次编译 .NET 类型可能要数秒） */
const POWERSHELL_TIMEOUT_MS = 30_000

/**
 * C# RawPrinterHelper（winspool.Drv P/Invoke，经典 KB322091 方案的 Unicode 版本）。
 * 用 W 系列 API（OpenPrinterW / CharSet.Unicode）而非经典 ANSI 版——中文打印机名安全。
 */
const RAW_PRINTER_HELPER_CS = `
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOW
  {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPWStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);

  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

  public static bool SendBytesToPrinter(string szPrinterName, IntPtr pBytes, Int32 dwCount)
  {
    IntPtr hPrinter = IntPtr.Zero;
    DOCINFOW di = new DOCINFOW();
    di.pDocName = "selling-electron receipt";
    di.pDataType = "RAW";
    bool bSuccess = OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero);
    if (bSuccess)
    {
      bSuccess = StartDocPrinter(hPrinter, 1, di);
      if (bSuccess)
      {
        bSuccess = StartPagePrinter(hPrinter);
        if (bSuccess)
        {
          Int32 dwWritten;
          bSuccess = WritePrinter(hPrinter, pBytes, dwCount, out dwWritten);
          EndPagePrinter(hPrinter);
        }
        EndDocPrinter(hPrinter);
      }
      ClosePrinter(hPrinter);
    }
    return bSuccess;
  }
}
`

/** 拼装完成的 PowerShell 调用规格（纯函数产物，可单测、不执行） */
export interface SpoolerCommandSpec {
  file: 'powershell.exe'
  args: string[]
  /** base64 超限改走 stdin 时存在；否则 undefined（内联在命令里） */
  stdinPayload?: string
}

/**
 * 纯函数：拼装 PowerShell RAW 打印命令（不执行）。
 * - 打印机名经 escapePowerShellSingleQuoted 转义后内联
 * - 字节经 base64 内联（小载荷）或 stdin 传输（大载荷，防 32K 命令行上限）
 * - PS 侧结构：$PrinterName / $B64 → [Convert]::FromBase64String → Add-Type RawPrinterHelper
 *   → SendBytesToPrinter；exit 0 成功 / exit 2 发送失败（stderr 带 win32 错误码）
 */
export function buildSpoolerPrintCommand(printerName: string, bytes: Uint8Array): SpoolerCommandSpec {
  const b64 = Buffer.from(bytes).toString('base64')
  const useStdin = b64.length > SPOOLER_STDIN_BASE64_LIMIT
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$PrinterName = '${escapePowerShellSingleQuoted(printerName)}'`,
    useStdin ? '$B64 = [Console]::In.ReadToEnd()' : `$B64 = '${b64}'`,
    "$Bytes = [Convert]::FromBase64String($B64)",
    'Add-Type -AssemblyName System.Drawing',
    "$Src = @'",
    RAW_PRINTER_HELPER_CS,
    "'@",
    'Add-Type -TypeDefinition $Src',
    '$Ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($Bytes.Length)',
    'try {',
    '  [Runtime.InteropServices.Marshal]::Copy($Bytes, 0, $Ptr, $Bytes.Length)',
    '  $Ok = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $Ptr, $Bytes.Length)',
    '} finally {',
    '  [Runtime.InteropServices.Marshal]::FreeHGlobal($Ptr)',
    '}',
    'if (-not $Ok) {',
    "  [Console]::Error.WriteLine(('RAW send failed, printer={0}, win32={1}' -f $PrinterName, [Runtime.InteropServices.Marshal]::GetLastWin32Error()))",
    '  exit 2',
    '}',
    'exit 0'
  ].join('\n')

  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    ...(useStdin ? { stdinPayload: b64 } : {})
  }
}

/** sendRawToPrinter 可注入项（单测用；生产不传） */
export interface SpoolerSendOptions {
  execFileFn?: ExecFileFn
  /** 平台注入点；默认 process.platform */
  platform?: NodeJS.Platform
}

/**
 * 通过 PowerShell RawPrinterHelper 向系统打印机发送 RAW 字节（Windows spooler 主通道）。
 * - 非 win32 平台：抛明确错误（比 execFile 的 ENOENT 可诊断；G11）
 * - execFile（不走 shell）+ Node 自动做 Windows 参数引号转义（" → \"），PS -Command 可正确还原
 */
export function sendRawToPrinter(
  printerName: string,
  bytes: Uint8Array,
  options: SpoolerSendOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return Promise.reject(
      new Error(
        `spooler channel 仅 Windows 可用（当前平台：${platform}；请在设置页切换 tcp/serial 通道或使用 Windows 设备）`
      )
    )
  }
  if (!printerName) {
    return Promise.reject(
      new Error('spooler channel 需要打印机名（settings.printer_name 不能为空）')
    )
  }

  const spec = buildSpoolerPrintCommand(printerName, bytes)
  const execFileFn = options.execFileFn ?? defaultExecFile

  return new Promise<void>((resolve, reject) => {
    const child = execFileFn(
      spec.file,
      spec.args,
      { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() ? ` | ${stderr.trim()}` : ''
          reject(new Error(`spooler RAW 打印失败（${printerName}）：${error.message}${detail}`))
        } else {
          resolve()
        }
      }
    )
    if (spec.stdinPayload !== undefined && child.stdin) {
      // 大载荷走 stdin；EPIPE 之类写入错误由 execFile 的 exit code 兜底
      child.stdin.on('error', () => {})
      child.stdin.end(spec.stdinPayload)
    }
  })
}

/** spooler 通道配置 */
export interface SpoolerChannelOptions {
  /** 系统打印机名（settings.printer_name） */
  printerName: string
  execFileFn?: ExecFileFn
}

/** spooler 主通道（PrintChannel 实现）：RAW 字节 → Windows spooler */
export class SpoolerChannel implements PrintChannel {
  readonly name = 'spooler' as const
  readonly printerName: string
  private readonly execFileFn?: ExecFileFn

  constructor(options: SpoolerChannelOptions) {
    this.printerName = options.printerName
    this.execFileFn = options.execFileFn
  }

  send(bytes: Uint8Array): Promise<void> {
    return sendRawToPrinter(this.printerName, bytes, { execFileFn: this.execFileFn })
  }
}
