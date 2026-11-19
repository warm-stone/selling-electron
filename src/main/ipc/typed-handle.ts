/**
 * 契约类型化的 ipcMain.handle —— G8 主进程侧唯一装配入口。
 *
 * 为什么需要：裸 ipcMain.handle 的 listener 返回值不受通道契约约束，
 * service 实际返回与 shared/types/ipc.ts 的 IpcChannels 漂移在编译期
 * 无从发现（教训：sales:checkout 契约曾声明 res Sale 而 service 实际
 * 返回 SaleDetail；printing:preview 的 data/vars/logoUrls 长期靠
 * 「运行时结构超集」注释 + renderer 侧 cast 补差）。typedHandle 把
 * 「通道名 + req + res」全部钉在契约表上：通道名拼错、返回少字段/
 * 多字段、service 返回类型漂移——一律编译失败。
 *
 * ipcMain 由参数显式传入而非顶层 import electron：
 * - printing/settings/templates/reports-export 走懒 require（vitest 纯
 *   Node 环境可导入模块的纯函数部分——T2 模式）；
 * - diagnostics 走测试注入 fake（DiagnosticsIpcElectron）；
 * 本模块自身零 electron 运行时依赖（import type 编译期擦除），
 * IpcMainLike 为最小结构子集——真实 ipcMain 与各 fake 均满足。
 *
 * req 按契约 req 类型声明（void 通道归一为 undefined）。这是**编译期
 * 约定，不是运行时校验**：renderer 实际 payload 可能是脏数据，各
 * handler 既有的运行时防御（`req?.x ?? 哨兵` / parse* 纯函数）照旧保留。
 */
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcChannels } from '../../shared/types/ipc'

/**
 * ipcMain 的最小结构子集。方法语法（而非属性箭头语法）保持参数双变——
 * electron 真实例（listener 返回 void、rest args any[]）与测试 fake
 * （listener 返回 unknown）均可赋值，无需 cast。
 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, req: unknown) => unknown): void
}

/** 契约 req（void 通道归一为 undefined——listener 可声明零参） */
type ReqOf<K extends keyof IpcChannels> = IpcChannels[K]['req'] extends void
  ? undefined
  : IpcChannels[K]['req']

/**
 * 注册契约类型化 handler。
 * - channel：keyof IpcChannels（拼错通道名 = 编译失败）；
 * - listener：req 按契约 req 收窄（void 通道 → undefined），返回值被
 *   契约 res 钉死（同步或 Promise 均可）；第二参 event 仅供需要
 *   sender 的通道使用（如 settings:uploadLogo 的对话框父窗口定位）。
 */
export function typedHandle<K extends keyof IpcChannels>(
  ipcMain: IpcMainLike,
  channel: K,
  listener: (
    req: ReqOf<K>,
    event: IpcMainInvokeEvent
  ) => IpcChannels[K]['res'] | Promise<IpcChannels[K]['res']>
): void {
  ipcMain.handle(channel, (event, req) =>
    (listener as (r: unknown, e: unknown) => unknown)(req, event)
  )
}
