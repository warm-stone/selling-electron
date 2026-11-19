/**
 * app 侧合成段（collect.runner 拆分批次 5）：诊断快照中不来自 PowerShell
 * 采集、而由主进程编排（T9）注入的应用配置事实——打印设置/纸宽/driver
 * 实验键/默认模板事实/运行时版本。
 */

import type { PrintDiagnosticSnapshot } from '../../../../shared/printing/diagnostics-schema'
import { asNumber, asRecord, asString } from './primitives'

/**
 * app 侧合成段原料（T9 编排注入；测试用 fake 注入）。
 * 「provider」= 数据提供者：字段全部可空，本模块负责防御归一（printer_name
 * 为 null → '' 等——T1 learnings「AppSettings null 陷阱」的归一责任在本任务）。
 */
export interface AppInfoSnapshotProvider {
  /** 打印设置（结构兼容 AppSettings 打印子集；printer_name 可为 null → 归一为 ''） */
  settings?: { printer_channel?: string | null; printer_name?: string | null } | null
  /** 默认模板纸宽（'58mm' / '80mm'；取不到为 null → ''） */
  templatePaperWidth?: string | null
  /** driver 通道实际打印选项（缺省字段归一为默认值；v2 实验键条件透传） */
  printOptions?: {
    pageSizeMode?: string | null
    marginsMode?: string | null
    printBackground?: boolean | null
    /** v2 driver 实验：显式 DPI（null/缺省 = 未设置——输出不携带 dpi 键） */
    dpi?: number | null
    /** v2 driver 实验：使用驱动默认页尺寸（true 时才携带键） */
    usePrinterDefaultPageSize?: boolean | null
  } | null
  /** 默认模板事实（logo-measurement-race 等规则的比对输入） */
  templateFacts?: {
    hasLogo?: boolean | null
    logoPx?: number | null
    cssPadding?: string | null
  } | null
  /** 当前 OS 用户名（WMI Owner 的 'DOMAIN\user' 与裸 'user' 均可命中） */
  currentUserName?: string | null
  /** Electron 版本；缺省取 process.versions.electron（纯 node 环境下为 'unknown'） */
  electronVersion?: string
}

export function resolveCurrentUserName(appInfo: AppInfoSnapshotProvider | undefined): string {
  const name = appInfo?.currentUserName
  if (typeof name === 'string' && name !== '') return name
  // 默认 provider：Windows 为 USERNAME，类 Unix 为 USER（生产 T9 可显式注入覆盖）
  return process.env['USERNAME'] ?? process.env['USER'] ?? ''
}

export function composeAppSection(
  appInfo: AppInfoSnapshotProvider | undefined
): PrintDiagnosticSnapshot['app'] {
  const settings = asRecord(appInfo?.settings)
  const printOptions = asRecord(appInfo?.printOptions)
  const templateFacts = asRecord(appInfo?.templateFacts)
  // v2 实验键观测（条件携带——未启用时物理不存在，报告可区分「未设置」与「设为缺省值」）
  const dpi = asNumber(printOptions?.['dpi'])
  const useDefaultPageSize = printOptions?.['usePrinterDefaultPageSize'] === true
  return {
    // settings 的 nullable 归一为 string（T1 learnings：归一责任在本任务）
    settings: {
      channel: asString(settings?.['printer_channel']) ?? '',
      printerName: asString(settings?.['printer_name']) ?? '',
      templatePaperWidth: asString(appInfo?.templatePaperWidth) ?? ''
    },
    electronVersion: asString(appInfo?.electronVersion) ?? process.versions.electron ?? 'unknown',
    printOptions: {
      pageSizeMode: asString(printOptions?.['pageSizeMode']) ?? '',
      marginsMode: asString(printOptions?.['marginsMode']) ?? '',
      printBackground: printOptions?.['printBackground'] === true,
      ...(dpi !== null ? { dpi } : {}),
      ...(useDefaultPageSize ? { usePrinterDefaultPageSize: true } : {})
    },
    templateFacts: {
      hasLogo: templateFacts?.['hasLogo'] === true,
      logoPx: asNumber(templateFacts?.['logoPx']),
      cssPadding: asString(templateFacts?.['cssPadding']) ?? ''
    }
  }
}
