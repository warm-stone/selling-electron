/**
 * 销售人员最近输入历史（纯函数模块，零依赖）。
 *
 * 用途：结账/订单侧记录销售人员姓名，经 settings KV 表
 * （key = RECENT_SALESPERSONS_KEY，value = JSON 数组字符串）持久化，
 * 读通道用 parseRecentSalespersons 复原，写入侧用 pushRecentSalesperson
 * 维护「去重置顶、上限 10」的最近使用队列。
 *
 * 本模块不读写 DB/文件，序列化与落库由下游任务组装。
 */

/** settings KV 表中存储最近销售人员 JSON 数组字符串的 key */
export const RECENT_SALESPERSONS_KEY = 'recent_salespersons'

/** 队列上限（上限定死 10，不可配置） */
export const RECENT_SALESPERSONS_LIMIT = 10

/**
 * 解析 settings KV 中的最近销售人员 JSON 字符串。
 * 脏值防御：null/undefined/损坏 JSON/非数组 → []；
 * 数组逐项 String 化 → trim → 过滤空串。
 */
export function parseRecentSalespersons(raw: string | null): string[] {
  if (raw === null || raw === undefined || raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((item) => String(item).trim())
    .filter((name) => name !== '')
}

/**
 * 推入一名销售人员，去重置顶（同名从任意位置移到队首），
 * 超上限逐出队尾最旧。返回新数组，不修改入参；
 * name trim 后为空串则返回原数组内容的副本（不记录）。
 */
export function pushRecentSalesperson(list: string[], name: string): string[] {
  const trimmed = name.trim()
  if (trimmed === '') return [...list]
  const topped = [trimmed, ...list.filter((item) => item !== trimmed)]
  return topped.slice(0, RECENT_SALESPERSONS_LIMIT)
}
