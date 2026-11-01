import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { createSettingsRepo } from '../../../src/main/db/repositories/settings.repo'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-settings-repo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function freshDb(): Database.Database {
  const db = new Database(join(dir, 'pos.db'))
  migrate(db)
  return db
}

describe('settings.repo：KV upsert 语义（settings 表 key TEXT PRIMARY KEY）', () => {
  it('get 未写入的 key 返回 null（非 undefined、非抛错）', () => {
    const repo = createSettingsRepo(freshDb())
    expect(repo.get('shop_name')).toBeNull()
  })

  it('set → get 写读一致（含中文值）', () => {
    const repo = createSettingsRepo(freshDb())
    repo.set('shop_name', '我的小店')
    repo.set('printer_channel', 'tcp')
    expect(repo.get('shop_name')).toBe('我的小店')
    expect(repo.get('printer_channel')).toBe('tcp')
  })

  it('upsert 语义：同 key 二次 set 是整体替换而非追加（INSERT OR REPLACE）', () => {
    const db = freshDb()
    const repo = createSettingsRepo(db)
    repo.set('shop_name', '旧店名')
    repo.set('shop_name', '新店名')

    expect(repo.get('shop_name')).toBe('新店名')
    // 表内该 key 仅一行（REPLACE 不产生重复行）
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'shop_name'").get() as {
        n: number
      }
    ).n
    expect(count).toBe(1)
  })

  it('getAll 返回全部键值对（多 key 快照）', () => {
    const repo = createSettingsRepo(freshDb())
    repo.set('shop_name', '我的小店')
    repo.set('shop_phone', '13800000000')
    repo.set('receipt_note', '谢谢惠顾')

    expect(repo.getAll()).toEqual({
      shop_name: '我的小店',
      shop_phone: '13800000000',
      receipt_note: '谢谢惠顾'
    })
  })

  it('getAll 空表返回空对象', () => {
    const repo = createSettingsRepo(freshDb())
    expect(repo.getAll()).toEqual({})
  })

  it('setOnce + setMany：批量 upsert 原子写入多 key', () => {
    const repo = createSettingsRepo(freshDb())
    repo.setMany({ printer_channel: 'tcp', tcp_host: '127.0.0.1', tcp_port: '9100' })

    expect(repo.getAll()).toEqual({
      printer_channel: 'tcp',
      tcp_host: '127.0.0.1',
      tcp_port: '9100'
    })
  })

  it('setMany upsert 语义：已有 key 被替换，未涉及 key 保留', () => {
    const repo = createSettingsRepo(freshDb())
    repo.set('shop_name', '旧店名')
    repo.set('printer_channel', 'spooler')
    repo.setMany({ shop_name: '新店名', tcp_host: '192.168.1.50' })

    expect(repo.getAll()).toEqual({
      shop_name: '新店名',
      printer_channel: 'spooler',
      tcp_host: '192.168.1.50'
    })
  })

  it('setMany 空对象 no-op（不抛错、不写行）', () => {
    const db = freshDb()
    const repo = createSettingsRepo(db)
    repo.setMany({})

    const n = (db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n
    expect(n).toBe(0)
    expect(repo.getAll()).toEqual({})
  })

  it('同库多次 createSettingsRepo 共享数据（工厂无隐藏状态）', () => {
    const db = freshDb()
    createSettingsRepo(db).set('shop_name', '第一家')
    expect(createSettingsRepo(db).get('shop_name')).toBe('第一家')
  })
})
