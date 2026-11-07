// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { VueWrapper } from '@vue/test-utils'
import SalesHistoryView from '../../../src/renderer/src/views/SalesHistoryView.vue'
import type { Customer, Sale, SaleDetail, SaleExtraInfo } from '../../../src/shared/types'

/**
 * customer-order-extras 计划任务 12 — 销售明细弹窗附加信息区组件测试。
 *
 * 覆盖：
 * - 展示区：客户四行 / 散客占位 / 国补 tag 惯例（true 才有 el-tag——保 .el-tag 计数）/
 *   旧单 extras=null 退化 / 引用语义（重开明细反映客户档案改名）
 * - 编辑区可见性：completed 渲染（含表单初值回填）；voided 前置隐藏且不拉销售选项（Q4）
 * - 保存 patch 组装：未变字段不进 patch（undefined=不动）；电话清空 → customer:null
 *   （显式解绑）；电话新值 → customer 裸值对象（命中回传档案原值防 PUT 覆盖丢数据）
 * - 保存后刷新（updateExtra 返回明细即回填展示区+重拍表单快照）；失败 ElMessage.error
 *   中文文案（SALE_ALREADY_VOIDED）；保存中 loading 防双击
 *
 * window.api 走 vi.hoisted 前置 stub：SalesHistoryView → printing.store 链在模块
 * 顶层即读 window.api.invoke（import 时求值），beforeEach 里赋值来不及。
 */

/** el-table 布局依赖 ResizeObserver（jsdom 无原生实现；纯 stub 足以渲染行） */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

// ── window.api 前置 stub（hoisted：必须先于视图模块 import 生效）──

const api = vi.hoisted(() => {
  const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>()
  const updateExtra = vi.fn<(saleId: number, patch: unknown) => Promise<unknown>>()
  const customersList = vi.fn<
    (opts?: { keyword?: string; limit?: number; offset?: number }) => Promise<{
      items: unknown[]
      total: number
    }>
  >()
  const recentSalespersons = vi.fn<() => Promise<string[]>>()
  window.api = {
    invoke,
    sales: { updateExtra },
    customers: { list: customersList },
    settings: { getRecentSalespersons: recentSalespersons }
  } as unknown as Window['api']
  return { invoke, updateExtra, customersList, recentSalespersons }
})

// ElMessage 渲染挂 document.body——spy 且置空实现，断言文案即可
const messageErrorSpy = vi
  .spyOn(ElMessage, 'error')
  .mockImplementation(() => ({ close: () => undefined }))
const messageSuccessSpy = vi
  .spyOn(ElMessage, 'success')
  .mockImplementation(() => ({ close: () => undefined }))

// ── fixtures ──

function makeSale(patch: Partial<Sale> = {}): Sale {
  return {
    id: 1,
    sale_no: '20261107-0001',
    total_cents: 5200,
    item_count: 2,
    status: 'completed',
    voided_at: null,
    created_at: '2026-11-07 10:00:00',
    ...patch
  }
}

function makeDetail(patch: Partial<SaleDetail> = {}): SaleDetail {
  return {
    ...makeSale(),
    items: [
      {
        id: 1,
        sale_id: 1,
        product_id: 1,
        product_name: '可口可乐 330ml',
        barcode: '6901234567890',
        quantity: 2,
        unit_price_cents: 350,
        subtotal_cents: 700,
        sn: null
      }
    ],
    extras: null,
    ...patch
  }
}

function makeCustomer(patch: Partial<Customer> = {}): Customer {
  return {
    id: 7,
    name: '张三',
    phone: '13800001111',
    address: '高新区天府大道 1 号',
    note: '老客户，手机贴膜免费',
    created_at: '2026-11-01 10:00:00',
    updated_at: '2026-11-02 09:30:00',
    ...patch
  }
}

const ZHANG = makeCustomer()

function makeExtras(patch: Partial<SaleExtraInfo> = {}): SaleExtraInfo {
  return {
    sale_id: 1,
    customer_id: 7,
    is_national_subsidy: true,
    order_note: '含安装服务',
    salesperson: '李销售',
    customer: ZHANG,
    ...patch
  }
}

/** invoke 路由返回值（测试内按需覆写） */
let detailResponse: SaleDetail = makeDetail()
let salesListResponse: Sale[] = [makeSale()]

function mountView(): VueWrapper {
  return mount(SalesHistoryView, {
    global: { plugins: [ElementPlus, createPinia()] }
  })
}

/** 列表加载 → 点「查看明细」→ detail 拉取完成（打开弹窗的唯一真实入口） */
async function openDetailDialog(wrapper: VueWrapper): Promise<void> {
  await flushPromises()
  const btn = wrapper.findAll('button').find((b) => b.text() === '查看明细')
  expect(btn).toBeDefined()
  await btn!.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  detailResponse = makeDetail()
  salesListResponse = [makeSale()]
  api.invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'sales:list') return salesListResponse
    if (channel === 'sales:detail') return detailResponse
    throw new Error(`unexpected ipc channel in test: ${channel}`)
  })
  api.updateExtra.mockReset()
  api.customersList.mockReset().mockResolvedValue({ items: [], total: 0 })
  api.recentSalespersons.mockReset().mockResolvedValue(['李销售'])
  messageErrorSpy.mockClear()
  messageSuccessSpy.mockClear()
})

describe('明细弹窗：附加信息展示区', () => {
  it('extras.customer 存在 → 姓名/电话/地址/客户备注四行；国补 true 渲染 el-tag「国补」', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    expect(wrapper.find('[data-testid="detail-customer-name"]').text()).toBe('张三')
    expect(wrapper.find('[data-testid="detail-customer-phone"]').text()).toBe('13800001111')
    expect(wrapper.find('[data-testid="detail-customer-address"]').text()).toBe(
      '高新区天府大道 1 号'
    )
    expect(wrapper.find('[data-testid="detail-customer-note"]').text()).toBe('老客户，手机贴膜免费')
    expect(wrapper.find('[data-testid="detail-order-note"]').text()).toBe('含安装服务')
    expect(wrapper.find('[data-testid="detail-salesperson"]').text()).toBe('李销售')

    // tag 惯例（ReportsView）：true → el-tag success「国补」；展示区内 .el-tag 恰 1 个
    const extras = wrapper.find('[data-testid="detail-extras"]')
    const tags = extras.findAll('.el-tag')
    expect(tags).toHaveLength(1)
    expect(tags[0]!.text()).toBe('国补')
    expect(tags[0]!.classes()).toContain('el-tag--success')
  })

  it('旧单 extras=null → 散客占位；国补 false 纯文本「否」（展示区零 .el-tag）', async () => {
    detailResponse = makeDetail({ extras: null })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    expect(wrapper.find('[data-testid="detail-customer-placeholder"]').text()).toBe(
      '散客（未填写客户信息）'
    )
    expect(wrapper.find('[data-testid="detail-customer-name"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-subsidy"]').text()).toBe('否')
    expect(wrapper.find('[data-testid="detail-order-note"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="detail-salesperson"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="detail-extras"]').findAll('.el-tag')).toHaveLength(0)
  })

  it('引用语义：客户档案改名后重开明细立即反映（非快照）', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)
    expect(wrapper.find('[data-testid="detail-customer-name"]').text()).toBe('张三')

    // 客户管理侧改档案（customers:update）→ sales:detail 重新 JOIN 最新行
    detailResponse = makeDetail({
      extras: makeExtras({ customer: makeCustomer({ name: '张三丰' }) })
    })
    await openDetailDialog(wrapper)
    expect(wrapper.find('[data-testid="detail-customer-name"]').text()).toBe('张三丰')
  })
})

describe('明细弹窗：编辑区可见性与初值（Q4）', () => {
  it('completed 单渲染编辑区，四字段初值=当前附加值；无改动时保存禁用 + 拉销售人员选项', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    const edit = wrapper.find('[data-testid="extra-edit"]')
    expect(edit.exists()).toBe(true)
    expect(api.recentSalespersons).toHaveBeenCalledTimes(1)

    // 初值回填
    const phone = wrapper.find('[data-testid="extra-customer-phone"]')
    expect((phone.element as HTMLInputElement).value).toBe('13800001111')
    const note = wrapper.find('[data-testid="extra-order-note"]')
    expect((note.element as HTMLTextAreaElement).value).toBe('含安装服务')
    // 国补 true → switch 激活态
    expect(wrapper.find('[data-testid="extra-is-subsidy"]').classes()).toContain('is-checked')

    // 无改动 → 保存禁用
    const save = wrapper.find('[data-testid="extra-save"]')
    expect((save.element as HTMLButtonElement).disabled).toBe(true)
    expect(api.updateExtra).not.toHaveBeenCalled()
  })

  it('voided 单：作废警示可见，编辑区整体隐藏且不拉销售人员选项', async () => {
    detailResponse = makeDetail({
      status: 'voided',
      voided_at: '2026-11-07 11:00:00',
      extras: makeExtras()
    })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    expect(wrapper.find('[data-testid="extra-edit"]').exists()).toBe(false)
    expect(wrapper.find('.el-alert').text()).toContain('该单已作废')
    // 展示区仍可见（历史信息只读保留）
    expect(wrapper.find('[data-testid="detail-customer-name"]').text()).toBe('张三')
    expect(api.recentSalespersons).not.toHaveBeenCalled()
  })
})

describe('明细弹窗：电话联想（Q5）', () => {
  it('电话不变失焦：无提示（undefined=不动）', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    const phone = wrapper.find('[data-testid="extra-customer-phone"]')
    await phone.setValue(' 13800001111 ') // trim 后同值
    await phone.trigger('blur')
    await flushPromises()

    expect(wrapper.find('[data-testid="extra-phone-hint"]').exists()).toBe(false)
    expect(api.customersList).not.toHaveBeenCalled()
  })

  it('清空电话失焦：提示「将解绑客户」', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    await wrapper.find('[data-testid="extra-customer-phone"]').setValue('')
    await wrapper.find('[data-testid="extra-customer-phone"]').trigger('blur')
    await flushPromises()

    const hint = wrapper.find('[data-testid="extra-phone-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('将解绑客户')
  })

  it('新电话失焦：customers.list 查全等项，命中 → 「将关联：王五」', async () => {
    const wang = makeCustomer({
      id: 9,
      name: '王五',
      phone: '13900002222',
      address: '人民南路 2 号',
      note: 'VIP'
    })
    api.customersList.mockResolvedValue({ items: [ZHANG, wang], total: 2 })
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    const phone = wrapper.find('[data-testid="extra-customer-phone"]')
    await phone.setValue('13900002222')
    await phone.trigger('blur')
    await flushPromises()

    expect(api.customersList).toHaveBeenCalledWith({ keyword: '13900002222' })
    const hint = wrapper.find('[data-testid="extra-phone-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe('将关联：王五')
  })

  it('新电话未命中：提示将新建客户', async () => {
    api.customersList.mockResolvedValue({ items: [], total: 0 })
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    await wrapper.find('[data-testid="extra-customer-phone"]').setValue('13700003333')
    await wrapper.find('[data-testid="extra-customer-phone"]').trigger('blur')
    await flushPromises()

    const hint = wrapper.find('[data-testid="extra-phone-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('13700003333')
    expect(hint.text()).toContain('新建客户')
  })
})

describe('明细弹窗：保存 patch 组装与结果刷新', () => {
  /** 编辑区表单的测试侧直达通道（el-select 交互在 jsdom 不便，仅此一处走 setupState） */
  function setSalesperson(wrapper: VueWrapper, value: string): void {
    const form = (
      wrapper.vm as unknown as { extraForm: { salesperson: string } }
    ).extraForm
    form.salesperson = value
  }

  it('未变字段不进 patch：只改订单备注+销售人员 → patch 恰含两键', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    await wrapper.find('[data-testid="extra-order-note"]').setValue('送货上门，周末送达')
    setSalesperson(wrapper, '王经理')
    await flushPromises()

    api.updateExtra.mockResolvedValue(
      makeDetail({
        extras: makeExtras({ order_note: '送货上门，周末送达', salesperson: '王经理' })
      })
    )
    await wrapper.find('[data-testid="extra-save"]').trigger('click')
    await flushPromises()

    // undefined=不动：国补/客户均未动 → 不出现在 patch
    expect(api.updateExtra).toHaveBeenCalledTimes(1)
    expect(api.updateExtra).toHaveBeenCalledWith(1, {
      order_note: '送货上门，周末送达',
      salesperson: '王经理'
    })
  })

  it('电话清空保存 → customer: null（显式解绑——Q5）；保存后展示区/表单刷新 + 成功消息', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    await wrapper.find('[data-testid="extra-customer-phone"]').setValue('')
    await wrapper.find('[data-testid="extra-customer-phone"]').trigger('blur')
    await flushPromises()
    expect(wrapper.find('[data-testid="extra-phone-hint"]').text()).toContain('将解绑客户')

    api.updateExtra.mockResolvedValue(
      makeDetail({
        extras: makeExtras({ customer_id: null, customer: null, salesperson: '李销售' })
      })
    )
    await wrapper.find('[data-testid="extra-save"]').trigger('click')
    await flushPromises()

    expect(api.updateExtra).toHaveBeenCalledWith(1, { customer: null })

    // 保存后：展示区变散客占位（updateExtra 返回明细即刷新）+ 成功消息
    expect(wrapper.find('[data-testid="detail-customer-placeholder"]').text()).toBe(
      '散客（未填写客户信息）'
    )
    expect(messageSuccessSpy).toHaveBeenCalledWith('附加信息已保存')
    // 表单重拍快照 → 无改动 → 保存再次禁用
    expect(
      (wrapper.find('[data-testid="extra-save"]').element as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('电话新值保存（命中档案）→ customer 对象回传档案原值（防 find-or-create PUT 覆盖丢数据）', async () => {
    const wang = makeCustomer({
      id: 9,
      name: '王五',
      phone: '13900002222',
      address: '人民南路 2 号',
      note: 'VIP'
    })
    api.customersList.mockResolvedValue({ items: [wang], total: 1 })
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    const phone = wrapper.find('[data-testid="extra-customer-phone"]')
    await phone.setValue('13900002222')
    await phone.trigger('blur')
    await flushPromises()

    api.updateExtra.mockResolvedValue(makeDetail({ extras: makeExtras({ customer: wang }) }))
    await wrapper.find('[data-testid="extra-save"]').trigger('click')
    await flushPromises()

    expect(api.updateExtra).toHaveBeenCalledWith(1, {
      customer: { name: '王五', phone: '13900002222', address: '人民南路 2 号', note: 'VIP' }
    })
    expect(wrapper.find('[data-testid="detail-customer-name"]').text()).toBe('王五')
  })

  it('电话新值保存（未命中且 blur 未查过）→ 保存前补查；仍无命中 → 空串档案裸建客户', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    // 改完直接保存（不经 blur 联想）：saveExtra 内自行 resolvePhoneMatch 兜底
    await wrapper.find('[data-testid="extra-customer-phone"]').setValue('13700003333')
    api.customersList.mockResolvedValue({ items: [], total: 0 })
    api.updateExtra.mockResolvedValue(
      makeDetail({
        extras: makeExtras({ customer_id: 9, customer: makeCustomer({ phone: '13700003333' }) })
      })
    )
    await wrapper.find('[data-testid="extra-save"]').trigger('click')
    await flushPromises()

    expect(api.customersList).toHaveBeenCalledWith({ keyword: '13700003333' })
    expect(api.updateExtra).toHaveBeenCalledWith(1, {
      customer: { name: '', phone: '13700003333', address: '', note: '' }
    })
  })

  it('保存失败：剥 IPC 前缀后 ElMessage.error 展示后端中文文案，展示区保持旧值', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    await wrapper.find('[data-testid="extra-order-note"]').setValue('新备注')
    api.updateExtra.mockRejectedValue(
      new Error(
        "Error invoking remote method 'sales:updateExtra': Error: 该销售单已作废"
      )
    )
    await wrapper.find('[data-testid="extra-save"]').trigger('click')
    await flushPromises()

    expect(messageErrorSpy).toHaveBeenCalledWith('该销售单已作废')
    // 失败不刷新：展示区仍是打开时的值，编辑态保留可重试
    expect(wrapper.find('[data-testid="detail-order-note"]').text()).toBe('含安装服务')
    expect((wrapper.find('[data-testid="extra-save"]').element as HTMLButtonElement).disabled)
      .toBe(false)
  })

  it('保存中 loading：按钮 is-loading 且二次点击不重发（防双击）', async () => {
    detailResponse = makeDetail({ extras: makeExtras() })
    const wrapper = mountView()
    await openDetailDialog(wrapper)

    await wrapper.find('[data-testid="extra-order-note"]').setValue('新备注')

    let resolveSave: (d: SaleDetail) => void = () => undefined
    api.updateExtra.mockImplementation(
      () =>
        new Promise<SaleDetail>((resolve) => {
          resolveSave = resolve
        })
    )
    const save = wrapper.find('[data-testid="extra-save"]')
    await save.trigger('click')
    await flushPromises()

    expect(api.updateExtra).toHaveBeenCalledTimes(1)
    expect(save.classes()).toContain('is-loading')
    await save.trigger('click')
    expect(api.updateExtra).toHaveBeenCalledTimes(1)

    resolveSave(makeDetail({ extras: makeExtras({ order_note: '新备注' }) }))
    await flushPromises()
    expect(save.classes()).not.toContain('is-loading')
    expect(messageSuccessSpy).toHaveBeenCalledWith('附加信息已保存')
  })
})
