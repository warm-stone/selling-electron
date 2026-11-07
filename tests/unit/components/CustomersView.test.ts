// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import CustomersView from '../../../src/renderer/src/views/CustomersView.vue'
import type { Customer } from '../../../src/shared/types'

/**
 * Task 11 — 客户管理页组件测试。
 *
 * 覆盖：列表加载渲染 / 空态 / 搜索触发（防抖 300ms + keyword 透传）/
 * 新增提交（trim 归一 + 电话必填前端拦截）/ 编辑回填 + update 提交 /
 * 电话冲突（CUSTOMER_PHONE_EXISTS——后端 message 含现有客户姓名，弹窗不关）。
 *
 * window.api.customers 三通道全 mock；ElMessage error/success spy 断言消息文案
 * （mockImplementation 置空避免真实 DOM 挂载）。
 */

// el-table 布局依赖 ResizeObserver（jsdom 无原生实现；纯 stub 足以渲染行）
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

function makeCustomer(id: number, patch: Partial<Customer> = {}): Customer {
  return {
    id,
    name: '',
    phone: '',
    address: '',
    note: '',
    created_at: '2026-11-01 10:00:00',
    updated_at: '2026-11-02 09:30:00',
    ...patch
  }
}

const ALICE = makeCustomer(1, {
  name: '张三',
  phone: '13800001111',
  address: '高新区天府大道 1 号',
  note: '老客户，手机贴膜免费'
})

const listMock = vi.fn<
  (
    opts?: { keyword?: string; limit?: number; offset?: number }
  ) => Promise<{ items: Customer[]; total: number }>
>()
const createMock = vi.fn<
  (req: { name: string; phone: string; address: string; note: string }) => Promise<Customer>
>()
const updateMock = vi.fn<
  (
    id: number,
    patch: { name?: string; phone?: string; address?: string; note?: string }
  ) => Promise<Customer>
>()

// ElMessage 渲染挂 document.body——spy 且置空实现（MessageHandler 为 { close } 接口），
// 断言文案即可，不产生真实消息 DOM
const messageErrorSpy = vi
  .spyOn(ElMessage, 'error')
  .mockImplementation(() => ({ close: () => undefined }))
const messageSuccessSpy = vi
  .spyOn(ElMessage, 'success')
  .mockImplementation(() => ({ close: () => undefined }))

function mountView() {
  return mount(CustomersView, {
    global: { plugins: [ElementPlus] }
  })
}

/**
 * 断言弹窗已关闭：el-overlay 由 v-show 控制显隐（display:none 同步生效）；
 * destroy-on-close 的内容销毁挂在 leave transition 的 afterLeave（依赖 rAF 回退，
 * jsdom 下不可靠）——以「overlay 已隐藏」作为用户视角的关闭判定。
 */
function expectDialogHidden(wrapper: ReturnType<typeof mountView>): void {
  const overlay = wrapper.find('.el-overlay')
  expect(overlay.exists()).toBe(true)
  expect((overlay.element as HTMLElement).style.display).toBe('none')
}

/** 断言弹窗保持打开（overlay 可见）——电话冲突等业务错误场景 */
function expectDialogVisible(wrapper: ReturnType<typeof mountView>): void {
  const overlay = wrapper.find('.el-overlay')
  expect(overlay.exists()).toBe(true)
  expect((overlay.element as HTMLElement).style.display).not.toBe('none')
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue({ items: [ALICE], total: 1 })
  createMock.mockReset()
  updateMock.mockReset()
  messageErrorSpy.mockClear()
  messageSuccessSpy.mockClear()
  window.api = {
    customers: { list: listMock, create: createMock, update: updateMock }
  } as unknown as Window['api']
})

describe('CustomersView 列表加载与空态', () => {
  it('挂载即调 customers.list（limit 20 / offset 0），渲染行与列头', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(listMock).toHaveBeenCalledWith({ limit: 20, offset: 0 })

    const text = wrapper.find('[data-testid="customer-table"]').text()
    expect(text).toContain('姓名')
    expect(text).toContain('电话')
    expect(text).toContain('地址')
    expect(text).toContain('客户备注')
    expect(text).toContain('创建时间')
    expect(text).toContain('更新时间')
    expect(text).toContain('张三')
    expect(text).toContain('13800001111')
    expect(text).toContain('高新区天府大道 1 号')
    expect(text).toContain('2026-11-01 10:00:00')
    // 头部计数（total 来自服务端）
    expect(wrapper.find('.page-title__count').text()).toContain('共 1 位客户')
  })

  it('空列表渲染 el-empty「暂无客户」；无删除按钮/接口', async () => {
    listMock.mockResolvedValue({ items: [], total: 0 })
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('.el-empty').text()).toContain('暂无客户')
    // MUST NOT DO：无删除——全页不出现删除文案，update/delete 均未被调
    expect(wrapper.text()).not.toContain('删除')
  })
})

describe('CustomersView 搜索', () => {
  it('输入关键词防抖 300ms 后带 keyword 重查（页码在 1 时单次请求）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const wrapper = mountView()
      await flushPromises()
      listMock.mockClear()

      await wrapper.find('[data-testid="customer-search"]').setValue('张三')
      // 防抖窗口内不触发
      vi.advanceTimersByTime(200)
      expect(listMock).not.toHaveBeenCalled()

      vi.advanceTimersByTime(100)
      await flushPromises()
      expect(listMock).toHaveBeenCalledTimes(1)
      expect(listMock).toHaveBeenCalledWith({ keyword: '张三', limit: 20, offset: 0 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CustomersView 新增客户', () => {
  it('新增提交：四字段 trim 后调 create，成功消息 + 弹窗关闭 + 刷新', async () => {
    createMock.mockResolvedValue(makeCustomer(2, { name: '王五', phone: '13900002222' }))
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('[data-testid="customer-create-btn"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="customer-name"]').setValue('  王五  ')
    await wrapper.find('[data-testid="customer-phone"]').setValue(' 13900002222 ')
    await wrapper.find('[data-testid="customer-address"]').setValue(' 人民南路 2 号 ')
    await wrapper.find('[data-testid="customer-note"]').setValue('VIP 客户')

    listMock.mockClear()
    await wrapper.find('[data-testid="customer-save-btn"]').trigger('click')
    await flushPromises()

    expect(createMock).toHaveBeenCalledWith({
      name: '王五',
      phone: '13900002222',
      address: '人民南路 2 号',
      note: 'VIP 客户'
    })
    expect(messageSuccessSpy).toHaveBeenCalledWith('客户已创建')
    // 弹窗关闭 + 重新加载
    expectDialogHidden(wrapper)
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('电话为空：前端拦截提示「电话不能为空」，不调 create', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('[data-testid="customer-create-btn"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="customer-name"]').setValue('无电话客户')
    await wrapper.find('[data-testid="customer-save-btn"]').trigger('click')
    await flushPromises()

    expect(createMock).not.toHaveBeenCalled()
    // .el-form-item__error 经 refDebounced(100ms) 显示——须真实等待后再断言文案
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(wrapper.text()).toContain('电话不能为空')
    // 弹窗保持打开
    expectDialogVisible(wrapper)
  })
})

describe('CustomersView 编辑客户', () => {
  it('编辑回填行数据，改字段后调 update(id, patch)', async () => {
    updateMock.mockResolvedValue({ ...ALICE, name: '张三丰' })
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('[data-testid="customer-edit-btn"]').trigger('click')
    await flushPromises()

    // 回填（含地址/备注）
    expect(
      (wrapper.find('[data-testid="customer-name"]').element as HTMLInputElement).value
    ).toBe('张三')
    expect(
      (wrapper.find('[data-testid="customer-phone"]').element as HTMLInputElement).value
    ).toBe('13800001111')
    expect(
      (wrapper.find('[data-testid="customer-address"]').element as HTMLInputElement).value
    ).toBe('高新区天府大道 1 号')
    expect(
      (wrapper.find('[data-testid="customer-note"]').element as HTMLTextAreaElement).value
    ).toBe('老客户，手机贴膜免费')
    expect(wrapper.find('.el-dialog__title').text()).toBe('编辑客户')

    // 改姓名 + 电话留原值提交（update patch 查重「排除自身」由 service 保证）
    await wrapper.find('[data-testid="customer-name"]').setValue('张三丰')
    listMock.mockClear()
    await wrapper.find('[data-testid="customer-save-btn"]').trigger('click')
    await flushPromises()

    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock).toHaveBeenCalledWith(1, {
      name: '张三丰',
      phone: '13800001111',
      address: '高新区天府大道 1 号',
      note: '老客户，手机贴膜免费'
    })
    expect(messageSuccessSpy).toHaveBeenCalledWith('客户已保存')
    expectDialogHidden(wrapper)
    expect(listMock).toHaveBeenCalledTimes(1)
  })
})

describe('CustomersView 电话冲突（CUSTOMER_PHONE_EXISTS）', () => {
  it('create reject：剥 IPC 前缀后 ElMessage.error 展示后端 message（含现有客户姓名），弹窗不关', async () => {
    // 主进程 CustomerServiceError 经 invoke 序列化的真实形态
    createMock.mockRejectedValue(
      new Error(
        "Error invoking remote method 'customers:create': Error: 该电话已被客户「张三」使用"
      )
    )
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('[data-testid="customer-create-btn"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="customer-name"]').setValue('李四')
    await wrapper.find('[data-testid="customer-phone"]').setValue('13800001111')
    listMock.mockClear()

    await wrapper.find('[data-testid="customer-save-btn"]').trigger('click')
    await flushPromises()

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(messageErrorSpy).toHaveBeenCalledWith('该电话已被客户「张三」使用')
    // 弹窗不关：让用户改号后重交；列表也不刷新
    expectDialogVisible(wrapper)
    expect(
      (wrapper.find('[data-testid="customer-phone"]').element as HTMLInputElement).value
    ).toBe('13800001111')
    expect(listMock).not.toHaveBeenCalled()
  })
})
