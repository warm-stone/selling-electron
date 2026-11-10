import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * electron-vite 6（rolldown 链，Vite 8）
 *
 * 注意：
 * - externalizeDepsPlugin 已于 v5 废弃；main/preload 依赖外部化默认开启（build.externalizeDeps）
 * - main/preload 输出 CJS（package.json 未设 "type": "module"，可使用 __dirname）
 * - __dirname 由 electron-vite 注入为 config 文件所在目录（项目根），可安全用于读取 package.json
 */
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()]
  }
})
