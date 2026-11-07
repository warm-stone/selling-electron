/**
 * 订单附加信息 DAL（Task 5）：sale_extras 表 1:1 旁挂读写。
 *
 * 设计前提（见 .omo/notepads/customer-order-extras/decisions.md）：
 * - `sale_extras.sale_id` 兼任 PRIMARY KEY（1:1 旁挂，同单至多一行）
 *   → upsert 的 `ON CONFLICT(sale_id)` 即此 PK，无需额外唯一判断
 * - SQLite 无 bool：`is_national_subsidy` 是 INTEGER 0/1，
 *   boolean↔INTEGER 映射在此层做（DB 层不存 bool）
 * - `sale_extras.customer_id` 仅存引用（非快照）：LEFT JOIN customers
 *   取最新行——客户改名后旧单 getWithCustomer 即时反映（D-ref 定案）
 * - 全部单条预编译语句、无自有 `db.transaction`：
 *   insert/upsert 将被结账事务调用（D-SN8 豁免前提——事务 owner 在
 *   service.checkout，repo 只提供语句不开启事务）
 */

import type Database from 'better-sqlite3'
import type { Customer, SaleExtraInfo } from '../../../shared/types'

/** insert 入参：落库前形态（boolean 原样传入，repo 内转 INTEGER 0/1） */
export interface SaleExtraInsertData {
  customer_id: number | null
  is_national_subsidy: boolean
  order_note: string | null
  salesperson: string | null
}

/** upsert patch：全字段可选（只更新出现的键） */
export interface SaleExtraPatch {
  customer_id?: number | null
  is_national_subsidy?: boolean
  order_note?: string | null
  salesperson?: string | null
}

/** findBySaleIds 返回的行级摘要（报表明细备用） */
export interface SaleExtraBrief {
  is_national_subsidy: boolean
  order_note: string | null
}

/** upsert 四列的元数据：列名 → patch key + INSERT 默认值（用于 ON CONFLICT 动态拼 SET） */
const UPSERT_COLUMNS = [
  { col: 'customer_id', key: 'customer_id', default: null as number | null },
  { col: 'is_national_subsidy', key: 'is_national_subsidy', default: false },
  { col: 'order_note', key: 'order_note', default: null as string | null },
  { col: 'salesperson', key: 'salesperson', default: null as string | null }
] as const

/** boolean → INTEGER 0/1（DB 无 bool） */
function boolToInt(b: boolean): number {
  return b ? 1 : 0
}

export function createSaleExtraRepo(db: Database.Database) {
  // ── insert：全字段写入（结账事务内调用） ──
  const stmtInsert = db.prepare(
    `INSERT INTO sale_extras
       (sale_id, customer_id, is_national_subsidy, order_note, salesperson)
     VALUES (?, ?, ?, ?, ?)`
  )

  // ── getWithCustomer：sale_extras LEFT JOIN customers 平铺 ──
  //   无 sale_extras 行 → undefined（repo 层转 null）
  //   有行无客户（customer_id NULL）→ c.* 全 NULL，customer 字段 null
  //   有行有客户 → 平铺 Customer
  const stmtGetWithCustomer = db.prepare(
    `SELECT
       se.sale_id             AS sale_id,
       se.customer_id         AS customer_id,
       se.is_national_subsidy AS is_national_subsidy,
       se.order_note          AS order_note,
       se.salesperson         AS salesperson,
       c.id                   AS c_id,
       c.name                 AS c_name,
       c.phone                AS c_phone,
       c.address              AS c_address,
       c.note                 AS c_note,
       c.created_at           AS c_created_at,
       c.updated_at           AS c_updated_at
     FROM sale_extras se
     LEFT JOIN customers c ON c.id = se.customer_id
     WHERE se.sale_id = ?`
  )

  // ── findBySaleIds：批量查询行级摘要（报表明细备用） ──
  //   better-sqlite3 无 `??` 展开占位符——按入参个数动态生成 `?,?,?` 占位符
  //   （空数组在方法内提前返回，此语句只对非空数组调用）

  // ── upsert 双语句方案（动态 SET，保证只改 patch 中出现的键） ──
  //   INSERT 部分：对未提供的 patch 键用默认值（customer_id NULL/
  //   is_national_subsidy 0/order_note NULL/salesperson NULL）——sale_id
  //   不存在时建行；ON CONFLICT(sale_id) 走 UPDATE 分支
  //   UPDATE 部分：只 SET patch 中出现的键（动态拼 SET 子句，未出现列不动）
  const stmtUpsertInsert = db.prepare(
    `INSERT INTO sale_extras
       (sale_id, customer_id, is_national_subsidy, order_note, salesperson)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sale_id) DO NOTHING`
  )

  return {
    /**
     * 全字段插入（结账事务内调用）。
     * boolean→INTEGER 0/1 转换在此层做（DB 无 bool）。
     * 重复 sale_id 会抛 SQLITE_CONSTRAINT（PK 冲突）——调用方保证同单只插一次。
     */
    insert(saleId: number, data: SaleExtraInsertData): void {
      stmtInsert.run(
        saleId,
        data.customer_id,
        boolToInt(data.is_national_subsidy),
        data.order_note,
        data.salesperson
      )
    },

    /**
     * 部分键 upsert（`sales:updateExtra` 消费）。
     * - 旧单无行：INSERT 建行（未提供的 patch 键走默认值）
     * - 已有行：只 SET patch 中出现的键（未提供列保持不变）
     * 幂等：同 sale_id 多次 upsert 至多一行。
     */
    upsert(saleId: number, patch: SaleExtraPatch): void {
      // 第一步：尝试建行（未提供的键用默认值）；已有行时 ON CONFLICT DO NOTHING 跳过
      stmtUpsertInsert.run(
        saleId,
        patch.customer_id !== undefined ? patch.customer_id : null,
        patch.is_national_subsidy !== undefined
          ? boolToInt(patch.is_national_subsidy)
          : 0,
        patch.order_note !== undefined ? patch.order_note : null,
        patch.salesperson !== undefined ? patch.salesperson : null
      )

      // 第二步：动态拼 UPDATE——只改 patch 中出现的键
      const setClauses: string[] = []
      const params: (number | string | null)[] = []
      for (const { col, key } of UPSERT_COLUMNS) {
        if (patch[key] !== undefined) {
          setClauses.push(`${col} = ?`)
          if (key === 'is_national_subsidy') {
            params.push(boolToInt(patch[key] as boolean))
          } else {
            params.push(patch[key] as number | string | null)
          }
        }
      }
      if (setClauses.length === 0) return // patch 无键：建行已足够，无需 UPDATE
      params.push(saleId)
      db.prepare(
        `UPDATE sale_extras SET ${setClauses.join(', ')} WHERE sale_id = ?`
      ).run(...params)
    },

    /**
     * 取附加信息 + 平铺客户（LEFT JOIN，引用非快照）。
     * - 无 sale_extras 行 → null
     * - 有行 customer_id NULL → customer: null
     * - 有行有客户 → customer 平铺 Customer（客户改名后即时反映）
     * is_national_subsidy INTEGER→boolean 映射在此层做。
     */
    getWithCustomer(saleId: number): SaleExtraInfo | null {
      const row = stmtGetWithCustomer.get(saleId) as
        | {
            sale_id: number
            customer_id: number | null
            is_national_subsidy: number
            order_note: string | null
            salesperson: string | null
            c_id: number | null
            c_name: string | null
            c_phone: string | null
            c_address: string | null
            c_note: string | null
            c_created_at: string | null
            c_updated_at: string | null
          }
        | undefined
      if (!row) return null
      // customer_id 非空但客户行不存在（理论上 FK 保证不会发生，防御性处理）
      const customer: Customer | null =
        row.c_id !== null
          ? {
              id: row.c_id,
              name: row.c_name as string,
              phone: row.c_phone as string,
              address: row.c_address as string,
              note: row.c_note as string,
              created_at: row.c_created_at as string,
              updated_at: row.c_updated_at as string
            }
          : null
      return {
        sale_id: row.sale_id,
        customer_id: row.customer_id,
        is_national_subsidy: row.is_national_subsidy === 1,
        order_note: row.order_note,
        salesperson: row.salesperson,
        customer
      }
    },

    /**
     * 批量查询行级摘要（报表明细备用）。
     * 空数组 → 空 Map（不跑 SQL，避免 IN () 语法错误）。
     * 返回 Map<sale_id, brief>，无行的 sale_id 不在 Map 中。
     */
    findBySaleIds(saleIds: number[]): Map<number, SaleExtraBrief> {
      if (saleIds.length === 0) return new Map()
      const placeholders = saleIds.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT sale_id, is_national_subsidy, order_note
           FROM sale_extras
           WHERE sale_id IN (${placeholders})`
        )
        .all(...saleIds) as Array<{
        sale_id: number
        is_national_subsidy: number
        order_note: string | null
      }>
      const map = new Map<number, SaleExtraBrief>()
      for (const row of rows) {
        map.set(row.sale_id, {
          is_national_subsidy: row.is_national_subsidy === 1,
          order_note: row.order_note
        })
      }
      return map
    }
  }
}

export type SaleExtraRepo = ReturnType<typeof createSaleExtraRepo>
