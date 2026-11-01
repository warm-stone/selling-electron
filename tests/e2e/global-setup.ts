import { execSync } from 'node:child_process'

/**
 * E2E 启动方案（Task 6 决策）：驱动构建产物而非 dev server
 * - _electron.launch({ args: ['.'] }) 走 package.json main → out/main/index.js
 * - dev server 方案需要先起 electron-vite dev 再等 HMR 就绪，链路长且时序不稳；
 *   build 产物确定性强，CI（windows-latest）与本地行为一致
 * - 注意：package.json 的 postinstall（install-electron）保证 Electron 二进制就绪
 */
export default function globalSetup(): void {
  execSync('npm run build', { stdio: 'inherit' })
}
