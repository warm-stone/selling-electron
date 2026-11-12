import { describe, it, expect } from 'vitest'
import { basename, join } from 'node:path'
import type { DiagnosticReport } from '../../../../src/main/printing/diagnostics/schema'
import {
  archiveHistory,
  buildReportTxt,
  redactSnapshot,
  toTxtBuffer
} from '../../../../src/main/printing/diagnostics/report.exporter'
import { FIXTURES } from './fixtures/index'

/**
 * printer-diagnostics T8 报告导出器：三层 txt（人读 + RAW JSON 附录）+ 脱敏 + history 封顶。
 *
 * golden 输入 = symptom2-driver-layout fixture（A4 驱动配置 ≠ 80mm 模板 + heightDelta 265 +
 * needs-dev 类素材）；findings 按 symptom2 语义手工构造——T5 规则引擎未落地前先锁
 * 报告层形状，T5 上线后 fixture→findings 的真实映射归 T5 表驱动测试锁定。
 */

const SYMPTOM2_SNAPSHOT = FIXTURES['symptom2-driver-layout']

const SYMPTOM2_REPORT: DiagnosticReport = {
  schemaVersion: 1,
  collectedAt: '2026-11-12T10:30:00+08:00',
  snapshot: SYMPTOM2_SNAPSHOT,
  renderSnapshot: SYMPTOM2_SNAPSHOT.renderSnapshot,
  findings: [
    {
      code: 'driver-page-size-ignored',
      severity: 'high',
      scope: 'printer',
      printerName: 'POS-80 Printer',
      evidence: "system.printConfigs[0].paperSize='A4' ≠ app.settings.templatePaperWidth='80mm'",
      suggestedActions: [],
      status: 'needs-dev',
      description: '打印机驱动把纸宽固定为 A4（210000μm），忽略应用传入的 80mm 自定义页宽，小票被按 A4 版面输出'
    },
    {
      code: 'logo-measurement-race',
      severity: 'medium',
      scope: 'appConfig',
      evidence: 'renderSnapshot.heightDelta=265（immediatelyMeasured=1842 → afterImgDecode=2107）',
      suggestedActions: ['SWITCH_TO_DRIVER_CHANNEL'],
      status: 'pending',
      description: 'Logo 图片解码完成的测量竞态：两次渲染内容高度相差 265px，打印任务在图片未解码时发出会被驱动提前分页'
    }
  ]
}

describe('报告导出器（printer-diagnostics T8）', () => {
  it('golden：symptom2 报告三层 txt（摘要/打印机/发现/渲染快照/事件日志 + RAW JSON 附录）', () => {
    expect(buildReportTxt(SYMPTOM2_REPORT)).toMatchInlineSnapshot(`
      "════════ 打印机诊断报告 ════════
      应用版本见 settings · 采集时间: 2026-11-12T10:30:00+08:00 · Electron 44.10.1 · schemaVersion 1

      【摘要】
      打印机 1 台 · 发现问题 2 个（已自动修复 0 · 待确认 1 · 需人工/开发 1）
      Spooler 服务: Running · 事件日志: Operational 已启用

      【打印机】
      - POS-80 Printer [online] 驱动:POS80 Printer Driver 端口:USB001(usb) 队列:0

      【发现问题】（按 severity 排序 critical>high>medium>info）
      [high] driver-page-size-ignored（printer） POS-80 Printer
        描述: 打印机驱动把纸宽固定为 A4（210000μm），忽略应用传入的 80mm 自定义页宽，小票被按 A4 版面输出
        证据: system.printConfigs[0].paperSize='A4' ≠ app.settings.templatePaperWidth='80mm'
        建议: 需开发介入
        状态: needs-dev
      [medium] logo-measurement-race（appConfig）
        描述: Logo 图片解码完成的测量竞态：两次渲染内容高度相差 265px，打印任务在图片未解码时发出会被驱动提前分页
        证据: renderSnapshot.heightDelta=265（immediatelyMeasured=1842 → afterImgDecode=2107）
        建议: SWITCH_TO_DRIVER_CHANNEL
        状态: pending

      【渲染快照】
      立即测量 1842px · 解码后 2107px · Δ265px
      内容宽 307px vs 纸宽 307px · DPR 1

      【事件日志摘录】
      Admin 通道 0 条（近 7 天）· Application 1000 崩溃 0 条
      最近: （无）

      ════════ 附录：机器可读数据 ════════
      === RAW JSON BEGIN ===
      {"schemaVersion":1,"collectedAt":"2026-11-12T10:30:00+08:00","snapshot":{"printers":[{"name":"POS-80 Printer","isDefault":true,"local":true,"network":false,"shared":false,"status":{"state":"online","detectedError":null,"source":"win32-printer"},"driver":{"name":"POS80 Printer Driver","matchesInstalled":true,"printProcessor":"WINPRINT","manufacturer":"Generic","rawOnlyBit":false},"port":{"name":"USB001","type":"usb","hostAddress":null,"portNumber":null,"snmpEnabled":null,"reachable":null},"queue":{"jobCount":0,"errorJobs":0,"deletingJobs":0,"spoolFiles":{"spl":0,"shd":0}},"jobs":[]}],"system":{"spooler":{"status":"Running","startType":"Auto","dependents":[]},"eventLog":{"adminEvents":[],"app1000Events":[],"operationalEnabled":true},"printConfigs":[{"printerName":"POS-80 Printer","paperSize":"A4","widthMicrons":210000,"heightMicrons":297000,"orientation":"Portrait"}]},"app":{"settings":{"channel":"driver","printerName":"POS-80 Printer","templatePaperWidth":"80mm"},"electronVersion":"44.10.1","printOptions":{"pageSizeMode":"custom-microns","marginsMode":"none","printBackground":true},"templateFacts":{"hasLogo":true,"logoPx":180,"cssPadding":"12px 9px"}},"renderSnapshot":{"immediatelyMeasured":1842,"afterImgDecode":2107,"heightDelta":265,"scrollWidth":307,"paperWidthPx":307,"horizontalOverflow":false,"dpr":1},"errors":{},"raw":{}},"renderSnapshot":{"immediatelyMeasured":1842,"afterImgDecode":2107,"heightDelta":265,"scrollWidth":307,"paperWidthPx":307,"horizontalOverflow":false,"dpr":1},"findings":[{"code":"driver-page-size-ignored","severity":"high","scope":"printer","printerName":"POS-80 Printer","evidence":"system.printConfigs[0].paperSize='A4' ≠ app.settings.templatePaperWidth='80mm'","suggestedActions":[],"status":"needs-dev","description":"打印机驱动把纸宽固定为 A4（210000μm），忽略应用传入的 80mm 自定义页宽，小票被按 A4 版面输出"},{"code":"logo-measurement-race","severity":"medium","scope":"appConfig","evidence":"renderSnapshot.heightDelta=265（immediatelyMeasured=1842 → afterImgDecode=2107）","suggestedActions":["SWITCH_TO_DRIVER_CHANNEL"],"status":"pending","description":"Logo 图片解码完成的测量竞态：两次渲染内容高度相差 265px，打印任务在图片未解码时发出会被驱动提前分页"}]}
      === RAW JSON END ===
      "
    `)
  })

  it('往返：RAW JSON BEGIN/END 之间内容可 JSON.parse，schemaVersion=1 且 heightDelta=265', () => {
    const txt = buildReportTxt(SYMPTOM2_REPORT)
    const beginMarker = '=== RAW JSON BEGIN ===\n'
    const begin = txt.indexOf(beginMarker)
    const end = txt.indexOf('\n=== RAW JSON END ===')
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(begin)

    const parsed = JSON.parse(txt.slice(begin + beginMarker.length, end)) as DiagnosticReport
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.renderSnapshot?.heightDelta).toBe(265)
  })

  it('脱敏：40 字符 document 截断为 20+…，原报告不改，txt 不含原文', () => {
    const longDoc = '甲'.repeat(40)
    const [printer] = SYMPTOM2_SNAPSHOT.printers
    const report: DiagnosticReport = {
      ...SYMPTOM2_REPORT,
      findings: [],
      snapshot: {
        ...SYMPTOM2_SNAPSHOT,
        printers: [{ ...printer, jobs: [{ document: longDoc, owner: 'wenshi', statusMask: 0, isOwnedByCurrentUser: true }] }]
      }
    }

    const redacted = redactSnapshot(report)
    expect(redacted.snapshot.printers[0].jobs[0].document).toBe('甲'.repeat(20) + '…')
    expect(redacted).not.toBe(report)
    // 不改原：原 report 的 document 仍是 40 字符
    expect(report.snapshot.printers[0].jobs[0].document).toBe(longDoc)

    const txt = buildReportTxt(report)
    expect(txt).not.toContain(longDoc)
    expect(txt).toContain('甲'.repeat(20) + '…')
  })

  it('封顶：预置 21 个历史文件 → 归档后 20 个，最旧被删 1 次', () => {
    const dir = '/fake/user-data'
    const state = Array.from({ length: 21 }, (_, i) => `diagnose-20260101-${String(i + 1).padStart(6, '0')}.json`)
    const writes: { path: string; data: string }[] = []
    const deletes: string[] = []

    const target = archiveHistory(SYMPTOM2_REPORT, dir, {
      mkdirDir: () => {},
      writeFile: (p, data) => {
        writes.push({ path: p, data })
      },
      listDir: () => [...state],
      deleteFile: (p) => {
        deletes.push(p)
        state.splice(state.indexOf(basename(p)), 1)
      }
    })

    expect(target).toBe(writes[0].path)
    expect(target).toMatch(/diagnose-\d{8}-\d{6}\.json$/)
    expect(state.length).toBe(20)
    expect(deletes).toEqual([join(dir, 'diagnostics', 'history', 'diagnose-20260101-000001.json')])
  })

  it('BOM：toTxtBuffer 前 3 字节 EF BB BF，解码后首行含标题且行尾 CRLF', () => {
    const buf = toTxtBuffer(SYMPTOM2_REPORT)
    expect(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)

    const decoded = buf.toString('utf8')
    expect(decoded.startsWith('\uFEFF')).toBe(true)
    expect(decoded).toContain('\r\n')
    expect(decoded.replace(/^\uFEFF/, '').split('\r\n')[0]).toContain('打印机诊断报告')
  })
})
