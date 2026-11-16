import { describe, it, expect } from 'vitest'
import { RULE_DEPENDS_ON } from '../../../../src/main/printing/diagnostics/schema'
import type { FindingCode } from '../../../../src/main/printing/diagnostics/schema'

// ── printer-diagnostics 契约锁：17 个 FindingCode 清单（grep 断言的事实源）──
// v2 T1 增补末两码：driver-print-combo-known-issue / printconfig-unavailable
const EXPECTED_FINDING_CODES = [
  'spooler-stopped',
  'jobs-stuck-error',
  'jobs-stuck-deleting',
  'port-wsd-instability',
  'snmp-false-offline',
  'driver-missing',
  'driver-crash-loop',
  'raw-garbled-risk',
  'cloud-printer-raw-utf8',
  'driver-page-size-ignored',
  'printable-area-clip',
  'logo-measurement-race',
  'printer-offline-flag',
  'queue-paused',
  'printer-name-mismatch',
  'driver-print-combo-known-issue',
  'printconfig-unavailable'
] as const satisfies readonly FindingCode[]

// ── T3 采集段名值域（RULE_DEPENDS_ON 值的合法集合；type 已锁，运行时复核）──
const EXPECTED_SECTION_NAMES = [
  'printers',
  'wmi',
  'jobs',
  'ports',
  'drivers',
  'spooler',
  'spoolDir',
  'events',
  'tcpProbe',
  'printConfig'
] as const

describe('诊断契约 RULE_DEPENDS_ON（printer-diagnostics 契约锁）', () => {
  it('键集合与 17 个 FindingCode 清单一一对应（编译期 Record 已保证，运行时复核）', () => {
    expect(Object.keys(RULE_DEPENDS_ON).sort()).toEqual([...EXPECTED_FINDING_CODES].sort())
  })

  it('依赖段名均在采集段值域内（10 段）', () => {
    for (const sections of Object.values(RULE_DEPENDS_ON)) {
      for (const section of sections) {
        expect(EXPECTED_SECTION_NAMES).toContain(section)
      }
    }
  })

  // ── 空依赖豁免清单（成员逐码说明，与 schema.ts RULE_DEPENDS_ON 注释同步）──
  //  - logo-measurement-race：依赖 T7 renderSnapshot（renderer 侧注入，非 PS 采集段）
  //  - driver-print-combo-known-issue：组合前提全在 app 合成段（channel/pageSizeMode/marginsMode）
  //  - printconfig-unavailable：自检双路径（errors.printConfig OR fallback 链终值无宽高）——
  //    段失败守卫会抑制依赖段规则，空依赖自检（缺数据≠健康）
  const EMPTY_DEPS_EXEMPT: readonly FindingCode[] = [
    'logo-measurement-race',
    'driver-print-combo-known-issue',
    'printconfig-unavailable'
  ]

  it('除空依赖豁免清单（三键）外每条规则至少依赖一个采集段', () => {
    for (const [code, sections] of Object.entries(RULE_DEPENDS_ON)) {
      if (EMPTY_DEPS_EXEMPT.includes(code as FindingCode)) continue
      expect(sections.length, `${code} 应声明采集段依赖`).toBeGreaterThan(0)
    }
  })

  it('空依赖豁免清单完备性锁：恰为三键（防豁免表静默扩员）', () => {
    const actualEmpty = Object.entries(RULE_DEPENDS_ON)
      .filter(([, sections]) => sections.length === 0)
      .map(([code]) => code as FindingCode)
    expect([...actualEmpty].sort()).toEqual([...EMPTY_DEPS_EXEMPT].sort())
  })
})
