## Task 7（已解决，留档）
- [已解决] TDD RED 阶段 serial 测试首轮运行时，SerialChannel 构造签名不匹配（测试传字符串、实现收 options 对象）→ 默认口 `\\.\COM1` 在 Linux cwd 静默生成 1 字节垃圾文件。修复：构造收 `string | SerialChannelOptions` 联合类型；垃圾文件已删除（`ls` 复核零残留）。教训入 learnings（串口通道跨平台陷阱）

## Task 4（待办，T12/T15 消费）
- [ ] **G7 契约缺口：ITEM_COLUMN_WIDTHS 上提 shared**——items 四列列宽（58mm 12/4/8/8、80mm 24/4/10/10）目前导出自 src/main/printing/escpos/escpos-generator.ts（主进程侧），T12 HTML 预览无法 import；**T12 落地前**应将常量（及其 name 行组合语义：先降级→truncate→pad）上提到 src/shared/receipt/（T4 按"记录缺口并适配"处理，未动 shared）
- [ ] **金额格式化函数共享**——SaleReceiptData/ReceiptVars 均为 display-ready 字符串（'12.00'），T15 组装、T12 预览、T18 报表导出都需要"整数分→元字符串"同一格式化函数；建议 Wave 2 前某任务统一上提（当前 T4 侧测试以字面量锁定格式样例）
