import { describe, it, expect } from 'vitest'
import { RULE_DEPENDS_ON } from '../../../../src/main/printing/diagnostics/schema'
import type { FindingCode } from '../../../../src/main/printing/diagnostics/schema'

// ── printer-diagnostics T1 契约锁：15 个 FindingCode 清单（grep 断言的事实源）──
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
  'printer-name-mismatch'
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

describe('诊断契约 RULE_DEPENDS_ON（printer-diagnostics T1）', () => {
  it('键集合与 15 个 FindingCode 清单一一对应（编译期 Record 已保证，运行时复核）', () => {
    expect(Object.keys(RULE_DEPENDS_ON).sort()).toEqual([...EXPECTED_FINDING_CODES].sort())
  })

  it('依赖段名均在采集段值域内（10 段）', () => {
    for (const sections of Object.values(RULE_DEPENDS_ON)) {
      for (const section of sections) {
        expect(EXPECTED_SECTION_NAMES).toContain(section)
      }
    }
  })

  it('除 logo-measurement-race（依赖 T7 renderSnapshot 注入）外每条规则至少依赖一个采集段', () => {
    for (const [code, sections] of Object.entries(RULE_DEPENDS_ON)) {
      if (code === 'logo-measurement-race') continue
      expect(sections.length, `${code} 应声明采集段依赖`).toBeGreaterThan(0)
    }
  })
})
