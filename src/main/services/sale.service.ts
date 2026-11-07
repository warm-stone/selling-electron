/**
 * 销售结账 + 作废业务核心（全应用最核心的事务——G2）。
 *
 * checkout：单事务 = sale_no 生成（事务内 COUNT LIKE 前缀）→ 整数分合计
 * → 逐项实时读 products 快照（SN 行同事务校验 product_sns 台账——D-SN6
 * 拒绝态全部先于任何 INSERT）→ INSERT sales + sale_items（SN 行含 sn 快照）
 * → SN 行台账流转 in_stock→sold + 回写 sale_item_id（D-SN8）→
 * 逐项 stock -= qty（负库存允许 D2）→ INSERT movements(source='sale')
 * → 附加信息（计划任务 8，可选：客户 find-or-create + sale_extras +
 * 销售人员历史写 settings——散客快单零追加）。
 * voidSale：单事务 = 校验 → status='voided' + voided_at → 逐行 stock += qty
 * → SN 行台账回滚 sold→in_stock（D-SN8，按明细行自身 id 定位）→
 * movements(source='void')。作废不物理删除任何行（D3）。
 * updateExtra：单事务 = 校验（综合已有 sale_extras 行的最终状态——Q5）→
 * 客户解绑/find-or-create → sale_extras.upsert（全空结果行保留）→
 * 销售人员历史（非空时）→ 返回装配 extras 的明细。
 *
 * 事务内零 I/O：无 channel/网络/文件/打印调用（G3：打印是落库后异步）。
 * 竞态分析见 learnings：better-sqlite3 同步事务在单条 JS 调用栈内完成，
 * Node 单线程下事务中途不可能插入其它 checkout → COUNT+1 无竞态。
 */

import type Database from 'better-sqlite3'
import type {
  CheckoutCustomerInput,
  CheckoutExtrasInput,
  CheckoutItem,
  Sale,
  SaleDetail,
  SaleStatus
} from '../../shared/types'
import { createSaleRepo } from '../db/repositories/sale.repo'
import type { SaleListFilter, SnLedgerRow } from '../db/repositories/sale.repo'
import { createSaleExtraRepo } from '../db/repositories/sale-extra.repo'
import type { SaleExtraPatch } from '../db/repositories/sale-extra.repo'
import { createCustomerRepo } from '../db/repositories/customer.repo'
import { createSettingsRepo } from '../db/repositories/settings.repo'
import {
  RECENT_SALESPERSONS_KEY,
  parseRecentSalespersons,
  pushRecentSalesperson
} from './salesperson-history'

/** service 错误码（IPC 层透传 message 给 renderer） */
export type SaleErrorCode =
  | 'SALE_EMPTY_CART'
  | 'SALE_INVALID_ITEM'
  | 'PRODUCT_NOT_FOUND'
  | 'SALE_NOT_FOUND'
  | 'SALE_ALREADY_VOIDED'
  | 'SALE_SN_REQUIRED'
  | 'SALE_SN_NOT_FOUND'
  | 'SALE_SN_SOLD'
  | 'SALE_SN_PRODUCT_MISMATCH'
  | 'SALE_EXTRAS_PHONE_REQUIRED'
  | 'SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER'

/** 带 code 的业务错误（message 为面向用户的中文文案） */
export class SaleServiceError extends Error {
  constructor(readonly code: SaleErrorCode, message: string) {
    super(message)
    this.name = 'SaleServiceError'
  }
}

/** IpcChannels['sales:list'] req 形状（date_from/date_to/status） */
export interface SaleListQuery {
  date_from?: string
  date_to?: string
  status?: SaleStatus
}

/**
 * sales:updateExtra 的 patch 形状（IpcChannels req 去掉 sale_id）。
 * undefined 键 = 不动（sale-extra.repo.upsert 的部分键语义）；
 * customer: null = 显式解绑（与 undefined「不动」刻意区分）。
 */
export interface SaleExtraUpdatePatch {
  is_national_subsidy?: boolean
  order_note?: string
  salesperson?: string
  customer?: CheckoutCustomerInput | null
}

/** 本地今日 yyyyMMdd（sale_no 日期前缀；与 DDL datetime('now','localtime') 同口径） */
function localDateCompact(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** 结账行校验（数量/单价的编译期外防线；DB CHECK 约束兜底） */
function assertValidItems(items: CheckoutItem[]): void {
  if (items.length === 0) {
    throw new SaleServiceError('SALE_EMPTY_CART', '购物车为空，无法结账')
  }
  for (const item of items) {
    if (!Number.isInteger(item.product_id) || item.product_id <= 0) {
      throw new SaleServiceError('SALE_INVALID_ITEM', '购物车存在非法商品，无法结账')
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new SaleServiceError(
        'SALE_INVALID_ITEM',
        `商品数量必须为正整数（当前：${item.quantity}）`
      )
    }
    if (!Number.isInteger(item.unit_price_cents) || item.unit_price_cents < 0) {
      throw new SaleServiceError(
        'SALE_INVALID_ITEM',
        `商品单价必须为非负整数分（当前：${item.unit_price_cents}）`
      )
    }
    // SN 行（D-SN7）：sn 非空白；一物一码 → quantity 恒 1
    if (item.sn != null) {
      if (typeof item.sn !== 'string' || item.sn.trim() === '') {
        throw new SaleServiceError('SALE_SN_REQUIRED', 'SN 不能为空')
      }
      if (item.quantity !== 1) {
        throw new SaleServiceError(
          'SALE_SN_REQUIRED',
          `SN 商品数量必须为 1（SN：${item.sn}）`
        )
      }
    }
  }
}

/** trim 后空串归一（null/undefined 输入容错为 ''） */
function trimTo(s: string | null | undefined): string {
  return (s ?? '').trim()
}

/**
 * 结账附加信息校验（service 层镜像校验——IPC 可直达，前端规则不是防线）。
 * 全字段 trim 后判定；extras 为 null/undefined 或 customer 四字段全空
 * → 视为无客户信息（合法——散客快单路径）；name/address/note 任一非空
 * ⇒ phone 必填（备注缝隙 L2：note 需电话建档承载，service 镜像 UI 收紧）。
 */
function assertValidExtras(extras: CheckoutExtrasInput | undefined): void {
  if (extras == null) return
  const customer = extras.customer
  if (
    customer != null &&
    (trimTo(customer.name) !== '' ||
      trimTo(customer.address) !== '' ||
      trimTo(customer.note) !== '') &&
    trimTo(customer.phone) === ''
  ) {
    throw new SaleServiceError(
      'SALE_EXTRAS_PHONE_REQUIRED',
      '填写客户信息时，电话不能为空'
    )
  }
  if (extras.is_national_subsidy === true) {
    const hasName = customer != null && trimTo(customer.name) !== ''
    const hasPhone = customer != null && trimTo(customer.phone) !== ''
    if (!hasName || !hasPhone) {
      throw new SaleServiceError(
        'SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER',
        '参与国补需填写客户姓名和电话'
      )
    }
  }
}

/**
 * 「有无任一附加内容」判定（checkout）：customer 四字段（trim 后）全空
 * 且非国补、备注空、销售人员空 → 不写任何附加行、不建客户
 * （散客快单路径与现状完全一致）。
 */
function hasAnyExtra(extras: CheckoutExtrasInput): boolean {
  const c = extras.customer
  const hasCustomerField =
    c != null &&
    (trimTo(c.name) !== '' ||
      trimTo(c.phone) !== '' ||
      trimTo(c.address) !== '' ||
      trimTo(c.note) !== '')
  return (
    hasCustomerField ||
    extras.is_national_subsidy === true ||
    trimTo(extras.order_note) !== '' ||
    trimTo(extras.salesperson) !== ''
  )
}

export function createSaleService(db: Database.Database) {
  const repo = createSaleRepo(db)
  const saleExtraRepo = createSaleExtraRepo(db)
  const customerRepo = createCustomerRepo(db)
  const settingsRepo = createSettingsRepo(db)

  /**
   * 明细装配：repo 头+行 + sale_extras 旁挂（extras 真装配——替换 T2 占位；
   * 组装点在 service 层：sale.repo 不跨表装配，保持销售 DAL 单一职责）。
   */
  function assembleSaleDetail(saleId: number): SaleDetail | undefined {
    const core = repo.getDetail(saleId)
    if (!core) return undefined
    return { ...core, extras: saleExtraRepo.getWithCustomer(saleId) }
  }

  /**
   * 客户 find-or-create（电话=只读查找键——Q1 定案：phone 列永不 UPDATE）。
   * 命中 → PUT 全量覆盖 name/address/note（空=清空档案值）；
   * 未命中 → insert 新档。入参须已 trim（调用方保证）。
   */
  function findOrCreateCustomer(c: {
    name: string
    phone: string
    address: string
    note: string
  }): number {
    const hit = customerRepo.findByPhone(c.phone)
    if (hit) {
      customerRepo.update(hit.id, {
        name: c.name,
        address: c.address,
        note: c.note
      })
      return hit.id
    }
    return customerRepo.insert(c).id
  }

  /**
   * 记录销售人员到 settings recent_salespersons 队列。
   * 只能在事务内调用（settingsRepo.set 单条 INSERT OR REPLACE 预编译语句
   * 无自有事务——回滚零残留）。
   */
  function rememberSalesperson(name: string): void {
    const list = pushRecentSalesperson(
      parseRecentSalespersons(settingsRepo.get(RECENT_SALESPERSONS_KEY)),
      name
    )
    settingsRepo.set(RECENT_SALESPERSONS_KEY, JSON.stringify(list))
  }

  return {
    /**
     * 结账：单事务落 sales + sale_items（快照）+ 扣库存 + movements。
     * 返回头 + items 明细（T11 收银台 / T15 打印编排的核心输入——金额全程整数分）。
     *
     * 附加信息（计划任务 8）：extras 可选——不传或全空 = 散客快单路径
     * （不写任何附加行、不建客户，与现状完全一致）；有任一附加内容则事务内
     * 追加客户 find-or-create → sale_extras.insert → 销售人员历史写 settings。
     *
     * D-SN8 豁免：本事务跨 repo 调用（customer/sale-extra/settings），被调方法
     * 均单条预编译语句无自有事务，SAVEPOINT 降级安全（sale.repo.ts:3-11 先例）。
     */
    checkout(items: CheckoutItem[], extras?: CheckoutExtrasInput): SaleDetail {
      assertValidItems(items)
      assertValidExtras(extras)

      const run = db.transaction((): SaleDetail => {
        const datePrefix = localDateCompact()
        const seq = repo.dailyCount(datePrefix) + 1
        const saleNo = `${datePrefix}-${String(seq).padStart(4, '0')}`

        // 事务内实时读快照（product_name/barcode/当前库存）；商品不存在或已软删 →
        // 抛错回滚。SN 行同事务校验台账（D-SN6 拒绝态）——全部校验先于任何 INSERT
        const lines = items.map((item) => {
          const product = repo.getProductSnapshot(item.product_id)
          if (!product) {
            throw new SaleServiceError(
              'PRODUCT_NOT_FOUND',
              `商品不存在（id=${item.product_id}），无法结账`
            )
          }
          let snRow: SnLedgerRow | undefined
          if (item.sn != null) {
            if (product.tracking !== 'sn') {
              throw new SaleServiceError(
                'SALE_SN_PRODUCT_MISMATCH',
                `商品「${product.name}」不是 SN 商品`
              )
            }
            snRow = repo.findSnForSale(item.sn)
            if (!snRow) {
              throw new SaleServiceError(
                'SALE_SN_NOT_FOUND',
                `SN ${item.sn} 不存在或已删除`
              )
            }
            if (snRow.status === 'sold') {
              throw new SaleServiceError(
                'SALE_SN_SOLD',
                snRow.sale_no
                  ? `SN ${item.sn} 已售出（单号 ${snRow.sale_no}），不可重复销售`
                  : `SN ${item.sn} 已售出，不可重复销售`
              )
            }
            if (snRow.product_id !== item.product_id) {
              throw new SaleServiceError(
                'SALE_SN_PRODUCT_MISMATCH',
                `SN ${item.sn} 不属于该商品`
              )
            }
          }
          return { item, product, snRow }
        })

        // 整数分乘加（G1）：subtotal = qty × unit_price_cents
        const totalCents = lines.reduce(
          (sum, l) => sum + l.item.quantity * l.item.unit_price_cents,
          0
        )
        const itemCount = lines.reduce((sum, l) => sum + l.item.quantity, 0)

        const { saleId, itemIds } = repo.createSaleWithItems(
          { sale_no: saleNo, total_cents: totalCents, item_count: itemCount },
          lines.map((l) => ({
            product_id: l.product.id,
            product_name: l.product.name,
            barcode: l.product.barcode,
            quantity: l.item.quantity,
            unit_price_cents: l.item.unit_price_cents,
            subtotal_cents: l.item.quantity * l.item.unit_price_cents,
            sn: l.item.sn
          }))
        )

        // SN 台账流转 in_stock→sold + 回写销售去向行（D-SN8，与落库同事务；
        // itemIds 与 lines 逐行对应）
        lines.forEach((l, i) => {
          if (!l.snRow) return
          if (repo.markSnSold(l.snRow.id, itemIds[i]) !== 1) {
            // 防御：同事务内刚校验过的行不可能消失（同步事务无并发写）
            throw new SaleServiceError(
              'SALE_SN_NOT_FOUND',
              `SN ${l.item.sn} 不存在或已删除`
            )
          }
        })

        // 扣库存（负库存允许 D2）+ 流水（source='sale'，before/after 审计链）
        for (const l of lines) {
          repo.adjustStock(l.product.id, -l.item.quantity)
          repo.insertMovement({
            product_id: l.product.id,
            change_qty: -l.item.quantity,
            before_stock: l.product.stock,
            after_stock: l.product.stock - l.item.quantity,
            source: 'sale',
            source_id: saleId
          })
        }

        // ── 附加信息写入（FK 顺序：saleId 已落库；散客快单路径零追加）──
        if (extras != null && hasAnyExtra(extras)) {
          const customer = extras.customer
          let customerId: number | null = null
          if (customer != null && trimTo(customer.phone) !== '') {
            customerId = findOrCreateCustomer({
              name: trimTo(customer.name),
              phone: trimTo(customer.phone),
              address: trimTo(customer.address),
              note: trimTo(customer.note)
            })
          }
          const note = trimTo(extras.order_note)
          const salesperson = trimTo(extras.salesperson)
          saleExtraRepo.insert(saleId, {
            customer_id: customerId,
            is_national_subsidy: extras.is_national_subsidy === true,
            order_note: note === '' ? null : note,
            salesperson: salesperson === '' ? null : salesperson
          })
          if (salesperson !== '') {
            rememberSalesperson(salesperson)
          }
        }

        const detail = assembleSaleDetail(saleId)
        if (!detail) {
          throw new SaleServiceError('SALE_NOT_FOUND', '销售单不存在')
        }
        return detail
      })

      return run()
    },

    /**
     * 整单作废（D3）：单事务 = 校验 → status='voided' + voided_at →
     * 逐行 stock += qty → movements(source='void')。不物理删除任何行。
     * 商品不可达的明细行跳过库存复原（两条路径并存）：
     * product_id 为 NULL（历史断链行）或商品已软删（deleted=1——004 迁移后
     * 快照行保留但 getProductSnapshot 不可见）。
     */
    voidSale(saleId: number): Sale {
      const run = db.transaction((): Sale => {
        const sale = repo.getById(saleId)
        if (!sale) {
          throw new SaleServiceError(
            'SALE_NOT_FOUND',
            `销售单不存在（id=${saleId}）`
          )
        }
        if (sale.status !== 'completed') {
          throw new SaleServiceError('SALE_ALREADY_VOIDED', '该销售单已作废')
        }

        repo.markVoided(saleId)

        for (const item of repo.getSaleItems(saleId)) {
          // SN 台账回滚 sold→in_stock（D-SN8，按明细行自身 id 定位）：商品已软删时
          // product_sns 已被级联软删 → WHERE deleted=0 命中 0 行，静默跳过
          if (item.sn != null) {
            repo.restoreSnBySaleItem(item.id)
          }
          if (item.product_id == null) continue
          const product = repo.getProductSnapshot(item.product_id)
          if (!product) continue // 商品已软删（或历史断链行）：快照行保留，不写复原流水
          repo.adjustStock(product.id, item.quantity)
          repo.insertMovement({
            product_id: product.id,
            change_qty: item.quantity,
            before_stock: product.stock,
            after_stock: product.stock + item.quantity,
            source: 'void',
            source_id: saleId
          })
        }

        const updated = repo.getById(saleId)
        if (!updated) {
          throw new SaleServiceError('SALE_NOT_FOUND', '销售单不存在')
        }
        return updated
      })

      return run()
    },

    /** 销售列表（分页 + 过滤；id 倒序=最新在前） */
    list(query: SaleListQuery, page = 1): Sale[] {
      const filter: SaleListFilter = {
        from: query.date_from,
        to: query.date_to,
        status: query.status
      }
      return repo.list(page, filter)
    },

    /** 单据明细（头 + items + extras 旁挂） */
    getDetail(saleId: number): SaleDetail {
      const detail = assembleSaleDetail(saleId)
      if (!detail) {
        throw new SaleServiceError(
          'SALE_NOT_FOUND',
          `销售单不存在（id=${saleId}）`
        )
      }
      return detail
    },

    /**
     * 修改销售附加信息（sales:updateExtra）——自有事务，返回更新后明细。
     * - 单不存在 → SALE_NOT_FOUND；已作废 → SALE_ALREADY_VOIDED（Q4 定案）
     * - 校验综合最终状态（Q5 定案）：旧单已勾国补同样要求姓名+电话
     *   （需读现有 sale_extras 行合并 patch 后判定）
     * - 客户 patch 语义（Q5）：customer=null 或电话 trim 空 → customer_id 置
     *   NULL（解绑）；电话非空 → find-or-create（同 checkout 路径，永不 UPDATE
     *   phone）
     * - sale_extras 全空结果行保留（不删除）；salesperson trim 后非空 → 更新
     *   recent_salespersons 缓存（本事务内）
     * - D-SN8 豁免：同 checkout——跨 repo（customer/sale-extra/settings）被调
     *   方法均单条预编译语句无自有事务
     */
    updateExtra(saleId: number, patch: SaleExtraUpdatePatch): SaleDetail {
      const run = db.transaction((): SaleDetail => {
        const sale = repo.getById(saleId)
        if (!sale) {
          throw new SaleServiceError(
            'SALE_NOT_FOUND',
            `销售单不存在（id=${saleId}）`
          )
        }
        if (sale.status === 'voided') {
          throw new SaleServiceError('SALE_ALREADY_VOIDED', '该销售单已作废')
        }

        const existing = saleExtraRepo.getWithCustomer(saleId)
        const customerPatch = patch.customer
        const nameT = trimTo(customerPatch?.name)
        const phoneT = trimTo(customerPatch?.phone)
        const addressT = trimTo(customerPatch?.address)
        const noteT = trimTo(customerPatch?.note)

        // 备注缝隙 L2：name/address/note 任一非空 ⇒ phone 必填（与 checkout 同规则）
        if (
          customerPatch != null &&
          (nameT !== '' || addressT !== '' || noteT !== '') &&
          phoneT === ''
        ) {
          throw new SaleServiceError(
            'SALE_EXTRAS_PHONE_REQUIRED',
            '填写客户信息时，电话不能为空'
          )
        }

        // 综合最终状态（Q5）：final = 已有行被 patch 覆盖后的结果
        const finalSubsidy =
          patch.is_national_subsidy !== undefined
            ? patch.is_national_subsidy === true
            : existing?.is_national_subsidy === true
        const finalName =
          customerPatch !== undefined ? nameT : trimTo(existing?.customer?.name)
        const finalPhone =
          customerPatch !== undefined
            ? phoneT
            : trimTo(existing?.customer?.phone)
        if (finalSubsidy && (finalName === '' || finalPhone === '')) {
          throw new SaleServiceError(
            'SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER',
            '参与国补需填写客户姓名和电话'
          )
        }

        let customerId: number | null | undefined = undefined
        if (customerPatch !== undefined) {
          if (customerPatch === null || phoneT === '') {
            customerId = null
          } else {
            customerId = findOrCreateCustomer({
              name: nameT,
              phone: phoneT,
              address: addressT,
              note: noteT
            })
          }
        }

        const extraPatch: SaleExtraPatch = {}
        if (customerId !== undefined) {
          extraPatch.customer_id = customerId
        }
        if (patch.is_national_subsidy !== undefined) {
          extraPatch.is_national_subsidy = patch.is_national_subsidy
        }
        if (patch.order_note !== undefined) {
          const note = trimTo(patch.order_note)
          extraPatch.order_note = note === '' ? null : note
        }
        if (patch.salesperson !== undefined) {
          const salesperson = trimTo(patch.salesperson)
          extraPatch.salesperson = salesperson === '' ? null : salesperson
          if (salesperson !== '') {
            rememberSalesperson(salesperson)
          }
        }
        saleExtraRepo.upsert(saleId, extraPatch)

        const detail = assembleSaleDetail(saleId)
        if (!detail) {
          throw new SaleServiceError('SALE_NOT_FOUND', '销售单不存在')
        }
        return detail
      })

      return run()
    }
  }
}

export type SaleService = ReturnType<typeof createSaleService>
