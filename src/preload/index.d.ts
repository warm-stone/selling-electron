/**
 * window.api 全局类型声明（renderer 侧消费）。
 *
 * 类型真源 = shared/types/ipc.ts 的 PosApi（从 IpcChannels 契约派生）；
 * preload/index.ts 以 `const api: PosApi` 实现同一接口——本文件仅做
 * Window 全局挂载声明，零手写方法签名（旧版 190 行手写镜像已废除，
 * 杜绝「契约 / 实现 / 声明」三方漂移）。
 */
import type { PosApi } from '../shared/types/ipc'

declare global {
  interface Window {
    api: PosApi
  }
}
