/**
 * 客户联系电话（手机号）格式校验——需求变更：电话输入须为手机号。
 *
 * 前后端共用（UI 表单 rules 与 main service 校验同一正则与文案，
 * 延续项目「UI+service 双防线、文案逐字一致」惯例）。
 */

/** 中国大陆手机号：1 开头、第二位 3-9、共 11 位数字 */
const CN_MOBILE_RE = /^1[3-9]\d{9}$/

/** 两侧统一 trim 后判定（电话是空串时由各自的必填规则处理，本函数只管格式） */
export function isValidMobilePhone(phone: string): boolean {
  return CN_MOBILE_RE.test(phone.trim())
}

/** 格式非法统一文案（UI 表单错误与 service 抛错逐字一致） */
export const INVALID_PHONE_MESSAGE = '请输入正确的手机号（1 开头 11 位）'
