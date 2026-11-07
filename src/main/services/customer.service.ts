/**
 * 客户管理业务核心（计划任务 7）：list / create / update。
 *
 * 职责（repo 是纯 SQL 零业务规则——业务全在这层）：
 * - 四字段 trim 归一（repo 收到什么查什么，trim 是 service 职责）；
 * - phone 非空校验：空串在 DB 侧能 INSERT 成功一次（NOT NULL 无 DEFAULT、
 *   UNIQUE 二插才炸——见 learnings 任务 1），service 必须在空串时就拦
 *   （CUSTOMER_PHONE_REQUIRED），不能依赖 DB 兜底；
 * - phone 查重：create 全量查、update 排除自身（hit.id !== id）；
 *   错误 message 内嵌现有客户姓名（renderer 直接展示，无需二次查询）；
 * - UNIQUE 兜底（belt-and-suspenders）：better-sqlite3 同步单线程下查重与
 *   写入间无并发窗口，但 repo 调用仍 catch SQLITE_CONSTRAINT_UNIQUE /
 *   message 含 UNIQUE → 映射 CUSTOMER_PHONE_EXISTS；
 * - update 存在性校验：repo.update 对不存在 id 静默（0 行受影响），
 *   service 在 update 后回读校验（repo.getById → CUSTOMER_NOT_FOUND）。
 *
 * 本期边界：无删除（错误码防御性保留）、无订单数/消费额聚合、无导入导出、
 * 无电话格式校验（只 trim 非空）。
 */

import type Database from 'better-sqlite3'
import type { Customer } from '../../shared/types'
import { createCustomerRepo } from '../db/repositories/customer.repo'
import type { CustomerPatch } from '../db/repositories/customer.repo'

/** service 错误码（IPC 层透传 message 给 renderer） */
export type CustomerErrorCode =
  | 'CUSTOMER_PHONE_REQUIRED'
  | 'CUSTOMER_PHONE_EXISTS'
  | 'CUSTOMER_NOT_FOUND'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class CustomerServiceError extends Error {
  constructor(readonly code: CustomerErrorCode, message: string) {
    super(message)
    this.name = 'CustomerServiceError'
  }
}

/** IpcChannels['customers:create'] req 形状（四字段原始输入——trim 是 service 职责） */
export interface CustomerCreateInput {
  name: string
  phone: string
  address: string
  note: string
}

/** customers:list 分页缺省（契约可选项：默认 limit 20 / offset 0） */
const DEFAULT_LIST_LIMIT = 20
/** list limit 上限（防 renderer 传巨值拉全表；超限 clamp） */
const MAX_LIST_LIMIT = 100

/** list limit 归一：缺省 20；非正整数回落缺省；超上限 clamp */
function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return DEFAULT_LIST_LIMIT
  }
  return Math.min(limit, MAX_LIST_LIMIT)
}

/** list offset 归一：缺省 0；负数/非整数回落 0（照 sale.repo 的 Math.max(0, …) 防御惯例） */
function normalizeListOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) {
    return 0
  }
  return offset
}

/** better-sqlite3 UNIQUE 违约识别：code SQLITE_CONSTRAINT_UNIQUE 或 message 含 UNIQUE */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      err.message.includes('UNIQUE'))
  )
}

export function createCustomerService(db: Database.Database) {
  const repo = createCustomerRepo(db)

  /** phone 占位冲突错误（message 尽力内嵌现有客户姓名） */
  function phoneExistsError(phone: string): CustomerServiceError {
    const existing = repo.findByPhone(phone)
    return new CustomerServiceError(
      'CUSTOMER_PHONE_EXISTS',
      existing
        ? `该电话已被客户「${existing.name}」使用`
        : '该电话已被其他客户使用'
    )
  }

  return {
    /** 分页搜索（keyword 同时 LIKE 匹配 name/phone，透传 repo；total 与分页参数无关） */
    list(
      keyword?: string,
      limit?: number,
      offset?: number
    ): { items: Customer[]; total: number } {
      const kw = typeof keyword === 'string' ? keyword.trim() : ''
      return repo.list(kw, normalizeListLimit(limit), normalizeListOffset(offset))
    },

    /**
     * 新建客户：四字段 trim 后校验 phone 非空 → 查重 → insert（回读完整行）。
     * insert 的 UNIQUE 违约兜底：同步流程查重后无并发窗口，防御性保留。
     */
    create(input: CustomerCreateInput): Customer {
      const name = input.name.trim()
      const phone = input.phone.trim()
      const address = input.address.trim()
      const note = input.note.trim()

      if (phone === '') {
        throw new CustomerServiceError('CUSTOMER_PHONE_REQUIRED', '客户电话不能为空')
      }
      const existing = repo.findByPhone(phone)
      if (existing) {
        throw new CustomerServiceError(
          'CUSTOMER_PHONE_EXISTS',
          `该电话已被客户「${existing.name}」使用`
        )
      }

      try {
        return repo.insert({ name, phone, address, note })
      } catch (err) {
        // belt-and-suspenders：查重与 insert 之间理论无窗口，UNIQUE 仍兜底为业务错误
        if (isUniqueViolation(err)) throw phoneExistsError(phone)
        throw err
      }
    },

    /**
     * 局部更新：patch 各键 trim（undefined 键跳过）→ phone 空串拦截 →
     * 查重排除自身（hit.id !== id）→ repo.update（不存在 id 静默）→
     * 回读校验（repo.update 静默语义 → CUSTOMER_NOT_FOUND 是 service 职责）。
     */
    update(id: number, patch: CustomerPatch): Customer {
      const normalized: CustomerPatch = {}
      for (const key of ['name', 'phone', 'address', 'note'] as const) {
        const raw = patch[key]
        if (raw !== undefined) {
          normalized[key] = raw.trim()
        }
      }

      if (normalized.phone === '') {
        throw new CustomerServiceError('CUSTOMER_PHONE_REQUIRED', '客户电话不能为空')
      }
      if (normalized.phone !== undefined) {
        const hit = repo.findByPhone(normalized.phone)
        if (hit && hit.id !== id) {
          throw new CustomerServiceError(
            'CUSTOMER_PHONE_EXISTS',
            `该电话已被客户「${hit.name}」使用`
          )
        }
      }

      try {
        repo.update(id, normalized)
      } catch (err) {
        // UNIQUE 兜底仅在 patch 含 phone 时可达（其余列无约束）
        if (normalized.phone !== undefined && isUniqueViolation(err)) {
          throw phoneExistsError(normalized.phone)
        }
        throw err
      }

      const updated = repo.getById(id)
      if (!updated) {
        // 防御：本期无删除，id 不存在只能来自调用方传错（repo.update 静默 0 行）
        throw new CustomerServiceError('CUSTOMER_NOT_FOUND', '客户不存在（可能已被删除）')
      }
      return updated
    }
  }
}

export type CustomerService = ReturnType<typeof createCustomerService>
