// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { ElMessageBox } from 'element-plus'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DiagnosisDialog from '../../../src/renderer/src/components/settings/DiagnosisDialog.vue'
import { analyzeSnapshot } from '../../../src/main/printing/diagnostics/analyze'
import type {
  DiagnosticReport,
  Finding,
  PrintDiagnosticSnapshot,
  RepairActionId
} from '../../../src/main/printing/diagnostics/schema'
import { FIXTURES } from '../printing/diagnostics/fixtures/index'

/**
 * printer-diagnostics T10 — 诊断报告对话框组件测试。
 *
 * 报告全部由**真实 analyzeSnapshot** 产出（fixture 快照直喂——T5/T9 同款
 * 「真实规则引擎」策略，不手造 findings）；组件为纯渲染（props 进/事件出），
 * 确认流经 spyOn(ElMessageBox.confirm) 隔离真实弹层。
 *
 * 覆盖：
 * - 三区渲染：系统概况（spooler tag / 事件日志摘要）/ 打印机行（状态 tag +
 *   驱动 + 仅RAW + 端口）/ 发现列表（severity 排序 + 徽章 + evidence 等宽）
 * - 徽章矩阵：auto-fixed / verify-passed / escalated / needs-manual / needs-dev / pending
 * - 修复按钮：pending 才出按钮（needs-dev 不出）；L1 无确认直发；L2 确认文案
 *   含破坏半径三句（PURGE / MIGRATE / ENABLE_PRINT_LOG）；取消不 emit
 * - L4 引导：GENERIC 五步 / REINSTALL / 特定发现（name-mismatch 等）走 el-collapse
 * - 空态：healthy 全绿 + spooler-dead 打印机空态 + loading 占位
 */

// EP 弹层（popper/collapse 布局）依赖 ResizeObserver——jsdom 无原生实现，纯 stub 足够
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

const confirmSpy = vi
  .spyOn(ElMessageBox, 'confirm')
  .mockResolvedValue('confirm' as never)

/** fixture 深拷贝（analyze 只读，但保持与 T9 相同的隔离纪律） */
function cloneSnapshot(key: string): PrintDiagnosticSnapshot {
  return JSON.parse(JSON.stringify(FIXTURES[key])) as PrintDiagnosticSnapshot
}

/** 真实 analyzeSnapshot 产出报告（可追加/改写 findings 组装展示场景） */
function reportFrom(
  snapshot: PrintDiagnosticSnapshot,
  tweak?: (findings: Finding[]) => Finding[]
): DiagnosticReport {
  const findings = analyzeSnapshot(snapshot)
  return {
    schemaVersion: 1,
    collectedAt: '2026-11-12T10:00:00+08:00',
    snapshot,
    findings: tweak !== undefined ? tweak(findings) : findings
  }
}

/** 合成 jobs-stuck-error 快照（T9 同款配方：healthy 底座 + 本人错误任务 + 他人错误任务） */
function snapshotWithErrorJobs(): PrintDiagnosticSnapshot {
  const base = cloneSnapshot('healthy-machine')
  const target = base.printers[0]!
  return {
    ...base,
    app: { ...base.app, settings: { ...base.app.settings, printerName: 'POS-80' } },
    printers: [
      {
        ...target,
        name: 'POS-80',
        jobs: [
          { document: '本人的错误任务', owner: 'SHOPPC\\shop', statusMask: 2, isOwnedByCurrentUser: true },
          { document: '他人的错误任务', owner: 'SHOPPC\\other', statusMask: 2, isOwnedByCurrentUser: false }
        ],
        queue: { ...target.queue, jobCount: 2, errorJobs: 2 }
      },
      ...base.printers.slice(1)
    ]
  }
}

let wrapper: VueWrapper | undefined

/**
 * 挂载并等 el-dialog onMounted 完成（visible/rendered 在 mounted 钩子里置位——
 * jsdom 下不 flush 微任务时 overlay 保持 display:none 且默认槽不渲染）。
 */
async function mountDialog(
  report: DiagnosticReport | null,
  visible = true,
  loading = false
): Promise<VueWrapper> {
  wrapper = mount(DiagnosisDialog, {
    props: { visible, report, loading },
    global: { plugins: [ElementPlus] }
  })
  await flushPromises()
  return wrapper
}

/** 按出现序取发现卡的纯文本描述行（.diagnosis-finding__title 内） */
function findingTitles(w: VueWrapper): string[] {
  return w.findAll('.diagnosis-finding__title').map((t) => t.text())
}

beforeEach(() => {
  confirmSpy.mockReset().mockResolvedValue('confirm' as never)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('三区渲染（真实 fixture 报告）', () => {
  it('spooler-dead：概况区 spooler 危险 tag + 事件日志摘要 + 发现区 critical 条目', async () => {
    const report = reportFrom(cloneSnapshot('spooler-dead'))
    const w = await mountDialog(report)

    // 区 1：非 Running → danger tag 显示原始状态字
    const system = w.find('[data-testid="diagnosis-zone-system"]')
    expect(system.text()).toContain('打印服务')
    expect(system.find('.el-tag').classes()).toContain('el-tag--danger')
    expect(system.text()).toContain('Stopped')

    // 区 2：RPC 不可用 → 空态文案
    expect(w.find('[data-testid="diagnosis-zone-printers"]').text()).toContain('未采集到打印机')

    // 区 3：critical 发现 + [严重] 前缀 + evidence 等宽小字 + pending 徽章
    const findings = w.findAll('[data-testid="diagnosis-finding"]')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.text()).toContain('[严重]')
    expect(findings[0]!.text()).toContain('Print Spooler')
    expect(w.find('.diagnosis-finding__evidence').text()).toContain("system.spooler.status='Stopped'")
    expect(w.find('[data-testid="finding-badge-pending"]').text()).toBe('待处理')
  })

  it('printer-name-mismatch：打印机行（名称 + 在线 tag + 驱动 + 端口）+ 采集时间本地化显示', async () => {
    const report = reportFrom(cloneSnapshot('printer-name-mismatch'))
    const w = await mountDialog(report)

    const rows = w.findAll('[data-testid="diagnosis-printer-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('POS-80 (副本 2)')
    expect(rows[0]!.find('.el-tag').text()).toBe('在线')
    expect(rows[0]!.text()).toContain('驱动：')
    expect(rows[0]!.text()).toContain('端口：')

    // spooler Running → success tag；采集时间 +08:00 后缀剥除
    expect(w.find('[data-testid="diagnosis-zone-system"]').find('.el-tag').classes()).toContain(
      'el-tag--success'
    )
    expect(w.find('[data-testid="diagnosis-zone-system"]').text()).toContain(
      '采集时间：2026-11-12 10:00:00'
    )
  })

  it('severity 排序：critical → high → medium → info（同 severity 保持产出序）', async () => {
    const report = reportFrom(cloneSnapshot('printer-name-mismatch'), (findings) => {
      const extra: Finding[] = [
        analyzeSnapshot(cloneSnapshot('spooler-dead'))[0]!, // critical spooler-stopped
        analyzeSnapshot(cloneSnapshot('symptom1-cloud-utf8'))[0]!, // high cloud-printer-raw-utf8
        analyzeSnapshot(cloneSnapshot('symptom1-driver-raw-garbled'))[0]! // medium raw-garbled-risk
      ]
      const info: Finding = { ...extra[0]!, severity: 'info' }
      return [...extra, info, ...findings] // 乱序压入
    })
    const w = await mountDialog(report)

    const titles = findingTitles(w)
    // 乱序压入 [cloud-utf8 高, raw-garbled 中, spooler-stopped 严重, 提示克隆, name-mismatch 高]
    // → 排序后 [严重, 高(cloud), 高(name-mismatch), 中, 提示]（同 severity 保持产出序）
    expect(titles.map((t) => t.match(/\[(.+?)\]/)?.[1])).toEqual(['严重', '高', '高', '中', '提示'])
  })
})

describe('修复动作按钮与确认流', () => {
  it('jobs-stuck-error（pending）：L1 清除任务直发不弹确认；L2 清队列带破坏半径确认后 emit', async () => {
    const report = reportFrom(snapshotWithErrorJobs())
    expect(report.findings[0]!.suggestedActions).toEqual([
      'CANCEL_ERROR_JOBS',
      'PURGE_QUEUE_RESTART_SPOOLER'
    ])
    const w = await mountDialog(report)

    // L1 无确认：直发 emit，targetPrinter 传归属打印机
    await w.find('[data-testid="repair-btn-CANCEL_ERROR_JOBS"]').trigger('click')
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(w.emitted('repair')![0]).toEqual(['CANCEL_ERROR_JOBS', 'POS-80'])

    // L2 PURGE：确认弹窗文案含破坏半径句
    await w.find('[data-testid="repair-btn-PURGE_QUEUE_RESTART_SPOOLER"]').trigger('click')
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]![0]).toContain('将停止打印服务并清空本机所有打印机的队列任务')
    await flushPromises()
    expect(w.emitted('repair')![1]).toEqual(['PURGE_QUEUE_RESTART_SPOOLER', 'POS-80'])
  })

  it('L2 确认文案矩阵：MIGRATE / ENABLE_PRINT_LOG 的破坏半径句逐字锁定', async () => {
    const report = reportFrom(cloneSnapshot('spooler-dead'), (findings) => {
      const base = findings[0]!
      return [
        base,
        { ...base, code: 'port-wsd-instability', suggestedActions: ['MIGRATE_WSD_TO_TCP'] },
        { ...base, code: 'spooler-stopped', suggestedActions: ['ENABLE_PRINT_LOG'] }
      ]
    })
    const w = await mountDialog(report)

    await w.find('[data-testid="repair-btn-MIGRATE_WSD_TO_TCP"]').trigger('click')
    expect(confirmSpy.mock.calls[0]![0]).toContain(
      '将把该打印机端口迁移为标准 TCP/IP 端口（保留旧端口可回退）'
    )
    await w.find('[data-testid="repair-btn-ENABLE_PRINT_LOG"]').trigger('click')
    expect(confirmSpy.mock.calls[1]![0]).toContain('将启用 Windows 打印服务的详细日志（一次性）')
  })

  it('确认弹窗取消（reject）：不 emit repair', async () => {
    confirmSpy.mockRejectedValueOnce('cancel' as never)
    const report = reportFrom(cloneSnapshot('spooler-dead'))
    const w = await mountDialog(report)

    await w.find('[data-testid="repair-btn-PURGE_QUEUE_RESTART_SPOOLER"]').trigger('click')
    await flushPromises()
    expect(w.emitted('repair')).toBeUndefined()
  })

  it('L1 SWITCH_TO_DRIVER_CHANNEL 也走确认（后端 requiresConfirm=true）后 emit', async () => {
    const report = reportFrom(cloneSnapshot('symptom1-cloud-utf8'))
    const w = await mountDialog(report)

    await w.find('[data-testid="repair-btn-SWITCH_TO_DRIVER_CHANNEL"]').trigger('click')
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(w.emitted('repair')![0]).toEqual(['SWITCH_TO_DRIVER_CHANNEL', 'DELIVERY DL-5801PW'])
  })
})

describe('L4 引导与 needs-dev', () => {
  it('raw-garbled-risk：GENERIC_TEXT_ONLY 不出执行按钮，collapse 展示 checklist 五步', async () => {
    const report = reportFrom(cloneSnapshot('symptom1-driver-raw-garbled'))
    const w = await mountDialog(report)

    expect(w.find('[data-testid^="repair-btn-"]').exists()).toBe(false)
    const guide = w.find('.diagnosis-guide')
    expect(guide.exists()).toBe(true)
    expect(guide.text()).toContain('Generic / Text Only')
    expect(guide.findAll('.diagnosis-guide__steps li').length).toBeGreaterThanOrEqual(5)
  })

  it('symptom2-driver-layout（needs-dev）：徽章「需开发介入」+ REINSTALL 引导，不出修复按钮', async () => {
    const report = reportFrom(cloneSnapshot('symptom2-driver-layout'))
    const w = await mountDialog(report)

    const badges = w.findAll('[data-testid="finding-badge-needs-dev"]')
    expect(badges).toHaveLength(2)
    expect(badges[0]!.text()).toBe('需开发介入')
    expect(w.find('[data-testid^="repair-btn-"]').exists()).toBe(false)
    expect(w.find('.diagnosis-guide').text()).toContain('重装打印机驱动')
  })

  it('printer-name-mismatch：无建议动作 → 「人工处理步骤」重选指引', async () => {
    const report = reportFrom(cloneSnapshot('printer-name-mismatch'))
    const w = await mountDialog(report)

    const guide = w.find('.diagnosis-guide')
    expect(guide.exists()).toBe(true)
    expect(guide.text()).toContain('人工处理步骤')
    expect(guide.text()).toContain('重新选择当前实际存在的打印机')
  })
})

describe('徽章矩阵与空态', () => {
  it('状态徽章全集：auto-fixed / verify-passed / escalated / needs-manual / verify-failed', async () => {
    const report = reportFrom(cloneSnapshot('spooler-dead'), (findings) => {
      const base = findings[0]!
      return [
        { ...base, status: 'auto-fixed' as const },
        { ...base, status: 'verify-passed' as const },
        { ...base, status: 'escalated' as const },
        { ...base, status: 'needs-manual' as const },
        { ...base, status: 'verify-failed' as const }
      ]
    })
    const w = await mountDialog(report)

    expect(w.find('[data-testid="finding-badge-auto-fixed"]').text()).toBe('已自动修复 ✓')
    expect(w.find('[data-testid="finding-badge-verify-passed"]').text()).toBe('已验证')
    expect(w.find('[data-testid="finding-badge-escalated"]').text()).toBe('未消除')
    expect(w.find('[data-testid="finding-badge-needs-manual"]').text()).toBe('需人工处理')
    expect(w.find('[data-testid="finding-badge-verify-failed"]').text()).toBe('复核未通过')
  })

  it('healthy-machine：发现区空态「未发现问题，打印环境健康」', async () => {
    const w = await mountDialog(reportFrom(cloneSnapshot('healthy-machine')))
    expect(w.find('[data-testid="diagnosis-zone-findings"]').text()).toContain('未发现问题')
    expect(w.findAll('[data-testid="diagnosis-finding"]')).toHaveLength(0)
  })

  it('无报告：loading 占位文案 + 导出按钮禁用；关闭按钮 emit update:visible=false', async () => {
    const w = await mountDialog(null, true, true)

    expect(w.find('[data-testid="diagnosis-loading"]').text()).toContain('正在采集打印环境信息')
    expect(w.find('[data-testid="diagnosis-dialog-export-btn"]').attributes('disabled')).toBeDefined()

    await w.find('.el-dialog__footer button').trigger('click')
    expect(w.emitted('update:visible')![0]).toEqual([false])
  })

  it('有报告：footer 导出按钮可点击并 emit export', async () => {
    const w = await mountDialog(reportFrom(cloneSnapshot('spooler-dead')))
    await w.find('[data-testid="diagnosis-dialog-export-btn"]').trigger('click')
    expect(w.emitted('export')).toHaveLength(1)
  })
})

describe('修复动作 emit 类型契约', () => {
  it('machine scope 发现的 targetPrinter 为 undefined（ finding.printerName 缺省直传）', async () => {
    const report = reportFrom(cloneSnapshot('spooler-dead'))
    const w = await mountDialog(report)

    await w.find('[data-testid="repair-btn-PURGE_QUEUE_RESTART_SPOOLER"]').trigger('click')
    await flushPromises()
    const [actionId, targetPrinter] = w.emitted('repair')![0] as [RepairActionId, string | undefined]
    expect(actionId).toBe('PURGE_QUEUE_RESTART_SPOOLER')
    expect(targetPrinter).toBeUndefined()
  })
})
