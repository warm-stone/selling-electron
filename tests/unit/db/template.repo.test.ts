import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../../src/main/db/migrator'
import {
  createTemplateRepo,
  TemplateRepoError,
  isValidReceiptTemplate
} from '../../../src/main/db/repositories/template.repo'
import { DEFAULT_TEMPLATES } from '../../../src/shared/receipt/default-template'
import type { ReceiptTemplate } from '../../../src/shared/receipt/template-schema'
import { rmTempDirSync } from '../../helpers/cleanup'

let dir: string

/** 本文件打开的连接登记（Windows 不可删打开中的文件：afterEach 先逐一 close 再删目录） */
const openDbs: Database.Database[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-template-repo-'))
})

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
  rmTempDirSync(dir)
})

function freshDb(): Database.Database {
  const db = new Database(join(dir, 'pos.db'))
  openDbs.push(db)
  migrate(db)
  return db
}

/** 深拷贝默认模板（测试各自改写互不污染） */
function cloneTemplate(width: '58mm' | '80mm' = '80mm'): ReceiptTemplate {
  return JSON.parse(JSON.stringify(DEFAULT_TEMPLATES[width])) as ReceiptTemplate
}

/** 直插一行模板（绕过 repo.create——用 SQL 断言 repo 行为，读取方法语义独立于被测 CRUD） */
function seedRow(
  db: Database.Database,
  name: string,
  paperWidth: '58mm' | '80mm',
  isDefault: number
): number {
  const info = db
    .prepare(
      'INSERT INTO print_templates (name, paper_width, config_json, is_default) VALUES (?, ?, ?, ?)'
    )
    .run(name, paperWidth, JSON.stringify(cloneTemplate(paperWidth)), isDefault)
  return Number(info.lastInsertRowid)
}

/** DB 权威读：恰好一个默认的行数 + 默认行 id */
function defaultRows(db: Database.Database): { count: number; ids: number[] } {
  const rows = db
    .prepare('SELECT id FROM print_templates WHERE is_default = 1')
    .all() as Array<{ id: number }>
  return { count: rows.length, ids: rows.map((r) => r.id) }
}

function rowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM print_templates').get() as { n: number }).n
}

function isCode(err: unknown, code: string): boolean {
  return err instanceof TemplateRepoError && err.code === code
}

describe('template.repo：isValidReceiptTemplate 类型守卫（config_json 落库前校验）', () => {
  it('合法模板（DEFAULT_TEMPLATES 两纸宽变体）通过', () => {
    expect(isValidReceiptTemplate(DEFAULT_TEMPLATES['80mm'])).toBe(true)
    expect(isValidReceiptTemplate(DEFAULT_TEMPLATES['58mm'])).toBe(true)
  })

  it('非法 paperWidth / 段落非数组 / section type 非法 / totals label 缺失 / cutPaper 非布尔 拒绝', () => {
    const bad1 = cloneTemplate()
    ;(bad1 as unknown as Record<string, unknown>)['paperWidth'] = '210mm'
    expect(isValidReceiptTemplate(bad1)).toBe(false)

    const bad2 = cloneTemplate()
    ;(bad2 as unknown as Record<string, unknown>)['header'] = '不是数组'
    expect(isValidReceiptTemplate(bad2)).toBe(false)

    const bad3 = cloneTemplate()
    bad3.header.push({ type: 'sound' } as never)
    expect(isValidReceiptTemplate(bad3)).toBe(false)

    const bad4 = cloneTemplate()
    ;(bad4 as unknown as Record<string, unknown>)['totals'] = [{ type: 'total', align: 'right' }]
    expect(isValidReceiptTemplate(bad4)).toBe(false)

    const bad5 = cloneTemplate()
    ;(bad5 as unknown as Record<string, unknown>)['cutPaper'] = 'yes'
    expect(isValidReceiptTemplate(bad5)).toBe(false)

    expect(isValidReceiptTemplate(null)).toBe(false)
    expect(isValidReceiptTemplate('json 字符串')).toBe(false)
  })
})

describe('template.repo create：config_json 序列化 + 校验 + 首个模板自动默认', () => {
  it('序列化 round-trip：config_json 可解析回等值模板；paper_width 列随模板；首个模板 is_default=1', () => {
    const repo = createTemplateRepo(freshDb())
    const created = repo.create({ name: '门店小票', template: cloneTemplate('80mm') })

    expect(created.id).toBeGreaterThan(0)
    expect(created.name).toBe('门店小票')
    expect(created.paper_width).toBe('80mm')
    expect(created.is_default).toBe(true)
    // round-trip：序列化无字段丢失
    expect(JSON.parse(created.config_json)).toEqual(DEFAULT_TEMPLATES['80mm'])
  })

  it('第二个模板 is_default=0（默认唯一由 setDefault 切换，create 不抢占）', () => {
    const repo = createTemplateRepo(freshDb())
    repo.create({ name: '第一个', template: cloneTemplate() })
    const second = repo.create({ name: '第二个', template: cloneTemplate('58mm') })

    expect(second.is_default).toBe(false)
    expect(second.paper_width).toBe('58mm')
  })

  it('名称空/空白/非字符串抛 INVALID_NAME，零写库', () => {
    const db = freshDb()
    const repo = createTemplateRepo(db)

    expect(() => repo.create({ name: '', template: cloneTemplate() })).toThrowError(TemplateRepoError)
    expect(() => repo.create({ name: '   ', template: cloneTemplate() })).toThrowError(/名称/)
    expect(() =>
      (repo as unknown as { create: (i: { name: number }) => unknown }).create({ name: 42 })
    ).toThrowError(TemplateRepoError)
    expect(rowCount(db)).toBe(0)
  })

  it('非法 ReceiptTemplate 抛 INVALID_TEMPLATE 且零写库（矩阵：非法 paperWidth/段落结构/totals）', () => {
    const db = freshDb()
    const repo = createTemplateRepo(db)

    const cases: Array<ReceiptTemplate> = []
    const badPaper = cloneTemplate()
    ;(badPaper as unknown as Record<string, unknown>)['paperWidth'] = '210mm'
    cases.push(badPaper)
    const badSection = cloneTemplate()
    badSection.header.push({ type: 'sound' } as never)
    cases.push(badSection)
    const badTotals = cloneTemplate()
    ;(badTotals as unknown as Record<string, unknown>)['totals'] = [
      { type: 'total', label: 123 as never }
    ]
    cases.push(badTotals)

    for (const bad of cases) {
      try {
        repo.create({ name: '坏模板', template: bad })
        expect.unreachable('非法模板应抛错')
      } catch (err) {
        expect(isCode(err, 'INVALID_TEMPLATE')).toBe(true)
      }
    }
    expect(rowCount(db)).toBe(0)
  })
})

describe('template.repo update：局部更新 + 纸宽列同步', () => {
  it('仅改名：config_json 原样、paper_width 原样', () => {
    const db = freshDb()
    const id = seedRow(db, '旧名', '80mm', 1)
    const before = (
      db.prepare('SELECT config_json FROM print_templates WHERE id = ?').get(id) as {
        config_json: string
      }
    ).config_json

    const repo = createTemplateRepo(db)
    const updated = repo.update(id, { name: '新名' })

    expect(updated.name).toBe('新名')
    const after = (
      db.prepare('SELECT config_json, paper_width FROM print_templates WHERE id = ?').get(id) as {
        config_json: string
        paper_width: string
      }
    )
    expect(after.config_json).toBe(before)
    expect(after.paper_width).toBe('80mm')
  })

  it('换模板：config_json 替换 + paper_width 列同步（80mm→58mm）', () => {
    const db = freshDb()
    const id = seedRow(db, '换模板', '80mm', 1)
    const repo = createTemplateRepo(db)

    const updated = repo.update(id, { template: cloneTemplate('58mm') })

    expect(JSON.parse(updated.config_json)).toEqual(DEFAULT_TEMPLATES['58mm'])
    expect(updated.paper_width).toBe('58mm')
  })

  it('名称校验同样生效（空名抛 INVALID_NAME，DB 原值）', () => {
    const db = freshDb()
    const id = seedRow(db, '原名', '80mm', 1)
    const repo = createTemplateRepo(db)

    expect(() => repo.update(id, { name: '  ' })).toThrowError(TemplateRepoError)
    expect(
      (db.prepare('SELECT name FROM print_templates WHERE id = ?').get(id) as { name: string }).name
    ).toBe('原名')
  })

  it('非法模板抛 INVALID_TEMPLATE，config_json 保持原值', () => {
    const db = freshDb()
    const id = seedRow(db, '好模板', '80mm', 1)
    const repo = createTemplateRepo(db)
    const bad = cloneTemplate()
    ;(bad as unknown as Record<string, unknown>)['header'] = null

    try {
      repo.update(id, { template: bad })
      expect.unreachable()
    } catch (err) {
      expect(isCode(err, 'INVALID_TEMPLATE')).toBe(true)
    }
    const row = db.prepare('SELECT config_json FROM print_templates WHERE id = ?').get(id) as {
      config_json: string
    }
    expect(JSON.parse(row.config_json)).toEqual(DEFAULT_TEMPLATES['80mm'])
  })

  it('不存在的 id 抛 TEMPLATE_NOT_FOUND', () => {
    const db = freshDb()
    seedRow(db, '唯一的', '80mm', 1)
    const repo = createTemplateRepo(db)

    expect(() => repo.update(999, { name: '谁' })).toThrowError(/不存在/)
  })
})

describe('template.repo delete：唯一模板守卫（双保险的 repo 侧）', () => {
  it('唯一模板不可删：抛 CANNOT_DELETE_LAST_TEMPLATE，行仍在', () => {
    const db = freshDb()
    const id = seedRow(db, '最后一个', '80mm', 1)
    const repo = createTemplateRepo(db)

    try {
      repo.delete(id)
      expect.unreachable('唯一模板删除应抛错')
    } catch (err) {
      expect(isCode(err, 'CANNOT_DELETE_LAST_TEMPLATE')).toBe(true)
    }
    expect(rowCount(db)).toBe(1)
  })

  it('多模板时删除正常：目标行消失、其余保留', () => {
    const db = freshDb()
    const a = seedRow(db, 'A', '80mm', 1)
    const b = seedRow(db, 'B', '58mm', 0)
    const repo = createTemplateRepo(db)

    repo.delete(b)

    expect(rowCount(db)).toBe(1)
    expect(
      (db.prepare('SELECT id FROM print_templates').get() as { id: number }).id
    ).toBe(a)
  })

  it('删除默认模板：剩余模板晋升默认（事务内保持恰好一个 is_default=1）', () => {
    const db = freshDb()
    const a = seedRow(db, 'A 默认', '80mm', 1)
    const b = seedRow(db, 'B 普通', '58mm', 0)
    const repo = createTemplateRepo(db)

    repo.delete(a)

    const d = defaultRows(db)
    expect(d.count).toBe(1)
    expect(d.ids).toEqual([b])
  })

  it('不存在的 id 抛 TEMPLATE_NOT_FOUND', () => {
    const db = freshDb()
    seedRow(db, '唯一的', '80mm', 1)
    const repo = createTemplateRepo(db)

    expect(() => repo.delete(999)).toThrowError(/不存在/)
    expect(rowCount(db)).toBe(1)
  })
})

describe('template.repo setDefault：事务互斥切换（只能一个 is_default=1）', () => {
  it('三个模板切换默认：恰好一个默认 = 新 id，旧默认归 0', () => {
    const db = freshDb()
    const a = seedRow(db, 'A', '80mm', 1)
    const b = seedRow(db, 'B', '58mm', 0)
    const c = seedRow(db, 'C', '80mm', 0)
    const repo = createTemplateRepo(db)

    const result = repo.setDefault(b)

    expect(result.id).toBe(b)
    expect(result.is_default).toBe(true)
    const d = defaultRows(db)
    expect(d.count).toBe(1)
    expect(d.ids).toEqual([b])
    // 其余两者均非默认
    const rows = db
      .prepare('SELECT id, is_default FROM print_templates ORDER BY id')
      .all() as Array<{ id: number; is_default: number }>
    expect(rows).toEqual([
      { id: a, is_default: 0 },
      { id: b, is_default: 1 },
      { id: c, is_default: 0 }
    ])
  })

  it('重复 setDefault 同一模板幂等：仍恰好一个默认', () => {
    const db = freshDb()
    const a = seedRow(db, 'A', '80mm', 1)
    seedRow(db, 'B', '58mm', 0)
    const repo = createTemplateRepo(db)

    repo.setDefault(a)
    repo.setDefault(a)

    expect(defaultRows(db)).toEqual({ count: 1, ids: [a] })
  })

  it('不存在的 id 抛 TEMPLATE_NOT_FOUND，默认状态无变化（事务回滚）', () => {
    const db = freshDb()
    const a = seedRow(db, 'A', '80mm', 1)
    const repo = createTemplateRepo(db)

    expect(() => repo.setDefault(999)).toThrowError(/不存在/)
    expect(defaultRows(db)).toEqual({ count: 1, ids: [a] })
  })
})

describe('template.repo list：行映射（IPC templates:list 数据源）', () => {
  it('is_default number→boolean 映射、按 id 升序、config_json 原样携带', () => {
    const db = freshDb()
    seedRow(db, 'A', '80mm', 1)
    seedRow(db, 'B', '58mm', 0)
    const repo = createTemplateRepo(db)

    const list = repo.list()

    expect(list).toHaveLength(2)
    expect(list[0]?.name).toBe('A')
    expect(list[0]?.is_default).toBe(true)
    expect(list[1]?.is_default).toBe(false)
    expect(JSON.parse(list[1]?.config_json ?? '')).toEqual(DEFAULT_TEMPLATES['58mm'])
  })

  it('空表返回 []（惰性 seed 是 T15 读取方法职责，list 保持纯 SELECT）', () => {
    const repo = createTemplateRepo(freshDb())
    expect(repo.list()).toEqual([])
  })
})

describe('template.repo getDefault（Task 15：惰性 seed 读取方法）', () => {
  it('空表首调：插入 DEFAULT_TEMPLATES 两行（80mm 置默认），返回 80mm 行且 config_json round-trip', () => {
    const db = freshDb()
    const repo = createTemplateRepo(db)

    const got = repo.getDefault()

    expect(got.paper_width).toBe('80mm')
    expect(got.is_default).toBe(true)
    expect(JSON.parse(got.config_json)).toEqual(DEFAULT_TEMPLATES['80mm'])
    // 两行出厂：58mm 陪跑（is_default=0）+ 80mm 默认
    expect(rowCount(db)).toBe(2)
    const rows = db
      .prepare('SELECT paper_width, is_default FROM print_templates ORDER BY id')
      .all() as Array<{ paper_width: string; is_default: number }>
    expect(rows).toEqual([
      { paper_width: '58mm', is_default: 0 },
      { paper_width: '80mm', is_default: 1 }
    ])
    // 58mm 行的 config_json 同为完整默认模板
    const row58 = db
      .prepare("SELECT config_json FROM print_templates WHERE paper_width = '58mm'")
      .get() as { config_json: string }
    expect(JSON.parse(row58.config_json)).toEqual(DEFAULT_TEMPLATES['58mm'])
  })

  it('二次调用幂等：直接命中已 seed 行，不再重复插入', () => {
    const db = freshDb()
    const repo = createTemplateRepo(db)

    const first = repo.getDefault()
    const second = repo.getDefault()

    expect(second.id).toBe(first.id)
    expect(second.paper_width).toBe('80mm')
    expect(rowCount(db)).toBe(2)
  })

  it('已有默认行：原样返回，不触发 seed（表行数不变）', () => {
    const db = freshDb()
    const id = seedRow(db, '编辑器建的', '80mm', 1)
    const repo = createTemplateRepo(db)

    const got = repo.getDefault()

    expect(got.id).toBe(id)
    expect(got.name).toBe('编辑器建的')
    expect(rowCount(db)).toBe(1)
  })

  it('有模板但全无默认（is_default 全 0）：仍走 seed 路径补默认', () => {
    const db = freshDb()
    seedRow(db, '无默认 A', '80mm', 0)
    seedRow(db, '无默认 B', '58mm', 0)
    const repo = createTemplateRepo(db)

    const got = repo.getDefault()

    expect(got.is_default).toBe(true)
    expect(got.paper_width).toBe('80mm')
    expect(rowCount(db)).toBe(4)
    const d = defaultRows(db)
    expect(d.count).toBe(1)
    expect(d.ids).toEqual([got.id])
  })
})
