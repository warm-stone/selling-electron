import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 主进程侧（services/repositories/generator/detector）纯 TS 测试为主
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts']
    }
  }
})
