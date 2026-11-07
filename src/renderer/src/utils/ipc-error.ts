/**
 * IPC 错误信息提取（renderer 专属 util）。
 *
 * 用途：renderer 各视图 catch IPC invoke rejection 时，剥去 Electron 的
 * `Error invoking remote method '<通道>': `（及可能的 `Error: ` 二层）包装
 * 前缀，取用户可读的中文 message；非 Error 值退化为 String(err)。
 *
 * 迁移自四处视图的逐字本地拷贝（PosView / ProductsView / CustomersView /
 * components/pos/SnEntryDialog，原各持一份——F2 审查后提取，行为零变化）。
 */

/** 剥去 Electron invoke 错误包装前缀，取用户可读的中文 message */
export function extractIpcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const matched = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return matched ? matched[1]! : raw
}
