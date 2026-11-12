import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiagnosticReport, Finding, FindingSeverity } from './schema'

/**
 * 诊断报告导出器（printer-diagnostics 计划 Wave 3 / T8）。
 *
 * 单文件双用途（用户确认的交付设计）：
 * - 人读层：摘要 / 打印机 / 发现问题 / 渲染快照 / 事件日志摘录（中文小节）；
 * - 机器读层：附录 RAW JSON（=== BEGIN/END === 标记包裹的紧凑 JSON）。
 *
 * 分层约束（对齐 export/txt.exporter + export.service 惯例）：
 * - buildReportTxt / redactSnapshot / toTxtBuffer 纯函数零 I/O；
 * - archiveHistory 是唯一 I/O 点，fs 经 deps 注入（vitest 纯 Node 免目录可测）；
 * - dialog/save 归 T9（export.service 集成）——本模块只产 Buffer/字符串/归档。
 *
 * BOM + CRLF 对齐 txt.exporter（Windows 记事本中文兼容）：
 * buildReportTxt 行尾 \n（测试/golden 友好），toTxtBuffer 统一转 \r\n 并前置 BOM。
 */

/** 快照层 document 脱敏上限（超出截断 + '…'；raw 段从简不逐 job 处理） */
const DOCUMENT_TRUNCATE = 20

/** 历史归档封顶：超过即删最旧（文件名 yyyyMMdd-HHmmss 前缀保证字典序 = 时间序） */
const HISTORY_CAP = 20

/** 历史文件名形状（列目录过滤 + 排序的事实源） */
const HISTORY_NAME_RE = /^diagnose-\d{8}-\d{6}\.json$/

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** severity 排序权重（critical > high > medium > info；sort 稳定，同级保持产出序） */
const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, info: 3 }

// ══════════════ 脱敏 ══════════════

function truncateDocument(doc: string): string {
  // Array.from 按 Unicode 码位切（emoji/代理对不被劈半；20 码位 + '…'）
  const chars = Array.from(doc)
  if (chars.length <= DOCUMENT_TRUNCATE) return doc
  return chars.slice(0, DOCUMENT_TRUNCATE).join('') + '…'
}

/**
 * 脱敏变换：返回新对象不改原。只作用于快照层 printers[].jobs[].document
 * （打印文档名可能含客户/单据敏感内容）；raw 各段保持段级原始输出，不逐 job 处理。
 * findings / system / app / renderSnapshot 均为诊断结构化数据，透传。
 */
export function redactSnapshot(report: DiagnosticReport): DiagnosticReport {
  return {
    ...report,
    snapshot: {
      ...report.snapshot,
      printers: report.snapshot.printers.map((p) => ({
        ...p,
        jobs: p.jobs.map((j) => ({ ...j, document: truncateDocument(j.document) }))
      }))
    }
  }
}

// ══════════════ 三层 txt ══════════════

/** 摘要三桶计数：已自动修复（auto-fixed/verify-passed）· 待确认（pending/verify-failed）· 需人工/开发（needs-manual/needs-dev/escalated） */
function statusBuckets(findings: readonly Finding[]): { autoFixed: number; pending: number; needsHuman: number } {
  let autoFixed = 0
  let pending = 0
  let needsHuman = 0
  for (const f of findings) {
    if (f.status === 'auto-fixed' || f.status === 'verify-passed') autoFixed++
    else if (f.status === 'pending' || f.status === 'verify-failed') pending++
    else if (f.status === 'needs-manual' || f.status === 'needs-dev' || f.status === 'escalated') needsHuman++
    // 'pass'：规则未命中时不产出（schema 契约），即便混入也不计入三桶
  }
  return { autoFixed, pending, needsHuman }
}

/** 建议 行：有动作透传 join；空动作回退 needs-dev→需开发介入 / 其余→人工引导 */
function adviceText(f: Finding): string {
  if (f.suggestedActions.length > 0) return f.suggestedActions.join(' + ')
  return f.status === 'needs-dev' ? '需开发介入' : '人工引导'
}

/**
 * 三层纯文本报告（人读五小节 + 机器读 RAW JSON 附录）。
 * 行尾统一 \n——CRLF 由 toTxtBuffer（导出 Buffer 层）处理。
 */
export function buildReportTxt(report: DiagnosticReport): string {
  const { snapshot, findings } = report
  const lines: string[] = []

  lines.push('════════ 打印机诊断报告 ════════')
  lines.push(
    `应用版本见 settings · 采集时间: ${report.collectedAt} · Electron ${snapshot.app.electronVersion} · schemaVersion ${report.schemaVersion}`
  )
  lines.push('')

  // ── 摘要 ──
  const { autoFixed, pending, needsHuman } = statusBuckets(findings)
  lines.push('【摘要】')
  lines.push(
    `打印机 ${snapshot.printers.length} 台 · 发现问题 ${findings.length} 个（已自动修复 ${autoFixed} · 待确认 ${pending} · 需人工/开发 ${needsHuman}）`
  )
  lines.push(
    `Spooler 服务: ${snapshot.system.spooler.status} · 事件日志: ${
      snapshot.system.eventLog.operationalEnabled ? 'Operational 已启用' : 'Operational 未启用'
    }`
  )
  lines.push('')

  // ── 打印机 ──
  lines.push('【打印机】')
  if (snapshot.printers.length === 0) {
    lines.push('（无）')
  }
  for (const p of snapshot.printers) {
    lines.push(
      `- ${p.name} [${p.status.state}] 驱动:${p.driver.name}${
        p.driver.rawOnlyBit ? ' (RAW)' : ''
      } 端口:${p.port.name}(${p.port.type}) 队列:${p.queue.jobCount}`
    )
  }
  lines.push('')

  // ── 发现问题（severity 排序） ──
  lines.push('【发现问题】（按 severity 排序 critical>high>medium>info）')
  if (findings.length === 0) {
    lines.push('（无）')
  }
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  for (const f of sorted) {
    lines.push(`[${f.severity}] ${f.code}（${f.scope}）${f.printerName ? ` ${f.printerName}` : ''}`)
    lines.push(`  描述: ${f.description}`)
    lines.push(`  证据: ${f.evidence}`)
    lines.push(`  建议: ${adviceText(f)}`)
    lines.push(`  状态: ${f.status}`)
  }
  lines.push('')

  // ── 渲染快照（T7 产出；未执行 render-check 时整节约缺） ──
  const rs = report.renderSnapshot ?? report.snapshot.renderSnapshot
  if (rs) {
    lines.push('【渲染快照】')
    lines.push(`立即测量 ${rs.immediatelyMeasured}px · 解码后 ${rs.afterImgDecode}px · Δ${rs.heightDelta}px`)
    lines.push(
      `内容宽 ${rs.scrollWidth}px vs 纸宽 ${rs.paperWidthPx}px${rs.horizontalOverflow ? '（溢出!）' : ''} · DPR ${rs.dpr}`
    )
    lines.push('')
  }

  // ── 事件日志摘录 ──
  const { adminEvents, app1000Events } = snapshot.system.eventLog
  lines.push('【事件日志摘录】')
  lines.push(`Admin 通道 ${adminEvents.length} 条（近 7 天）· Application 1000 崩溃 ${app1000Events.length} 条`)
  const recent = adminEvents.slice(0, 3).map((e) => `${e.time} #${e.id}`)
  lines.push(`最近: ${recent.length > 0 ? recent.join(' · ') : '（无）'}`)
  lines.push('')

  // ── 附录：机器可读数据（脱敏后紧凑 JSON——单行，标记对易于机械提取） ──
  lines.push('════════ 附录：机器可读数据 ════════')
  lines.push('=== RAW JSON BEGIN ===')
  lines.push(JSON.stringify(redactSnapshot(report)))
  lines.push('=== RAW JSON END ===')

  return `${lines.join('\n')}\n`
}

// ══════════════ Buffer（BOM + CRLF，对齐 txt.exporter） ══════════════

/** 导出 Buffer：\n→\r\n + UTF-8 BOM（Windows 记事本兼容）。 */
export function toTxtBuffer(report: DiagnosticReport): Buffer {
  const body = buildReportTxt(report).replace(/\n/g, '\r\n')
  return Buffer.concat([UTF8_BOM, Buffer.from(body, 'utf8')])
}

// ══════════════ 历史归档（封顶 20） ══════════════

/** archiveHistory 的 I/O 注入面（默认走同步 fs；vitest 注入 fake 免磁盘） */
export interface ArchiveDeps {
  mkdirDir?: (p: string) => void
  writeFile?: (p: string, data: string) => void
  listDir?: (p: string) => string[]
  deleteFile?: (p: string) => void
}

/** collectedAt（ISO 8601）→ 文件名时间戳 yyyyMMdd-HHmmss（本地钟；确定值免时钟注入） */
function formatStamp(iso: string): string {
  const d = new Date(iso)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

/**
 * 归档到 <userDataDir>/diagnostics/history/diagnose-<yyyyMMdd-HHmmss>.json（脱敏后 JSON），
 * 写后列目录封顶 HISTORY_CAP：超出删最旧（前缀字典序 = 时间序）。
 * 返回写入路径。同秒重复归档同名覆盖（计数不膨胀）。
 */
export function archiveHistory(report: DiagnosticReport, userDataDir: string, deps: ArchiveDeps = {}): string {
  const mkdirDir = deps.mkdirDir ?? ((p: string) => { mkdirSync(p, { recursive: true }) })
  const writeFile = deps.writeFile ?? ((p: string, data: string) => { writeFileSync(p, data, 'utf8') })
  const listDir = deps.listDir ?? ((p: string) => readdirSync(p))
  const deleteFile = deps.deleteFile ?? ((p: string) => { unlinkSync(p) })

  const dir = join(userDataDir, 'diagnostics', 'history')
  mkdirDir(dir)

  const target = join(dir, `diagnose-${formatStamp(report.collectedAt)}.json`)
  writeFile(target, JSON.stringify(redactSnapshot(report)))

  const names = listDir(dir)
    .filter((n) => HISTORY_NAME_RE.test(n))
    .sort()
  const excess = names.length - HISTORY_CAP
  for (let i = 0; i < excess; i++) {
    deleteFile(join(dir, names[i]))
  }
  return target
}
