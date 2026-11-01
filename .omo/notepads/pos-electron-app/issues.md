## Task 7（已解决，留档）
- [已解决] TDD RED 阶段 serial 测试首轮运行时，SerialChannel 构造签名不匹配（测试传字符串、实现收 options 对象）→ 默认口 `\\.\COM1` 在 Linux cwd 静默生成 1 字节垃圾文件。修复：构造收 `string | SerialChannelOptions` 联合类型；垃圾文件已删除（`ls` 复核零残留）。教训入 learnings（串口通道跨平台陷阱）

## Task 4（待办，T12/T15 消费）
- [ ] **G7 契约缺口：ITEM_COLUMN_WIDTHS 上提 shared**——items 四列列宽（58mm 12/4/8/8、80mm 24/4/10/10）目前导出自 src/main/printing/escpos/escpos-generator.ts（主进程侧），T12 HTML 预览无法 import；**T12 落地前**应将常量（及其 name 行组合语义：先降级→truncate→pad）上提到 src/shared/receipt/（T4 按"记录缺口并适配"处理，未动 shared）
- [ ] **金额格式化函数共享**——SaleReceiptData/ReceiptVars 均为 display-ready 字符串（'12.00'），T15 组装、T12 预览、T18 报表导出都需要"整数分→元字符串"同一格式化函数；建议 Wave 2 前某任务统一上提（当前 T4 侧测试以字面量锁定格式样例）
  - **T17 关联（2026-11-01）**：shared/utils/money.ts 仍未落地 → T17 已在 `src/main/export/money.ts` 实现等价私有 formatMoney（纯整数运算，'XX.XX' 元样式）——**又一份同源拷贝**，T12 统一上提时一并删除替换（learnings 已记）

## Task 17（待办，T14 落地时处理）
- [ ] **MonthlyReport DTO 缺 buckets（T3 契约缺口）**——T3 `MonthlyReport` 仅 `{ month, total_cents, order_count }`，无按日分桶字段；T17 按指示以 T3 类型为准 + 本地结构扩展 `MonthlyReportInput = MonthlyReport & { buckets?: MonthlyBucket[] }`（src/main/export/export.types.ts，月报 xlsx『按日分桶』sheet / docx 表 / txt 区块的数据源）。**T14 若在 shared DTO 补 `buckets` 字段则结构直接兼容**，届时应删除本地扩展类型改用 shared DTO（含 MonthlyBucket 上提）
- [ ] **report-loader.ts 与 T14 report.service 聚合逻辑重复（技术债，刻意）**——`reports:export` IPC 当前用私有 SQL loader（src/main/export/report-loader.ts：日/月聚合 + 剔除 voided）避免跨波次依赖；T14 落地 report.service 后，reports-export.ipc 应改为注入/委托 report.service，删除私有聚合 SQL
