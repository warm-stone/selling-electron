import { inject, provide, type InjectionKey } from 'vue'
import type { PaperWidth } from '../../../../shared/receipt/char-grid'
import type { ItemColumnWidths } from '../../../../shared/receipt/item-columns'
import type { Section, TotalLine } from '../../../../shared/receipt/template-schema'

/**
 * 模板编辑器共享草稿模型（TemplateEditorView 拆分批次 4）。
 *
 * draft 为页面级单一响应式表单模型：视图持有并负责 CRUD/序列化编排，
 * SectionListEditor 等子组件经 provide/inject 直接读写同一 reactive 对象
 * （实时预览依赖 draft 的即时变更——若走 props 传数组，子组件行内
 * v-model 会触发 vue/no-mutating-props；inject 共享是 Vue 官方对
 * 「深层共享表单模型」的推荐通道）。
 */

/** 表单草稿（与 ReceiptTemplate 字段一一对应） */
export interface TemplateDraft {
  name: string
  paperWidth: PaperWidth
  cutPaper: boolean
  header: Section[]
  items: {
    showHeader: boolean
    nameLabel: string
    qtyLabel: string
    priceLabel: string
    subtotalLabel: string
    /**
     * 列宽覆盖（Partial：undefined 键 = 未覆盖，沿用纸宽默认）。
     * 恒为对象（空对象起步）便于 el-input-number 直接绑定；
     * 序列化时未覆盖键不写入 JSON（见视图 serializeColumnWidths）。
     */
    columnWidths: Partial<ItemColumnWidths>
  }
  totals: TotalLine[]
  footer: Section[]
}

/** 段落行编辑目标（段落级为止，G14——无拖拽/逐元素样式） */
export type ListTarget = 'header' | 'footer' | 'totals'

const TEMPLATE_DRAFT_KEY: InjectionKey<TemplateDraft> = Symbol('template-editor-draft')

/** 视图侧：把页面级 draft（reactive）下发给段落编辑子组件 */
export function provideTemplateDraft(draft: TemplateDraft): void {
  provide(TEMPLATE_DRAFT_KEY, draft)
}

/** 子组件侧：取页面级 draft（未在视图内使用即编程错误——fail fast） */
export function useTemplateDraft(): TemplateDraft {
  const draft = inject(TEMPLATE_DRAFT_KEY)
  if (!draft) {
    throw new Error('useTemplateDraft 必须在 provideTemplateDraft 的组件树内使用')
  }
  return draft
}
