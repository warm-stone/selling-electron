import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 组件测试（tests/unit/components/**）需编译 .vue SFC；
  // 对纯 .ts 测试无副作用（插件仅处理 .vue 文件）
  plugins: [vue()],
  test: {
    // 主进程侧（services/repositories/generator/detector）纯 TS 测试为主；
    // 组件测试按文件级 docblock 切换 jsdom（// @vitest-environment jsdom）
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
