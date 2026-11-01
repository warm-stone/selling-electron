import type Database from 'better-sqlite3'
import initSql from './migrations/001_init.sql?raw'

interface Migration {
  version: number
  name: string
  sql: string
}

const migrations: Migration[] = [{ version: 1, name: '001_init.sql', sql: initSql }]

export function migrate(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
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
