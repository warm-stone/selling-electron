import { describe, expect, it, vi } from 'vitest'
import {
  createPrinterEnumerator,
  type PrintersCapableWindow
} from '../../../../src/main/printing/channels/printer-enumerator'

/**
 * Task 7 — printer-enumerator 单元测试。
 * 验证 G11：无窗口 / Linux / webContents 不可用 → 返回空数组不抛错；
 * 正常路径：getPrintersAsync 结果映射为 PrinterInfo[]。
 */

function fakeWindow(options: {
  printers?: unknown[]
  rejectWith?: Error
  destroyed?: boolean
}): PrintersCapableWindow {
  return {
    isDestroyed: () => options.destroyed ?? false,
    webContents: {
      getPrintersAsync: options.rejectWith
        ? vi.fn(() => Promise.reject(options.rejectWith))
        : vi.fn(() => Promise.resolve(options.printers ?? []))
    }
  }
}

describe('listSystemPrinters（createPrinterEnumerator）', () => {
  it('未提供 window provider（无窗口装配）→ 空数组不抛错', async () => {
    const enumerator = createPrinterEnumerator()
    await expect(enumerator.listSystemPrinters()).resolves.toEqual([])
  })

  it('provider 返回 null → 空数组不抛错', async () => {
    const enumerator = createPrinterEnumerator(() => null)
    await expect(enumerator.listSystemPrinters()).resolves.toEqual([])
  })

  it('provider 返回 undefined → 空数组不抛错', async () => {
    const enumerator = createPrinterEnumerator(() => undefined)
    await expect(enumerator.listSystemPrinters()).resolves.toEqual([])
  })

  it('窗口已销毁 → 空数组，不调用 getPrintersAsync', async () => {
    const win = fakeWindow({ printers: [{ name: 'X' }], destroyed: true })
    const enumerator = createPrinterEnumerator(() => win)
    await expect(enumerator.listSystemPrinters()).resolves.toEqual([])
    expect(win.webContents.getPrintersAsync).not.toHaveBeenCalled()
  })

  it('getPrintersAsync 抛错（Linux 无打印子系统等）→ 空数组不抛错（G11）', async () => {
    const enumerator = createPrinterEnumerator(() =>
      fakeWindow({ rejectWith: new Error('ENOSYS: no printers') })
    )
    await expect(enumerator.listSystemPrinters()).resolves.toEqual([])
  })

  it('正常路径：Electron PrinterInfo 映射为 PrinterInfo[]（含 RAW-ONLY 语义字段透传）', async () => {
    const printers = [
      {
        name: 'POS-80mm',
        displayName: '前台小票打印机',
        description: 'ESC/POS thermal',
        status: 3,
        isDefault: true,
        options: { 'printer-settings': 'irrelevant' } // Electron 平台附加字段应被容忍
      },
      { name: 'Microsoft Print to PDF', displayName: 'PDF', description: '', status: 0, isDefault: false }
    ]
    const enumerator = createPrinterEnumerator(() => fakeWindow({ printers }))
    const result = await enumerator.listSystemPrinters()
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'POS-80mm',
      displayName: '前台小票打印机',
      description: 'ESC/POS thermal',
      status: 3,
      isDefault: true
    })
    expect(result[1].name).toBe('Microsoft Print to PDF')
    expect(result[1].isDefault).toBe(false)
  })

  it('脏数据防御：非对象项 / 缺 name 项被过滤，不抛错', async () => {
    const printers = [null, 42, {}, { name: 'OK-1' }, { displayName: '无名' }]
    const enumerator = createPrinterEnumerator(() => fakeWindow({ printers }))
    const result = await enumerator.listSystemPrinters()
    expect(result).toEqual([{ name: 'OK-1' }])
  })
})
