import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import {
  loadDailyReport,
  loadMonthlyReport,
  loadReportExportInput
} from '../../../src/main/export/report-loader'

/**
 * Task 17 — export/report-loader（reports:export 通道的数据侧）：
 * 日/月聚合 SQL（剔除 voided——D3）。T14 report.service 落地后此处应改为委托（issues 已记录）。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-export-loader-'))
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

const SEED_SALES: SaleSeed[] = [
  { sale_no: '20261101-0001', total_cents: 5250, item_count: 2, status: 'completed', created_at: '2026-11-01 08:30:12' },
  { sale_no: '20261101-0002', total_cents: 4100, item_count: 1, status: 'completed', created_at: '2026-11-01 12:45:33' },
  { sale_no: '20261101-0003', total_cents: 2995, item_count: 4, status: 'completed', created_at: '2026-11-01 18:02:59' },
  { sale_no: '20261102-0001', total_cents: 12000, item_count: 3, status: 'completed', created_at: '2026-11-02 09:10:00' },
  { sale_no: '20261102-0002', total_cents: 7760, item_count: 1, status: 'completed', created_at: '2026-11-02 21:15:45' },
  { sale_no: '20261101-0004', total_cents: 9999, item_count: 1, status: 'voided', created_at: '2026-11-01 22:00:00' },
  { sale_no: '20261231-0001', total_cents: 55555, item_count: 2, status: 'completed', created_at: '2026-12-31 23:59:59' }
]

describe('report-loader：日报', () => {
  it('合计/订单数只计 completed（voided 剔除——D3），按时间排序', () => {
    const db = createDb()
    try {
      for (const s of SEED_SALES) insertSale(db, s)

      const report = loadDailyReport(db, '2026-11-01')

      expect(report.date).toBe('2026-11-01')
      expect(report.total_cents).toBe(5250 + 4100 + 2995)
      expect(report.order_count).toBe(3)
      expect(report.sales.map((s) => s.sale_no)).toEqual(['20261101-0001', '20261101-0002', '20261101-0003'])
      expect(report.sales.every((s) => s.status === 'completed')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('无销售日 → 空报表（total 0 / count 0 / sales []）', () => {
    const db = createDb()
    try {
      const report = loadDailyReport(db, '2026-11-05')
      expect(report.total_cents).toBe(0)
      expect(report.order_count).toBe(0)
      expect(report.sales).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('report-loader：月报', () => {
  it('按日分桶（SUM/COUNT 聚合）+ 月度合计，voided 剔除', () => {
    const db = createDb()
    try {
      for (const s of SEED_SALES) insertSale(db, s)

      const report = loadMonthlyReport(db, '2026-11')

      expect(report.month).toBe('2026-11')
      expect(report.buckets).toEqual([
        { date: '2026-11-01', total_cents: 12345, order_count: 3 },
        { date: '2026-11-02', total_cents: 19760, order_count: 2 }
      ])
      expect(report.total_cents).toBe(32105)
      expect(report.order_count).toBe(5)
    } finally {
      db.close()
    }
  })

  it('无销售月 → 空 buckets', () => {
    const db = createDb()
    try {
      const report = loadMonthlyReport(db, '2027-01')
      expect(report.total_cents).toBe(0)
      expect(report.order_count).toBe(0)
      expect(report.buckets).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('report-loader：loadReportExportInput（导出输入组装）', () => {
  it('日报：kind/period/title/report 组装（标题 {日期} 销售报表）', () => {
    const db = createDb()
    try {
      for (const s of SEED_SALES) insertSale(db, s)
      const input = loadReportExportInput(db, 'daily', '2026-11-01')

      expect(input.kind).toBe('daily')
      expect(input.period).toBe('2026-11-01')
      expect(input.title).toBe('2026-11-01 销售报表')
      if (input.kind !== 'daily') throw new Error('expected daily')
      expect(input.report.total_cents).toBe(12345)
    } finally {
      db.close()
    }
  })

  it('月报：标题 {yyyy-MM} 销售报表，report 带 buckets', () => {
    const db = createDb()
    try {
      for (const s of SEED_SALES) insertSale(db, s)
      const input = loadReportExportInput(db, 'monthly', '2026-11')

      expect(input.kind).toBe('monthly')
      expect(input.title).toBe('2026-11 销售报表')
      if (input.kind !== 'monthly') throw new Error('expected monthly')
      expect(input.report.total_cents).toBe(32105)
      expect(input.report.buckets).toHaveLength(2)
    } finally {
      db.close()
    }
  })
})
