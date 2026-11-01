import { rmSync } from 'node:fs'

/**
 * 删除测试临时目录（Windows EBUSY/EPERM 兜底）。
 *
 * Linux 允许 unlink 打开中的文件，Windows 不允许——teardown 删 temp DB 目录前
 * 必须先关闭全部 sqlite 连接（closeDatabase / openDbs 逐个 close）。但即使连接
 * 已关，Windows 上仍可能有第三方进程短暂持有句柄（防病毒扫描、索引服务等），
 * node fs 的 maxRetries/retryDelay 正是为该竞态设计：rmSync 遇 EBUSY/EPERM 时
 * 以 retryDelay 毫秒为间隔线性退避重试，最多 maxRetries 次。故所有测试的
 * temp 目录清理统一走本函数，禁止裸 rmSync。
 */
export function rmTempDirSync(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
