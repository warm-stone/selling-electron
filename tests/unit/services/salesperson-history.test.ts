import { describe, expect, it } from 'vitest'

import {
  RECENT_SALESPERSONS_LIMIT,
  parseRecentSalespersons,
  pushRecentSalesperson,
} from '../../../src/main/services/salesperson-history'

describe('salesperson-history 常量', () => {
  it('上限定死为 10，key 为 settings KV 约定值', () => {
    expect(RECENT_SALESPERSONS_LIMIT).toBe(10)
  })
})

describe('parseRecentSalespersons 解析容错', () => {
  it('null → []', () => {
    expect(parseRecentSalespersons(null)).toEqual([])
  })

  it('损坏 JSON → []', () => {
    expect(parseRecentSalespersons('{"broken":')).toEqual([])
  })

  it('非数组 JSON → []', () => {
    expect(parseRecentSalespersons('{"name":"张三"}')).toEqual([])
    expect(parseRecentSalespersons('"张三"')).toEqual([])
    expect(parseRecentSalespersons('42')).toEqual([])
  })

  it('数组逐项 String 化 → trim → 过滤空串', () => {
    expect(parseRecentSalespersons('["a","","  "]')).toEqual(['a'])
    expect(parseRecentSalespersons('[1, null, " b "]')).toEqual(['1', 'null', 'b'])
  })

  it('合法数组原样复原（含中文名与前后空白）', () => {
    expect(parseRecentSalespersons('[" 张三 ","李四"]')).toEqual(['张三', '李四'])
  })
})

describe('pushRecentSalesperson 去重置顶入队', () => {
  it('11 个不同名字依次 push → 长度 10，最早入队者被逐出，最新在队首', () => {
    let list: string[] = []
    for (let i = 1; i <= 11; i++) list = pushRecentSalesperson(list, `销售${i}`)
    expect(list).toHaveLength(10)
    expect(list[0]).toBe('销售11')
    expect(list).not.toContain('销售1')
    expect(list[9]).toBe('销售2')
  })

  it('重复名字 push → 置顶且不重复（["a","b","c"] push "b" → ["b","a","c"]）', () => {
    expect(pushRecentSalesperson(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })

  it('push 空串/纯空白 → 列表不变（返回副本）', () => {
    const original = ['a', 'b']
    const result = pushRecentSalesperson(original, '   ')
    expect(result).toEqual(['a', 'b'])
    expect(result).not.toBe(original)
    expect(pushRecentSalesperson(original, '')).toEqual(original)
  })

  it('name 先 trim 再入队，前后空白不产生重复项', () => {
    expect(pushRecentSalesperson(['张三', '李四'], '  张三  ')).toEqual(['张三', '李四'])
    expect(pushRecentSalesperson([], ' 王五 ')).toEqual(['王五'])
  })

  it('返回新数组，不修改入参（不可变风格）', () => {
    const original = ['a', 'b', 'c']
    pushRecentSalesperson(original, 'a')
    expect(original).toEqual(['a', 'b', 'c'])
  })
})
