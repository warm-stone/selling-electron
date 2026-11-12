import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type {
  DiagnosticReport,
  RepairActionId
} from '../../../main/printing/diagnostics/schema'

/**
 * 打印编排全局状态（Task 15）：小票预览弹窗的跨页复用中枢。
 *
 * PosView（结账成功回调）与 SalesHistoryView（重打按钮）都经 openPreview
 * 打开同一份 ReceiptPreviewDialog——「可复用组件」的全局状态载体。
 * print 走主进程串行队列（printing:print），失败 toast 由主进程 error
 * 文案承担（含通道名 + 重打引导——G3：销售已保存不受影响）。
 *
 * printer-diagnostics（T10）追加：打印机诊断三态机 + 报告载荷——
 * SettingsView「打印机诊断」卡片与 DiagnosisDialog 的共享状态源
 * （弹窗本体 props/emits 解耦，本 store 承担 IPC 与 toast）。
 */

/** printing:preview res 的运行时结构超集形态（契约只声明 template+sale，附加字段由主进程 PreviewPayload 提供） */
type PrintingPreviewResult = Awaited<ReturnType<typeof window.api.printing.preview>>

/**
 * printing:repair res 的运行时结构超集（T9 交接）：契约只声明 ok/error/verify，
 * 主进程另附 outcome（repair.runner RepairOutcome 的形状镜像——该模块非 main
 * 纯类型模块，不跨侧 import；字段契约见 diagnostics.ipc「运行时结构超集」注释，
 * 引导文案在 outcome.detail，前端按 outcome.status 分支）。
 */
type PrintingRepairResult = Awaited<ReturnType<typeof window.api.printing.repair>> & {
  outcome?: { status: 'done' | 'needs-manual' | 'dry-run'; detail?: string; commands?: string[] }
}

/** 诊断流程状态机：idle 未诊断 / collecting 采集中 / report 已出报告 / error 诊断失败 */
export type DiagnosisState = 'idle' | 'collecting' | 'report' | 'error'

const typedInvoke = createTypedInvoke(window.api.invoke)

/** 剥除 Electron invoke 序列化前缀（T8 模式） */
function extractIpcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const matched = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return matched ? matched[1] : raw
}

export const usePrintingStore = defineStore('printing', {
  state: () => ({
    visible: false,
    loading: false,
    printing: false,
    payload: null as PrintingPreviewResult | null,
    diagnosisState: 'idle' as DiagnosisState,
    diagnosisReport: null as DiagnosticReport | null
  }),

  getters: {
    /** 弹窗标题（单号随载荷）；无载荷时退化为通用标题 */
    title: (state): string =>
      state.payload ? `小票预览 · ${state.payload.sale.sale_no}` : '小票预览'
  },

  actions: {
    /** 打开预览（printing:preview → 弹窗）；加载失败内建 error toast，不抛出 */
    async openPreview(saleId: number): Promise<void> {
      this.loading = true
      try {
        const res = await typedInvoke('printing:preview', { sale_id: saleId })
        // res 契约类型为 { template, sale }；运行时是主进程 PreviewPayload
        // 的结构超集（T8 ProductRow 同款下传 cast）
        this.payload = res as PrintingPreviewResult
        this.visible = true
      } catch (err) {
        ElMessage.error(`小票预览加载失败：${extractIpcErrorMessage(err)}`)
      } finally {
        this.loading = false
      }
    },

    /** 立即打印（printing:print）；成功 toast + 关弹窗，失败 error toast（G3） */
    async print(): Promise<void> {
      const saleId = this.payload?.sale.id
      if (saleId === undefined || this.printing) return
      this.printing = true
      try {
        const res = await typedInvoke('printing:print', { sale_id: saleId })
        if (res.ok) {
          ElMessage.success('打印已发送')
          this.close()
        } else {
          // 主进程 error 含通道名 + 「销售已保存，可稍后在销售记录中重打」引导
          ElMessage.error(res.error ?? '打印失败')
        }
      } catch (err) {
        ElMessage.error(extractIpcErrorMessage(err))
      } finally {
        this.printing = false
      }
    },

    close(): void {
      this.visible = false
      this.payload = null
    },

    /**
     * 开始诊断（printing:diagnose）：collecting → report/error 三态机。
     * 失败（含非 Windows 平台守卫 G11）error toast；报告就位后 DiagnosisDialog 展示三区。
     */
    async diagnose(): Promise<void> {
      if (this.diagnosisState === 'collecting') return
      this.diagnosisState = 'collecting'
      try {
        const res = await window.api.printing.diagnose()
        if (res.ok && res.report) {
          this.diagnosisReport = res.report
          this.diagnosisState = 'report'
        } else {
          this.diagnosisState = 'error'
          ElMessage.error(res.error ?? '诊断失败')
        }
      } catch (err) {
        this.diagnosisState = 'error'
        ElMessage.error(`诊断失败：${extractIpcErrorMessage(err)}`)
      }
    },

    /**
     * 执行修复动作（printing:repair）：done 附 verify 时刷新报告；
     * needs-manual（含 UAC 拒绝）/ dry-run 用 info 引导而非红条（T9 契约）。
     */
    async repairAction(actionId: RepairActionId, targetPrinter?: string): Promise<void> {
      try {
        const res = (await window.api.printing.repair(
          actionId,
          targetPrinter
        )) as PrintingRepairResult
        if (res.ok) {
          if (res.verify) this.diagnosisReport = res.verify
          if (res.outcome?.status === 'needs-manual') {
            ElMessage.info(res.outcome.detail ?? '该操作需要人工处理，请按引导步骤操作')
          } else if (res.outcome?.status === 'dry-run') {
            ElMessage.info(res.outcome.detail ?? '已执行预演（未改动系统）')
          } else {
            ElMessage.success('修复动作已执行')
          }
        } else {
          ElMessage.error(res.error ?? '修复失败')
        }
      } catch (err) {
        ElMessage.error(`修复失败：${extractIpcErrorMessage(err)}`)
      }
    },

    /**
     * 导出诊断报告（printing:diagnoseExport）：保存对话框取消（无 filePath）静默；
     * 成功 toast 带完整路径。
     *
     * ★ 过桥前必须 JSON 深拷贝：pinia state 是 Vue 深度响应式 Proxy，
     * contextBridge 的结构化克隆不接受 Proxy（DataCloneError「An object
     * could not be cloned」——T10 E2E 场景七实测）；报告契约即纯 JSON。
     */
    async exportDiagnosisReport(): Promise<void> {
      const report = this.diagnosisReport
      if (report === null) return
      try {
        const plain = JSON.parse(JSON.stringify(report)) as DiagnosticReport
        const res = await window.api.printing.exportReport(plain)
        if (!res.ok) {
          ElMessage.error(res.error ?? '报告导出失败')
        } else if (res.filePath) {
          ElMessage.success(`报告已导出：${res.filePath}`)
        }
      } catch (err) {
        ElMessage.error(`报告导出失败：${extractIpcErrorMessage(err)}`)
      }
    },

    /**
     * 关闭诊断对话框：状态机回 idle，报告保留——卡片「导出报告」按钮仍可用，
     * 重新诊断时整体覆盖。采集中关闭则报告就位后对话框会重新打开（结果送达）。
     */
    closeDiagnosis(): void {
      this.diagnosisState = 'idle'
    }
  }
})
