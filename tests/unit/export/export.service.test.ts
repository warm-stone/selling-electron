import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportReport } from '../../../src/main/export/export.service'
import type { ExportDeps, SaveDialogOptionsLike, SaveDialogResultLike } from '../../../src/main/export/export.service'
import { SAMPLE_DAILY_INPUT, SAMPLE_MONTHLY_INPUT } from './export-report.fixture'

/**
 * Task 17 — export.service：
 * showSaveDialog（DI 注入）→ 取消返回 null 零写入 → Buffer 写文件 → shell.showItemInFolder。
 * E2E_EXPORT_DIR 测试钩子：env 存在时跳过 dialog 直写固定目录（T18 E2E 消费）。
 */

interface DialogScript {
  result: SaveDialogResultLike
}

interface ServiceTestCtx {
  dialogOptions: SaveDialogOptionsLike[]
  writes: Array<{ path: string; data: Buffer }>
  reveals: string[]
  deps: ExportDeps
}

function createContext(script: DialogScript): ServiceTestCtx {
  const dialogOptions: SaveDialogOptionsLike[] = []
  const writes: Array<{ path: string; data: Buffer }> = []
  const reveals: string[] = []
  return {
    dialogOptions,
    writes,
    reveals,
    deps: {
      showSaveDialog: async (options) => {
        dialogOptions.push(options)
        return script.result
      },
      writeFile: async (path, data) => {
        writes.push({ path, data })
      },
      revealInFolder: (path) => {
        reveals.push(path)
      }
    }
  }
}

const SAVED_PATH = '/tmp/opencode/saved/日报2026-11-01.xlsx'

let e2eDir: string

beforeEach(() => {
  e2eDir = mkdtempSync(join(tmpdir(), 'pos-export-e2e-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(e2eDir, { recursive: true, force: true })
})

describe('export.service：正常路径（dialog 确认保存）', () => {
  it('xlsx：默认文件名 + filters → 写文件 → 打开所在文件夹 → 返回路径', async () => {
    const ctx = createContext({ result: { canceled: false, filePath: SAVED_PATH } })
    const result = await exportReport(SAMPLE_DAILY_INPUT, 'xlsx', ctx.deps)

    expect(result).toBe(SAVED_PATH)
    expect(ctx.dialogOptions).toHaveLength(1)
    expect(ctx.dialogOptions[0].defaultPath).toBe('日报2026-11-01.xlsx')
    expect(ctx.dialogOptions[0].filters).toEqual([{ name: 'Excel 工作簿', extensions: ['xlsx'] }])
    expect(ctx.writes).toHaveLength(1)
    expect(ctx.writes[0].path).toBe(SAVED_PATH)
    expect(ctx.writes[0].data.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))).toBe(true)
    expect(ctx.reveals).toEqual([SAVED_PATH])
  })

  it('txt：写入内容含 BOM（EF BB BF）', async () => {
    const txtPath = '/tmp/opencode/saved/日报2026-11-01.txt'
    const ctx = createContext({ result: { canceled: false, filePath: txtPath } })
    const result = await exportReport(SAMPLE_DAILY_INPUT, 'txt', ctx.deps)

    expect(result).toBe(txtPath)
    expect(ctx.dialogOptions[0].defaultPath).toBe('日报2026-11-01.txt')
    expect(ctx.dialogOptions[0].filters).toEqual([{ name: '文本文件', extensions: ['txt'] }])
    expect(ctx.writes[0].data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
    expect(ctx.reveals).toEqual([txtPath])
  })

  it('docx：filters 为 Word 文档', async () => {
    const ctx = createContext({ result: { canceled: false, filePath: '/tmp/x/日报.docx' } })
    await exportReport(SAMPLE_DAILY_INPUT, 'docx', ctx.deps)
    expect(ctx.dialogOptions[0].filters).toEqual([{ name: 'Word 文档', extensions: ['docx'] }])
  })

  it('月报：默认文件名为 月报{period}.{ext}', async () => {
    const ctx = createContext({ result: { canceled: false, filePath: '/tmp/x/月报2026-11.xlsx' } })
    await exportReport(SAMPLE_MONTHLY_INPUT, 'xlsx', ctx.deps)
    expect(ctx.dialogOptions[0].defaultPath).toBe('月报2026-11.xlsx')
  })

  it('filePath 为空字符串的边界（视为取消）', async () => {
    const ctx = createContext({ result: { canceled: false, filePath: '' } })
    const result = await exportReport(SAMPLE_DAILY_INPUT, 'xlsx', ctx.deps)
    expect(result).toBeNull()
    expect(ctx.writes).toHaveLength(0)
  })
})

describe('export.service：取消路径（QA Scenario 3）', () => {
  it('用户取消 → 返回 null、零文件写入、不打开文件夹、不抛错', async () => {
    const ctx = createContext({ result: { canceled: true } })
    const result = await exportReport(SAMPLE_DAILY_INPUT, 'xlsx', ctx.deps)

    expect(result).toBeNull()
    expect(ctx.dialogOptions).toHaveLength(1)
    expect(ctx.writes).toHaveLength(0)
    expect(ctx.reveals).toHaveLength(0)
  })

  it('canceled 且带 filePath（Electron 边界形态）→ 仍视为取消', async () => {
    const ctx = createContext({ result: { canceled: true, filePath: SAVED_PATH } })
    const result = await exportReport(SAMPLE_DAILY_INPUT, 'xlsx', ctx.deps)
    expect(result).toBeNull()
    expect(ctx.writes).toHaveLength(0)
  })
})

describe('export.service：E2E_EXPORT_DIR 测试钩子（T18 E2E 消费）', () => {
  it('env 存在时：跳过 dialog 直写 ${E2E_EXPORT_DIR}/${文件名}，返回路径，不打开文件夹', async () => {
    vi.stubEnv('E2E_EXPORT_DIR', e2eDir)
    const ctx = createContext({ result: { canceled: true } })

    const result = await exportReport(SAMPLE_DAILY_INPUT, 'xlsx', ctx.deps)

    const expected = join(e2eDir, '日报2026-11-01.xlsx')
    expect(result).toBe(expected)
    expect(ctx.dialogOptions).toHaveLength(0)
    expect(ctx.writes).toHaveLength(1)
    expect(ctx.writes[0].path).toBe(expected)
    expect(ctx.writes[0].data.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]))).toBe(true)
    expect(ctx.reveals).toHaveLength(0)
  })

  it('env 未设置时：走 dialog 路径（钩子零影响）', async () => {
    delete process.env.E2E_EXPORT_DIR
    const ctx = createContext({ result: { canceled: false, filePath: SAVED_PATH } })
    const result = await exportReport(SAMPLE_DAILY_INPUT, 'xlsx', ctx.deps)
    expect(result).toBe(SAVED_PATH)
    expect(ctx.dialogOptions).toHaveLength(1)
    expect(ctx.writes).toHaveLength(1)
    expect(ctx.reveals).toHaveLength(1)
  })

  it('真实落盘：默认 writeFile（非注入）写入的文件 exceljs 可读回', async () => {
    vi.stubEnv('E2E_EXPORT_DIR', e2eDir)
    const result = await exportReport(SAMPLE_DAILY_INPUT, 'xlsx')
    expect(result).toBe(join(e2eDir, '日报2026-11-01.xlsx'))
    const { Workbook } = await import('exceljs')
    const { readFile } = await import('node:fs/promises')
    const wb = new Workbook()
    const onDisk = await readFile(result as string)
    await wb.xlsx.load(onDisk as unknown as ArrayBuffer)
    const summary = wb.getWorksheet('汇总')
    if (!summary) throw new Error('缺少汇总 sheet')
    expect(summary.getCell('B2').value).toBeCloseTo(123.45, 2)
  })
})
