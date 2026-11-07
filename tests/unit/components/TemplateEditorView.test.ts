// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { VueWrapper } from '@vue/test-utils'
import TemplateEditorView from '../../../src/renderer/src/views/TemplateEditorView.vue'
import type { PrintTemplate } from '../../../src/shared/types'

/**
 * 模板编辑器顶部「可用变量」说明区组件测试。
 *
 * 说明区消费 shared/receipt/template-schema 的 RECEIPT_VAR_DOCS（单一事实源），
 * 断言用写死的期望数组锁数量与键名——schema 常量若漂移（改名/增删键）测试即红。
 * 覆盖：
 * - 渲染：8 个变量项（{shopName} 等 slot 原文 + 含义文本）、默认展开
 * - 点击复制：clipboard.writeText('{shopName}') + ElMessage.success('已复制')
 * - 剪贴板不可用（file:// Electron 容错）：静默降级——不 toast、不抛错
 */

/** EP 布局组件（select/radio-group 等）依赖 ResizeObserver（jsdom 无原生实现） */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

// ── window.api 前置 stub（视图 onMounted 走 templates.list / settings.listLogos）──

const api = vi.hoisted(() => {
  const templatesList = vi.fn<() => Promise<PrintTemplate[]>>()
  const listLogos = vi.fn<() => Promise<never[]>>()
  window.api = {
    templates: { list: templatesList },
    settings: { listLogos }
  } as unknown as Window['api']
  return { templatesList, listLogos }
})

/** ElMessage 渲染挂 document.body——spy 且置空实现，断言文案即可 */
const messageSuccessSpy = vi
  .spyOn(ElMessage, 'success')
  .mockImplementation(() => ({ close: () => undefined }))

/** navigator.clipboard stub（jsdom 无 secure context，直接定义属性） */
const clipboardWriteText = vi.fn<(text: string) => Promise<void>>()

/** 说明区期望的 8 个 slot 原文（写死锁定——防 schema 常量漂移静默通过） */
const EXPECTED_SLOTS = [
  '{shopName}',
  '{shopPhone}',
  '{receiptNote}',
  '{saleNo}',
  '{datetime}',
  '{total}',
  '{itemCount}',
  '{companyFooter}'
]

function mountView(): VueWrapper {
  return mount(TemplateEditorView, { global: { plugins: [ElementPlus] } })
}

beforeEach(() => {
  api.templatesList.mockReset().mockResolvedValue([])
  api.listLogos.mockReset().mockResolvedValue([])
  messageSuccessSpy.mockClear()
  clipboardWriteText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true
  })
})

describe('模板编辑器：可用变量说明区', () => {
  it('渲染全部 8 个变量（slot 原文 + 含义），默认展开可见', async () => {
    const wrapper = mountView()
    await flushPromises()

    const items = wrapper.findAll('[data-testid="tpl-var-item"]')
    expect(items).toHaveLength(8)

    const slots = items.map((i) => i.find('code').text())
    expect(slots).toEqual(EXPECTED_SLOTS)

    // 含义文本（≥2 条——含设置页来源语境、金额格式化语义、预留标注）
    const text = wrapper.text()
    expect(text).toContain('店名（设置页「店铺信息」）')
    expect(text).toContain('合计金额（元，已格式化两位小数，如 12.00）')
    expect(text).toContain('商品总件数')
    expect(text).toContain('预留扩展变量（当前未填充，打印时保留原文）')

    // 使用说明一句（插槽语义：未知保留原文）
    expect(text).toContain('未知变量保留原文')

    // 默认展开：变量项可见（el-collapse-item 的 wrap 为 v-show）
    expect(items[0].isVisible()).toBe(true)

    wrapper.unmount()
  })

  it('点击 {shopName} 复制到剪贴板并 toast「已复制」', async () => {
    const wrapper = mountView()
    await flushPromises()

    const first = wrapper.findAll('[data-testid="tpl-var-item"]')[0]
    expect(first.text()).toContain('{shopName}')
    await first.trigger('click')
    await flushPromises()

    expect(clipboardWriteText).toHaveBeenCalledTimes(1)
    expect(clipboardWriteText).toHaveBeenCalledWith('{shopName}')
    expect(messageSuccessSpy).toHaveBeenCalledTimes(1)
    expect(messageSuccessSpy).toHaveBeenCalledWith('已复制')

    wrapper.unmount()
  })

  it('剪贴板不可用时静默降级：不 toast、不抛错', async () => {
    clipboardWriteText.mockRejectedValue(new Error('Clipboard API denied'))
    const wrapper = mountView()
    await flushPromises()

    await wrapper.findAll('[data-testid="tpl-var-item"]')[0].trigger('click')
    await flushPromises()

    expect(clipboardWriteText).toHaveBeenCalledTimes(1)
    expect(messageSuccessSpy).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})
