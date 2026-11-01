import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ExportFormat, ReportExportInput } from './export.types'
import { exportDocx } from './docx.exporter'
import { exportTxt } from './txt.exporter'
import { exportXlsx } from './xlsx.exporter'

/**
 * 导出编排服务：exporter 产物 Buffer → showSaveDialog → 写文件 → 打开所在文件夹。
 *
 * 分层约束：dialog/shell 只出现在本层（exporter 纯函数零 UI）；
 * electron 通过懒加载 require 引入 + 依赖注入（deps），vitest 纯 Node 环境零依赖可测
 * （注入或 E2E 钩子路径下懒加载分支不执行）。
 */

/** Electron dialog.showSaveDialog 的最小结构面（DI 友好——测试 stub 免依赖 electron） */
export interface SaveDialogOptionsLike {
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface SaveDialogResultLike {
  canceled: boolean
  filePath?: string
}

export interface ExportDeps {
  showSaveDialog?: (options: SaveDialogOptionsLike) => Promise<SaveDialogResultLike>
  writeFile?: (path: string, data: Buffer) => Promise<void>
  revealInFolder?: (path: string) => void
}

const EXTENSIONS: Record<ExportFormat, string> = { txt: 'txt', xlsx: 'xlsx', docx: 'docx' }
const FILTER_NAMES: Record<ExportFormat, string> = {
  txt: '文本文件',
  xlsx: 'Excel 工作簿',
  docx: 'Word 文档'
}

export function buildExportFileName(input: ReportExportInput, format: ExportFormat): string {
  const prefix = input.kind === 'daily' ? '日报' : '月报'
  return `${prefix}${input.period}.${EXTENSIONS[format]}`
}

async function renderBuffer(input: ReportExportInput, format: ExportFormat): Promise<Buffer> {
  switch (format) {
    case 'txt':
      return exportTxt(input)
    case 'xlsx':
      return exportXlsx(input)
    case 'docx':
      return exportDocx(input)
  }
}

async function defaultWriteFile(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await fsWriteFile(path, data)
}

function defaultShowSaveDialog(options: SaveDialogOptionsLike): Promise<SaveDialogResultLike> {
  // 懒加载 electron：vitest 纯 Node 环境下（deps 注入 / E2E 钩子路径）本函数不被调用
  const electron = require('electron') as {
    dialog: { showSaveDialog(o: SaveDialogOptionsLike): Promise<SaveDialogResultLike> }
  }
  return electron.dialog.showSaveDialog(options)
}

function defaultRevealInFolder(path: string): void {
  const electron = require('electron') as {
    shell: { showItemInFolder(p: string): void }
  }
  electron.shell.showItemInFolder(path)
}

export async function exportReport(
  input: ReportExportInput,
  format: ExportFormat,
  deps: ExportDeps = {}
): Promise<string | null> {
  const buffer = await renderBuffer(input, format)
  const fileName = buildExportFileName(input, format)

  // ★ E2E 测试钩子（Task 17 QA Scenario 2 / Task 18 E2E 消费）：
  // E2E_EXPORT_DIR 存在时跳过 dialog，直写 ${E2E_EXPORT_DIR}/${文件名} 并返回路径
  // （不打开文件夹——CI 上不弹资源管理器）。正常 dev/生产不注入该变量，零影响。
  const e2eDir = process.env['E2E_EXPORT_DIR']
  if (e2eDir) {
    const target = join(e2eDir, fileName)
    await (deps.writeFile ?? defaultWriteFile)(target, buffer)
    return target
  }

  const result = await (deps.showSaveDialog ?? defaultShowSaveDialog)({
    defaultPath: fileName,
    filters: [{ name: FILTER_NAMES[format], extensions: [EXTENSIONS[format]] }]
  })
  if (result.canceled || !result.filePath) return null

  await (deps.writeFile ?? defaultWriteFile)(result.filePath, buffer)
  ;(deps.revealInFolder ?? defaultRevealInFolder)(result.filePath)
  return result.filePath
}
