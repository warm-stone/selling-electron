import type { DailyReport } from '../../../src/shared/types/domain'
import type { ReportExportInput } from '../../../src/main/export/export.types'

type DailyExportInput = Extract<ReportExportInput, { kind: 'daily' }>
type MonthlyExportInput = Extract<ReportExportInput, { kind: 'monthly' }>

/**
 * Task 17 — 导出器 round-trip 测试共用样例（txt/xlsx/docx/service 四套测试共享，
 * 保证三格式断言的是同一份输入数据）。
 *
 * 金额约定（G1）：样例一律整数分；括注为导出层应显示的元字符串。
 */

/** 3 单完成销售：5250 + 4100 + 2995 = 12345（123.45 元） */
export const SAMPLE_DAILY_REPORT: DailyReport = {
  date: '2026-11-01',
  total_cents: 12345,
  order_count: 3,
  sales: [
    {
      id: 1,
      sale_no: '20261101-0001',
      total_cents: 5250,
      item_count: 2,
      status: 'completed',
      voided_at: null,
      created_at: '2026-11-01 08:30:12'
    },
    {
      id: 2,
      sale_no: '20261101-0002',
      total_cents: 4100,
      item_count: 1,
      status: 'completed',
      voided_at: null,
      created_at: '2026-11-01 12:45:33'
    },
    {
      id: 3,
      sale_no: '20261101-0003',
      total_cents: 2995,
      item_count: 4,
      status: 'completed',
      voided_at: null,
      created_at: '2026-11-01 18:02:59'
    }
  ]
}

export const SAMPLE_DAILY_INPUT: DailyExportInput = {
  kind: 'daily',
  period: '2026-11-01',
  title: '2026-11-01 销售报表',
  report: SAMPLE_DAILY_REPORT
}

/** 月报：11-01（12345/3 单）+ 11-02（19760/2 单）= 32105（321.05 元 / 5 单） */
export const SAMPLE_MONTHLY_INPUT: MonthlyExportInput = {
  kind: 'monthly',
  period: '2026-11',
  title: '2026-11 销售报表',
  report: {
    month: '2026-11',
    total_cents: 32105,
    order_count: 5,
    buckets: [
      { date: '2026-11-01', total_cents: 12345, order_count: 3 },
      { date: '2026-11-02', total_cents: 19760, order_count: 2 }
    ]
  }
}

/** 空数据日（T18 空数据态的导出侧等价物：仍须产出合法文件） */
export const EMPTY_DAILY_INPUT: DailyExportInput = {
  kind: 'daily',
  period: '2026-11-03',
  title: '2026-11-03 销售报表',
  report: { date: '2026-11-03', total_cents: 0, order_count: 0, sales: [] }
}

/** 不带 buckets 的月报输入（T14 落地前的兼容形态：跳过按日分桶区块） */
export const BUCKETLESS_MONTHLY_INPUT: MonthlyExportInput = {
  kind: 'monthly',
  period: '2026-11',
  title: '2026-11 销售报表',
  report: { month: '2026-11', total_cents: 32105, order_count: 5 }
}
