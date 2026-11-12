import { describe, it, expect } from 'vitest'
import { FIXTURES } from './fixtures'

// ── printer-diagnostics T2 黄金样本：7 组真实故障机症状复刻 ──
// 只锁特征字段（症状保真度），findings 期望归 T5 规则引擎表驱动测试锁定。

const EXPECTED_FIXTURE_KEYS = [
  'symptom1-driver-raw-garbled',
  'symptom1-cloud-utf8',
  'symptom2-driver-layout',
  'spooler-dead',
  'log-disabled',
  'printer-name-mismatch',
  'healthy-machine'
] as const

describe('printer-diagnostics fixtures（T2 黄金样本）', () => {
  it('FIXTURES 7 键齐全（键 = fixture 文件名去 .json）', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...EXPECTED_FIXTURE_KEYS].sort())
  })

  // ── 共同基线骨架（as 编译锁之外的存在性复核）──
  it('所有 fixture 满足快照骨架：printers/system/app 核心字段 + 共同基线值', () => {
    for (const key of EXPECTED_FIXTURE_KEYS) {
      const snap = FIXTURES[key]
      expect(Array.isArray(snap.printers), `${key}.printers`).toBe(true)
      expect(snap.system.spooler, `${key}.system.spooler`).toHaveProperty('status')
      expect(snap.system.eventLog, `${key}.system.eventLog`).toHaveProperty('operationalEnabled')
      expect(Array.isArray(snap.system.printConfigs), `${key}.system.printConfigs`).toBe(true)
      expect(snap.app.electronVersion, `${key}.electronVersion`).toBe('44.10.1')
      expect(snap.app.printOptions, `${key}.printOptions`).toMatchObject({
        pageSizeMode: 'custom-microns',
        marginsMode: 'none',
        printBackground: true
      })
      expect(snap.app.templateFacts.cssPadding, `${key}.cssPadding`).toBe('12px 9px')
      expect(typeof snap.errors, `${key}.errors`).toBe('object')
      expect(typeof snap.raw, `${key}.raw`).toBe('object')
    }
  })

  it('symptom1-driver-raw-garbled：WINPRINT 处理器 + rawOnlyBit=false + 中文名打印机（编码链路）', () => {
    const snap = FIXTURES['symptom1-driver-raw-garbled']
    const p = snap.printers[0]
    expect(p.name).toBe('XP-58 热敏打印机')
    expect(p.driver.printProcessor).toBe('WINPRINT')
    expect(p.driver.rawOnlyBit).toBe(false)
    expect(snap.app.settings.channel).toBe('spooler')
    expect(snap.app.settings.printerName).toBe('XP-58 热敏打印机')
  })

  it('symptom1-cloud-utf8：dlpproc 云固件处理器 + tcp-raw 端口 9100（DL-5801PW）', () => {
    const snap = FIXTURES['symptom1-cloud-utf8']
    const p = snap.printers[0]
    expect(p.name).toBe('DELIVERY DL-5801PW')
    expect(p.driver.printProcessor).toBe('dlpproc')
    expect(p.port.type).toBe('tcp-raw')
    expect(p.port.hostAddress).toBe('192.168.1.66')
    expect(p.port.portNumber).toBe(9100)
    expect(p.port.reachable).toBe(true)
    expect(snap.app.settings.channel).toBe('spooler')
  })

  it('symptom2-driver-layout：A4 驱动配置 ≠ 80mm 模板 + heightDelta=265 + driver 通道 + Logo', () => {
    const snap = FIXTURES['symptom2-driver-layout']
    expect(snap.system.printConfigs[0].paperSize).toBe('A4')
    expect(snap.system.printConfigs[0].widthMicrons).toBe(210000)
    expect(snap.system.printConfigs[0].heightMicrons).toBe(297000)
    expect(snap.renderSnapshot).toBeDefined()
    expect(snap.renderSnapshot?.immediatelyMeasured).toBe(1842)
    expect(snap.renderSnapshot?.afterImgDecode).toBe(2107)
    expect(snap.renderSnapshot?.heightDelta).toBe(265)
    expect(snap.app.settings.channel).toBe('driver')
    expect(snap.app.settings.templatePaperWidth).toBe('80mm')
    expect(snap.app.templateFacts.hasLogo).toBe(true)
    expect(snap.app.templateFacts.logoPx).toBe(180)
  })

  it('spooler-dead：Stopped + dependents 含 Fax + printers 空 + errors 双段失败', () => {
    const snap = FIXTURES['spooler-dead']
    expect(snap.system.spooler.status).toBe('Stopped')
    expect(snap.system.spooler.startType).toBe('Auto')
    expect(snap.system.spooler.dependents).toEqual(['Fax'])
    expect(snap.printers).toHaveLength(0)
    expect(snap.errors.printers).toBeTruthy()
    expect(snap.errors.jobs).toBeTruthy()
  })

  it('log-disabled：operationalEnabled=false + 两个事件通道皆空（遥测缺失）', () => {
    const snap = FIXTURES['log-disabled']
    expect(snap.system.eventLog.operationalEnabled).toBe(false)
    expect(snap.system.eventLog.adminEvents).toHaveLength(0)
    expect(snap.system.eventLog.app1000Events).toHaveLength(0)
    // 其余结构同健康机：打印机在线 + 队列干净
    expect(snap.printers[0].name).toBe('Generic / Text Only')
    expect(snap.printers[0].driver.rawOnlyBit).toBe(true)
    expect(snap.printers[0].status.state).toBe('online')
  })

  it('printer-name-mismatch：系统侧 "POS-80 (副本 2)" vs 设置 "POS-80"', () => {
    const snap = FIXTURES['printer-name-mismatch']
    expect(snap.printers[0].name).toContain('副本 2')
    expect(snap.printers[0].driver.matchesInstalled).toBe(true)
    expect(snap.printers[0].status.state).toBe('online')
    expect(snap.app.settings.printerName).toBe('POS-80')
  })

  it('healthy-machine：双打印机 + 队列全 0 + 仅 307 正常业务事件 + 无 1000 崩溃', () => {
    const snap = FIXTURES['healthy-machine']
    expect(snap.printers).toHaveLength(2)
    expect(snap.printers[0].name).toBe('Generic / Text Only')
    expect(snap.printers[0].queue).toMatchObject({
      jobCount: 0,
      errorJobs: 0,
      deletingJobs: 0,
      spoolFiles: { spl: 0, shd: 0 }
    })
    expect(snap.printers[1].name).toBe('Microsoft Print to PDF')
    expect(snap.printers[1].port.name).toBe('PORTPROMPT:')
    expect(snap.system.eventLog.adminEvents).toHaveLength(2)
    expect(snap.system.eventLog.adminEvents.every((e) => e.id === 307)).toBe(true)
    expect(snap.system.eventLog.app1000Events).toHaveLength(0)
    expect(snap.system.eventLog.operationalEnabled).toBe(true)
    expect(snap.app.settings.printerName).toBe('Generic / Text Only')
  })
})
