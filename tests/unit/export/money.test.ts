import { describe, expect, it } from 'vitest'
import { formatMoney } from '../../../src/main/export/money'

/**
 * Task 17 — 私有 money.formatMoney（整数分 → 'XX.XX' 元字符串）。
 * shared/utils/money.ts（T12）尚未落地——本函数为导出层私有实现，T12 合并后统一
 * （见 learnings 与 issues 的待统一条目）。纯整数运算（G1）。
 */

describe('money.formatMoney', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [12345, '123.45'],
    [32105, '321.05'],
    [99999999, '999999.99']
  ])('%d 分 → %s 元', (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected)
  })

  it('负数金额：符号在前', () => {
    expect(formatMoney(-250)).toBe('-2.50')
  })
})
