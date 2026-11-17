/**
 * ESC/POS 规范字节常量（打印子系统共用）。
 *
 * 为什么单独一个模块：`escpos-generator` 装配小票、`raw-probe` 装配编码探针，
 * 两边必须发**同一串字节**——探针的全部价值在于它复现生产链路，各写一份魔法字节
 * 就会悄悄漂移（探针测的东西与真机收到的东西不再是同一个）。
 *
 * 为什么一律按规范字节直发而不用库的语义方法：
 * - 库把部分十进制参数当十六进制拼装（见 GS_MAGNIFICATION_RESET）；
 * - `initHardware` 未暴露在 .d.ts；
 * - `cut()` 发的是 `1d 56 00`（立即切），任务契约要的是 `GS V 66 0`（走纸后全切）。
 */

/** `ESC @`（1b 40）：初始化，清除所有模式（含汉字模式、放大倍率、对齐） */
export const HW_INIT = Buffer.from([0x1b, 0x40])

/**
 * `FS &`（1c 26）：进入汉字模式（ESC/POS 标准汉字指令，官方 issue #75 验证方案）。
 * 国产打印机大多忽略 `ESC R 15`（国际字符集指令），只有 `FS &` 能让固件接受后续
 * GBK 双字节流；在 setCharacterSet(CHINA) 之后追加，与其发出的 `ESC R 15` 共存无害。
 */
export const FS_HANZI_MODE = Buffer.from([0x1c, 0x26])

/**
 * `FS .`（1c 2e）：退出汉字模式。探针在 GBK 段之后必须显式退出——否则后续字节
 * 仍被按双字节配对解析，光栅段的判读会被污染。
 */
export const FS_HANZI_MODE_OFF = Buffer.from([0x1c, 0x2e])

/**
 * `GS ! 0x00`（倍宽/倍高放大归一）。按规范字节直发的原因：
 * 库的 setTextSize 把十进制数字当十六进制拼装（(1,1)→0x11 = 2×2），
 * 语义错误，不能用于尺寸控制。
 */
export const GS_MAGNIFICATION_RESET = Buffer.from([0x1d, 0x21, 0x00])

/** `GS V 66 0`：走纸 0 单位后全切（任务契约的切纸字节序列；库 cut() 发 1d 56 00） */
export const FULL_CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00])

/**
 * `ESC d n`（1b 64 n）：打印并走纸 n 行，**不切纸**。
 * 探针用它在末尾留出撕纸余量：`GS V 66 0` 在没有切刀的机器上会被当文本打出乱字符，
 * 正好落在判读区里干扰结论。
 */
export function feedLines(n: number): Buffer {
  return Buffer.from([0x1b, 0x64, n])
}
