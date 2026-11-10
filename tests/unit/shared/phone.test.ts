import { describe, expect, it } from 'vitest'

import {
  INVALID_PHONE_MESSAGE,
  isValidMobilePhone
} from '../../../src/shared/utils/phone'

/**
 * 需求变更：电话号码输入须为手机号——共享校验（UI 表单 rules 与 main service
 * 同一实现，双防线不漂移）。
 *
 * - 1 开头 + 第二位 3-9 + 共 11 位数字
 * - 两侧空格容忍（trim 后判定；空串属必填规则管辖，本函数只管格式）
 */

describe('isValidMobilePhone（手机号格式）', () => {
  it.each([
    ['13800138000'],
    ['15912345678'],
    ['19999999999'],
    ['18600001111'],
    [' 13800138000 ']
  ])('合法：%j → true', (phone) => {
    expect(isValidMobilePhone(phone)).toBe(true)
  })

  it.each([
    ['12345678901'],
    ['12800138000'],
    ['11800138000'],
    ['1380013800'],
    ['138001380001'],
    ['05718888888'],
    ['400-800-8000'],
    ['1380013800a'],
    [''],
    ['   ']
  ])('非法：%j → false', (phone) => {
    expect(isValidMobilePhone(phone)).toBe(false)
  })
})

describe('INVALID_PHONE_MESSAGE（统一文案）', () => {
  it('非空字符串（前后端逐字一致的契约常量）', () => {
    expect(INVALID_PHONE_MESSAGE).toBe('请输入正确的手机号（1 开头 11 位）')
  })
})
