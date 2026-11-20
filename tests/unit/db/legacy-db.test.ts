import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { detectDbState, removeDbFiles, DB_FILENAME } from '../../../src/main/db/legacy-db'
import { rmTempDirSync } from '../../helpers/cleanup'

/**
 * 旧库检测（legacy-db.ts）单元测试——仅 1.0.0-beta 接线启用的启动期清理确认，
 * 判定逻辑必须零误报（current 误判 legacy → 用户数据被引导删除，不可接受）
 * 且对旧形态零遗漏（正向识别当前 schema：user_version=1 + 哨兵表）。
 */

let dir: string
const openDbs: Database.Database[] = []

function newDb(): Database.Database {
  const db = new Database(join(dir, DB_FILENAME))
  openDbs.push(db)
  return db
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-legacy-db-'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
  rmTempDirSync(dir)
})

describe('detectDbState：库文件状态判定', () => {
  it('库文件不存在 → absent（全新安装，不触发弹窗）', () => {
    expect(detectDbState(dir)).toBe('absent')
  })

  it('合并版新库（migrate 后 user_version=1 + 哨兵表在）→ current，重复检测稳定', () => {
    const db = newDb()
    migrate(db)
    db.close()
    openDbs.pop()

    expect(detectDbState(dir)).toBe('current')
    expect(detectDbState(dir)).toBe('current')
  })

  it('旧增量库 user_version=5 → legacy', () => {
    const db = newDb()
    db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    db.pragma('user_version = 5')
    db.close()
    openDbs.pop()

    expect(detectDbState(dir)).toBe('legacy')
  })

  it('旧增量库 user_version=2~4 → legacy（逐版本）', () => {
    for (const version of [2, 3, 4]) {
      const subDir = join(dir, `v${version}`)
      mkdirSync(subDir, { recursive: true })
      const db = new Database(join(subDir, DB_FILENAME))
      try {
        db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY)')
        db.pragma(`user_version = ${version}`)
      } finally {
        db.close()
      }
      expect(detectDbState(subDir), `v${version} 应判 legacy`).toBe('legacy')
    }
  })

  it('合并前旧 001 时代库（user_version=1 但缺哨兵表）→ legacy', () => {
    const db = newDb()
    db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    db.pragma('user_version = 1')
    db.close()
    openDbs.pop()

    expect(detectDbState(dir)).toBe('legacy')
  })

  it('user_version=0 的空壳库（异常中断残留）→ legacy', () => {
    const db = newDb()
    db.close()
    openDbs.pop()

    expect(detectDbState(dir)).toBe('legacy')
  })

  it('损坏文件（非 SQLite 内容）→ legacy（不抛错，弹窗引导删除）', () => {
    writeFileSync(join(dir, DB_FILENAME), '这不是 SQLite 文件'.repeat(10))

    expect(detectDbState(dir)).toBe('legacy')
  })

  it('WAL 模式新库正常判定 current（检测打开不因 WAL 失败）', () => {
    const db = newDb()
    migrate(db)
    db.prepare('INSERT INTO products (name) VALUES (?)').run('WAL 判定')
    db.close()
    openDbs.pop()

    expect(detectDbState(dir)).toBe('current')
  })
})

describe('removeDbFiles：三件套删除', () => {
  it('删除 pos.db 与 -wal/-shm（存在的全删，缺失的容忍）', () => {
    const db = newDb()
    migrate(db)
    db.prepare('INSERT INTO products (name) VALUES (?)').run('待删除')
    // WAL 模式运行期三件套齐全（-shm 在连接打开时存在）
    writeFileSync(join(dir, 'pos.db-shm'), '') // 兜底确保文件在（部分平台 close 即回收）
    db.close()
    openDbs.pop()
    writeFileSync(join(dir, 'pos.db-wal'), 'wal-remnant')

    removeDbFiles(dir)

    expect(existsSync(join(dir, DB_FILENAME))).toBe(false)
    expect(existsSync(join(dir, 'pos.db-wal'))).toBe(false)
    expect(existsSync(join(dir, 'pos.db-shm'))).toBe(false)
  })

  it('目录内无库文件时调用不抛错（force 语义）', () => {
    expect(() => removeDbFiles(dir)).not.toThrow()
  })

  it('删除后 detectDbState 回到 absent → 可全新初始化', () => {
    const db = newDb()
    db.pragma('user_version = 5')
    db.close()
    openDbs.pop()
    expect(detectDbState(dir)).toBe('legacy')

    removeDbFiles(dir)

    expect(detectDbState(dir)).toBe('absent')
    // 删除后可正常建库（与启动流程衔接：removeDbFiles → initDatabase）
    const fresh = newDb()
    expect(() => migrate(fresh)).not.toThrow()
    expect(fresh.pragma('user_version', { simple: true })).toBe(1)
  })
})
