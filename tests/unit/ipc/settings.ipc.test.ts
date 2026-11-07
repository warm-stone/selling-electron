import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { createLogoRepo, type LogoRow } from '../../../src/main/db/repositories/logo.repo'
import { createSettingsRepo } from '../../../src/main/db/repositories/settings.repo'
import { RECENT_SALESPERSONS_KEY } from '../../../src/main/services/salesperson-history'
import {
  DEFAULT_APP_SETTINGS,
  appSettingsPatchToKv,
  importLogoFile,
  readRecentSalespersons,
  removeLogoFile,
  rowsToLogoInfos,
  rowsToAppSettings
} from '../../../src/main/ipc/settings.ipc'
import { buildTestPrintBytes, TEST_PRINT_SALE, toPrintSettings } from '../../../src/main/ipc/printing.ipc'
import { DEFAULT_TEMPLATES } from '../../../src/shared/receipt/default-template'
import type { PrintTemplate } from '../../../src/shared/types'
import { encodeGbk } from '../../../src/main/printing/escpos/gb2312-encoder'
import { rmTempDirSync } from '../../helpers/cleanup'

let dir: string

/** 本文件打开的连接登记（Windows 不可删打开中的文件：afterEach 先逐一 close 再删目录） */
const openDbs: Database.Database[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-settings-ipc-'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
  rmTempDirSync(dir)
})

/** 1×1 透明 PNG（valid 头，dataURL 断言用） */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 打开已迁移库并登记（logo/settings repo 共用） */
function openDb(): Database.Database {
  const db = new Database(join(dir, 'pos.db'))
  openDbs.push(db)
  migrate(db)
  return db
}

/** 默认模板行（80mm，测试打印样例依赖） */
const TEMPLATE_ROW_80: PrintTemplate = {
  id: 1,
  name: '默认小票（80mm）',
  paper_width: '80mm',
  config_json: JSON.stringify(DEFAULT_TEMPLATES['80mm']),
  is_default: true,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-01 00:00:00'
}

describe('settings.ipc 纯映射：rowsToAppSettings', () => {
  it('空表 → 全默认值（通道默认 spooler，auto_cut 默认 true；logo_path 已从契约移除）', () => {
    expect(rowsToAppSettings({})).toEqual(DEFAULT_APP_SETTINGS)
    expect(DEFAULT_APP_SETTINGS.printer_channel).toBe('spooler')
    expect(DEFAULT_APP_SETTINGS.auto_cut).toBe(true)
    expect('logo_path' in DEFAULT_APP_SETTINGS).toBe(false)
  })

  it('KV 行 → AppSettings 类型化映射（端口 string→number，auto_cut 字符串→boolean）；DB 残留 logo_path 行被忽略', () => {
    const settings = rowsToAppSettings({
      shop_name: '我的小店',
      shop_phone: '13800000000',
      receipt_note: '谢谢惠顾',
      // 旧单 Logo 时代残留行：不再映射，无害（不做迁移）
      logo_path: '/tmp/logos/logo.png',
      printer_channel: 'tcp',
      printer_name: 'XP-58',
      tcp_host: '192.168.1.50',
      tcp_port: '9100',
      com_port: '\\\\.\\COM3',
      auto_cut: '0'
    })
    expect(settings).toEqual({
      shop_name: '我的小店',
      shop_phone: '13800000000',
      receipt_note: '谢谢惠顾',
      printer_channel: 'tcp',
      printer_name: 'XP-58',
      tcp_host: '192.168.1.50',
      tcp_port: 9100,
      com_port: '\\\\.\\COM3',
      auto_cut: false
    })
  })

  it('脏值防御：非法 printer_channel 回落 spooler，非数字端口回落 null，空串归一 null', () => {
    const settings = rowsToAppSettings({
      printer_channel: 'usb',
      tcp_port: '不是端口',
      printer_name: '',
      tcp_host: '',
      com_port: ''
    })
    expect(settings.printer_channel).toBe('spooler')
    expect(settings.tcp_port).toBeNull()
    expect(settings.printer_name).toBeNull()
    expect(settings.tcp_host).toBeNull()
    expect(settings.com_port).toBeNull()
  })

  it('auto_cut 非法值回落默认 true', () => {
    expect(rowsToAppSettings({ auto_cut: 'garbage' }).auto_cut).toBe(true)
  })
})

describe('settings.ipc 纯映射：appSettingsPatchToKv（settings:set 序列化）', () => {
  it('Partial → KV 条目（只含出现的 key；boolean/number → 字符串）', () => {
    expect(
      appSettingsPatchToKv({ shop_name: '我的小店', printer_channel: 'tcp', tcp_port: 9100, auto_cut: false })
    ).toEqual({ shop_name: '我的小店', printer_channel: 'tcp', tcp_port: '9100', auto_cut: '0' })
  })

  it('null 归一为空串（可空字段清除路径：null ≡ 空串）', () => {
    expect(appSettingsPatchToKv({ printer_name: null, tcp_port: null })).toEqual({
      printer_name: '',
      tcp_port: ''
    })
  })

  it('空 patch → 空条目（settings:set 空对象 no-op）', () => {
    expect(appSettingsPatchToKv({})).toEqual({})
  })

  it('非法通道值序列化为回落后的 spooler', () => {
    expect(appSettingsPatchToKv({ printer_channel: 'bluetooth' as never })).toEqual({
      printer_channel: 'spooler'
    })
  })

  it('round-trip：patch → kv → rowsToAppSettings 值语义一致', () => {
    const patch = {
      shop_name: '我的小店',
      printer_channel: 'serial' as const,
      com_port: '\\\\.\\COM3',
      auto_cut: true
    }
    expect(rowsToAppSettings(appSettingsPatchToKv(patch))).toEqual({
      ...DEFAULT_APP_SETTINGS,
      ...patch
    })
  })
})

describe('settings.ipc 读通道：readRecentSalespersons（settings:getRecentSalespersons 数据源）', () => {
  it('repo 无 key（get → null）→ []（新装/从未记录场景）', () => {
    const db = openDb()
    const repo = createSettingsRepo(db)
    expect(repo.get(RECENT_SALESPERSONS_KEY)).toBeNull()
    expect(readRecentSalespersons(repo)).toEqual([])
  })

  it('repo 返回合法 JSON 数组字符串 → 复原列表', () => {
    const db = openDb()
    const repo = createSettingsRepo(db)
    repo.set(RECENT_SALESPERSONS_KEY, '["张三","李四"]')
    expect(readRecentSalespersons(repo)).toEqual(['张三', '李四'])
  })

  it('repo 返回损坏 JSON → []（脏值防御，不抛错）', () => {
    const db = openDb()
    const repo = createSettingsRepo(db)
    repo.set(RECENT_SALESPERSONS_KEY, '{oops')
    expect(readRecentSalespersons(repo)).toEqual([])
  })

  it('白名单不泄漏回归：settings 表存在 recent_salespersons 行时 rowsToAppSettings 返回对象无该键（恰好白名单 9 键）', () => {
    const db = openDb()
    const repo = createSettingsRepo(db)
    repo.set(RECENT_SALESPERSONS_KEY, '["x"]')
    // 前置成立性：行确实已写入 settings 表
    expect(repo.get(RECENT_SALESPERSONS_KEY)).toBe('["x"]')

    const settings = rowsToAppSettings(repo.getAll())
    expect('recent_salespersons' in settings).toBe(false)
    expect(Object.keys(settings).sort()).toEqual(
      [
        'auto_cut',
        'com_port',
        'printer_channel',
        'printer_name',
        'receipt_note',
        'shop_name',
        'shop_phone',
        'tcp_host',
        'tcp_port'
      ].sort()
    )
  })
})

describe('settings.ipc 多 Logo 文件助手', () => {
  it('importLogoFile：复制到 logosDir/<uuid>.png + INSERT logos 行（display_name 默认原文件名去扩展）', async () => {
    const db = openDb()
    const repo = createLogoRepo(db)

    const src = join(dir, '店招图.png')
    writeFileSync(src, Buffer.from(PNG_1PX_BASE64, 'base64'))
    const logosDir = join(dir, 'logos')

    const row = await importLogoFile(src, logosDir, repo)

    // 唯一文件名：uuid.png（非原名），文件已复制，DB 行带展示名
    expect(row.filename).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(existsSync(join(logosDir, row.filename))).toBe(true)
    expect(row.display_name).toBe('店招图')
    // 源文件保留（复制语义）
    expect(existsSync(src)).toBe(true)
  })

  it('importLogoFile：同名重复上传互不覆盖（两次导入两行两文件）', async () => {
    const db = openDb()
    const repo = createLogoRepo(db)

    const src = join(dir, 'same.png')
    writeFileSync(src, Buffer.from(PNG_1PX_BASE64, 'base64'))
    const logosDir = join(dir, 'logos')

    const first = await importLogoFile(src, logosDir, repo)
    const second = await importLogoFile(src, logosDir, repo)

    expect(first.filename).not.toBe(second.filename)
    expect(repo.list()).toHaveLength(2)
  })

  it('rowsToLogoInfos：逐行读文件转 dataURL（data:image/png;base64 前缀）', async () => {
    const db = openDb()
    const repo = createLogoRepo(db)
    const logosDir = join(dir, 'logos')
    mkdirSync(logosDir, { recursive: true })

    const a = repo.insert('a.png', '店招 A')
    const b = repo.insert('b.png', '店招 B')
    writeFileSync(join(logosDir, 'a.png'), Buffer.from(PNG_1PX_BASE64, 'base64'))
    writeFileSync(join(logosDir, 'b.png'), Buffer.from(PNG_1PX_BASE64, 'base64'))

    const infos = await rowsToLogoInfos(repo.list(), logosDir)
    expect(infos).toEqual([
      { id: a.id, display_name: '店招 A', data_url: `data:image/png;base64,${PNG_1PX_BASE64}` },
      { id: b.id, display_name: '店招 B', data_url: `data:image/png;base64,${PNG_1PX_BASE64}` }
    ])
  })

  it('rowsToLogoInfos：文件缺失的行被跳过（优雅降级，不抛错），其余行正常返回', async () => {
    const logosDir = join(dir, 'logos')
    mkdirSync(logosDir, { recursive: true })

    const rows: LogoRow[] = [
      { id: 1, filename: 'a.png', display_name: 'A', created_at: '2026-11-01 00:00:00' },
      { id: 2, filename: 'missing.png', display_name: 'B', created_at: '2026-11-01 00:00:00' },
      { id: 3, filename: 'c.png', display_name: 'C', created_at: '2026-11-01 00:00:00' }
    ]
    writeFileSync(join(logosDir, 'a.png'), Buffer.from(PNG_1PX_BASE64, 'base64'))
    writeFileSync(join(logosDir, 'c.png'), Buffer.from(PNG_1PX_BASE64, 'base64'))

    const infos = await rowsToLogoInfos(rows, logosDir)
    expect(infos.map((i) => i.id)).toEqual([1, 3])
  })

  it('removeLogoFile：删 DB 行 + 删文件；文件已缺失时行删除仍成功（不抛错）', async () => {
    const db = openDb()
    const repo = createLogoRepo(db)
    const logosDir = join(dir, 'logos')

    const src = writePng(dir, 'src.png')
    const row = await importLogoFile(src, logosDir, repo)
    expect(existsSync(join(logosDir, row.filename))).toBe(true)

    await removeLogoFile(row.id, logosDir, repo)
    expect(repo.getById(row.id)).toBeUndefined()
    expect(existsSync(join(logosDir, row.filename))).toBe(false)

    // 文件已缺失的行（手工删文件后再删 logo）：DB 行删除成功
    const row2 = repo.insert('ghost.png', '幽灵')
    await removeLogoFile(row2.id, logosDir, repo)
    expect(repo.getById(row2.id)).toBeUndefined()
  })

  it('removeLogoFile：行不存在抛可诊断错误（id 回显）', async () => {
    const db = openDb()
    const repo = createLogoRepo(db)
    await expect(removeLogoFile(999, join(dir, 'logos'), repo)).rejects.toThrow(/id=999/)
  })
})

/** 写入 1px PNG 并返回路径（importLogoFile/removeLogoFile 测试辅助） */
function writePng(dirPath: string, name: string): string {
  const p = join(dirPath, name)
  writeFileSync(p, Buffer.from(PNG_1PX_BASE64, 'base64'))
  return p
}

describe('printing.ipc 测试打印（真实生成链路）', () => {
  it('buildTestPrintBytes：默认模板 + 样例数据 → init/中文页/汉字模式/中文/折行/全切全链路字节', async () => {
    const bytes = Buffer.from(
      await buildTestPrintBytes({
        getDefaultTemplate: () => TEMPLATE_ROW_80,
        readLogoById: async () => null
      })
    )
    const hex = bytes.toString('hex')

    // ESC @ 初始化 + ESC R 15 中文页 + FS & 汉字模式（真机修复指令链）
    expect(hex.startsWith('1b401b520f1c26')).toBe(true)
    // 样例中文店名（GBK）与超长商品名折行段进入字节流
    expect(hex).toContain(encodeGbk('测试商店').toString('hex'))
    expect(hex).toContain(encodeGbk('可口可乐330ml').toString('hex'))
    // 超长名折行：完整名不出现，首段（前 24 列 = 12 个汉字）出现
    const longName = TEST_PRINT_SALE.items[1]?.name ?? ''
    expect(hex).not.toContain(encodeGbk(longName).toString('hex'))
    expect(hex).toContain(encodeGbk(longName.slice(0, 12)).toString('hex'))
    // cutPaper=true：GS V 66 0 全切结尾
    expect(hex.endsWith('1d564200')).toBe(true)
    // 真实生成链路产物远大于纯 ASCII 假字节
    expect(bytes.length).toBeGreaterThan(200)
  })

  it('buildTestPrintBytes：坏 config_json 回落内置默认模板（同 parseTemplateRow 兜底）', async () => {
    const bytes = Buffer.from(
      await buildTestPrintBytes({
        getDefaultTemplate: () => ({ ...TEMPLATE_ROW_80, config_json: '{oops' }),
        readLogoById: async () => null
      })
    )
    const hex = bytes.toString('hex')
    expect(hex.startsWith('1b401b520f1c26')).toBe(true)
    // 回落模板的默认列头「商品/数量/单价/小计」
    expect(hex).toContain(encodeGbk('商品').toString('hex'))
  })

  it('buildTestPrintBytes：模板含 image 段落且 logo 可读 → 光栅注入；logo 读不到 → 自然跳过', async () => {
    const png = Buffer.from(PNG_1PX_BASE64, 'base64')
    const templateWithImage = JSON.parse(
      JSON.stringify({ ...DEFAULT_TEMPLATES['80mm'], header: [{ type: 'image', logoId: 7 }] })
    ) as typeof DEFAULT_TEMPLATES['80mm']
    const row: PrintTemplate = {
      ...TEMPLATE_ROW_80,
      config_json: JSON.stringify(templateWithImage)
    }

    const withLogo = Buffer.from(
      await buildTestPrintBytes({
        getDefaultTemplate: () => row,
        readLogoById: async () => png
      })
    )
    expect(withLogo.toString('hex')).toContain('1d763030') // GS v 0 光栅（m=0x30 库默认）

    const noLogo = Buffer.from(
      await buildTestPrintBytes({
        getDefaultTemplate: () => row,
        readLogoById: async () => null
      })
    )
    expect(noLogo.toString('hex')).not.toContain('1d7630')
    // 缺 logo 不影响其余链路
    expect(noLogo.toString('hex').startsWith('1b401b520f1c26')).toBe(true)
  })

  it('toPrintSettings：请求归一（脏通道回落 spooler；可空字符串 → 空串；端口透传）', () => {
    expect(
      toPrintSettings({
        printer_channel: 'tcp',
        printer_name: null,
        tcp_host: '127.0.0.1',
        tcp_port: 19910,
        com_port: null
      })
    ).toEqual({
      printer_channel: 'tcp',
      printer_name: '',
      tcp_host: '127.0.0.1',
      tcp_port: 19910,
      com_port: undefined
    })

    expect(toPrintSettings(undefined)).toEqual({
      printer_channel: 'spooler',
      printer_name: '',
      tcp_host: '',
      tcp_port: undefined,
      com_port: undefined
    })

    expect(toPrintSettings({ printer_channel: 'bluetooth' as never }).printer_channel).toBe('spooler')
  })
})
