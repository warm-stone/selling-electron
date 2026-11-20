import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getLogFilePath,
  initLogger,
  logError,
  logWarn
} from '../../../src/main/common/logger'
import { rmTempDirSync } from '../../helpers/cleanup'

/**
 * P2-3 极简文件日志单测：同步写（appendFileSync）、~1MB 轮转留 1 份备份
 * （测试注入小阈值驱动轮转分支）、fs 故障/未初始化静默降级不抛。
 */

let dir: string

afterEach(() => {
  if (dir) rmTempDirSync(dir)
  dir = ''
})

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'pos-logger-'))
  return dir
}

describe('logger（同步写 + 轮转 + 静默降级）', () => {
  it('initLogger 建目录；写入行含 ISO 时间戳/级别/scope/内容', () => {
    const logsDir = join(freshDir(), 'logs') // 不存在的子目录——initLogger 自建
    initLogger(logsDir)
    expect(getLogFilePath()).toBe(join(logsDir, 'main.log'))

    logWarn('test-scope', '中文告警内容')
    const content = readFileSync(join(logsDir, 'main.log'), 'utf8')
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[WARN\] test-scope: 中文告警内容\n$/)
  })

  it('logError 对 Error 记录 stack（崩溃现场取证）；非 Error 走 String', () => {
    initLogger(join(freshDir(), 'logs'))
    logError('uncaughtException', new Error('boom'))
    logError('unhandledRejection', 'plain-string-reason')

    const content = readFileSync(getLogFilePath()!, 'utf8')
    expect(content).toContain('[ERROR] uncaughtException: Error: boom')
    expect(content).toContain('at ') // stack 帧存在
    expect(content).toContain('[ERROR] unhandledRejection: plain-string-reason')
  })

  it('超过阈值轮转：main.log → main.log.1，仅保留 1 份备份（旧备份被覆盖）', () => {
    const logsDir = join(freshDir(), 'logs')
    initLogger(logsDir, 200) // 注入小阈值驱动轮转分支（生产默认 ~1MB）

    const line = 'x'.repeat(40)
    for (let i = 0; i < 12; i++) {
      logWarn('rotate', `${i}:${line}`)
    }

    const main = join(logsDir, 'main.log')
    const backup = join(logsDir, 'main.log.1')
    expect(existsSync(backup)).toBe(true)
    expect(statSync(main).size).toBeLessThan(400) // 轮转后主文件回落
    expect(existsSync(join(logsDir, 'main.log.2'))).toBe(false) // 只有 1 份备份
  })

  it('appendFileSync 同步落盘：write 调用返回后内容立即可读（崩溃不丢尾行的前提）', () => {
    initLogger(join(freshDir(), 'logs'))
    logWarn('sync', 'first')
    // 无任何 await/flush——同步写语义下此刻必须已在盘上
    expect(readFileSync(getLogFilePath()!, 'utf8')).toContain('first')
    logWarn('sync', 'second')
    expect(readFileSync(getLogFilePath()!, 'utf8')).toContain('second')
  })

  it('logsDir 不可建（指向已存在文件）→ 静默降级：initLogger/写入均不抛', () => {
    const d = freshDir()
    const filePath = join(d, 'not-a-dir')
    writeFileSync(filePath, 'occupied')

    expect(() => initLogger(filePath)).not.toThrow()
    expect(getLogFilePath()).toBeNull()
    expect(() => logError('scope', new Error('ignored'))).not.toThrow()
  })
})
