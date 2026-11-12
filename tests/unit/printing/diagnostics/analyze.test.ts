import { describe, expect, it } from 'vitest'
import { analyzeSnapshot } from '../../../../src/main/printing/diagnostics/analyze'
import type {
  Finding,
  FindingCode,
  PrintDiagnosticSnapshot,
  RepairActionId
} from '../../../../src/main/printing/diagnostics/schema'
import {
  FIXTURES,
  healthyMachine,
  logDisabled,
  printerNameMismatch,
  spoolerDead,
  symptom1CloudUtf8,
  symptom1DriverRawGarbled,
  symptom2DriverLayout
} from './fixtures/index'

/**
 * printer-diagnostics T5 —— 规则引擎表驱动测试。
 *
 * 三层锁定：
 * 1. 7 组黄金样本的命中/不命中矩阵（症状语义 ↔ 规则编码）；
 * 2. 命中细节（severity / status / suggestedActions / description 关键短语）；
 * 3. 负变体 + 结构不变量（evidence 非空、动作值域、printer scope 必带 printerName）。
 * 纯函数零 I/O——全部用例免 mock。
 */

/** 合法 RepairActionId 全集（schema 9 个；与 repair.test.ts 的 EXPECTED 五元组同源锁定） */
const LEGAL_ACTION_IDS: readonly RepairActionId[] = [
  'CANCEL_ERROR_JOBS',
  'SWITCH_TO_DRIVER_CHANNEL',
  'SWITCH_TO_SPOOLER_CHANNEL',
  'PURGE_QUEUE_RESTART_SPOOLER',
  'MIGRATE_WSD_TO_TCP',
  'ENABLE_PRINT_LOG',
  'DISABLE_SNMP',
  'REINSTALL_DRIVER_GUIDE',
  'GENERIC_TEXT_ONLY_GUIDE'
]

/** 合法 FindingCode 全集（schema 15 个——规则引擎不得产出枚举外的 code） */
const LEGAL_FINDING_CODES: readonly FindingCode[] = [
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
]

function codesOf(findings: Finding[]): FindingCode[] {
  return findings.map((f) => f.code)
}

/** 取指定规则的 Finding（不存在时 fail 并打印实际命中清单） */
function findFinding(findings: Finding[], code: FindingCode): Finding {
  const hit = findings.find((f) => f.code === code)
  expect(hit, `应命中规则 ${code}（实际命中：${codesOf(findings).join(', ') || '无'}）`).toBeDefined()
  return hit as Finding
}

// ══════════════ 第一层：7 组黄金样本命中矩阵 ══════════════

describe('analyzeSnapshot 表驱动（7 组黄金样本 → 命中/不命中矩阵）', () => {
  const table: Array<{
    name: string
    snapshot: PrintDiagnosticSnapshot
    mustHave: FindingCode[]
    mustNotHave: FindingCode[]
  }> = [
    {
      name: 'symptom1DriverRawGarbled（症状 1a：驱动把 RAW 当图形渲染）',
      snapshot: symptom1DriverRawGarbled,
      mustHave: ['raw-garbled-risk'],
      mustNotHave: ['cloud-printer-raw-utf8']
    },
    {
      name: 'symptom1CloudUtf8（症状 1b：云固件把 RAW 当 UTF-8）',
      snapshot: symptom1CloudUtf8,
      mustHave: ['cloud-printer-raw-utf8'],
      mustNotHave: ['raw-garbled-risk']
    },
    {
      name: 'symptom2DriverLayout（症状 2：driver 通道布局异常）',
      snapshot: symptom2DriverLayout,
      mustHave: ['driver-page-size-ignored', 'logo-measurement-race'],
      mustNotHave: ['printable-area-clip']
    },
    {
      name: 'spoolerDead（spooler 服务停止 + printers/jobs 段采集失败）',
      snapshot: spoolerDead,
      mustHave: ['spooler-stopped'],
      mustNotHave: ['jobs-stuck-error', 'jobs-stuck-deleting']
    },
    {
      name: 'logDisabled（Operational 日志关闭——空遥测）',
      snapshot: logDisabled,
      mustHave: [],
      mustNotHave: ['driver-crash-loop']
    },
    {
      name: 'printerNameMismatch（设置名 ≠ 系统实际名）',
      snapshot: printerNameMismatch,
      mustHave: ['printer-name-mismatch'],
      mustNotHave: ['raw-garbled-risk']
    },
    {
      name: 'healthyMachine（全绿基线——零产出）',
      snapshot: healthyMachine,
      mustHave: [],
      mustNotHave: []
    }
  ]

  for (const row of table) {
    it(`${row.name}：命中 [${row.mustHave.join(', ') || '无'}]，不含 [${row.mustNotHave.join(', ') || '无'}]`, () => {
      const codes = codesOf(analyzeSnapshot(row.snapshot))
      for (const code of row.mustHave) expect(codes).toContain(code)
      for (const code of row.mustNotHave) expect(codes).not.toContain(code)
    })
  }

  it('healthyMachine：findings 为空数组（未命中不产出 pass 占位）', () => {
    expect(analyzeSnapshot(healthyMachine)).toEqual([])
  })
})

// ══════════════ 第二层：命中细节锁定 ══════════════

describe('命中细节（severity / status / suggestedActions / description）', () => {
  it('raw-garbled-risk：medium + GENERIC_TEXT_ONLY_GUIDE，printer scope 带打印机名', () => {
    const f = findFinding(analyzeSnapshot(symptom1DriverRawGarbled), 'raw-garbled-risk')
    expect(f.severity).toBe('medium')
    expect(f.scope).toBe('printer')
    expect(f.printerName).toBe('XP-58 热敏打印机')
    expect(f.suggestedActions).toContain('GENERIC_TEXT_ONLY_GUIDE')
  })

  it('cloud-printer-raw-utf8：high + SWITCH_TO_DRIVER_CHANNEL', () => {
    const f = findFinding(analyzeSnapshot(symptom1CloudUtf8), 'cloud-printer-raw-utf8')
    expect(f.severity).toBe('high')
    expect(f.suggestedActions).toContain('SWITCH_TO_DRIVER_CHANNEL')
  })

  it('driver-page-size-ignored：status needs-dev + 双动作（切回 spooler + 重装驱动引导）', () => {
    const f = findFinding(analyzeSnapshot(symptom2DriverLayout), 'driver-page-size-ignored')
    expect(f.status).toBe('needs-dev')
    expect(f.severity).toBe('high')
    expect(f.suggestedActions).toEqual(['SWITCH_TO_SPOOLER_CHANNEL', 'REINSTALL_DRIVER_GUIDE'])
  })

  it('logo-measurement-race：high / appConfig / needs-dev / 空动作（开发侧问题）', () => {
    const f = findFinding(analyzeSnapshot(symptom2DriverLayout), 'logo-measurement-race')
    expect(f.severity).toBe('high')
    expect(f.scope).toBe('appConfig')
    expect(f.status).toBe('needs-dev')
    expect(f.suggestedActions).toEqual([])
    expect(f.evidence).toBe('renderSnapshot.heightDelta=265')
  })

  it('spooler-stopped：critical + PURGE_QUEUE_RESTART_SPOOLER + 结构化 evidence', () => {
    const f = findFinding(analyzeSnapshot(spoolerDead), 'spooler-stopped')
    expect(f.severity).toBe('critical')
    expect(f.scope).toBe('machine')
    expect(f.suggestedActions).toEqual(['PURGE_QUEUE_RESTART_SPOOLER'])
    expect(f.evidence).toBe("system.spooler.status='Stopped'")
  })

  it('printer-name-mismatch：high + description 列出近似名「副本 2」', () => {
    const f = findFinding(analyzeSnapshot(printerNameMismatch), 'printer-name-mismatch')
    expect(f.severity).toBe('high')
    expect(f.scope).toBe('appConfig')
    expect(f.suggestedActions).toEqual([])
    expect(f.description).toContain('副本 2')
  })
})

// ══════════════ 第三层之一：负变体（spread fixture 后改字段） ══════════════

describe('负变体（spread 后改单字段 → 对应规则失活）', () => {
  it('去掉 renderSnapshot → 不产 logo-measurement-race（其余规则不受影响）', () => {
    const noRender: PrintDiagnosticSnapshot = { ...symptom2DriverLayout }
    delete noRender.renderSnapshot
    const codes = codesOf(analyzeSnapshot(noRender))
    expect(codes).not.toContain('logo-measurement-race')
    expect(codes).toContain('driver-page-size-ignored')
  })

  it('channel 改 driver → raw-garbled-risk 与 cloud-printer-raw-utf8 均不产（R8/R9 只看 spooler 通道）', () => {
    const toDriver = (snap: PrintDiagnosticSnapshot): PrintDiagnosticSnapshot => ({
      ...snap,
      app: { ...snap.app, settings: { ...snap.app.settings, channel: 'driver' } }
    })
    expect(codesOf(analyzeSnapshot(toDriver(symptom1DriverRawGarbled)))).not.toContain('raw-garbled-risk')
    expect(codesOf(analyzeSnapshot(toDriver(symptom1CloudUtf8)))).not.toContain('cloud-printer-raw-utf8')
  })

  it('抑制：spooler-stopped 命中时跳过 jobs-stuck-error / jobs-stuck-deleting（即使 jobs 段采集正常）', () => {
    const stoppedWithStuckJobs: PrintDiagnosticSnapshot = {
      ...healthyMachine,
      system: { ...healthyMachine.system, spooler: { ...healthyMachine.system.spooler, status: 'Stopped' } },
      printers: [
        {
          ...healthyMachine.printers[0],
          // statusMask 位 2 = Error、位 4 = Deleting，本人任务
          jobs: [
            { document: '小票 #1024', owner: 'DESKTOP\\wenshi', statusMask: 6, isOwnedByCurrentUser: true }
          ]
        }
      ]
    }
    const codes = codesOf(analyzeSnapshot(stoppedWithStuckJobs))
    expect(codes).toContain('spooler-stopped')
    expect(codes).not.toContain('jobs-stuck-error')
    expect(codes).not.toContain('jobs-stuck-deleting')
  })
})

// ══════════════ 第三层之二：队列/端口/状态类规则合成样本（fixture 未覆盖的 8 条） ══════════════

describe('规则专项（合成样本锁定 fixture 未覆盖的规则分支）', () => {
  /** 单打印机合成快照：以 healthyMachine 为底座替换 printers */
  function withPrinters(...printers: PrintDiagnosticSnapshot['printers']): PrintDiagnosticSnapshot {
    return { ...healthyMachine, printers }
  }

  it('jobs-stuck-error（仅本人错误任务）：actions 恰为 [CANCEL_ERROR_JOBS]', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      jobs: [{ document: '小票 #1024', owner: 'DESKTOP\\wenshi', statusMask: 2, isOwnedByCurrentUser: true }]
    })
    const f = findFinding(analyzeSnapshot(snap), 'jobs-stuck-error')
    expect(f.suggestedActions).toEqual(['CANCEL_ERROR_JOBS'])
    expect(f.severity).toBe('high')
  })

  it('jobs-stuck-error（本人 + 他人错误任务）：追加 PURGE_QUEUE_RESTART_SPOOLER', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      jobs: [
        { document: '小票 #1024', owner: 'DESKTOP\\wenshi', statusMask: 2, isOwnedByCurrentUser: true },
        { document: '他人文档', owner: 'DESKTOP\\someone', statusMask: 2, isOwnedByCurrentUser: false }
      ]
    })
    const f = findFinding(analyzeSnapshot(snap), 'jobs-stuck-error')
    expect(f.suggestedActions).toEqual(['CANCEL_ERROR_JOBS', 'PURGE_QUEUE_RESTART_SPOOLER'])
  })

  it('jobs-stuck-deleting（删除中任务卡死）：high + PURGE_QUEUE_RESTART_SPOOLER', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      jobs: [{ document: '小票 #1024', owner: 'DESKTOP\\wenshi', statusMask: 4, isOwnedByCurrentUser: true }]
    })
    const f = findFinding(analyzeSnapshot(snap), 'jobs-stuck-deleting')
    expect(f.suggestedActions).toEqual(['PURGE_QUEUE_RESTART_SPOOLER'])
  })

  it('jobs-stuck-deleting（.shd 残留，无卡死任务）：同样命中', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      queue: { jobCount: 0, errorJobs: 0, deletingJobs: 0, spoolFiles: { spl: 1, shd: 3 } }
    })
    expect(codesOf(analyzeSnapshot(snap))).toContain('jobs-stuck-deleting')
  })

  it('port-wsd-instability：WSD + 离线 → MIGRATE_WSD_TO_TCP，且不误报 printer-offline-flag', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      status: { state: 'offline', detectedError: null, source: 'wmi-workoffline' },
      port: { ...healthyMachine.printers[0].port, type: 'wsd' }
    })
    const f = findFinding(analyzeSnapshot(snap), 'port-wsd-instability')
    expect(f.suggestedActions).toEqual(['MIGRATE_WSD_TO_TCP'])
    expect(codesOf(analyzeSnapshot(snap))).not.toContain('printer-offline-flag')
  })

  it('snmp-false-offline：TCP 可达 + SNMP 开 + 脱机 → DISABLE_SNMP，且不误报 printer-offline-flag', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      status: { state: 'offline', detectedError: null, source: 'wmi-workoffline' },
      port: {
        name: 'IP_192.168.1.66',
        type: 'tcp-raw',
        hostAddress: '192.168.1.66',
        portNumber: 9100,
        snmpEnabled: true,
        reachable: true
      }
    })
    const f = findFinding(analyzeSnapshot(snap), 'snmp-false-offline')
    expect(f.suggestedActions).toEqual(['DISABLE_SNMP'])
    expect(codesOf(analyzeSnapshot(snap))).not.toContain('printer-offline-flag')
  })

  it('driver-missing：matchesInstalled=false → high + REINSTALL_DRIVER_GUIDE', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      driver: { ...healthyMachine.printers[0].driver, matchesInstalled: false }
    })
    const f = findFinding(analyzeSnapshot(snap), 'driver-missing')
    expect(f.severity).toBe('high')
    expect(f.suggestedActions).toEqual(['REINSTALL_DRIVER_GUIDE'])
  })

  it('driver-crash-loop：spoolsv.exe 崩溃 + faultingModule 有效 → high + REINSTALL_DRIVER_GUIDE', () => {
    const snap: PrintDiagnosticSnapshot = {
      ...healthyMachine,
      system: {
        ...healthyMachine.system,
        eventLog: {
          ...healthyMachine.system.eventLog,
          app1000Events: [
            { time: '2026-11-12T09:14:32.000Z', faultingApp: 'spoolsv.exe', faultingModule: 'ntdll.dll' }
          ]
        }
      }
    }
    const f = findFinding(analyzeSnapshot(snap), 'driver-crash-loop')
    expect(f.severity).toBe('high')
    expect(f.scope).toBe('machine')
    expect(f.suggestedActions).toEqual(['REINSTALL_DRIVER_GUIDE'])
  })

  it('driver-crash-loop：faultingModule 为 unknown 的条目不产结论（模块未锁定不指认驱动）', () => {
    const snap: PrintDiagnosticSnapshot = {
      ...healthyMachine,
      system: {
        ...healthyMachine.system,
        eventLog: {
          ...healthyMachine.system.eventLog,
          app1000Events: [
            { time: '2026-11-12T09:14:32.000Z', faultingApp: 'spoolsv.exe', faultingModule: 'unknown' }
          ]
        }
      }
    }
    expect(codesOf(analyzeSnapshot(snap))).not.toContain('driver-crash-loop')
  })

  it('printer-offline-flag：普通脱机 → medium + 空动作 + description 含电源/联机/USB 检查指引', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      status: { state: 'offline', detectedError: null, source: 'wmi-workoffline' }
    })
    const f = findFinding(analyzeSnapshot(snap), 'printer-offline-flag')
    expect(f.severity).toBe('medium')
    expect(f.suggestedActions).toEqual([])
    expect(f.description).toContain('检查打印机电源/联机/USB 连接与「脱机使用打印机」复选框')
  })

  it('queue-paused：队列暂停 → medium + 空动作 + description 含恢复步骤', () => {
    const snap = withPrinters({
      ...healthyMachine.printers[0],
      status: { state: 'paused', detectedError: null, source: 'wmi' }
    })
    const f = findFinding(analyzeSnapshot(snap), 'queue-paused')
    expect(f.severity).toBe('medium')
    expect(f.description).toContain('恢复步骤')
  })

  it('printable-area-clip：纸宽比模板窄超 4mm 时命中（driver 通道）', () => {
    // 80mm 模板 + 58mm 实际纸宽：58000 < 80000 - 4000 → 裁切
    const snap: PrintDiagnosticSnapshot = {
      ...symptom2DriverLayout,
      system: {
        ...symptom2DriverLayout.system,
        printConfigs: [
          { printerName: 'POS-80 Printer', paperSize: 'XP58Paper', widthMicrons: 58000, heightMicrons: null, orientation: 'Portrait' }
        ]
      }
    }
    const f = findFinding(analyzeSnapshot(snap), 'printable-area-clip')
    expect(f.status).toBe('needs-dev')
    expect(f.suggestedActions).toEqual([])
    // 纸宽偏差同时超容差 → driver-page-size-ignored 也命中
    expect(codesOf(analyzeSnapshot(snap))).toContain('driver-page-size-ignored')
  })
})

// ══════════════ 第三层之三：结构不变量（全部 fixture × 全部 findings） ══════════════

describe('结构不变量（全部 fixture 逐条 Finding 校验）', () => {
  for (const [name, snapshot] of Object.entries(FIXTURES)) {
    it(`${name}：code/evidence/description 非空，动作值 ∈ 合法集合，printer scope 必带 printerName`, () => {
      const findings = analyzeSnapshot(snapshot)
      for (const f of findings) {
        expect(LEGAL_FINDING_CODES).toContain(f.code)
        expect(f.evidence.length).toBeGreaterThan(0)
        expect(f.description.length).toBeGreaterThan(0)
        expect(Array.isArray(f.suggestedActions)).toBe(true) // 空动作合法（needs-dev/指引类）
        for (const action of f.suggestedActions) {
          expect(LEGAL_ACTION_IDS).toContain(action)
        }
        if (f.scope === 'printer') {
          expect(f.printerName, `printer scope 的 ${f.code} 必带 printerName`).toBeTruthy()
        }
      }
    })
  }
})
