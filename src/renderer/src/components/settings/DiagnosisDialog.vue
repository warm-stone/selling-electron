<script setup lang="ts">
import { computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import type {
  DiagnosticReport,
  Finding,
  FindingSeverity,
  FindingStatus,
  PrinterDiagnostic,
  RepairActionId
} from '../../../../main/printing/diagnostics/schema'

/**
 * 打印机诊断报告对话框（printer-diagnostics Wave 4 / T10）。
 *
 * 纯渲染组件：props 进（报告 + 装载态）、事件出（repair / export）——
 * IPC 与 toast 全在 printing store（SettingsView 接线），本组件可被
 * @vue/test-utils 独立挂载测试（fixture 报告直喂）。
 *
 * 三区：系统概况 / 打印机列表 / 发现问题（按 severity 排序）；
 * pending 发现的建议动作渲染为按钮（L2 需 ElMessageBox 破坏半径确认），
 * L4 引导类与特定发现展开人工步骤（el-collapse 内联中文文案）。
 */

const props = withDefaults(
  defineProps<{
    visible: boolean
    report: DiagnosticReport | null
    /** 采集中（报告未就位时展示装载占位） */
    loading?: boolean
  }>(),
  { loading: false }
)

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'repair', actionId: RepairActionId, targetPrinter?: string): void
  (e: 'export'): void
}>()

// ══════════════ 修复动作前端目录 ══════════════

/**
 * actionId → 按钮/确认文案（渲染分级）。
 * 值与 src/main/printing/diagnostics/repair-script.ts 的 buildRepairActionCatalog
 * 保持一致（L1 的 SWITCH_ 两项与 CANCEL、L2 的 PURGE/MIGRATE/ENABLE、L4 引导类；
 * requiresConfirm 的动作带 confirmText）。preload 未暴露 catalog——组件内静态
 * 映射避免跨进程拉目录，后端目录变更时需同步此处（L4 三项不渲染执行按钮，只出引导面板）。
 */
const REPAIR_ACTION_UI: Record<
  RepairActionId,
  { label: string; level: 'L1' | 'L2' | 'L4'; confirmText?: string }
> = {
  CANCEL_ERROR_JOBS: { label: '清除我的错误任务', level: 'L1' },
  SWITCH_TO_DRIVER_CHANNEL: {
    label: '切换到驱动渲染通道',
    level: 'L1',
    confirmText:
      '将把应用的打印通道切换为「驱动渲染」（由打印机驱动渲染完整版面，绕开 RAW 通道兼容性问题），修改后立即生效。'
  },
  SWITCH_TO_SPOOLER_CHANNEL: {
    label: '切回指令直发通道',
    level: 'L1',
    confirmText:
      '将把应用的打印通道切回「系统打印机」（ESC/POS 指令直发，速度最快），修改后立即生效。'
  },
  PURGE_QUEUE_RESTART_SPOOLER: {
    label: '清空队列并重启打印服务',
    level: 'L2',
    confirmText:
      '将停止打印服务并清空本机所有打印机的队列任务（影响本机全部打印任务，需管理员授权），完成后自动重启服务。'
  },
  MIGRATE_WSD_TO_TCP: {
    label: '迁移为标准 TCP/IP 端口',
    level: 'L2',
    confirmText:
      '将把该打印机端口迁移为标准 TCP/IP 端口（保留旧端口可回退）。建议先通过打印机自检页确认其 IP 地址。'
  },
  ENABLE_PRINT_LOG: {
    label: '启用打印服务详细日志',
    level: 'L2',
    confirmText:
      '将启用 Windows 打印服务的详细日志（一次性）。需管理员授权，日志供下次诊断定位问题。'
  },
  DISABLE_SNMP: { label: '禁用 SNMP 状态监测（引导）', level: 'L4' },
  REINSTALL_DRIVER_GUIDE: { label: '重装打印机驱动（引导）', level: 'L4' },
  GENERIC_TEXT_ONLY_GUIDE: { label: '改装 Generic / Text Only 驱动（引导）', level: 'L4' }
}

/** L4 引导类动作的人工步骤（GENERIC 五步与 docs/windows-manual-checklist.md 第 3 节一致） */
const ACTION_GUIDES: Partial<Record<RepairActionId, string[]>> = {
  GENERIC_TEXT_ONLY_GUIDE: [
    '打开「控制面板 → 设备和打印机」→「添加打印机」',
    '选「我需要的打印机不在列表中」',
    '选择对应端口：USB 连接选 USB001/USB002；网口连接选「添加 TCP/IP 端口」并填打印机 IP',
    '厂商选 Generic，打印机选 Generic / Text Only，完成安装',
    '回到本应用「设置 → 打印设置」，打印机选择新建的 Generic / Text Only，重新测试打印'
  ],
  REINSTALL_DRIVER_GUIDE: [
    '到打印机厂商官网下载对应型号的最新驱动（优先 WHQL 认证版）',
    '「控制面板 → 设备和打印机」右键该打印机 →「删除设备」',
    '运行驱动安装程序，按向导重新连接打印机',
    '回到本应用「设置 → 打印设置」重新选择打印机并测试打印',
    '若问题复现，重新诊断并查看事件日志中是否仍有崩溃记录'
  ],
  DISABLE_SNMP: [
    '打开「控制面板 → 设备和打印机」',
    '右键该打印机 →「打印机属性」→「端口」页',
    '选中该打印机的 TCP/IP 端口 →「配置端口」',
    '取消勾选「SNMP 状态已启用」→ 确定',
    '重新运行诊断，确认打印机状态恢复在线'
  ]
}

/** 无建议动作（或引导类）发现的特定人工指引 */
const FINDING_GUIDES: Partial<Record<string, string[]>> = {
  'printer-offline-flag': [
    '确认打印机电源已开启且处于联机（在线）状态',
    '检查 USB 线 / 网线连接，必要时换一个 USB 口',
    '「控制面板 → 设备和打印机」右键该打印机，若「脱机使用打印机」被勾选则取消勾选',
    '仍脱机时重启打印机与电脑后重试'
  ],
  'queue-paused': [
    '打开「控制面板 → 设备和打印机」',
    '右键该打印机 →「查看现在正在打印什么」',
    '取消勾选菜单中的「暂停打印」',
    '积压任务会自动继续打印'
  ],
  'printer-name-mismatch': [
    '回到本应用「设置 → 打印设置」',
    '在「打印机」下拉中重新选择当前实际存在的打印机',
    '保存后重新测试打印'
  ]
}

// ══════════════ 展示映射 ══════════════

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, info: 3 }

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  info: '提示'
}

const SEVERITY_ALERT: Record<FindingSeverity, 'error' | 'warning' | 'info'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  info: 'info'
}

const STATUS_BADGE: Record<FindingStatus, { label: string; type: 'success' | 'warning' | 'info' | 'danger' } | null> = {
  pass: null,
  'auto-fixed': { label: '已自动修复 ✓', type: 'success' },
  'verify-passed': { label: '已验证', type: 'success' },
  'verify-failed': { label: '复核未通过', type: 'danger' },
  escalated: { label: '未消除', type: 'warning' },
  'needs-manual': { label: '需人工处理', type: 'info' },
  'needs-dev': { label: '需开发介入', type: 'info' },
  pending: { label: '待处理', type: 'warning' }
}

const PRINTER_STATE_TAG: Record<PrinterDiagnostic['status']['state'], { type: 'success' | 'danger' | 'warning' | 'info'; label: string }> = {
  online: { type: 'success', label: '在线' },
  offline: { type: 'danger', label: '脱机' },
  paused: { type: 'warning', label: '已暂停' },
  error: { type: 'danger', label: '错误' },
  unknown: { type: 'info', label: '未知' }
}

const sortedFindings = computed<Finding[]>(() => {
  if (props.report === null) return []
  return [...props.report.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  )
})

const spoolerRunning = computed<boolean>(
  () => props.report?.snapshot.system.spooler.status === 'Running'
)

/** pending 发现的建议动作中可执行（L1/L2）的按钮项 */
function actionableButtons(f: Finding): Array<{ id: RepairActionId; ui: (typeof REPAIR_ACTION_UI)[RepairActionId] }> {
  if (f.status !== 'pending') return []
  return f.suggestedActions
    .map((id) => ({ id, ui: REPAIR_ACTION_UI[id] }))
    .filter((entry) => entry.ui.level !== 'L4')
}

/** 引导面板（L4 动作步骤 + 特定发现人工指引） */
function guideSections(f: Finding): Array<{ title: string; steps: string[] }> {
  const sections: Array<{ title: string; steps: string[] }> = []
  for (const id of f.suggestedActions) {
    const guide = ACTION_GUIDES[id]
    if (REPAIR_ACTION_UI[id].level === 'L4' && guide !== undefined) {
      sections.push({ title: REPAIR_ACTION_UI[id].label.replace('（引导）', ''), steps: guide })
    }
  }
  const findingGuide = FINDING_GUIDES[f.code]
  if (findingGuide !== undefined) {
    sections.push({ title: '人工处理步骤', steps: findingGuide })
  }
  return sections
}

async function onAction(actionId: RepairActionId, finding: Finding): Promise<void> {
  const ui = REPAIR_ACTION_UI[actionId]
  if (ui.level === 'L4') return
  if (ui.confirmText !== undefined) {
    try {
      await ElMessageBox.confirm(`${ui.confirmText}`, '确认执行修复动作', {
        type: 'warning',
        confirmButtonText: '执行',
        cancelButtonText: '取消'
      })
    } catch {
      return
    }
  }
  emit('repair', actionId, finding.printerName)
}

function onClose(): void {
  emit('update:visible', false)
}
</script>

<template>
  <el-dialog
    :model-value="props.visible"
    title="打印机诊断报告"
    width="720px"
    align-center
    class="diagnosis-dialog"
    data-testid="diagnosis-dialog"
    @update:model-value="onClose"
  >
    <!-- 采集中且尚无报告：装载占位（有旧报告时保持展示，按钮 loading 提示进度） -->
    <div v-if="props.report === null" class="diagnosis-loading" data-testid="diagnosis-loading">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>{{ props.loading ? '正在采集打印环境信息，通常需要几秒钟…' : '暂无诊断报告' }}</span>
    </div>

    <template v-else>
      <!-- ══ 区 1：系统概况 ══ -->
      <section class="diagnosis-zone diagnosis-zone--system" data-testid="diagnosis-zone-system">
        <h4 class="diagnosis-zone__title">系统概况</h4>
        <div class="diagnosis-summary">
          <span class="diagnosis-summary__row">
            打印服务（Print Spooler）：
            <el-tag :type="spoolerRunning ? 'success' : 'danger'" size="small">
              {{ spoolerRunning ? '运行中' : props.report.snapshot.system.spooler.status }}
            </el-tag>
          </span>
          <span class="diagnosis-summary__row">
            事件日志：
            {{
              props.report.snapshot.system.eventLog.operationalEnabled ? 'Operational 已启用' : 'Operational 未启用'
            }}
            · 管理错误 {{ props.report.snapshot.system.eventLog.adminEvents.length }} 条 · 应用崩溃
            {{ props.report.snapshot.system.eventLog.app1000Events.length }} 条
          </span>
          <span class="diagnosis-summary__row diagnosis-summary__row--meta">
            采集时间：{{ props.report.collectedAt.replace('T', ' ').replace(/Z|[+-]\d{2}:\d{2}$/, '') }}
          </span>
        </div>
      </section>

      <!-- ══ 区 2：打印机列表 ══ -->
      <section class="diagnosis-zone diagnosis-zone--printers" data-testid="diagnosis-zone-printers">
        <h4 class="diagnosis-zone__title">打印机（{{ props.report.snapshot.printers.length }} 台）</h4>
        <ul v-if="props.report.snapshot.printers.length > 0" class="printer-list">
          <li
            v-for="p in props.report.snapshot.printers"
            :key="p.name"
            class="printer-row"
            data-testid="diagnosis-printer-row"
          >
            <span class="printer-row__name" :title="p.name">{{ p.name }}</span>
            <el-tag :type="PRINTER_STATE_TAG[p.status.state].type" size="small">
              {{ PRINTER_STATE_TAG[p.status.state].label }}
            </el-tag>
            <span class="printer-row__meta">驱动：{{ p.driver.name }}</span>
            <el-tag v-if="p.driver.rawOnlyBit" type="info" size="small" effect="plain">仅 RAW</el-tag>
            <span class="printer-row__meta">端口：{{ p.port.name }}</span>
          </li>
        </ul>
        <p v-else class="printer-empty">未采集到打印机（打印服务不可用或本机未安装打印机）</p>
      </section>

      <!-- ══ 区 3：发现问题（severity 排序）═══ -->
      <section class="diagnosis-zone diagnosis-zone--findings" data-testid="diagnosis-zone-findings">
        <h4 class="diagnosis-zone__title">发现问题（{{ sortedFindings.length }} 项）</h4>
        <el-alert
          v-if="sortedFindings.length === 0"
          type="success"
          :closable="false"
          show-icon
          title="未发现问题，打印环境健康"
        />
        <div
          v-for="(f, idx) in sortedFindings"
          :key="`${f.code}-${f.printerName ?? ''}-${idx}`"
          class="diagnosis-finding"
          data-testid="diagnosis-finding"
        >
          <el-alert :type="SEVERITY_ALERT[f.severity]" :closable="false">
            <template #title>
              <span class="diagnosis-finding__title">
                <span class="diagnosis-finding__severity">[{{ SEVERITY_LABEL[f.severity] }}]</span>
                {{ f.description }}
              </span>
            </template>
            <div class="diagnosis-finding__body">
              <code class="diagnosis-finding__evidence">{{ f.evidence }}</code>
              <span class="diagnosis-finding__meta">
                <code>{{ f.code }}</code>
                <el-tag
                  v-if="STATUS_BADGE[f.status]"
                  :type="STATUS_BADGE[f.status]!.type"
                  size="small"
                  class="diagnosis-finding__status"
                  :data-testid="`finding-badge-${f.status}`"
                >
                  {{ STATUS_BADGE[f.status]!.label }}
                </el-tag>
              </span>
            </div>
            <div v-if="actionableButtons(f).length > 0" class="diagnosis-finding__actions">
              <el-button
                v-for="btn in actionableButtons(f)"
                :key="btn.id"
                size="small"
                :type="btn.ui.level === 'L2' ? 'warning' : 'primary'"
                :plain="btn.ui.level === 'L2'"
                :data-testid="`repair-btn-${btn.id}`"
                @click="onAction(btn.id, f)"
              >
                {{ btn.ui.label }}
              </el-button>
            </div>
            <el-collapse v-if="guideSections(f).length > 0" class="diagnosis-guide">
              <el-collapse-item
                v-for="(section, sIdx) in guideSections(f)"
                :key="sIdx"
                :title="section.title"
                :name="`${f.code}-${sIdx}`"
              >
                <ol class="diagnosis-guide__steps">
                  <li v-for="(step, tIdx) in section.steps" :key="tIdx">{{ step }}</li>
                </ol>
              </el-collapse-item>
            </el-collapse>
          </el-alert>
        </div>
      </section>
    </template>

    <template #footer>
      <el-button data-testid="diagnosis-dialog-close" @click="onClose">关闭</el-button>
      <el-button
        type="primary"
        :disabled="props.report === null"
        data-testid="diagnosis-dialog-export-btn"
        @click="emit('export')"
      >
        导出报告
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ── 装载占位 ── */
.diagnosis-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px 0;
  color: var(--el-text-color-secondary);
}

/* ── 三区骨架 ── */
.diagnosis-zone {
  margin-bottom: 18px;
}

.diagnosis-zone__title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  display: flex;
  align-items: center;
}

.diagnosis-zone__title::before {
  content: '';
  width: 3px;
  height: 12px;
  margin-right: 8px;
  border-radius: 1px;
  background: var(--el-color-warning);
}

/* ── 区 1 概况行 ── */
.diagnosis-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-lighter);
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.diagnosis-summary__row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.diagnosis-summary__row--meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ── 区 2 打印机行 ── */
.printer-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  overflow: hidden;
}

.printer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 14px;
  font-size: 13px;
}

.printer-row + .printer-row {
  border-top: 1px solid var(--el-border-color-lighter);
}

.printer-row__name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.printer-row__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.printer-empty {
  margin: 0;
  padding: 14px;
  border: 1px dashed var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ── 区 3 发现 ── */
.diagnosis-finding {
  margin-bottom: 10px;
}

.diagnosis-finding :deep(.el-alert__content) {
  max-width: 100%;
}

.diagnosis-finding__title {
  font-size: 13px;
  line-height: 1.6;
  display: inline-block;
}

.diagnosis-finding__severity {
  font-weight: 700;
  margin-right: 2px;
}

.diagnosis-finding__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.diagnosis-finding__evidence {
  font-family: var(--el-font-family-mono, 'Courier New', monospace);
  font-size: 11px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.diagnosis-finding__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.diagnosis-finding__meta code {
  font-size: 11px;
}

.diagnosis-finding__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

/* ── 引导面板 ── */
.diagnosis-guide {
  margin-top: 8px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.diagnosis-guide :deep(.el-collapse-item__header) {
  font-size: 12px;
  color: var(--el-color-primary);
  height: 32px;
  line-height: 32px;
}

.diagnosis-guide__steps {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--el-text-color-regular);
}
</style>
