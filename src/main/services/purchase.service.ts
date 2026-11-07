import type Database from 'better-sqlite3'
import type { PurchaseInputItem, PurchaseOrderWithItems } from '../../shared/types'
import { createPurchaseRepo, type PurchaseRepo } from '../db/repositories/purchase.repo'

/**
 * 进货业务核心（Task 9 + SN 商品 T1.3）：
 * - createPurchase：入库单事务入口。结构校验在事务外（快速失败），
 *   productId 存在性 / tracking 匹配 / SN 台账查重在事务内（repo SELECT，缺失即抛错全回滚）。
 * - list / getDetail 经 repo 组装（品种数 = items.length；明细读快照列——G4）。
 *
 * G1：金额全程整数分；G5：入库必写 stock_movements（source='purchase'）。
 * SN 行（D-SN9/10）：UI 单行多 SN + 单一成本价 → 落库展开为每 SN 一行
 * purchase_items（quantity=1、同 cost_price_cents）；展开逻辑在 repo 事务内。
 */

export interface PurchaseService {
  /** 单事务入库；返回完整单据（含快照明细）。失败抛错 → 整单回滚 */
  createPurchase(
    items: readonly PurchaseInputItem[],
    note?: string | null
  ): PurchaseOrderWithItems
  /** 头+行列表（最新在前）；dateFrom/dateTo 为 yyyy-MM-dd（可选） */
  list(dateFrom?: string, dateTo?: string): PurchaseOrderWithItems[]
  /** 单张明细；不存在抛错 */
  getDetail(id: number): PurchaseOrderWithItems
}

/** service 错误码（IPC 层透传 message 给 renderer；repo 事务内抛出同款——见 purchase.repo） */
export type PurchaseErrorCode =
  | 'PURCHASE_INVALID_ITEM' // 行结构非法（数量/成本价/SN 结构等，message 指明字段）
  | 'PURCHASE_SN_DUP_IN_ORDER' // 本单内 SN 重复（跨所有 sn 行收集后统一判重）
  | 'PURCHASE_TYPE_MISMATCH' // 行类型与商品 tracking 不符（D-SN9）
  | 'PURCHASE_SN_EXISTS' // SN 已在库 / 已售（事务内台账检查——D-SN4/17）
  | 'PRODUCT_NOT_FOUND' // 商品不存在（事务内）
  | 'PURCHASE_NOT_FOUND' // 进货单不存在（getDetail）

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class PurchaseServiceError extends Error {
  constructor(readonly code: PurchaseErrorCode, message: string) {
    super(message)
    this.name = 'PurchaseServiceError'
  }
}

/** 归一化备注：空串/全空白 → null（DB 可空列语义） */
function normalizeNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null
  const trimmed = String(note).trim()
  return trimmed === '' ? null : trimmed
}

/** SN 长度上限（结构校验；台账/明细列均为 TEXT，此处防超长脏数据） */
const MAX_SN_LENGTH = 128

/**
 * 逐行结构校验 + 归一化（存在性 / tracking / 台账查重在事务内）。
 *
 * - quantity 行：原校验逐字保留（product_id / quantity / cost_price_cents）。
 * - sn 行：product_id 正整数 + sns 非空数组 + 每 SN 非空字符串（trim 后）
 *   + trim 后长度 ≤ 128 + cost_price_cents 非负整数分。
 * - 全单 SN 判重（D-SN4）：跨所有 sn 行收集 trim 后的 SN 统一判一次
 *   （空白差异不构成不同 SN）。
 * - 归一化：SN 一律 trim 后落库（返回新数组，原入参不变）。
 *
 * 返回归一化后的行数组（repo 直接消费联合类型，无需再收窄）。
 */
function validateItems(
  items: readonly PurchaseInputItem[] | undefined
): PurchaseInputItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', '进货单至少需要一行商品')
  }
  const normalized: PurchaseInputItem[] = []
  const seenSns = new Set<string>()
  for (const [index, item] of items.entries()) {
    const label = `第 ${index + 1} 行`
    if (item?.kind === 'quantity') {
      if (
        typeof item?.product_id !== 'number' ||
        !Number.isInteger(item.product_id) ||
        item.product_id <= 0
      ) {
        throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：商品无效（productId 必须是正整数）`)
      }
      if (typeof item?.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：数量必须是正整数`)
      }
      if (
        typeof item?.cost_price_cents !== 'number' ||
        !Number.isInteger(item.cost_price_cents) ||
        item.cost_price_cents < 0
      ) {
        throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：成本价无效（必须是不小于 0 的整数分）`)
      }
      normalized.push({
        kind: 'quantity',
        product_id: item.product_id,
        quantity: item.quantity,
        cost_price_cents: item.cost_price_cents
      })
    } else if (item?.kind === 'sn') {
      if (
        typeof item?.product_id !== 'number' ||
        !Number.isInteger(item.product_id) ||
        item.product_id <= 0
      ) {
        throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：商品无效（productId 必须是正整数）`)
      }
      if (!Array.isArray(item.sns) || item.sns.length === 0) {
        throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：SN 列表必须是非空数组`)
      }
      if (
        typeof item?.cost_price_cents !== 'number' ||
        !Number.isInteger(item.cost_price_cents) ||
        item.cost_price_cents < 0
      ) {
        throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：成本价无效（必须是不小于 0 的整数分）`)
      }
      const trimmedSns: string[] = []
      for (const [snIndex, rawSn] of item.sns.entries()) {
        if (typeof rawSn !== 'string') {
          throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：第 ${snIndex + 1} 个 SN 必须是字符串`)
        }
        const sn = rawSn.trim()
        if (sn === '') {
          throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：SN 不能为空白`)
        }
        if (sn.length > MAX_SN_LENGTH) {
          throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：SN 长度不能超过 ${MAX_SN_LENGTH} 字符`)
        }
        if (seenSns.has(sn)) {
          throw new PurchaseServiceError('PURCHASE_SN_DUP_IN_ORDER', `进货单内 SN 重复：${sn}`)
        }
        seenSns.add(sn)
        trimmedSns.push(sn)
      }
      normalized.push({
        kind: 'sn',
        product_id: item.product_id,
        sns: trimmedSns,
        cost_price_cents: item.cost_price_cents
      })
    } else {
      throw new PurchaseServiceError('PURCHASE_INVALID_ITEM', `${label}：行类型无效（kind 必须是 'quantity' 或 'sn'）`)
    }
  }
  return normalized
}

export function createPurchaseService(db: Database.Database, repo?: PurchaseRepo): PurchaseService {
  const repository = repo ?? createPurchaseRepo(db)

  return {
    createPurchase(items, note) {
      const normalized = validateItems(items)
      return repository.createOrderWithItems(normalizeNote(note), normalized)
    },

    list(dateFrom, dateTo) {
      return repository.list(dateFrom, dateTo)
    },

    getDetail(id: number) {
      const detail = repository.getDetail(id)
      if (!detail) {
        throw new PurchaseServiceError('PURCHASE_NOT_FOUND', `进货单不存在（id=${id}）`)
      }
      return detail
    }
  }
}
