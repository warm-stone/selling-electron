import { describe, expect, it } from 'vitest'

/**
 * 脚手架冒烟测试：验证 vitest 接线（Task 1）。
 * 后续任务将以 tests/unit/<模块>/ 结构扩展真正的业务单测。
 */
describe('scaffold smoke', () => {
  it('vitest is wired up', () => {
    expect(1 + 1).toBe(2)
  })

  it('node environment is available for main-process tests', () => {
    expect(typeof process).toBe('object')
    expect(process.platform).toBeTruthy()
  })
})
