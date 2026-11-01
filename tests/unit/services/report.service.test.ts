import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import { createReportService } from '../../../src/main/services/report.service'

/**
 * Task 14 — report.service 时间边界矩阵：
 * - 跨午夜：created_at 本地语义（datetime('now','localtime') 同钟），SQL date()/strftime 分桶
 * - voided 剔除（D3）：total/order_count 不含；明细行带 status 标记（与 T17 导出明细契约对齐）
 * - 空数据日/月：零值不抛错；自洽：日报 total == Σ明细（剔除 voided）；月报按日分桶
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-report-service-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function createDb(): Database.Database {
  const db = new Database(join(dir, 'pos.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

interface SaleSeed {
  sale_no: string
  total_cents: number
  item_count: number
  status: 'completed' | 'voided'
  created_at: string
}

function insertSale(db: Database.Database, s: SaleSeed): void {
  db.prepare(
    `INSERT INTO sales (sale_no, total_cents, item_count, status, voided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(s.sale_no, s.total_cents, s.item_count, s.status, s.status === 'voided' ? s.created_at : null, s.created_at)
}

/** 跨午夜 seed（Task 14 QA Scenario 原文）：23:59:59 ×2 单 + 00:00:01 ×1 单（voided） */
const MIDNIGHT_SALES: SaleSeed[] = [
  { sale_no: '20261031-0001', total_cents: 5250, item_count: 2, status: 'completed', created_at: '2026-10-31 23:59:59' },
  { sale_no: '20261031-0002', total_cents: 4100, item_count: 1, status: 'completed', created_at: '2026-10-31 23:59:59' },
  { sale_no: '20261101-0001', total_cents: 9999, item_count: 1, status: 'voided', created_at: '2026-11-01 00:00:01' }
]

describe('report.service：跨午夜边界（SQL date() 本地语义分桶）', () => {
  it('2026-10-31 日报：orderCount=2、total=两单和、明细=[23:59 两单] 均带 status 标记', () => {
    const db = createDb()
    try {
      for (const s of MIDNIGHT_SALES) insertSale(db, s)

      const report = createReportService(db).daily('2026-10-31')

      expect(report).toEqual({
        date: '2026-10-31',
        total_cents: 5250 + 4100,
        order_count: 2,
        sales: [
          {
            id: 1,
            sale_no: '20261031-0001',
            total_cents: 5250,
            item_count: 2,
            status: 'completed',
            voided_at: null,
            created_at: '2026-10-31 23:59:59'
          },
          {
            id: 2,
            sale_no: '20261031-0002',
            total_cents: 4100,
            item_count: 1,
            status: 'completed',
            voided_at: null,
            created_at: '2026-10-31 23:59:59'
          }
        ]
      })
    } finally {
      db.close()
    }
  })

  it('2026-11-01 日报：该日唯一单已作废 → totalCents=0、orderCount=0、明细=[]（voided 精确断言）', () => {
    const db = createDb()
    try {
      for (const s of MIDNIGHT_SALES) insertSale(db, s)

      const report = createReportService(db).daily('2026-11-01')

      expect(report).toEqual({ date: '2026-11-01', total_cents: 0, order_count: 0, sales: [] })
    } finally {
      db.close()
    }
  })

  it('同秒两单稳定排序（ORDER BY created_at, id），日报 total 与明细行序自洽', () => {
    const db = createDb()
    try {
      for (const s of MIDNIGHT_SALES) insertSale(db, s)

      const report = createReportService(db).daily('2026-10-31')

      expect(report.sales.map((s) => s.sale_no)).toEqual(['20261031-0001', '20261031-0002'])
      expect(report.total_cents).toBe(report.sales.reduce((sum, s) => sum + s.total_cents, 0))
    } finally {
      db.close()
    }
  })

  it('2026-10 月报：含 31 日两单（跨月不丢午夜单），分桶单桶聚合', () => {
    const db = createDb()
    try {
      for (const s of MIDNIGHT_SALES) insertSale(db, s)

      const report = createReportService(db).monthly('2026-10')

      expect(report).toEqual({
        month: '2026-10',
        total_cents: 9350,
        order_count: 2,
        buckets: [{ date: '2026-10-31', total_cents: 9350, order_count: 2 }]
      })
    } finally {
      db.close()
    }
  })

  it('2026-11 月报：唯一单 voided → total=0、orderCount=0、buckets=[]', () => {
    const db = createDb()
    try {
      for (const s of MIDNIGHT_SALES) insertSale(db, s)

      const report = createReportService(db).monthly('2026-11')

      expect(report).toEqual({ month: '2026-11', total_cents: 0, order_count: 0, buckets: [] })
    } finally {
      db.close()
    }
  })
})

describe('report.service：月报按日分桶（strftime %Y-%m 过滤 + date() 分桶）', () => {
  const BUCKET_SALES: SaleSeed[] = [
    { sale_no: '20261005-0001', total_cents: 1000, item_count: 1, status: 'completed', created_at: '2026-10-05 10:00:00' },
    { sale_no: '20261005-0002', total_cents: 250, item_count: 3, status: 'completed', created_at: '2026-10-05 11:30:00' },
    { sale_no: '20261018-0001', total_cents: 7250, item_count: 2, status: 'completed', created_at: '2026-10-18 09:15:00' },
    { sale_no: '20261018-0002', total_cents: 999, item_count: 1, status: 'voided', created_at: '2026-10-18 20:00:00' },
    { sale_no: '20261102-0001', total_cents: 500, item_count: 1, status: 'completed', created_at: '2026-11-02 08:00:00' }
  ]

  it('同日多单合并一桶 + voided 不入桶 + 跨月互不串桶（按日数组）', () => {
    const db = createDb()
    try {
      for (const s of BUCKET_SALES) insertSale(db, s)

      const report = createReportService(db).monthly('2026-10')

      expect(report.buckets).toEqual([
        { date: '2026-10-05', total_cents: 1250, order_count: 2 },
        { date: '2026-10-18', total_cents: 7250, order_count: 1 }
      ])
      expect(report.buckets.every((b) => b.date.startsWith('2026-10-'))).toBe(true)
      expect(report.total_cents).toBe(1250 + 7250)
      expect(report.order_count).toBe(3)
    } finally {
      db.close()
    }
  })

  it('月度自洽：月报合计 == Σ桶 total_cents == Σ桶 order_count', () => {
    const db = createDb()
    try {
      for (const s of BUCKET_SALES) insertSale(db, s)

      const report = createReportService(db).monthly('2026-10')

      expect(report.total_cents).toBe(report.buckets.reduce((sum, b) => sum + b.total_cents, 0))
      expect(report.order_count).toBe(report.buckets.reduce((sum, b) => sum + b.order_count, 0))
    } finally {
      db.close()
    }
  })

  it('空数据月（无任何销售）→ 零值 + 空 buckets 不抛错', () => {
    const db = createDb()
    try {
      const report = createReportService(db).monthly('2030-01')

      expect(report).toEqual({ month: '2030-01', total_cents: 0, order_count: 0, buckets: [] })
    } finally {
      db.close()
    }
  })
})

describe('report.service：空数据日与参数校验', () => {
  it('空数据日 daily(2030-01-01) → totalCents=0、orderCount=0、items=[] 不抛错', () => {
    const db = createDb()
    try {
      const report = createReportService(db).daily('2030-01-01')

      expect(report).toEqual({ date: '2030-01-01', total_cents: 0, order_count: 0, sales: [] })
    } finally {
      db.close()
    }
  })

  it('有数据月中查无销售日 → 同样零值（空态不限于全库空）', () => {
    const db = createDb()
    try {
      for (const s of MIDNIGHT_SALES) insertSale(db, s)

      const report = createReportService(db).daily('2026-10-30')

      expect(report).toEqual({ date: '2026-10-30', total_cents: 0, order_count: 0, sales: [] })
    } finally {
      db.close()
    }
  })

  it('日报非法日期格式 → 抛可诊断错误（yyyy-MM-dd）', () => {
    const db = createDb()
    try {
      const service = createReportService(db)
      expect(() => service.daily('2026/10/31')).toThrow(/yyyy-MM-dd/)
      expect(() => service.daily('2026-10')).toThrow(/yyyy-MM-dd/)
      expect(() => service.daily('')).toThrow(/yyyy-MM-dd/)
      expect(() => service.daily(20261031 as unknown as string)).toThrow(/yyyy-MM-dd/)
    } finally {
      db.close()
    }
  })

  it('月报非法月份格式 → 抛可诊断错误（yyyy-MM）', () => {
    const db = createDb()
    try {
      const service = createReportService(db)
      expect(() => service.monthly('2026-10-01')).toThrow(/yyyy-MM/)
      expect(() => service.monthly('2026/10')).toThrow(/yyyy-MM/)
      expect(() => service.monthly('')).toThrow(/yyyy-MM/)
    } finally {
      db.close()
    }
  })
})
