import { describe, it, expect } from 'vitest'
import { IPC_CHANNEL_NAMES, createTypedInvoke } from '../../../src/shared/types/ipc'
import type { IpcChannels } from '../../../src/shared/types/ipc'

// ── 编译期断言工具：通道常量与 IpcChannels 键集必须完全一致（多/漏一个都编译失败）──
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
  ? true
  : false
type ChannelName = keyof IpcChannels
type FromConst = (typeof IPC_CHANNEL_NAMES)[number]

// ── 计划 Task 3 规定的通道清单（grep 断言的事实源）──
const EXPECTED_CHANNELS = [
  // 商品
  'products:list',
  'products:create',
  'products:update',
  'products:delete',
  'products:updateStock',
  'products:findSn',
  'products:listSns',
  'products:deleteSn',
  // 销售
  'sales:checkout',
  'sales:void',
  'sales:list',
  'sales:detail',
  // 进货
  'purchases:create',
  'purchases:list',
  // 报表
  'reports:daily',
  'reports:monthly',
  'reports:export',
  // 打印
  'printing:printers',
  'printing:preview',
  'printing:print',
  // 模板
  'templates:list',
  'templates:create',
  'templates:update',
  'templates:delete',
  'templates:setDefault',
  // 设置
  'settings:get',
  'settings:set'
] as const

describe('IPC 通道契约', () => {
  it('IPC_CHANNEL_NAMES 与计划通道清单一一对应', () => {
    expect([...IPC_CHANNEL_NAMES].sort()).toEqual([...EXPECTED_CHANNELS].sort())
  })

  it('通道常量与 IpcChannels 键集完全一致（编译期 Equal 已保证，运行时复核）', () => {
    const bothDirectionsMatch: Equal<ChannelName, FromConst> = true
    expect(bothDirectionsMatch).toBe(true)
  })

  it('通道名命名规范：<domain>:<action>（G8 typed surface，无魔法字符串）', () => {
    for (const name of IPC_CHANNEL_NAMES) {
      expect(name).toMatch(/^[a-z]+:[a-zA-Z]+$/)
    }
  })
})

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
