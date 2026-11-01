## Task 7（已解决，留档）
- [已解决] TDD RED 阶段 serial 测试首轮运行时，SerialChannel 构造签名不匹配（测试传字符串、实现收 options 对象）→ 默认口 `\\.\COM1` 在 Linux cwd 静默生成 1 字节垃圾文件。修复：构造收 `string | SerialChannelOptions` 联合类型；垃圾文件已删除（`ls` 复核零残留）。教训入 learnings（串口通道跨平台陷阱）
