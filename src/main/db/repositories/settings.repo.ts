import type Database from 'better-sqlite3'

/**
 * 系统设置 DAL（Task 19）：settings 表 KV 读写。
 *
 * key 清单与 ER 设计逐字一致（契约事实源见 .omo/plans/pos-electron-app.md ER 章节）：
 *   shop_name / shop_phone / receipt_note / logo_path /
 *   printer_channel('spooler'|'tcp'|'serial') / printer_name /
 *   tcp_host / tcp_port / com_port / auto_cut
 *
 * 职责边界：纯 SQL 编排，无业务规则——值一律 TEXT 字符串，
 * 类型化映射（AppSettings ↔ KV）在 ipc 薄层（settings.ipc.ts）。
 */

/** KV 快照形态（settings 表行的对象映射） */
export type SettingsKv = Record<string, string>

export function createSettingsRepo(db: Database.Database) {
  const stmtGet = db.prepare('SELECT value FROM settings WHERE key = ?')
  const stmtGetAll = db.prepare('SELECT key, value FROM settings')
  // upsert 语义：settings.key 是 PRIMARY KEY，INSERT OR REPLACE 同 key 整体替换
  const stmtUpsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM settings')

  return {
    /** 读取单个 key；不存在返回 null */
    get(key: string): string | null {
      const row = stmtGet.get(key) as { value: string } | undefined
      return row ? row.value : null
    },

    /** 全量快照（空表 → 空对象） */
    getAll(): SettingsKv {
      const rows = stmtGetAll.all() as Array<{ key: string; value: string }>
      const kv: SettingsKv = {}
      for (const row of rows) kv[row.key] = row.value
      return kv
    },

    /** 单 key upsert（INSERT OR REPLACE） */
    set(key: string, value: string): void {
      stmtUpsert.run(key, value)
    },

    /**
     * 批量 upsert（单事务：settings:set 一屏表单的多 key 原子写入）。
     * 空对象 no-op（不开启空事务、不写行）。
     */
    setMany(entries: SettingsKv): void {
      const pairs = Object.entries(entries)
      if (pairs.length === 0) return
      db.transaction(() => {
        for (const [key, value] of pairs) stmtUpsert.run(key, value)
      })()
    },

    /** 行数（测试辅助） */
    count(): number {
      return (stmtCount.get() as { n: number }).n
    }
  }
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>
