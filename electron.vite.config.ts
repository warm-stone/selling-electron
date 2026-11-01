import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * electron-vite 6（rolldown 链，Vite 8）
 *
 * 注意：
 * - externalizeDepsPlugin 已于 v5 废弃；main/preload 依赖外部化默认开启（build.externalizeDeps）
 * - main/preload 输出 CJS（package.json 未设 "type": "module"，可使用 __dirname）
 */
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()]
  }
})
