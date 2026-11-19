/**
 * 诊断采集归一化·防御小工具（collect.runner 拆分批次 5）。
 *
 * 「部分失败是数据不是异常」契约的底层原语：所有段解析/装配模块共用的
 * 类型守卫与归一函数（printer-enumerator 的防御模式同源）。
 */

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** T3 段级失败形状：@{ error = $_.Exception.Message } → { error: string } */
export function isErrorShape(v: unknown): v is { error: string } {
  const rec = asRecord(v)
  return rec !== null && typeof rec['error'] === 'string'
}

export function stringifyRaw(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null'
  } catch {
    return String(v)
  }
}
