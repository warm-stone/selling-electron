/**
 * printer-diagnostics T2 黄金样本（7 组真实故障机症状复刻 + v2 真机基线）。
 *
 * 规则引擎（T5）表驱动测试与报告导出（T8）golden 快照的共同输入：
 * 每组 fixture 对应 docs/windows-manual-checklist.md 的症状语义与
 * driver.channel.ts 的 DL-5801PW 背景，只提供输入快照——findings
 * 期望归 T5 锁定，本目录不掺入期望结论。
 *
 * `as PrintDiagnosticSnapshot` 是编译锁：tsconfig.node.json include
 * tests/**，schema.ts 字段改名/增删时这里最先红（as comparability 允许
 * widened string → 枚举联合，但字段缺失/多余/形状漂移立即 TS2352）。
 */
import type { PrintDiagnosticSnapshot } from '../../../../../src/main/printing/diagnostics/schema'

import symptom1DriverRawGarbledJson from './symptom1-driver-raw-garbled.json'
import symptom1CloudUtf8Json from './symptom1-cloud-utf8.json'
import symptom2DriverLayoutJson from './symptom2-driver-layout.json'
import spoolerDeadJson from './spooler-dead.json'
import logDisabledJson from './log-disabled.json'
import printerNameMismatchJson from './printer-name-mismatch.json'
import healthyMachineJson from './healthy-machine.json'
import realMachine20261115Json from './real-machine-20261115.json'

/** 症状 1a：热敏机驱动把 RAW 字节当图形渲染（中文名 + WINPRINT + rawOnlyBit=false + spooler 通道） */
export const symptom1DriverRawGarbled = symptom1DriverRawGarbledJson as PrintDiagnosticSnapshot

/** 症状 1b：云固件把 RAW 当 UTF-8（DL-5801PW + dlpproc 处理器 + tcp-raw 9100 端口） */
export const symptom1CloudUtf8 = symptom1CloudUtf8Json as PrintDiagnosticSnapshot

/** 症状 2：driver 通道布局异常（A4 驱动配置 ≠ 80mm 模板 + 两次渲染测量差 265px + Logo 180px） */
export const symptom2DriverLayout = symptom2DriverLayoutJson as PrintDiagnosticSnapshot

/** spooler 服务停止（RPC 不可用：printers/jobs 双段采集失败，printers 空数组） */
export const spoolerDead = spoolerDeadJson as PrintDiagnosticSnapshot

/** Operational 日志关闭（遥测缺失：adminEvents/app1000Events 空 + operationalEnabled=false） */
export const logDisabled = logDisabledJson as PrintDiagnosticSnapshot

/** 设置打印机名与系统实际不符（settings 'POS-80' vs 系统 'POS-80 (副本 2)'） */
export const printerNameMismatch = printerNameMismatchJson as PrintDiagnosticSnapshot

/** 全绿基线（Generic / Text Only 主力机 + PDF 虚拟机 + 事件 307 正常业务打印完成） */
export const healthyMachine = healthyMachineJson as PrintDiagnosticSnapshot

/**
 * 真机 2026-11-15 基线（v2 golden 回放数据锚——打印机诊断报告-20261115-170820.txt）。
 * 修复后语义终态：4 台全 online（PrinterStatus=0 位掩码归一，Bug1）、WER
 * ProviderName 过滤后 app1000Events=0 条（18 条 UndockedHost 遥测噪音被压掉，
 * Bug2）、v4 驱动 printConfig fallback 链终值全空（盲区 4 的 R17 输入）、
 * 元素级测量 scrollWidth=221 不溢出（Bug3 假阳性 786 消除）。
 * 症状 2 现场：channel=driver + DL-5801PW + 58mm + dpr=1.25（R16 坏组合证据源）。
 * printConfigs 条目暂为 v1 形状（无 source 键）——Track B 真机复采后按实际
 * fallback 命中层回填 source。
 */
export const realMachine20261115 = realMachine20261115Json as PrintDiagnosticSnapshot

/** 键 = fixture 文件名去 .json；T5 表驱动 / T8 golden 快照按 key 遍历 */
export const FIXTURES: Record<string, PrintDiagnosticSnapshot> = {
  'symptom1-driver-raw-garbled': symptom1DriverRawGarbled,
  'symptom1-cloud-utf8': symptom1CloudUtf8,
  'symptom2-driver-layout': symptom2DriverLayout,
  'spooler-dead': spoolerDead,
  'log-disabled': logDisabled,
  'printer-name-mismatch': printerNameMismatch,
  'healthy-machine': healthyMachine,
  'real-machine-20261115': realMachine20261115
}
