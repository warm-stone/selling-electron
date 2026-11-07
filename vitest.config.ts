import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 组件测试（tests/unit/components/**）需编译 .vue SFC；
  // 对纯 .ts 测试无副作用（插件仅处理 .vue 文件）
  plugins: [vue()],
  resolve: {
    alias: {
      // 与 electron.vite.config.ts renderer 侧 / tsconfig.web.json paths 同源
      // （组件 SFC 内 @renderer/* import 在 vitest 下同样要可解析）
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    // 主进程侧（services/repositories/generator/detector）纯 TS 测试为主；
    // 组件测试按文件级 docblock 切换 jsdom（// @vitest-environment jsdom）
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    server: {
      deps: {
        // element-plus 的 ESM 子模块（.mjs）默认走 Node 原生 import，其内部
        // `import AsyncValidator from 'async-validator'` 因 CJS interop 差异
        // 拿到 {__esModule, default} 对象而非构造器 → `new AsyncValidator()`
        // 同步抛 TypeError → el-form validate() 静默 resolve true（jsdom 实测）。
        // 生产无此问题（renderer 走 vite/rollup interop 尊重 __esModule）。
        // inline 让其经 vite 解析修复 interop，表单校验类组件测试才可运行。
        inline: ['element-plus']
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts']
    }
  }
})
