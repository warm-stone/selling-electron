/**
 * 商品管理业务核心（参数校验 + 审计流水——G5 + 改动记录留痕）。
 *
 * 手动改库存必走 updateStock → stock_movements（source='manual'）；
 * 负库存是定案（D2）：创建/调整允许负值，不在此拦截，UI 负库存标红。
 * 金额一律整数分（G1）：price 校验 Number.isInteger + ≥0，元单位浮点
 * 只存在于 UI 层边界转换。
 *
 * 改动记录（product_change_logs，用户定案）：
 * - 全部改动必填原因（update/updateStock/delete/deleteSn），reason trim 后
 *   非空——service 层第二道防线（UI inputValidator 第一道）；
 * - 一次保存一条记录：update 单事务合并 { 字段更新 + 批量计库存联动 +
 *   一条日志（逐字段旧→新）}；diff 为空且库存未变 → 不写日志静默成功；
 * - 建档（create）不记录（非改动、无旧值）；
 * - updateStock 独立通道同值调整也记录（与既有「同值流水 change_qty=0
 *   留审计痕迹」定案对齐）；
 * - SN 商品的 update.stock 字段静默忽略（D-SN11 禁手动调库——与建档
 *   stock 强制 0 的静默覆盖先例一致）。
 *
 * SN 商品（tracking='sn'）约束：
 * - 建档初始库存强制 0、禁手动调整库存（D-SN11——一物一码，库存只能随
 *   SN 增删在事务内联动，冗余值=在库 SN 数——D-SN13）；
 * - 非空 SN 前缀之间不得相同/互为前缀（D-SN14，大小写敏感——R7）；
 * - 有在库 SN 的 SN 商品禁删（D-SN15——提示先处理 SN）；
 * - 删在库 SN = 单事务 { 逻辑删除 + stock-1 + movements(source='manual')
 *   + 改动记录 }（D-SN16）。
 */

import type Database from 'better-sqlite3'
import type {
  Product,
  ProductChangeEntry,
  ProductChangeLog,
  ProductSn,
  ProductTracking
} from '../../shared/types'
import { createProductRepo } from '../db/repositories/product.repo'
import type { NewProduct, ProductRow } from '../db/repositories/product.repo'
// P1-2 分层修复：错误类下沉 common/errors（见该文件头注释）
import { ProductServiceError } from '../common/errors'

/** IpcChannels['products:create'] req 形状（snake_case，与契约逐字一致） */
export interface ProductCreateInput {
  barcode: string | null
  name: string
  default_price_cents: number | null
  stock: number
  /** 计存类型（'sn' 时 stock 强制 0——D-SN11） */
  tracking: ProductTracking
  /** SN 前缀（可空；仅 SN 商品生效，其余强制 ''——D-SN2） */
  sn_prefix?: string
}

/** IpcChannels['products:update'] req 形状（条码/tracking 不可改——契约语义） */
export interface ProductUpdateInput {
  id: number
  name: string
  default_price_cents: number | null
  /** SN 前缀可改（影响以后进货匹配）；非 SN 商品强制 '' */
  sn_prefix?: string
  /**
   * 批量计商品可同事务调库存（绝对目标值）；SN 商品携带时静默忽略
   * （D-SN11——与建档 stock 强制 0 的静默覆盖先例一致）。
   */
  stock?: number
  /** 改动原因（必填非空——落 product_change_logs） */
  reason: string
}

function assertValidName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ProductServiceError('INVALID_NAME', '商品名称不能为空')
  }
  return name.trim()
}

/** 价格：null（未设默认售价）或整数分 ≥0（一律整数分——G1） */
function assertValidPriceCents(cents: unknown): number | null {
  if (cents === null || cents === undefined) return null
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) {
    throw new ProductServiceError('INVALID_PRICE', '默认售价必须是大于等于 0 的整数（分）')
  }
  return cents
}

/** 库存：整数（允许负值——D2） */
function assertValidStock(stock: unknown): number {
  if (typeof stock !== 'number' || !Number.isInteger(stock)) {
    throw new ProductServiceError('INVALID_STOCK', '库存必须是整数')
  }
  return stock
}

/** 条码：null / 空白 → null（无条码商品 D17）；其余 trim 后原样（大小写敏感） */
function normalizeBarcode(barcode: unknown): string | null {
  if (typeof barcode !== 'string') return null
  const trimmed = barcode.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 计存类型：仅 'quantity' | 'sn'（建后不可互转——D-SN1，落库 CHECK 兜底前先挡） */
function assertValidTracking(tracking: unknown): ProductTracking {
  if (tracking !== 'quantity' && tracking !== 'sn') {
    throw new ProductServiceError('INVALID_TRACKING', '商品计存类型必须是 quantity 或 sn')
  }
  return tracking
}

/** SN 前缀：trim、空 → ''（空串=无前缀——D-SN2）；比较大小写敏感（R7） */
function normalizeSnPrefix(prefix: unknown): string {
  if (prefix === null || prefix === undefined) return ''
  if (typeof prefix !== 'string') {
    throw new ProductServiceError('INVALID_SN_PREFIX', 'SN 前缀必须是字符串')
  }
  return prefix.trim()
}

/** 改动原因：trim 后非空（所有改动必填——用户定案；UI inputValidator 后的第二道防线） */
function assertValidReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ProductServiceError('INVALID_REASON', '改动原因不能为空')
  }
  return reason.trim()
}

/** listChangeLogs limit 归一：默认 100（仅最近 N 条，不翻页——定案），钳制 [1, 500] */
function normalizeLogLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) return 100
  return Math.min(limit, 500)
}

export function createProductService(db: Database.Database) {
  const repo = createProductRepo(db)

  /** 存在性守卫（TOCTOU 无虞：better-sqlite3 同步单线程） */
  function requireProduct(id: number): Product {
    if (!Number.isInteger(id)) {
      throw new ProductServiceError('PRODUCT_NOT_FOUND', '商品不存在')
    }
    const found = repo.getById(id)
    if (!found) {
      throw new ProductServiceError('PRODUCT_NOT_FOUND', '商品不存在')
    }
    return found
  }

  /**
   * SN 前缀互斥校验（D-SN14）：非空前缀之间不得相同、不得互为前缀
   * （大小写敏感——R7）。excludeProductId 供编辑自身时排除自己。
   */
  function assertPrefixAvailable(candidate: string, excludeProductId?: number): void {
    if (candidate === '') return
    for (const other of repo.listSnPrefixes(excludeProductId)) {
      if (
        other.sn_prefix === candidate ||
        other.sn_prefix.startsWith(candidate) ||
        candidate.startsWith(other.sn_prefix)
      ) {
        throw new ProductServiceError(
          'PRODUCT_SN_PREFIX_CONFLICT',
          `SN 前缀与商品「${other.name}」的前缀冲突（${other.sn_prefix} / ${candidate}）`
        )
      }
    }
  }

  return {
    /**
     * 列表/搜索：名称子串 / 条码前缀。
     * 行带 willOrphan（删除影响计数——通道封闭约束下 UI 删除弹窗的唯一获取途径；
     * 契约 products:list res 即 ProductRow[]，与返回类型同源）。
     */
    list(keyword?: string): ProductRow[] {
      const kw = typeof keyword === 'string' ? keyword.trim() : ''
      return kw.length === 0 ? repo.list() : repo.search(kw)
    },

    create(input: ProductCreateInput): Product {
      const name = assertValidName(input.name)
      const barcode = normalizeBarcode(input.barcode)
      const priceCents = assertValidPriceCents(input.default_price_cents)
      const tracking = assertValidTracking(input.tracking)
      const stock = assertValidStock(input.stock)

      if (barcode !== null && repo.findByBarcode(barcode)) {
        throw new ProductServiceError('BARCODE_CONFLICT', '条码已存在')
      }

      // SN 前缀仅 SN 商品持有（D-SN2）；SN 商品建档初始库存强制 0（D-SN11——
      // 忽略入参，库存只能随 SN 增删联动，repo 对 stock=0 不写流水）
      const isSn = tracking === 'sn'
      const snPrefix = isSn ? normalizeSnPrefix(input.sn_prefix) : ''
      assertPrefixAvailable(snPrefix)
      const effectiveStock = isSn ? 0 : stock

      const created: NewProduct = {
        barcode,
        name,
        default_price_cents: priceCents,
        stock: effectiveStock,
        tracking,
        sn_prefix: snPrefix
      }
      return repo.create(created)
    },

    /**
     * 编辑保存（一次保存一条改动记录——单事务合并）：
     * 字段更新（name/price/sn_prefix）+ 批量计库存联动（stock 有变时
     * updateStock → movements 'manual'）+ 一条 product_change_logs
     * （逐字段旧→新，含 stock）。diff 为空且库存未变 → 原样返回不写日志。
     * SN 商品的 stock 字段静默忽略（D-SN11）。
     */
    update(input: ProductUpdateInput): Product {
      const product = requireProduct(input.id)
      const name = assertValidName(input.name)
      const priceCents = assertValidPriceCents(input.default_price_cents)
      const reason = assertValidReason(input.reason)
      // sn_prefix 可选：省略 = 保持现值（防部分提交静默清空），显式 '' 才清除；
      // 非 SN 商品恒 ''（D-SN2——前缀仅 SN 商品属性）
      let snPrefix: string
      if (product.tracking !== 'sn') {
        snPrefix = ''
      } else if (input.sn_prefix === undefined) {
        snPrefix = product.sn_prefix
      } else {
        snPrefix = normalizeSnPrefix(input.sn_prefix)
      }
      assertPrefixAvailable(snPrefix, product.id)

      // 批量计商品库存联动：显式传整数且与现值不同才调整；SN 商品静默忽略（D-SN11）
      let newStock: number | null = null
      if (product.tracking !== 'sn' && input.stock !== undefined) {
        const stock = assertValidStock(input.stock)
        if (stock !== product.stock) newStock = stock
      }

      // diff（旧→新）：空 = 无任何改动，不写日志、不落 UPDATE（审计降噪）
      const changes: ProductChangeEntry[] = []
      if (name !== product.name) {
        changes.push({ field: 'name', old: product.name, new: name })
      }
      if (priceCents !== product.default_price_cents) {
        changes.push({
          field: 'default_price_cents',
          old: product.default_price_cents,
          new: priceCents
        })
      }
      if (snPrefix !== product.sn_prefix) {
        changes.push({ field: 'sn_prefix', old: product.sn_prefix, new: snPrefix })
      }
      if (newStock !== null) {
        changes.push({ field: 'stock', old: product.stock, new: newStock })
      }
      if (changes.length === 0) return product

      const run = db.transaction((): Product => {
        repo.update(input.id, {
          name,
          default_price_cents: priceCents,
          sn_prefix: snPrefix
        })
        const updated =
          newStock !== null
            ? repo.updateStock(input.id, newStock, 'manual')
            : (repo.getById(input.id) as Product)
        repo.insertChangeLog(input.id, 'update', reason, changes)
        return updated
      })
      return run()
    },

    /**
     * 手动调整库存为绝对目标值（独立通道）；单事务 = repo.updateStock
     * （流水 source='manual'——G5）+ 改动记录 action='stock'（由几改为几）。
     * 同值调整也记录（与既有「同值流水 change_qty=0 留审计痕迹」定案对齐）。
     */
    updateStock(input: { id: number; stock: number; reason: string }): Product {
      const product = requireProduct(input.id)
      // SN 商品禁手动调整（D-SN11）——库存只能随 SN 增删在事务内联动（D-SN13）
      if (product.tracking === 'sn') {
        throw new ProductServiceError(
          'PRODUCT_SN_NO_MANUAL_STOCK',
          'SN 商品不支持手动调整库存，请通过 SN 增删管理'
        )
      }
      const stock = assertValidStock(input.stock)
      const reason = assertValidReason(input.reason)
      const run = db.transaction((): Product => {
        const updated = repo.updateStock(input.id, stock, 'manual')
        repo.insertChangeLog(input.id, 'stock', reason, [
          { field: 'stock', old: product.stock, new: stock }
        ])
        return updated
      })
      return run()
    },

    /**
     * 逻辑删除（软删）商品；返回 willOrphan（关联历史单据行数，UI 弹窗文案用）。
     * 单事务 = 软删 + 改动记录 action='delete'（无字段明细——action 本身已说明）。
     * 软删行保留：历史单据 product_id FK 持续有效、审计链完整；
     * barcode 随删置 NULL 释放 UNIQUE 占位；SN 台账级联软删（D-SN15 原始意图）。
     * SN 商品存在在库 SN 时拒绝（D-SN15——提示先处理 SN；已售 SN 不阻删，
     * 行随软删保留、deleted=1，对 findSn/listSns 不可见）。
     */
    delete(input: { id: number; reason: string }): { ok: true; willOrphan: number } {
      const product = requireProduct(input.id)
      const reason = assertValidReason(input.reason)
      const inStockCount = repo.countInStockSns(product.id)
      if (inStockCount > 0) {
        throw new ProductServiceError(
          'PRODUCT_SN_HAS_STOCK',
          `该 SN 商品仍有 ${inStockCount} 个在库 SN，请先删除在库 SN`
        )
      }
      const run = db.transaction((): number => {
        const willOrphan = repo.delete(product.id)
        repo.insertChangeLog(product.id, 'delete', reason, [])
        return willOrphan
      })
      return { ok: true, willOrphan: run() }
    },

    /**
     * 商品改动记录（最新在前，仅最近 limit 条——默认 100，不翻页）。
     * 软删商品的记录仍可查（product_id FK 有效——审计链完整），故不走
     * requireProduct 活跃守卫，仅做参数校验。
     */
    listChangeLogs(productId: number, limit?: number): ProductChangeLog[] {
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new ProductServiceError('PRODUCT_NOT_FOUND', '商品不存在')
      }
      return repo.listChangeLogs(productId, normalizeLogLimit(limit))
    },

    // ── SN 台账（D-SN16）──

    /**
     * 按 SN 精查（仅 deleted=0）：收银扫码第一优先级（D-SN5）+ SN 弹窗校验共用。
     * 未命中/已删除 → null（调用方分流：查商品码 / 报已售）。
     */
    findSn(sn: string): { sn: ProductSn; product: Product } | null {
      const normalized = typeof sn === 'string' ? sn.trim() : ''
      if (normalized === '') return null
      const found = repo.findSnActive(normalized)
      if (!found) return null
      return { sn: toProductSn(found.sn_row), product: found.product }
    },

    /** 商品 SN 列表（D-SN16）：默认在库；includeSold 含已售（带关联单号） */
    listSns(productId: number, includeSold: boolean): ProductSn[] {
      const product = requireProduct(productId)
      return repo.listSns(product.id, includeSold)
    },

    /**
     * 删除在库 SN（D-SN16）：单事务 { 逻辑删除 + stock-1 + movements(source='manual',
     * change_qty=-1) + 改动记录 action='sn_delete'（SN 值与库存旧→新）}；
     * 已售/已删行拒绝。事务后 products.stock 恒等于在库 SN 数
     * （D-SN13 一致性——测试断言基准）。
     */
    deleteSn(snId: number, reason: string): { ok: true } {
      const trimmedReason = assertValidReason(reason)
      const run = db.transaction((): void => {
        const row = Number.isInteger(snId) ? repo.getSnById(snId) : undefined
        if (!row || row.deleted !== 0 || row.status !== 'in_stock') {
          throw new ProductServiceError('PRODUCT_SN_NOT_DELETABLE', '该 SN 已售出或已删除，不可删除')
        }
        const product = repo.getById(row.product_id)
        if (!product) {
          throw new ProductServiceError('PRODUCT_NOT_FOUND', '商品不存在')
        }
        repo.softDeleteSn(row.id)
        repo.updateStock(product.id, product.stock - 1, 'manual')
        repo.insertChangeLog(product.id, 'sn_delete', trimmedReason, [
          { field: 'sn', old: row.sn, new: null },
          { field: 'stock', old: product.stock, new: product.stock - 1 }
        ])
      })
      run()
      return { ok: true }
    }
  }
}

/** ProductSnRow → ProductSn DTO（findSn 用；listSns 由 repo 直接映射同构行） */
function toProductSn(row: {
  id: number
  product_id: number
  sn: string
  status: 'in_stock' | 'sold'
  sale_id: number | null
  sale_no: string | null
  created_at: string
}): ProductSn {
  return {
    id: row.id,
    product_id: row.product_id,
    sn: row.sn,
    status: row.status,
    sale_id: row.sale_id,
    sale_no: row.sale_no,
    created_at: row.created_at
  }
}

export type ProductService = ReturnType<typeof createProductService>
