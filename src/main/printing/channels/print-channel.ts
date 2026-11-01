/**
 * Task 7 — 打印通道抽象（print-channel.ts）
 *
 * 打印子系统的 I/O 侧统一契约：ESC/POS 字节流（Uint8Array）→ 通道发送。
 * 三个实现：
 *   - spooler.channel.ts  主通道：Windows spooler RAW（PowerShell RawPrinterHelper）
 *   - tcp.channel.ts      辅通道：tcp://host:9100（net socket）
 *   - serial.channel.ts   备通道：串口设备路径（\\.\COM1，fs 流写入）
 *
 * 职责边界（G6）：escpos-generator 是纯函数零 I/O；本目录只做 I/O。
 */

/** 通道种类（枚举封装）。值与 settings 表 printer_channel 列（'spooler'|'tcp'|'serial'）逐字一致。 */
export const PRINT_CHANNEL_KIND = {
  spooler: 'spooler',
  tcp: 'tcp',
  serial: 'serial'
} as const

export type PrintChannelKind = (typeof PRINT_CHANNEL_KIND)[keyof typeof PRINT_CHANNEL_KIND]

/** 全部合法通道值（运行时枚举 + 校验用） */
export const ALL_PRINT_CHANNEL_KINDS: readonly PrintChannelKind[] = Object.values(
  PRINT_CHANNEL_KIND
)

/** 运行时类型守卫：settings 来自 DB（字符串），入口处必须校验 */
export function isPrintChannelKind(value: unknown): value is PrintChannelKind {
  return (
    typeof value === 'string' && (ALL_PRINT_CHANNEL_KINDS as readonly string[]).includes(value)
  )
}

/**
 * 打印通道接口：字节 → 设备/spooler/socket。
 * 所有实现必须：错误上抛（由 PrintQueue 统一重试/报错）；同名字段 name 用于日志与设置页展示。
 */
export interface PrintChannel {
  /** 通道种类名（'spooler' | 'tcp' | 'serial'） */
  readonly name: PrintChannelKind
  /** 发送一段完整的 ESC/POS 字节流；失败 reject */
  send(bytes: Uint8Array): Promise<void>
}

/**
 * 系统打印机信息（Electron webContents.getPrintersAsync() 结果的结构化子集）。
 *
 * RAW-ONLY 语义（借鉴 node-thermal-printer `printer:auto` 接口的过滤规则，
 * 见 node_modules/node-thermal-printer/lib/interfaces/printer.js getPrinterName()）：
 * 其在 Windows 上自动选择 attributes 含 'RAW-ONLY' 的打印机（通用/纯文本驱动）。
 * Electron 的 getPrintersAsync() 不暴露 attributes 字段，因此本枚举层不做强过滤，
 * 仅由设置页引导用户选择热敏小票机；真机验证清单（Task 20）覆盖该项。
 */
export interface PrinterInfo {
  /** 系统打印机名（spooler 通道 printer_name 使用此值） */
  name: string
  displayName?: string
  description?: string
  status?: number
  isDefault?: boolean
}
