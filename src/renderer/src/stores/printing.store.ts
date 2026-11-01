import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { createTypedInvoke } from '../../../shared/types/ipc'

/**
 * 打印编排全局状态（Task 15）：小票预览弹窗的跨页复用中枢。
 *
 * PosView（结账成功回调）与 SalesHistoryView（重打按钮）都经 openPreview
 * 打开同一份 ReceiptPreviewDialog——「可复用组件」的全局状态载体。
 * print 走主进程串行队列（printing:print），失败 toast 由主进程 error
 * 文案承担（含通道名 + 重打引导——G3：销售已保存不受影响）。
 */

/** printing:preview res 的运行时结构超集形态（契约只声明 template+sale，附加字段由主进程 PreviewPayload 提供） */
type PrintingPreviewResult = Awaited<ReturnType<typeof window.api.printing.preview>>

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
    payload: null as PrintingPreviewResult | null
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
    }
  }
})
