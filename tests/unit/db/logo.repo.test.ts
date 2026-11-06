import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { createLogoRepo, type LogoRow } from '../../../src/main/db/repositories/logo.repo'
import { rmTempDirSync } from '../../helpers/cleanup'

/**
 * Logo DAL（logos 表）单元测试：list / getById / insert / remove 纯 SQL 语义。
 * 文件读写不在 repo 职责内（ipc 编排层负责）——此处只测 DB 行为。
 */

let dir: string

/** 本文件打开的连接登记（Windows 不可删打开中的文件：afterEach 先逐一 close 再删目录） */
const openDbs: Database.Database[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-logo-repo-'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
  rmTempDirSync(dir)
})

function freshDb(): Database.Database {
  const db = new Database(join(dir, 'pos.db'))
  openDbs.push(db)
  migrate(db)
  return db
}

function rowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM logos').get() as { n: number }).n
}

describe('logo.repo insert / list / getById', () => {
  it('insert 返回完整新行（filename/display_name/created_at 默认与传值）', () => {
    const repo = createLogoRepo(freshDb())
    const row = repo.insert('a1b2c3d4.png', '店招')

    expect(row.id).toBeGreaterThan(0)
    expect(row.filename).toBe('a1b2c3d4.png')
    expect(row.display_name).toBe('店招')
    expect(row.created_at).toBeTruthy()
  })

  it("display_name 空串合法（DDL 默认空串，uploadLogo 总传值但表不强制）", () => {
    const repo = createLogoRepo(freshDb())
    const row = repo.insert('x.png', '')
    expect(row.display_name).toBe('')
  })

  it('filename UNIQUE：重复插入抛 UNIQUE constraint', () => {
    const repo = createLogoRepo(freshDb())
    repo.insert('same.png', '第一个')
    expect(() => repo.insert('same.png', '第二个')).toThrowError(/UNIQUE constraint failed/)
  })

  it('list 按 id 升序返回全量', () => {
    const repo = createLogoRepo(freshDb())
    const a = repo.insert('a.png', 'A')
    const b = repo.insert('b.png', 'B')

    const list: LogoRow[] = repo.list()
    expect(list.map((r) => r.id)).toEqual([a.id, b.id])
    expect(list[0]?.display_name).toBe('A')
  })

  it('getById：命中返回行，未命中返回 undefined', () => {
    const repo = createLogoRepo(freshDb())
    const row = repo.insert('a.png', 'A')
    expect(repo.getById(row.id)?.filename).toBe('a.png')
    expect(repo.getById(999)).toBeUndefined()
  })

  it('空表 list 返回 []', () => {
    const repo = createLogoRepo(freshDb())
    expect(repo.list()).toEqual([])
  })
})

describe('logo.repo remove', () => {
  it('remove 删除行；幂等语义：再删同一 id 无效果不抛错', () => {
    const db = freshDb()
    const repo = createLogoRepo(db)
    const row = repo.insert('a.png', 'A')

    repo.remove(row.id)
    expect(rowCount(db)).toBe(0)
    expect(repo.getById(row.id)).toBeUndefined()

    // 再删不抛（DELETE WHERE 未命中 no-op）
    expect(() => repo.remove(row.id)).not.toThrow()
  })
})
