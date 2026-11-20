import type Database from 'better-sqlite3'
import initSql from './migrations/001_init.sql?raw'

/**
 * 迁移执行器（合并版单文件直接初始化）。
 *
 * 历史：原 001~005 增量迁移已合并为单一 001_init.sql（全量 schema），
 * user_version 恒为 1。因无线上数据，旧增量库不做兼容升级——
 * assertNoLegacyDb 启动守卫检测旧库直接报错，要求删除 pos.db 重新初始化
 * （静默跳过迁移会得到旧 schema + 新代码的难诊断运行时错误）。
 *
 * ★ 未来新增迁移（version 2+）时：调整 assertNoLegacyDb 的旧库判定
 *   （旧增量库的 user_version 特征区间为 2~5 且缺哨兵表），避免误伤新库。
 */

interface Migration {
  version: number
  name: string
  sql: string
}

const migrations: Migration[] = [
  { version: 1, name: '001_init.sql', sql: initSql }
]

/** 旧增量迁移时代的 user_version 特征区间（002~005 逐版累加所致） */
const LEGACY_VERSION_RANGE = new Set([2, 3, 4, 5])

/** 合并版 schema 哨兵表（旧 001_init 时代不存在，用于识别 user_version=1 的旧库） */
const SENTINEL_TABLE = 'product_change_logs'

const LEGACY_DB_MESSAGE =
  '检测到旧版本数据库（历史增量迁移库），本版本已改为单文件初始化且不兼容旧库。' +
  '请删除 userData 目录下的 pos.db（含 pos.db-wal / pos.db-shm）后重启应用。'

/** 旧库守卫：user_version 2~5 直接判旧；=1 时以哨兵表区分新旧 v1 */
function assertNoLegacyDb(db: Database.Database, currentVersion: number): void {
  if (LEGACY_VERSION_RANGE.has(currentVersion)) {
    throw new Error(LEGACY_DB_MESSAGE)
  }
  if (currentVersion === 1) {
    const sentinel = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master
          WHERE type = 'table' AND name = ?`
      )
      .get(SENTINEL_TABLE) as { n: number }
    if (sentinel.n === 0) {
      throw new Error(LEGACY_DB_MESSAGE)
    }
  }
}

export function migrate(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  assertNoLegacyDb(db, currentVersion)
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= currentVersion) continue
    applyMigration(db, migration)
  }
}

function applyMigration(db: Database.Database, migration: Migration): void {
  const apply = db.transaction(() => {
    db.exec(migration.sql)
    db.pragma(`user_version = ${migration.version}`)
  })
  apply()
}
