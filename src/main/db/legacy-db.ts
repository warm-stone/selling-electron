import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * 旧库检测与清理（仅 1.0.0-beta 版本接线启用——见 main/index.ts 的版本门控）。
 *
 * 背景：迁移已合并为单文件 001_init.sql 直接初始化（无线上数据定案），
 * 旧增量库（user_version 2~5，或合并前旧 001 时代的 =1）与新代码不兼容。
 * migrator 的 assertNoLegacyDb 是最后防线（直接报错拒启动）；本模块把
 * 「报错」升级为「启动期确认弹窗：删除旧数据以继续 / 退出自行备份」。
 *
 * 判定采用**正向识别当前 schema**（而非枚举旧版本特征）：
 * user_version=1 且哨兵表 product_change_logs 存在 → 本版本自建库；
 * 其余一切（旧版本号 / 缺哨兵 / 打不开 / 损坏文件）→ 按旧数据处理。
 * 正向判定对任意历史形态零遗漏，且未来 schema 演进时只需同步哨兵。
 *
 * 零 electron 依赖（纯 node:fs + better-sqlite3），vitest 直接可测；
 * 弹窗/退出编排留在 main/index.ts（electron 领地）。
 */

export const DB_FILENAME = 'pos.db'

/** 当前 schema 版本（与 migrator 单条 v1 迁移一致） */
const CURRENT_USER_VERSION = 1

/** 当前 schema 哨兵表（旧库任何时代都不存在；与 migrator.assertNoLegacyDb 同源语义） */
const SENTINEL_TABLE = 'product_change_logs'

/** 库文件状态：absent=不存在（全新安装）；current=本版本 schema；legacy=旧数据/损坏 */
export type DbFileState = 'absent' | 'current' | 'legacy'

/**
 * 检测 userData 目录下 pos.db 的兼容性状态。
 * 以普通模式（非 readonly）打开：WAL 库可能存在热日志（应用被强杀），
 * readonly 打开会误报不可读——普通打开自动恢复 WAL，判定不失真。
 */
export function detectDbState(dir: string): DbFileState {
  const dbPath = join(dir, DB_FILENAME)
  if (!existsSync(dbPath)) return 'absent'

  let db: Database.Database | null = null
  try {
    db = new Database(dbPath)
    const userVersion = db.pragma('user_version', { simple: true }) as number
    if (userVersion !== CURRENT_USER_VERSION) return 'legacy'
    const sentinel = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(SENTINEL_TABLE) as { n: number }
    return sentinel.n > 0 ? 'current' : 'legacy'
  } catch {
    // 非 SQLite 文件 / 损坏 → 无法作为当前库使用，按旧数据处理（弹窗引导删除）
    return 'legacy'
  } finally {
    db?.close()
  }
}

/** 删除库文件三件套（pos.db + WAL 日志 + 共享内存索引；force 容忍缺失） */
export function removeDbFiles(dir: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(dir, `${DB_FILENAME}${suffix}`), { force: true })
  }
}
