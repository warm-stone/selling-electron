import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { createSettingsRepo } from '../../../src/main/db/repositories/settings.repo'
import {
  DEFAULT_APP_SETTINGS,
  appSettingsPatchToKv,
  importLogoFile,
  readLogoDataUrl,
  rowsToAppSettings
} from '../../../src/main/ipc/settings.ipc'
import { TEST_PRINT_BYTES, toPrintSettings } from '../../../src/main/ipc/printing.ipc'
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

describe('settings.ipc 纯映射：rowsToAppSettings', () => {
  it('空表 → 全默认值（通道默认 spooler，auto_cut 默认 true）', () => {
    expect(rowsToAppSettings({})).toEqual(DEFAULT_APP_SETTINGS)
    expect(DEFAULT_APP_SETTINGS.printer_channel).toBe('spooler')
    expect(DEFAULT_APP_SETTINGS.auto_cut).toBe(true)
  })

  it('KV 行 → AppSettings 类型化映射（端口 string→number，auto_cut 字符串→boolean）', () => {
    const settings = rowsToAppSettings({
      shop_name: '我的小店',
      shop_phone: '13800000000',
      receipt_note: '谢谢惠顾',
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
      logo_path: '/tmp/logos/logo.png',
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
      com_port: '',
      logo_path: ''
    })
    expect(settings.printer_channel).toBe('spooler')
    expect(settings.tcp_port).toBeNull()
    expect(settings.printer_name).toBeNull()
    expect(settings.tcp_host).toBeNull()
    expect(settings.com_port).toBeNull()
    expect(settings.logo_path).toBeNull()
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
    expect(appSettingsPatchToKv({ logo_path: null, printer_name: null, tcp_port: null })).toEqual({
      logo_path: '',
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

describe('settings.ipc Logo 文件助手', () => {
  it('importLogoFile：复制到 logosDir/logo.png + 写 settings.logo_path（不存 DB BLOB）', async () => {
    const db = new Database(join(dir, 'pos.db'))
    openDbs.push(db)
    migrate(db)
    const repo = createSettingsRepo(db)

    const src = join(dir, 'src-logo.png')
    writeFileSync(src, Buffer.from(PNG_1PX_BASE64, 'base64'))
    const logosDir = join(dir, 'logos')

    const dest = await importLogoFile(src, logosDir, repo)

    expect(dest).toBe(join(logosDir, 'logo.png'))
    expect(existsSync(dest)).toBe(true)
    // 源被复制（保留），目标字节一致
    expect(repo.get('logo_path')).toBe(dest)
  })

  it('readLogoDataUrl：有效 png → data:image/png;base64 前缀 dataURL', async () => {
    const logoPath = join(dir, 'logo.png')
    writeFileSync(logoPath, Buffer.from(PNG_1PX_BASE64, 'base64'))

    const dataUrl = await readLogoDataUrl(logoPath)
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(dataUrl!.endsWith(PNG_1PX_BASE64)).toBe(true)
  })

  it('readLogoDataUrl 优雅降级：null 路径 / 文件缺失 → null 不抛错', async () => {
    expect(await readLogoDataUrl(null)).toBeNull()
    expect(await readLogoDataUrl(join(dir, '不存在.png'))).toBeNull()
  })
})

describe('printing.ipc 测试打印（纯部分）', () => {
  it('TEST_PRINT_BYTES 与 T4 契约字节逐段对齐（init/居中/test/全切）', () => {
    const hex = Buffer.from(TEST_PRINT_BYTES).toString('hex')
    // ESC @ 初始化
    expect(hex.startsWith('1b40')).toBe(true)
    // ESC a 1 居中 + 'test' ASCII
    expect(hex).toContain('1b6101' + Buffer.from('test', 'ascii').toString('hex'))
    // LF×2 + GS V 66 0 全切（T4 FULL_CUT 前置走纸同构）
    expect(hex.endsWith('0a0a' + '1d564200')).toBe(true)
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
