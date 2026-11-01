/**
 * preload 暴露给 renderer 的类型化 API surface 声明。
 * 后续任务将扩展为完整的 IpcChannels 映射（Task 3 契约层）。
 */
export interface PosApi {
  ping: () => string
}

declare global {
  interface Window {
    api: PosApi
  }
}
