/**
 * v2 状态映射表（collect.runner 拆分批次 5；printer-diagnostics v2 / Bug1 修复）。
 *
 * 三套枚举语义不同，映射表独立维护禁合并（learnings v2 查证结论）：
 * - Get-Printer PrinterStatus：位掩码数字（0=Normal/1=Paused/2=Error/128=Offline/…，
 *   控制台显示 Normal 只是 CDXML 标签映射）——v1 按字符串 'normal' 匹配恒落
 *   unknown（真机 4 台全 unknown 的根因），v2 改 asNumber 读取 + 优先级位表；
 * - Win32_Printer.ExtendedPrinterStatus：1-18 枚举（WMI 兜底链首选信号）；
 * - Win32_Printer.PrinterStatus：1-7 枚举（防御字段，当前脚本未采集）。
 */

import type { PrinterDiagnostic } from '../../../../shared/printing/diagnostics-schema'

/**
 * Get-Printer PrinterStatus 位掩码优先级表（Bug1 修复核心）——**有序**数组，
 * 遍历首个命中的位决定。真机实测 PrinterStatus 是位掩码数字而非 'Normal'
 * 字符串：OFFLINE=128 / ERROR=2 / PAUSED=1 / PENDING_DELETION=4 /
 * PAPER_JAM=8 / PAPER_OUT=16 / PAPER_PROBLEM=64 / DOOR_OPEN=4194304；
 * 运行态位（256 IOActive 起）与 0（Normal）不扰动判定 → online。
 */
const PRINTER_STATUS_BITMASK: ReadonlyArray<{
  bit: number
  state: PrinterDiagnostic['status']['state']
  detectedError: string | null
}> = [
  { bit: 128, state: 'offline', detectedError: null },
  { bit: 2, state: 'error', detectedError: null },
  { bit: 1, state: 'paused', detectedError: null },
  { bit: 4, state: 'error', detectedError: 'pending-deletion' },
  { bit: 8, state: 'error', detectedError: 'paper-jam' },
  { bit: 16, state: 'error', detectedError: 'paper-out' },
  { bit: 64, state: 'error', detectedError: 'paper-problem' },
  { bit: 4194304, state: 'error', detectedError: 'door-open' }
]

/**
 * Get-Printer PrinterStatus 位掩码 → {state, detectedError}：遍历优先级表首个
 * 命中位决定；其余（含 0=Normal 与全部运行态位）→ online。
 */
export function mapPrinterStatusBitmask(mask: number): {
  state: PrinterDiagnostic['status']['state']
  detectedError: string | null
} {
  for (const entry of PRINTER_STATUS_BITMASK) {
    if ((mask & entry.bit) !== 0) return { state: entry.state, detectedError: entry.detectedError }
  }
  return { state: 'online', detectedError: null }
}

/**
 * Win32_Printer.PrinterStatus 1-7 表（防御字段：当前脚本未采集，wmi 记录带了
 * 就读）。1=Other/2=Unknown/6=StoppedPrinting → unknown；3=Idle/4=Printing/
 * 5=Warmup → online；7=Offline → offline。表外值 → unknown。
 */
export const WIN32_PRINTER_STATUS_1_7: Readonly<
  Record<number, PrinterDiagnostic['status']['state']>
> = {
  1: 'unknown',
  2: 'unknown',
  3: 'online',
  4: 'online',
  5: 'online',
  6: 'unknown',
  7: 'offline'
}

/**
 * Win32_Printer.ExtendedPrinterStatus 1-18 表（wmi 兜底链首选信号）：
 * 3=Idle/4=Printing/17=IOActive/18=ManualFeed → online；7=Offline → offline；
 * 8=Paused → paused；9=Error → error；2=Unknown（无 bidi 状态监视器的低价
 * 热敏机常态——「拿不到状态」非故障）与表外值（1/5/6/10-16）→ unknown。
 */
export const EXTENDED_PRINTER_STATUS_1_18: Readonly<
  Record<number, PrinterDiagnostic['status']['state']>
> = {
  2: 'unknown',
  3: 'online',
  4: 'online',
  7: 'offline',
  8: 'paused',
  9: 'error',
  17: 'online',
  18: 'online'
}

/**
 * Win32_Printer.ExtendedDetectedErrorState 人类可读标签表（v1 裸 String(n) 的
 * 替代）：0=Unknown/1=Other/2=NoError → null（无错误）；3=LowPaper/4=NoPaper/
 * 5=LowToner/6=NoToner/7=DoorOpen/8=Jammed/9=Offline → 标签。表外值保留
 * String(n) 原值（防御不丢真机数据）。
 */
const DETECTED_ERROR_STATE_LABELS: Readonly<Record<number, string | null>> = {
  0: null,
  1: null,
  2: null,
  3: 'low-paper',
  4: 'no-paper',
  5: 'low-toner',
  6: 'no-toner',
  7: 'door-open',
  8: 'jammed',
  9: 'offline'
}

/**
 * ExtendedDetectedErrorState → 人类可读标签：表内 0/1/2 = 无错误（null），
 * 3-9 = 错误标签；表外值保留 String(n) 原值。注意不能用 `表[n] ?? String(n)`
 * ——表内显式 null 会被 ?? 当键缺失吞成 String(n)，故用 in 判定。
 */
export function wmiDetectedErrorLabel(n: number): string | null {
  return n in DETECTED_ERROR_STATE_LABELS ? DETECTED_ERROR_STATE_LABELS[n] : String(n)
}
