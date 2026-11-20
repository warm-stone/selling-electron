import { describe, it, expect } from 'vitest'
import { createTypedInvoke } from '../../../src/shared/types/ipc'

// P0-3 了断：本文件原有的「IPC_CHANNEL_NAMES == 手抄 EXPECTED_CHANNELS」循环
// 断言已删除（手抄清单 A == 手抄清单 B，抓不到任何真实漂移；IPC_CHANNEL_NAMES
// 孤儿常量一并移除）。契约完整性保障换位：
//  - 「注册了未声明的通道」→ typedHandle 的 K extends keyof IpcChannels 编译期挡死；
//  - 「声明了但主进程没注册」→ tests/unit/ipc/channel-registration.test.ts
//    驱动全部 register*Ipc 后断言 typedHandle 运行时注册集 == 契约键集。

describe('createTypedInvoke（renderer 侧泛型封装）', () => {
  it('转发通道名与请求体到底层 invoke，并透传响应', async () => {
    const calls: Array<[string, unknown]> = []
    const invoke = async (channel: string, request?: unknown): Promise<unknown> => {
      calls.push([channel, request])
      return [{ id: 1, name: '可乐', barcode: '6901234567890' }]
    }
    const typed = createTypedInvoke(invoke)

    const products = await typed('products:list', { keyword: '可乐' })

    expect(products).toEqual([{ id: 1, name: '可乐', barcode: '6901234567890' }])
    expect(calls).toEqual([['products:list', { keyword: '可乐' }]])
  })

  it('void req 通道调用时不传请求体', async () => {
    const calls: Array<[string, unknown]> = []
    const invoke = async (channel: string, request?: unknown): Promise<unknown> => {
      calls.push([channel, request])
      return { shop_name: '测试店' }
    }
    const typed = createTypedInvoke(invoke)

    await typed('settings:get')

    expect(calls).toEqual([['settings:get', undefined]])
  })

  it('底层错误向上传播（打印失败可见）', async () => {
    const invoke = async (): Promise<unknown> => {
      throw new Error('printer not found')
    }
    const typed = createTypedInvoke(invoke)

    await expect(typed('printing:print', { sale_id: 1 })).rejects.toThrow('printer not found')
  })
})
