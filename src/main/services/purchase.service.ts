import type Database from 'better-sqlite3'
import type { PurchaseInputItem, PurchaseOrderWithItems } from '../../shared/types'
import { createPurchaseRepo, type PurchaseRepo } from '../db/repositories/purchase.repo'

/**
 * 进货业务核心（Task 9）：
 * - createPurchase：入库单事务入口。结构校验在事务外（快速失败），
 *   productId 存在性在事务内（repo SELECT，缺失即抛错全回滚）。
 * - list / getDetail 经 repo 组装（品种数 = items.length；明细读快照列——G4）。
 *
 * G1：金额全程整数分；G5：入库必写 stock_movements（source='purchase'）。
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

/** 归一化备注：空串/全空白 → null（DB 可空列语义） */
function normalizeNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null
  const trimmed = String(note).trim()
  return trimmed === '' ? null : trimmed
}

/** 逐行结构校验（存在性校验在事务内） */
function validateItems(
  items: readonly PurchaseInputItem[] | undefined
): asserts items is readonly PurchaseInputItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('进货单至少需要一行商品')
  }
  for (const [index, item] of items.entries()) {
    const label = `第 ${index + 1} 行`
    if (
      typeof item?.product_id !== 'number' ||
      !Number.isInteger(item.product_id) ||
      item.product_id <= 0
    ) {
      throw new Error(`${label}：商品无效（productId 必须是正整数）`)
    }
    if (typeof item?.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`${label}：数量必须是正整数`)
    }
    if (
      typeof item?.cost_price_cents !== 'number' ||
      !Number.isInteger(item.cost_price_cents) ||
      item.cost_price_cents < 0
    ) {
      throw new Error(`${label}：成本价无效（必须是不小于 0 的整数分）`)
    }
  }
}

export function createPurchaseService(db: Database.Database, repo?: PurchaseRepo): PurchaseService {
  const repository = repo ?? createPurchaseRepo(db)

  return {
    createPurchase(items, note) {
      validateItems(items)
      return repository.createOrderWithItems(normalizeNote(note), items)
    },

    list(dateFrom, dateTo) {
      return repository.list(dateFrom, dateTo)
    },

    getDetail(id: number) {
      const detail = repository.getDetail(id)
      if (!detail) {
        throw new Error(`进货单不存在（id=${id}）`)
      }
      return detail
    }
  }
}
