import { describe, it, expect } from 'vitest'
import {
  interpolateVariables
} from '../../../src/shared/receipt/template-schema'
import type { ReceiptVars } from '../../../src/shared/receipt/template-schema'

const vars: ReceiptVars = {
  shopName: '测试店',
  shopPhone: '13800000000',
  receiptNote: '退换货请保留小票',
  saleNo: '20261101-0001',
  datetime: '2026-11-01 12:00:00',
  total: '12.00',
  itemCount: '3'
}

describe('interpolateVariables（{插槽} 替换）', () => {
  it('{shopName}小票 → 测试店小票', () => {
    expect(interpolateVariables('{shopName}小票', vars)).toBe('测试店小票')
  })

  it('多个插槽混合替换', () => {
    expect(interpolateVariables('{saleNo} 共 {itemCount} 件', vars)).toBe('20261101-0001 共 3 件')
  })

  it('金额插槽替换', () => {
    expect(interpolateVariables('合计: ￥{total}', vars)).toBe('合计: ￥12.00')
  })

  it('未知插槽保留原文', () => {
    expect(interpolateVariables('你好 {unknownVar} 世界', vars)).toBe('你好 {unknownVar} 世界')
  })

  it('无插槽原样返回', () => {
    expect(interpolateVariables('谢谢惠顾', vars)).toBe('谢谢惠顾')
  })

  it('空字符串返回空字符串', () => {
    expect(interpolateVariables('', vars)).toBe('')
  })

  it('连续插槽全部替换', () => {
    expect(interpolateVariables('{total}{total}', vars)).toBe('12.0012.00')
  })

  it('变量值含 $ 特殊序列不被 replace 元字符解释（function replacer）', () => {
    const dollarVars: ReceiptVars = { ...vars, shopName: "$&$`$'$1$$" }
    expect(interpolateVariables('{shopName}', dollarVars)).toBe("$&$`$'$1$$")
  })

  it('扩展变量（index signature）可替换', () => {
    const ext: ReceiptVars = { ...vars, companyFooter: 'XX公司' }
    expect(interpolateVariables('{companyFooter}', ext)).toBe('XX公司')
  })

  it('花括号内非单词字符不视为插槽（保留原文）', () => {
    expect(interpolateVariables('价格 {12.5} 元', vars)).toBe('价格 {12.5} 元')
  })
})
