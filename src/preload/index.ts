import { contextBridge } from 'electron'

/**
 * 单一类型化 API surface（后续任务在此扩展 typed IPC，禁止散落裸 invoke）
 * Task 1 仅提供 ping 占位以验证 contextBridge 接线。
 */
const api = {
  ping: (): string => 'pong'
}

contextBridge.exposeInMainWorld('api', api)
