import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './migrator'

const DB_FILENAME = 'pos.db'

let current: Database.Database | null = null
let currentPath: string | null = null

export function initDatabase(dir?: string): Database.Database {
  const resolvedDir = dir ?? resolveUserDataDir()
  const dbPath = join(resolvedDir, DB_FILENAME)

  if (current && currentPath === dbPath) return current

  if (current) {
    current.close()
    current = null
    currentPath = null
  }

  mkdirSync(resolvedDir, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)

  current = db
  currentPath = dbPath
  return db
}

export function getDatabase(): Database.Database {
  if (!current) {
    throw new Error('数据库未初始化：请先在应用装配处调用 initDatabase()')
  }
  return current
}

/**
 * 关闭当前单例连接（幂等：未初始化时 no-op）。
 * 供测试 teardown 使用——Windows 不允许 unlink 打开中的文件，
 * 删除临时 DB 目录前必须先关闭连接（否则 rmSync EBUSY）。
 */
export function closeDatabase(): void {
  current?.close()
  current = null
  currentPath = null
}

function resolveUserDataDir(): string {
  // 延迟 require（而非顶部 import）：本模块需可在 vitest 纯 Node 环境导入，只有未传 dir 时才真正触碰 electron
  const electron = require('electron') as { app: { getPath(name: string): string } }
  return electron.app.getPath('userData')
}
