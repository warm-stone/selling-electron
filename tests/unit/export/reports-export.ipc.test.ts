import { describe, expect, it } from 'vitest'
import { parseReportsExportRequest } from '../../../src/main/ipc/reports-export.ipc'

/**
 * Task 17 — reports:export IPC 参数校验（薄层第一职责）。
 * registerReportsExportIpc 的 electron 依赖为懒加载 require——本文件可纯 Node 导入。
 */

describe('parseReportsExportRequest：合法请求', () => {
  it('日报 xlsx', () => {
    expect(parseReportsExportRequest({ kind: 'daily', period: '2026-11-01', format: 'xlsx' })).toEqual({
      kind: 'daily',
      period: '2026-11-01',
      format: 'xlsx'
    })
  })

  it('月报 docx', () => {
    expect(parseReportsExportRequest({ kind: 'monthly', period: '2026-11', format: 'docx' })).toEqual({
      kind: 'monthly',
      period: '2026-11',
      format: 'docx'
    })
  })

  it('txt 三格式之一', () => {
    expect(parseReportsExportRequest({ kind: 'daily', period: '2026-11-01', format: 'txt' }).format).toBe('txt')
  })
})

describe('parseReportsExportRequest：非法请求（可诊断错误信息）', () => {
  it('非对象 / null / undefined', () => {
    expect(() => parseReportsExportRequest(null)).toThrow(/对象/)
    expect(() => parseReportsExportRequest(undefined)).toThrow(/对象/)
    expect(() => parseReportsExportRequest('daily')).toThrow(/对象/)
  })

  it('非法 kind / format', () => {
    expect(() => parseReportsExportRequest({ kind: 'weekly', period: '2026-11-01', format: 'txt' })).toThrow(/kind/)
    expect(() => parseReportsExportRequest({ kind: 'daily', period: '2026-11-01', format: 'pdf' })).toThrow(/format/)
    expect(() => parseReportsExportRequest({ period: '2026-11-01', format: 'txt' })).toThrow(/kind/)
  })

  it('period 与 kind 不匹配（日报须 yyyy-MM-dd / 月报须 yyyy-MM）', () => {
    expect(() =>
      parseReportsExportRequest({ kind: 'daily', period: '2026-11', format: 'txt' })
    ).toThrow(/yyyy-MM-dd/)
    expect(() =>
      parseReportsExportRequest({ kind: 'monthly', period: '2026-11-01', format: 'txt' })
    ).toThrow(/yyyy-MM/)
    expect(() =>
      parseReportsExportRequest({ kind: 'daily', period: '2026/11/01', format: 'txt' })
    ).toThrow(/period/)
  })

  it('period 非字符串', () => {
    expect(() => parseReportsExportRequest({ kind: 'daily', period: 20261101, format: 'txt' })).toThrow(/period/)
  })
})
