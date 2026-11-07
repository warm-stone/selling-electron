// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CheckoutDialog from '../../../src/renderer/src/components/cart/CheckoutDialog.vue'
import { useCartStore } from '../../../src/renderer/src/stores/cart.store'
import type { CartAddSource } from '../../../src/renderer/src/stores/cart.store'
import type { CheckoutExtrasInput, Customer } from '../../../src/shared/types'

/**
 * Task 10 — 结账弹窗组件测试。
 *
 * 覆盖：
 * - 打开行为：拉取最近销售人员（settings 通道）/ 合计金额展示（分→元）/ 重开重置表单
 * - 校验规则矩阵（镜像后端 + ★客户备注缝隙 UI 收紧）：
 *   name 无 phone 阻断 / 国补无 name 阻断 / 全空放行 / 只填客户备注阻断
 * - 电话失焦查客户：phone 全等命中预填 + 提示 / 未命中不动手输 / 清空回散客态
 * - confirm extras 组装：trim / 全空 undefined（快单）/ 仅订单备注 / 含销售人员
 * - 取消零 confirm emit；submitting 态按钮 loading 防双击
 *
 * window.api 仅 mock 本组件消费的两通道（settings.getRecentSalespersons /
 * customers.list）；sales:checkout 在父视图（PosView），不在组件测试范围。
 */

// EP 弹层（popper/el-table 布局）依赖 ResizeObserver——jsdom 无原生实现，纯 stub 足够
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

/** 加购样例（CartAddSource 最小字段集；350 分 ×2 = 700 分 = ¥7.00） */
const COLA: CartAddSource = {
  id: 1,
  name: '可口可乐 330ml',
  barcode: '6901234567890',
  default_price_cents: 350,
  stock: 100
}

const ZHANG_SAN: Customer = {
  id: 7,
  name: '张三',
  phone: '13800001111',
  address: '幸福路 1 号',
  note: '老客户',
  created_at: '2026-01-01 09:00:00',
  updated_at: '2026-01-01 09:00:00'
}

const getRecentSalespersonsMock = vi.fn<() => Promise<string[]>>()
const listCustomersMock = vi.fn<
  (
    opts?: { keyword?: string; limit?: number; offset?: number }
  ) => Promise<{ items: Customer[]; total: number }>
>()

let wrapper: VueWrapper | undefined

/** 挂载弹窗（visible=true 直开）；cartSeed 可预置购物车行（合计展示用） */
function mountDialog(cartSeed?: (cart: ReturnType<typeof useCartStore>) => void): VueWrapper {
  const pinia = createPinia()
  setActivePinia(pinia)
  cartSeed?.(useCartStore())
  wrapper = mount(CheckoutDialog, {
    props: { visible: true, submitting: false },
    global: { plugins: [ElementPlus, pinia] }
  })
  return wrapper
}

function confirmClick(w: VueWrapper): Promise<void> {
  return w.find('[data-testid="checkout-dialog-confirm"]').trigger('click')
}

beforeEach(() => {
  getRecentSalespersonsMock.mockReset().mockResolvedValue([])
  listCustomersMock.mockReset().mockResolvedValue({ items: [], total: 0 })
  window.api = {
    settings: { getRecentSalespersons: getRecentSalespersonsMock },
    customers: { list: listCustomersMock }
  } as unknown as Window['api']
})

afterEach(() => {
  // 卸载组件（连带清理 el-select popper teleport 到 body 的挂载内容，防跨用例泄漏）
  wrapper?.unmount()
  wrapper = undefined
})

describe('CheckoutDialog 打开行为', () => {
  it('打开即拉取最近销售人员；合计金额分→元展示（¥7.00）', async () => {
    getRecentSalespersonsMock.mockResolvedValue(['王五'])
    const w = mountDialog((cart) => {
      cart.addItem(COLA)
      cart.addItem(COLA)
    })
    await flushPromises()

    expect(getRecentSalespersonsMock).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="checkout-total"]').text()).toContain('¥7.00')
  })

  it('重开弹窗：表单回初始（不残留上次输入），每次重新拉取销售人员', async () => {
    const w = mountDialog()
    await flushPromises()
    await w.find('[data-testid="checkout-customer-name"]').setValue('张三')

    await w.setProps({ visible: false })
    await flushPromises()
    await w.setProps({ visible: true })
    await flushPromises()

    expect(
      (w.find('[data-testid="checkout-customer-name"]').element as HTMLInputElement).value
    ).toBe('')
    expect(getRecentSalespersonsMock).toHaveBeenCalledTimes(2)
  })

  it('销售人员通道失败：静默回落空选项，不抛错不打断弹窗', async () => {
    getRecentSalespersonsMock.mockRejectedValue(new Error('ipc down'))
    const w = mountDialog()
    await flushPromises()

    expect(w.find('[data-testid="checkout-salesperson-select"]').exists()).toBe(true)
    expect(w.find('[data-testid="checkout-dialog-confirm"]').exists()).toBe(true)
  })
})

describe('CheckoutDialog 校验规则矩阵（镜像后端 + 备注缝隙收紧）', () => {
  // EP 错误文案渲染经 refDebounced(validateState, 100) 防抖——fake timers 推进后断言
  it('填姓名无电话：阻断，文案与后端逐字一致，不 emit confirm', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const w = mountDialog()
      await flushPromises()
      await w.find('[data-testid="checkout-customer-name"]').setValue('张三')

      await confirmClick(w)
      await flushPromises()
      vi.advanceTimersByTime(150)
      await flushPromises()

      expect(w.emitted('confirm')).toBeUndefined()
      expect(w.text()).toContain('填写客户姓名或地址时，电话不能为空')
    } finally {
      vi.useRealTimers()
    }
  })

  it('国补开而姓名/电话全空：阻断（文案与后端一致），不 emit confirm', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const w = mountDialog()
      await flushPromises()
      await w.find('[data-testid="checkout-subsidy-switch"]').trigger('click')

      await confirmClick(w)
      await flushPromises()
      vi.advanceTimersByTime(150)
      await flushPromises()

      expect(w.emitted('confirm')).toBeUndefined()
      expect(w.text()).toContain('参与国补需填写客户姓名和电话')
    } finally {
      vi.useRealTimers()
    }
  })

  it('★客户备注缝隙：只填客户备注无电话 → UI 层阻断（后端会静默丢弃 note）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const w = mountDialog()
      await flushPromises()
      await w.find('[data-testid="checkout-customer-note"]').setValue('VIP 客户')

      await confirmClick(w)
      await flushPromises()
      vi.advanceTimersByTime(150)
      await flushPromises()

      expect(w.emitted('confirm')).toBeUndefined()
      expect(w.text()).toContain('填写客户信息需提供电话')
    } finally {
      vi.useRealTimers()
    }
  })

  it('全空放行：confirm(undefined)——快单路径（不落 sale_extras 行）', async () => {
    const w = mountDialog()
    await flushPromises()

    await confirmClick(w)
    await flushPromises()

    expect(w.emitted('confirm')).toEqual([[undefined]])
  })

  it('国补开 + 姓名电话齐备：放行（切换即浮出必填错误，补齐后消散）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const w = mountDialog()
      await flushPromises()

      // 切换国补 → 即时校验 watch：错误浮出（防抖后渲染）
      await w.find('[data-testid="checkout-subsidy-switch"]').trigger('click')
      await flushPromises()
      vi.advanceTimersByTime(150)
      await flushPromises()
      expect(w.text()).toContain('参与国补需填写客户姓名和电话')

      // 补齐姓名/电话 → blur 重校验消散
      await w.find('[data-testid="checkout-customer-name"]').setValue('张三')
      await w.find('[data-testid="checkout-customer-phone"]').setValue('13800001111')
      await w.find('[data-testid="checkout-customer-name"]').trigger('blur')
      await w.find('[data-testid="checkout-customer-phone"]').trigger('blur')
      await flushPromises()
      vi.advanceTimersByTime(150)
      await flushPromises()
      expect(w.text()).not.toContain('参与国补需填写客户姓名和电话')

      await confirmClick(w)
      await flushPromises()

      const confirmEvents = w.emitted('confirm')
      expect(confirmEvents).toHaveLength(1)
      const extras = confirmEvents?.[0]?.[0] as CheckoutExtrasInput
      expect(extras.is_national_subsidy).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CheckoutDialog 电话失焦查客户', () => {
  it('命中 phone 全等：预填姓名/地址/客户备注 + 「已关联」提示', async () => {
    listCustomersMock.mockResolvedValue({ items: [ZHANG_SAN], total: 1 })
    const w = mountDialog()
    await flushPromises()

    await w.find('[data-testid="checkout-customer-phone"]').setValue('13800001111')
    await w.find('[data-testid="checkout-customer-phone"]').trigger('blur')
    await flushPromises()

    expect(listCustomersMock).toHaveBeenCalledWith({ keyword: '13800001111' })
    expect(
      (w.find('[data-testid="checkout-customer-name"]').element as HTMLInputElement).value
    ).toBe('张三')
    expect(
      (w.find('[data-testid="checkout-customer-address"]').element as HTMLInputElement).value
    ).toBe('幸福路 1 号')
    expect(
      (w.find('[data-testid="checkout-customer-note"]').element as HTMLInputElement).value
    ).toBe('老客户')
    expect(w.find('[data-testid="checkout-customer-hint"]').text()).toContain('已关联客户：张三')
  })

  it('未命中（keyword 模糊命中但 phone 不全等）：不预填、不清手输、无提示', async () => {
    listCustomersMock.mockResolvedValue({
      items: [{ ...ZHANG_SAN, name: '李四', phone: '13900002222' }],
      total: 1
    })
    const w = mountDialog()
    await flushPromises()
    await w.find('[data-testid="checkout-customer-name"]').setValue('手动输入')

    await w.find('[data-testid="checkout-customer-phone"]').setValue('13800001111')
    await w.find('[data-testid="checkout-customer-phone"]').trigger('blur')
    await flushPromises()

    expect(
      (w.find('[data-testid="checkout-customer-name"]').element as HTMLInputElement).value
    ).toBe('手动输入')
    expect(w.find('[data-testid="checkout-customer-hint"]').exists()).toBe(false)
  })

  it('电话清空失焦：客户信息组回初始（散客态），提示消散', async () => {
    listCustomersMock.mockResolvedValue({ items: [ZHANG_SAN], total: 1 })
    const w = mountDialog()
    await flushPromises()

    await w.find('[data-testid="checkout-customer-phone"]').setValue('13800001111')
    await w.find('[data-testid="checkout-customer-phone"]').trigger('blur')
    await flushPromises()
    expect(w.find('[data-testid="checkout-customer-hint"]').exists()).toBe(true)

    await w.find('[data-testid="checkout-customer-phone"]').setValue('')
    await w.find('[data-testid="checkout-customer-phone"]').trigger('blur')
    await flushPromises()

    for (const testId of ['checkout-customer-name', 'checkout-customer-address', 'checkout-customer-note']) {
      expect((w.find(`[data-testid="${testId}"]`).element as HTMLInputElement).value).toBe('')
    }
    expect(w.find('[data-testid="checkout-customer-hint"]').exists()).toBe(false)
  })

  it('查询失败：静默不阻断（无提示），表单可继续提交', async () => {
    listCustomersMock.mockRejectedValue(new Error('ipc down'))
    const w = mountDialog()
    await flushPromises()

    await w.find('[data-testid="checkout-customer-phone"]').setValue('13800001111')
    await w.find('[data-testid="checkout-customer-phone"]').trigger('blur')
    await flushPromises()

    expect(w.find('[data-testid="checkout-customer-hint"]').exists()).toBe(false)

    await confirmClick(w)
    await flushPromises()
    // 电话已填 → 校验放行（客户信息组有 phone 即有效）
    expect(w.emitted('confirm')).toHaveLength(1)
  })
})

describe('CheckoutDialog confirm extras 组装', () => {
  it('客户信息有值：四字段 trim 后组装，空串保留（后端 trim 后归一）', async () => {
    const w = mountDialog()
    await flushPromises()
    await w.find('[data-testid="checkout-customer-name"]').setValue('  张三  ')
    await w.find('[data-testid="checkout-customer-phone"]').setValue(' 13800001111 ')

    await confirmClick(w)
    await flushPromises()

    expect(w.emitted('confirm')).toEqual([
      [
        {
          customer: { name: '张三', phone: '13800001111', address: '', note: '' },
          is_national_subsidy: false,
          order_note: '',
          salesperson: ''
        }
      ]
    ])
  })

  it('仅订单备注：extras 带 order_note，customer 全空串（后端不建档、只落 extras 行）', async () => {
    const w = mountDialog()
    await flushPromises()
    await w.find('[data-testid="checkout-order-note"]').setValue('别放冰')

    await confirmClick(w)
    await flushPromises()

    const extras = w.emitted('confirm')?.[0]?.[0] as CheckoutExtrasInput
    expect(extras).toEqual({
      customer: { name: '', phone: '', address: '', note: '' },
      is_national_subsidy: false,
      order_note: '别放冰',
      salesperson: ''
    })
  })

  it('销售人员下拉：选项来自 getRecentSalespersons 通道，选择后入 extras', async () => {
    getRecentSalespersonsMock.mockResolvedValue(['王五', '李四'])
    const w = mountDialog()
    await flushPromises()

    // 打开下拉（popper teleport 到 body）→ 断言选项来自 mock 通道
    await w.find('.el-select__wrapper').trigger('click')
    await flushPromises()
    const labels = Array.from(
      document.body.querySelectorAll('.el-select-dropdown__item')
    ).map((el) => el.textContent?.trim() ?? '')
    expect(labels).toContain('王五')
    expect(labels).toContain('李四')

    // 真实用户路径：点选「王五」→ confirm extras 带 salesperson
    const target = Array.from(document.body.querySelectorAll('.el-select-dropdown__item')).find(
      (el) => el.textContent?.trim() === '王五'
    )
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    await confirmClick(w)
    await flushPromises()
    const extras = w.emitted('confirm')?.[0]?.[0] as CheckoutExtrasInput
    expect(extras.salesperson).toBe('王五')
  })
})

describe('CheckoutDialog 取消与提交态', () => {
  it('取消：emit update:visible false，零 confirm emit（购物车由父视图保留）', async () => {
    const w = mountDialog()
    await flushPromises()

    await w.find('[data-testid="checkout-dialog-cancel"]').trigger('click')

    expect(w.emitted('update:visible')).toEqual([[false]])
    expect(w.emitted('confirm')).toBeUndefined()
  })

  it('submitting=true：确认按钮 loading 态（is-loading，防双击）', async () => {
    const w = mountDialog()
    await flushPromises()
    await w.setProps({ submitting: true })

    expect(w.find('[data-testid="checkout-dialog-confirm"]').classes()).toContain('is-loading')
  })
})
