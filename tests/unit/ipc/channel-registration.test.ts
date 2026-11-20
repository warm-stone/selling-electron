import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import {
  getRegisteredChannels,
  resetRegisteredChannels
} from '../../../src/main/ipc/typed-handle'
import { registerCustomersIpc } from '../../../src/main/ipc/customers.ipc'
import { registerDiagnosticsIpc } from '../../../src/main/ipc/diagnostics.ipc'
import { registerPrintingIpc } from '../../../src/main/ipc/printing.ipc'
import { registerProductsIpc } from '../../../src/main/ipc/products.ipc'
import { registerPurchasesIpc } from '../../../src/main/ipc/purchases.ipc'
import { registerReportsExportIpc } from '../../../src/main/ipc/reports-export.ipc'
import { registerReportsIpc } from '../../../src/main/ipc/reports.ipc'
import { registerSalesIpc } from '../../../src/main/ipc/sales.ipc'
import { registerSettingsIpc } from '../../../src/main/ipc/settings.ipc'
import { registerTemplatesIpc } from '../../../src/main/ipc/templates.ipc'
import type { IpcChannels } from '../../../src/shared/types/ipc'
import { rmTempDirSync } from '../../helpers/cleanup'

/**
 * P0-3 契约测试了断：实际注册集 == 契约键集（替代已删除的
 * 「IPC_CHANNEL_NAMES == 手抄 EXPECTED_CHANNELS」循环断言）。
 *
 * 断言方向（omo 评估修正）：typedHandle 的 K extends keyof IpcChannels 已把
 * 「注册了未声明的通道」变成编译错误；本测试专抓编译期抓不到的反方向——
 * **契约声明了通道、主进程却没有任何 register*Ipc 注册它**。做法是驱动
 * 全部 10 个 register*Ipc（fake electron + 迁移后的临时库），从 typedHandle
 * 的运行时注册集取证，与下方清单比对。
 *
 * 下方 EXPECTED_CHANNELS 虽仍是手抄，但不再是孤儿：
 *  - satisfies + Equal<> 双向编译锁把它钉死在 keyof IpcChannels 上
 *    （契约增删通道而清单不动 → 编译失败）；
 *  - 运行时与真实注册集比对（register 漏装/handler 被删 → 测试失败）。
 *
 * fake electron 双路拦截（项目既有结论：vi.mock 拦不住运行时 require）：
 *  - vi.mock('electron')：customers/products/purchases/reports/sales 五个
 *    ipc 文件顶层静态 import { ipcMain }；
 *  - Module._load 补丁：reports-export/settings/templates/printing/diagnostics
 *    的懒 require('electron')（T2 模式，走 node CJS 加载器）。
 */

const h = vi.hoisted(() => {
  const handled: string[] = []
  const state = { userDataDir: '' }
  const electron = {
    ipcMain: {
      handle: (channel: string, _listener: unknown): void => {
        handled.push(channel)
      }
    },
    app: {
      getPath: (_name: 'userData'): string => state.userDataDir
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' })
    },
    BrowserWindow: { getAllWindows: (): unknown[] => [] },
    shell: {
      showItemInFolder: (): void => {},
      openExternal: async (): Promise<void> => {}
    }
  }
  return { handled, state, electron }
})

vi.mock('electron', () => h.electron)

// ── 编译期双向锁：清单与契约键集必须完全一致（多/漏一个都编译失败）──
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
  ? true
  : false

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
  // 客户
  'customers:list',
  'customers:create',
  'customers:update',
  // 销售
  'sales:checkout',
  'sales:void',
  'sales:list',
  'sales:detail',
  'sales:updateExtra',
  // 进货
  'purchases:create',
  'purchases:list',
  // 报表
  'reports:daily',
  'reports:monthly',
  'reports:export',
  // 打印
  'printing:printers',
  'printing:testPrint',
  'printing:rawProbe',
  'printing:preview',
  'printing:print',
  // 打印诊断
  'printing:diagnose',
  'printing:repair',
  'printing:diagnoseExport',
  // 模板
  'templates:list',
  'templates:create',
  'templates:update',
  'templates:delete',
  'templates:setDefault',
  // 设置
  'settings:get',
  'settings:set',
  'settings:listLogos',
  'settings:uploadLogo',
  'settings:deleteLogo',
  'settings:getRecentSalespersons'
] as const satisfies readonly (keyof IpcChannels)[]

// 契约增删通道而清单未同步 → 此赋值编译失败（双向 Equal）
const listMatchesContract: Equal<keyof IpcChannels, (typeof EXPECTED_CHANNELS)[number]> = true

let dir: string
let db: Database.Database
let origLoad: ((request: string, parent: unknown, isMain: boolean) => unknown) | undefined

beforeAll(() => {
  // 运行时 require('electron') 拦截（vi.mock 只覆盖静态 import）
  const mod = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  origLoad = mod._load
  mod._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') return h.electron
    return origLoad?.call(this, request, parent, isMain)
  }

  dir = mkdtempSync(join(tmpdir(), 'pos-channel-registration-'))
  h.state.userDataDir = dir
  db = new Database(join(dir, 'pos.db'))
  migrate(db)

  // 测试隔离：清掉其他测试文件可能累积的注册（同 worker 模块缓存复用）
  resetRegisteredChannels()
  h.handled.length = 0

  // 驱动全部 10 个 register*Ipc（与 main/index.ts 生产装配同一组函数）
  registerProductsIpc(db)
  registerSalesIpc(db)
  registerCustomersIpc(db)
  registerPurchasesIpc(db)
  registerReportsExportIpc(db)
  registerReportsIpc(db)
  registerPrintingIpc(db)
  registerDiagnosticsIpc(db)
  registerSettingsIpc(db)
  registerTemplatesIpc(db)
})

afterAll(() => {
  const mod = Module as unknown as { _load: unknown }
  mod._load = origLoad
  db?.close()
  if (dir) rmTempDirSync(dir)
})

describe('契约注册完整性（P0-3：声明的通道必须真的被注册）', () => {
  it('编译期：EXPECTED_CHANNELS 与 keyof IpcChannels 双向一致', () => {
    expect(listMatchesContract).toBe(true)
  })

  it('运行时：typedHandle 注册集 == 契约键集（驱动全部 register*Ipc 取证）', () => {
    const registered = [...getRegisteredChannels()].sort()
    const expected = [...EXPECTED_CHANNELS].sort()

    // 差集显式呈现（失败时可读：哪些声明了没注册 / 哪些注册了没声明）
    const declaredButUnregistered = expected.filter((c) => !registered.includes(c))
    const registeredButUndeclared = registered.filter(
      (c) => !(expected as string[]).includes(c)
    )
    expect({ declaredButUnregistered, registeredButUndeclared }).toEqual({
      declaredButUnregistered: [],
      registeredButUndeclared: []
    })
    expect(registered).toEqual(expected)
  })

  it('每个注册通道都真实抵达 ipcMain.handle（fake 收集器交叉验证）', () => {
    expect([...h.handled].sort()).toEqual([...EXPECTED_CHANNELS].sort())
  })

  it('通道名命名规范：<domain>:<action>（对真实注册集校验，非手抄清单）', () => {
    for (const name of getRegisteredChannels()) {
      expect(name).toMatch(/^[a-z]+:[a-zA-Z]+$/)
    }
  })
})
