/**
 * better-sqlite3 v13 未随包发布 TS 类型，@types/better-sqlite3 亦未安装（依赖锁定，勿动 package.json）。
 * 此处按 @types/better-sqlite3 的结构提供本项目用到的最小类型面。
 * 结构约定：`import Database from 'better-sqlite3'` 得到构造函数，实例类型为 `Database.Database`。
 */
declare module 'better-sqlite3' {
  namespace Database {
    interface RunResult {
      changes: number
      lastInsertRowid: number | bigint
    }

    interface Statement {
      run(...params: unknown[]): RunResult
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
    }

    interface Database {
      prepare(source: string): Statement
      exec(source: string): void
      pragma(source: string, options?: boolean | { simple?: boolean }): unknown
      transaction<F extends (...args: never[]) => unknown>(fn: F): F
      close(): void
      open: boolean
    }

    interface DatabaseConstructor {
      new (
        location: string,
        options?: {
          memory?: boolean
          readonly?: boolean
          fileMustExist?: boolean
          timeout?: number
          verbose?: (...args: unknown[]) => void
        }
      ): Database
    }
  }

  const Database: Database.DatabaseConstructor
  export = Database
}
