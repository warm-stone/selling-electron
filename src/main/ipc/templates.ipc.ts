import type Database from 'better-sqlite3'
import type { PaperWidth } from '../../shared/receipt/char-grid'
import type { ReceiptTemplate } from '../../shared/receipt/template-schema'
import { createTemplateRepo, type UpdateTemplatePatch } from '../db/repositories/template.repo'

/**
 * 模板 IPC 薄层（Task 16）。
 *
 * 通道：templates:list / create / update / delete / setDefault（T3 契约五通道）。
 * 结构与 settings.ipc.ts 同款：请求解析抽纯函数（零 Electron 依赖），
 * registerTemplatesIpc(db) 内 `require('electron')` 懒加载——本模块可被
 * vitest 纯 Node 环境导入。
 *
 * 深层校验（合法 ReceiptTemplate / 非空名称）由 repo 层承担
 * （create/update 落库守卫，见 template.repo.ts）；本层只做结构解析：
 * config_json JSON.parse + 纸宽一致性。解析产物 cast 到 ReceiptTemplate
 * 是边界惯例——运行时合法性由 repo 的类型守卫兜底。
 */

export function parseTemplatesCreateRequest(req: unknown): {
  name: string
  paperWidth: PaperWidth
  template: ReceiptTemplate
} {
  const r = (req ?? {}) as Record<string, unknown>
  if (typeof r['name'] !== 'string') {
    throw new Error('模板名称必须是字符串')
  }
  const paperWidth = r['paper_width']
  if (paperWidth !== '58mm' && paperWidth !== '80mm') {
    throw new Error('纸宽必须是 58mm 或 80mm')
  }
  if (typeof r['config_json'] !== 'string') {
    throw new Error('模板内容（config_json）必须是 JSON 字符串')
  }
  let template: unknown
  try {
    template = JSON.parse(r['config_json'])
  } catch {
    throw new Error('模板内容不是合法 JSON')
  }
  if (typeof template !== 'object' || template === null) {
    throw new Error('模板内容必须是 JSON 对象')
  }
  if ((template as Record<string, unknown>)['paperWidth'] !== paperWidth) {
    throw new Error('纸宽与模板内容不一致')
  }
  return { name: r['name'], paperWidth, template: template as ReceiptTemplate }
}

export function parseTemplatesUpdateRequest(req: unknown): {
  id: number
  patch: UpdateTemplatePatch
} {
  const r = (req ?? {}) as Record<string, unknown>
  if (!Number.isInteger(r['id']) || (r['id'] as number) <= 0) {
    throw new Error('模板 id 必须是正整数')
  }
  const patch: UpdateTemplatePatch = {}
  if (r['name'] !== undefined) {
    if (typeof r['name'] !== 'string') throw new Error('模板名称必须是字符串')
    patch.name = r['name']
  }
  if (r['config_json'] !== undefined) {
    if (typeof r['config_json'] !== 'string') {
      throw new Error('模板内容（config_json）必须是 JSON 字符串')
    }
    let template: unknown
    try {
      template = JSON.parse(r['config_json'])
    } catch {
      throw new Error('模板内容不是合法 JSON')
    }
    if (typeof template !== 'object' || template === null) {
      throw new Error('模板内容必须是 JSON 对象')
    }
    patch.template = template as ReceiptTemplate
  }
  return { id: r['id'] as number, patch }
}

export function parseTemplateIdRequest(req: unknown): number {
  const id = (req as Record<string, unknown> | null | undefined)?.['id']
  if (!Number.isInteger(id) || (id as number) <= 0) {
    throw new Error('模板 id 必须是正整数')
  }
  return id as number
}

export function registerTemplatesIpc(db: Database.Database): void {
  // 懒 require（T2/settings.ipc 同款模式）：纯解析函数可在 vitest 纯 Node 环境导入
  const { ipcMain } = require('electron') as typeof import('electron')
  const repo = createTemplateRepo(db)

  ipcMain.handle('templates:list', () => repo.list())

  ipcMain.handle('templates:create', (_event, req: unknown) => {
    const { name, template } = parseTemplatesCreateRequest(req)
    return repo.create({ name, template })
  })

  ipcMain.handle('templates:update', (_event, req: unknown) => {
    const { id, patch } = parseTemplatesUpdateRequest(req)
    return repo.update(id, patch)
  })

  ipcMain.handle('templates:delete', (_event, req: unknown) => {
    repo.delete(parseTemplateIdRequest(req))
    return { ok: true } as const
  })

  ipcMain.handle('templates:setDefault', (_event, req: unknown) => {
    return repo.setDefault(parseTemplateIdRequest(req))
  })
}
