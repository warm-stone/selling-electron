import type Database from 'better-sqlite3'

/**
 * Logo DAL（logos 表，多 Logo 架构）。
 *
 * ★ Logo 不存 DB BLOB（文件系统 + logos 表元数据引用——计划 MUST NOT）：
 *   文件本体在 userData/logos/&lt;filename&gt;，复制/删除/读文件由 ipc
 *   编排层（settings.ipc / printing.ipc）负责；本模块纯 SQL（构造注入
 *   db，参照 template.repo 风格，vitest 免 Electron 可单测）。
 * ★ filename 只存目录内相对名（&lt;uuid&gt;.png），绝对路径运行时拼——
 *   userData 目录可变（E2E 重定向 / 换机恢复）。
 */

/** logos 表行 */
export interface LogoRow {
  id: number
  /** logos 目录内文件名（<uuid>.png） */
  filename: string
  /** 展示名（默认上传文件名去扩展） */
  display_name: string
  created_at: string
}

export function createLogoRepo(db: Database.Database) {
  const stmtList = db.prepare('SELECT * FROM logos ORDER BY id ASC')
  const stmtGetById = db.prepare('SELECT * FROM logos WHERE id = ?')
  const stmtInsert = db.prepare('INSERT INTO logos (filename, display_name) VALUES (?, ?)')
  const stmtDelete = db.prepare('DELETE FROM logos WHERE id = ?')

  /** 行读取（不存在 → undefined） */
  const getByIdRaw = (id: number): LogoRow | undefined =>
    stmtGetById.get(id) as LogoRow | undefined

  const requireRow = (id: number): LogoRow => {
    const row = getByIdRaw(id)
    if (row === undefined) {
      throw new Error(`Logo 不存在（id=${id}，可能已被删除）`)
    }
    return row
  }

  return {
    /** 全量列表（按入库序；settings:listLogos 数据源） */
    list(): LogoRow[] {
      return stmtList.all() as LogoRow[]
    },

    /** 单行查询（readLogoById 编排：行缺失 → null 优雅降级） */
    getById(id: number): LogoRow | undefined {
      return getByIdRaw(id)
    },

    /** 新增（文件已由调用方落盘；返回新行） */
    insert(filename: string, displayName: string): LogoRow {
      const info = stmtInsert.run(filename, displayName)
      return requireRow(Number(info.lastInsertRowid))
    },

    /** 删除行（文件删除由调用方负责） */
    remove(id: number): void {
      stmtDelete.run(id)
    }
  }
}

export type LogoRepo = ReturnType<typeof createLogoRepo>
