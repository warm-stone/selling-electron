import { describe, it, expect } from 'vitest'
import { buildCollectScript } from '../../../../src/main/printing/diagnostics/collect-script'

// ── printer-diagnostics T3：段名值域同 schema DiagnosticSectionName
// （schema.test.ts EXPECTED_SECTION_NAMES 同款硬编码清单，改名必须双侧同步）──
const EXPECTED_SECTIONS = [
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

/** 子串计数（split 技巧：出现 n 次 → 分割成 n+1 段） */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('buildCollectScript 采集脚本结构锁（printer-diagnostics T3，纯结构断言不执行）', () => {
  const script = buildCollectScript()
  const lines = script.split('\n')

  it('完全静态：两次调用结果 === 全等（零运行时值拼接的证明）', () => {
    expect(buildCollectScript()).toBe(script)
    expect(buildCollectScript() === buildCollectScript()).toBe(true)
  })

  it('首行（任何输出前）强制 UTF-8 stdout 无 BOM，ErrorActionPreference = Continue', () => {
    expect(lines[0]).toContain('[Console]::OutputEncoding')
    expect(lines[0]).toContain('[System.Text.UTF8Encoding]::new($false)')
    expect(script).toContain("$ErrorActionPreference = 'Continue'")
  })

  it('10 个段标记齐全且按契约顺序出现（DiagnosticSectionName 值域）', () => {
    let prev = -1
    for (const name of EXPECTED_SECTIONS) {
      const marker = `# --- section: ${name} ---`
      expect(script).toContain(marker)
      const pos = script.indexOf(marker)
      expect(pos, `${name} 段标记应出现在前一段之后`).toBeGreaterThan(prev)
      prev = pos
    }
    expect(count(script, '# --- section: ')).toBe(10)
  })

  it('每段独立 try/catch：try ≥10、catch ≥10、catch 记 error 恰好 10 处（段级全覆盖）', () => {
    expect(count(script, 'try {')).toBeGreaterThanOrEqual(10)
    expect(count(script, 'catch')).toBeGreaterThanOrEqual(10)
    expect(count(script, '$_.Exception.Message')).toBe(10)
  })

  it('结尾：总输出 ConvertTo-Json -Depth 6 -Compress + 末行 exit 0（无其他 exit code）', () => {
    expect(lines[lines.length - 1]).toBe('exit 0')
    expect(script).toContain('$out | ConvertTo-Json -Depth 6 -Compress')
    expect(script).not.toContain('exit 1')
    expect(script).not.toContain('exit 2')
    expect(script).not.toContain('exit 3')
  })

  it('5 个列表段各自 ConvertTo-Json -Depth 4（printers/wmi/jobs/ports/drivers 同构）', () => {
    expect(count(script, 'ConvertTo-Json -Depth 4')).toBe(5)
    expect(count(script, 'ConvertTo-Json')).toBe(6) // 5 段级 + 1 总输出
  })

  it('禁词：无写操作命令、无 PS7 语法、无弃用 Get-WmiObject（采集零副作用）', () => {
    const banned = [
      'Remove-Printer',
      'Stop-Service',
      'Start-Service',
      'net stop',
      'Set-PrinterPort',
      'Set-Service',
      'Get-WmiObject',
      '??',
      '&&',
      '||'
    ]
    for (const word of banned) {
      expect(script, `脚本不应包含禁词 ${word}`).not.toContain(word)
    }
  })

  it('核心字段名抽查（schema 对齐——T4 归一化解析的目标字段）', () => {
    const fields = [
      'WorkOffline', // wmi → printer-offline-flag
      'ExtendedDetectedErrorState', // wmi → status.detectedError
      'StatusMask', // jobs → jobs-stuck-error / jobs-stuck-deleting
      'SNMPEnabled', // ports → snmp-false-offline
      'DefaultSpoolDirectory', // spoolDir 注册表项
      'PrintService/Admin', // events 管理通道
      'IsEnabled', // events Operational 日志开关（ENABLE_PRINT_LOG）
      'ConnectAsync', // tcpProbe 异步探测
      'Get-PrintConfiguration', // printConfig 段
      'PaperSize' // printConfig → driver-page-size-ignored
    ]
    for (const field of fields) {
      expect(script, `脚本应包含字段 ${field}`).toContain(field)
    }
  })

  it('TCP 探测：ConnectAsync + Wait(3000)（同步 Connect 会挂死，禁用）', () => {
    expect(script).toContain('Wait(3000)')
    expect(script).not.toContain('.Connect(')
  })

  it('events 三部分合一：admin / app1000 / operationalEnabled，Message 全文输出不解析', () => {
    expect(script).toContain('$out.events.admin')
    expect(script).toContain('$out.events.app1000')
    expect(script).toContain('$out.events.operationalEnabled')
    expect(script).toContain("Get-WinEvent -ListLog 'Microsoft-Windows-PrintService/Operational'")
    expect(script).toContain('message=$_.Message')
  })

  it('tcpProbe 独立查询端口（不依赖 $out.ports），探测对象限 IP_* 端口', () => {
    expect(script).toContain('Get-PrinterPort -ErrorAction SilentlyContinue')
    expect(script).toContain("-like 'IP_*'")
  })

  it('CIM 而非 WMI：Win32_Printer / Win32_PrintJob 均走 Get-CimInstance', () => {
    expect(script).toContain('Get-CimInstance Win32_Printer')
    expect(script).toContain('Get-CimInstance Win32_PrintJob')
  })

  it('脚本零中文字面量（段名/字段全英文，降低编码风险）', () => {
    expect(/[\u4e00-\u9fff]/.test(script)).toBe(false)
  })
})
