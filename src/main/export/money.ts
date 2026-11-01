/**
 * 整数分 → 'XX.XX' 元字符串（G1：纯整数运算，无 float 参与）。
 *
 * ⚠️ T12 的 shared/utils/money.ts 尚未落地（本文件创建时不存在）——
 * 此为导出层私有实现，与 T4（测试字面量）、T15（组装）的格式化需求同源；
 * T12 合并后应删除本文件改为统一 import（learnings/issues 已记录待统一）。
 */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const yuan = Math.trunc(abs / 100)
  const rem = abs % 100
  return `${sign}${yuan}.${String(rem).padStart(2, '0')}`
}
