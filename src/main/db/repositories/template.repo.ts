import type Database from 'better-sqlite3'
import { PAPER_COLUMNS, type PaperWidth } from '../../../shared/receipt/char-grid'
import { DEFAULT_TEMPLATES } from '../../../shared/receipt/default-template'
import type {
  ItemsSection,
  ReceiptTemplate,
  Section,
  TotalLine
} from '../../../shared/receipt/template-schema'
import type { PrintTemplate } from '../../../shared/types'

/**
 * 打印模板 DAL（print_templates 表）。
 *
 * ★ 并行领地（Wave 3a）：**list / getDefault（惰性 seed）归 Task 15 所有**，
 * 本文件由 Task 16 先落盘 list（templates:list IPC 的数据源）+ CRUD；
 * T15 合并时在此追加 getDefault（表空时从 DEFAULT_TEMPLATES 出厂 seed），
 * Task 16 的 CRUD 方法对读取方法零依赖（测试用直插 SQL 构造数据）。
 *
 * Task 16 CRUD 语义：
 *  - create：校验合法 ReceiptTemplate（isValidReceiptTemplate 类型守卫）+
 *    JSON 序列化落 config_json；**首个模板自动 is_default=1**（表恒有默认的不变量起点）
 *  - update：name / template 局部更新；换模板时 paper_width 列同步
 *  - delete：**唯一模板不可删**（count>1 守卫抛错）；删默认模板时剩余最早一员晋升默认（事务）
 *  - setDefault：事务互斥切换（全表清零 + 目标置一）
 */

export type TemplateRepoErrorCode =
  | 'TEMPLATE_NOT_FOUND'
  | 'CANNOT_DELETE_LAST_TEMPLATE'
  | 'INVALID_TEMPLATE'
  | 'INVALID_NAME'

export class TemplateRepoError extends Error {
  readonly code: TemplateRepoErrorCode

  constructor(code: TemplateRepoErrorCode, message: string) {
    super(message)
    this.name = 'TemplateRepoError'
    this.code = code
  }
}

// ════════════════ ReceiptTemplate 类型守卫（config_json 落库前校验） ════════════════

const SECTION_TYPES: readonly unknown[] = ['text', 'image', 'divider']
const ALIGNS: readonly unknown[] = ['left', 'center', 'right']
const SIZES: readonly unknown[] = ['normal', 'doubleHeight', 'doubleWidth', 'quad']
const PAPER_WIDTHS: readonly unknown[] = ['58mm', '80mm']

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

function isOptionalAlign(v: unknown): boolean {
  return v === undefined || ALIGNS.includes(v)
}

function isOptionalSize(v: unknown): boolean {
  return v === undefined || SIZES.includes(v)
}

function isOptionalBold(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean'
}

function isValidSection(v: unknown): v is Section {
  if (!isPlainObject(v)) return false
  if (!SECTION_TYPES.includes(v['type'])) return false
  if (!isOptionalString(v['content'])) return false
  if (!isOptionalAlign(v['align'])) return false
  if (!isOptionalSize(v['size'])) return false
  if (!isOptionalBold(v['bold'])) return false
  // image 段落引用的 logo 行 id：存在时必须是 number
  if (v['logoId'] !== undefined && typeof v['logoId'] !== 'number') return false
  return true
}

function isValidTotalLine(v: unknown): v is TotalLine {
  if (!isPlainObject(v)) return false
  if (v['type'] !== 'total') return false
  if (typeof v['label'] !== 'string') return false
  if (!isOptionalAlign(v['align'])) return false
  if (!isOptionalSize(v['size'])) return false
  if (!isOptionalBold(v['bold'])) return false
  return true
}

/**
 * columnWidths 覆盖的严格校验（与 item-columns resolveColumnWidths 同规则）：
 * 存在时必须四键全为正整数且总和等于该模板 paperWidth 的 PAPER_COLUMNS
 * （需 paperWidth 参数——校验发生在 isValidReceiptTemplate 的模板整体语境）。
 */
function isValidColumnWidths(v: unknown, paperWidth: PaperWidth): boolean {
  if (!isPlainObject(v)) return false
  let sum = 0
  for (const key of ['name', 'qty', 'price', 'subtotal'] as const) {
    const w = v[key]
    if (typeof w !== 'number' || !Number.isInteger(w) || w <= 0) return false
    sum += w
  }
  return sum === PAPER_COLUMNS[paperWidth]
}

function isValidItemsSection(v: unknown, paperWidth: PaperWidth): v is ItemsSection {
  if (!isPlainObject(v)) return false
  if (v['type'] !== 'items') return false
  if (v['showHeader'] !== undefined && typeof v['showHeader'] !== 'boolean') return false
  for (const key of ['nameLabel', 'qtyLabel', 'priceLabel', 'subtotalLabel'] as const) {
    if (!isOptionalString(v[key])) return false
  }
  if (v['columnWidths'] !== undefined && !isValidColumnWidths(v['columnWidths'], paperWidth)) {
    return false
  }
  return true
}

/**
 * 未知值是否为合法 ReceiptTemplate（模板编辑器保存链路的落库守卫）。
 * 枚举值与 shared/receipt/template-schema 的联合类型逐字对应（消费 T3 契约，不改 schema）。
 */
export function isValidReceiptTemplate(v: unknown): v is ReceiptTemplate {
  if (!isPlainObject(v)) return false
  if (!PAPER_WIDTHS.includes(v['paperWidth'])) return false
  const paperWidth = v['paperWidth'] as PaperWidth
  if (!Array.isArray(v['header']) || !v['header'].every(isValidSection)) return false
  if (!isValidItemsSection(v['items'], paperWidth)) return false
  if (!Array.isArray(v['totals']) || !v['totals'].every(isValidTotalLine)) return false
  if (!Array.isArray(v['footer']) || !v['footer'].every(isValidSection)) return false
  if (typeof v['cutPaper'] !== 'boolean') return false
  return true
}

function validateName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TemplateRepoError('INVALID_NAME', '模板名称不能为空')
  }
  return raw.trim()
}

function assertValidTemplate(v: unknown): ReceiptTemplate {
  if (!isValidReceiptTemplate(v)) {
    throw new TemplateRepoError('INVALID_TEMPLATE', '模板内容不合法（不符合小票模板结构）')
  }
  return v
}

// ════════════════ DAL ════════════════

interface TemplateRow {
  id: number
  name: string
  paper_width: PaperWidth
  config_json: string
  is_default: number
  created_at: string
  updated_at: string
}

function rowToPrintTemplate(row: TemplateRow): PrintTemplate {
  return { ...row, is_default: row.is_default === 1 }
}

export interface CreateTemplateInput {
  name: string
  template: ReceiptTemplate
}

export interface UpdateTemplatePatch {
  name?: string
  template?: ReceiptTemplate
}

export function createTemplateRepo(db: Database.Database) {
  const stmtList = db.prepare('SELECT * FROM print_templates ORDER BY id ASC')
  const stmtGetById = db.prepare('SELECT * FROM print_templates WHERE id = ?')
  const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM print_templates')
  const stmtInsert = db.prepare(
    'INSERT INTO print_templates (name, paper_width, config_json, is_default) VALUES (?, ?, ?, ?)'
  )
  const stmtUpdateName = db.prepare(
    "UPDATE print_templates SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  )
  const stmtUpdateTemplate = db.prepare(
    "UPDATE print_templates SET paper_width = ?, config_json = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  )
  const stmtDelete = db.prepare('DELETE FROM print_templates WHERE id = ?')
  const stmtClearDefault = db.prepare('UPDATE print_templates SET is_default = 0')
  const stmtMarkDefault = db.prepare(
    "UPDATE print_templates SET is_default = 1, updated_at = datetime('now','localtime') WHERE id = ?"
  )
  const stmtFirstSurvivor = db.prepare(
    'SELECT id FROM print_templates ORDER BY id ASC LIMIT 1'
  )
  const stmtGetDefault = db.prepare(
    'SELECT * FROM print_templates WHERE is_default = 1 ORDER BY id ASC LIMIT 1'
  )

  /**
   * 惰性 seed（T15）：表内无默认模板时，把 shared DEFAULT_TEMPLATES 两行
   * （58mm + 80mm）出厂插入（**80mm 置默认**），返回新插入的 80mm 行。
   * 单事务：两行要么都插入要么都不插（不留半成品状态）。
   */
  const seedDefaults = db.transaction((): PrintTemplate => {
    stmtInsert.run('默认小票（58mm）', '58mm', JSON.stringify(DEFAULT_TEMPLATES['58mm']), 0)
    const info = stmtInsert.run(
      '默认小票（80mm）',
      '80mm',
      JSON.stringify(DEFAULT_TEMPLATES['80mm']),
      1
    )
    return rowToPrintTemplate(requireRow(Number(info.lastInsertRowid)))
  })

  const getByIdRaw = (id: number): TemplateRow | undefined =>
    stmtGetById.get(id) as TemplateRow | undefined

  const requireRow = (id: number): TemplateRow => {
    const row = getByIdRaw(id)
    if (row === undefined) {
      throw new TemplateRepoError('TEMPLATE_NOT_FOUND', '模板不存在（可能已被删除）')
    }
    return row
  }

  const count = (): number => (stmtCount.get() as { n: number }).n

  return {
    /** 模板全量列表（按创建序；IPC templates:list 数据源）。★ getDefault（惰性 seed）为 T15 待追加方法 */
    list(): PrintTemplate[] {
      return (stmtList.all() as TemplateRow[]).map(rowToPrintTemplate)
    },

    /**
     * 默认模板（Task 15）：查 is_default=1；无则惰性 seed DEFAULT_TEMPLATES
     * 两行并返回 80mm 行（打印编排 print.service 的唯一模板入口）。
     */
    getDefault(): PrintTemplate {
      const row = stmtGetDefault.get() as TemplateRow | undefined
      if (row) return rowToPrintTemplate(row)
      return seedDefaults()
    },

    /** 新建：校验 + 序列化 config_json；首个模板自动成为默认 */
    create(input: CreateTemplateInput): PrintTemplate {
      const name = validateName(input?.name)
      const template = assertValidTemplate(input?.template)
      const isDefault = count() === 0 ? 1 : 0
      const info = stmtInsert.run(name, template.paperWidth, JSON.stringify(template), isDefault)
      return rowToPrintTemplate(requireRow(Number(info.lastInsertRowid)))
    },

    /** 局部更新：name 与 template 可独立传入；换模板时 paper_width 列同步 */
    update(id: number, patch: UpdateTemplatePatch): PrintTemplate {
      requireRow(id)
      if (patch?.name !== undefined) {
        stmtUpdateName.run(validateName(patch.name), id)
      }
      if (patch?.template !== undefined) {
        const template = assertValidTemplate(patch.template)
        stmtUpdateTemplate.run(template.paperWidth, JSON.stringify(template), id)
      }
      return rowToPrintTemplate(requireRow(id))
    },

    /** 删除：唯一模板不可删（守卫）；删默认模板时剩余最早一员晋升默认（单事务） */
    delete(id: number): void {
      db.transaction(() => {
        const row = requireRow(id)
        if (count() <= 1) {
          throw new TemplateRepoError(
            'CANNOT_DELETE_LAST_TEMPLATE',
            '至少保留一个小票模板，不能删除最后一个模板'
          )
        }
        stmtDelete.run(id)
        if (row.is_default === 1) {
          const survivor = stmtFirstSurvivor.get() as { id: number } | undefined
          if (survivor) stmtMarkDefault.run(survivor.id)
        }
      })()
    },

    /** 设为默认：事务互斥切换（全表清零 → 目标置一；恒恰好一个 is_default=1） */
    setDefault(id: number): PrintTemplate {
      db.transaction(() => {
        requireRow(id)
        stmtClearDefault.run()
        stmtMarkDefault.run(id)
      })()
      return rowToPrintTemplate(requireRow(id))
    }
  }
}

export type TemplateRepo = ReturnType<typeof createTemplateRepo>
