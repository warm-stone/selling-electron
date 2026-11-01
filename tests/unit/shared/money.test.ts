import { describe, expect, it } from 'vitest'

import { formatMoney, parseMoneyToCents } from '../../../src/shared/utils/money'

/**
 * Task 12 — 金额格式化纯函数（display-ready 约定的唯一实现）。
 *
 * 约定（T15 组装 ReceiptVars / T18 报表导出共同消费）：
 * - formatMoney：整数分 → 元字符串，**恰好 2 位小数、无千分位**（'12.50'）
 * - parseMoneyToCents：元字符串 → 整数分，最多 2 位小数，非法输入 NaN
 * 全程整数运算（Math.trunc / 字符串拼接），零浮点金额换算（G1）。
 */

describe('formatMoney（分 → 元字符串）', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [9, '0.09'],
    [10, '0.10'],
    [100, '1.00'],
    [1250, '12.50'],
    [12345, '123.45'],
    [99999, '999.99'],
    [999999999, '9999999.99']
  ])('formatMoney(%i) === %s', (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected)
  })

  it('负数：符号前置，绝对值格式不变', () => {
    expect(formatMoney(-1)).toBe('-0.01')
    expect(formatMoney(-1250)).toBe('-12.50')
  })

  it('无千分位分隔符（T15/T18 格式定案）', () => {
    const out = formatMoney(123456700)
    expect(out).toBe('1234567.00')
    expect(out).not.toContain(',')
  })

  it('非整数分输入防御：Math.trunc（文档化行为，入参契约仍为整数分）', () => {
    expect(formatMoney(1250.7)).toBe('12.50')
    expect(formatMoney(-0.5)).toBe('0.00')
  })
})

describe('parseMoneyToCents（元字符串 → 分）', () => {
  it.each([
    ['12.50', 1250],
    ['12.5', 1250], // 1 位小数容忍
    ['12', 1200], // 无小数
    ['0.01', 1],
    ['0', 0],
    ['0.10', 10],
    ['-3', -300],
    ['-0.5', -50],
    [' 12.50 ', 1250] // trim 容忍（输入框场景）
  ])('parseMoneyToCents(%j) === %i', (yuan, expected) => {
    expect(parseMoneyToCents(yuan)).toBe(expected)
  })

  it.each([
    ['abc'],
    [''],
    ['12.'], // 点后无数字
    ['.50'], // 点前无数字
    ['12.505'], // 3 位小数（超出 UI 输入约定）
    ['1,250'], // 千分位非法
    ['１２'], // 全角数字非法
    ['1 + 2'],
    ['12.50.10']
  ])('非法输入 %j → NaN', (yuan) => {
    expect(parseMoneyToCents(yuan)).toBeNaN()
  })

  it('往返一致：formatMoney(parseMoneyToCents(x)) === x（2 位小数内）', () => {
    for (const yuan of ['0.00', '0.01', '12.50', '999.99', '123456.78']) {
      expect(formatMoney(parseMoneyToCents(yuan))).toBe(yuan)
    }
  })
})
