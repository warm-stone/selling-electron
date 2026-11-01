## Task 7（已解决，留档）
- [已解决] TDD RED 阶段 serial 测试首轮运行时，SerialChannel 构造签名不匹配（测试传字符串、实现收 options 对象）→ 默认口 `\\.\COM1` 在 Linux cwd 静默生成 1 字节垃圾文件。修复：构造收 `string | SerialChannelOptions` 联合类型；垃圾文件已删除（`ls` 复核零残留）。教训入 learnings（串口通道跨平台陷阱）

## Task 4（原待办，Task 12 落地时已解决——2026-11-01）
- [x] [已解决 T12] **G7 契约缺口：ITEM_COLUMN_WIDTHS 上提 shared**——已上提 `src/shared/receipt/item-columns.ts`（ITEM_COLUMN_WIDTHS + buildItemLine「降级→truncate→pad」组合语义 + ReceiptItemLine/SaleReceiptData display-ready 类型）；escpos-generator.ts 改为 import + re-export，golden .bin 字节零变化（159 用例回归全绿）
- [x] [已解决 T12] **金额格式化函数共享**——`src/shared/utils/money.ts`：formatMoney（'12.50' 恰好 2 位小数、无千分位）+ parseMoneyToCents（非法输入 NaN）；T15/T18 统一消费
  - **T17 关联（2026-11-01）**：shared/utils/money.ts 仍未落地 → T17 已在 `src/main/export/money.ts` 实现等价私有 formatMoney（纯整数运算，'XX.XX' 元样式）——**又一份同源拷贝**，T12 统一上提时一并删除替换（learnings 已记）

## Task 17（已解决，留档——2026-11-01 T14 落地）
- [x] [已解决 T14] **MonthlyReport DTO 缺 buckets（T3 契约缺口）**——shared/types/domain.ts 已补 `DailyBucket` + `MonthlyReport.buckets: DailyBucket[]`（必填，service 恒提供、空月 []）；export.types.ts 的 `MonthlyReportInput`/`MonthlyBucket` 降级为兼容别名（= MonthlyReport / = DailyBucket），exporter 三文件零改动；BUCKETLESS_MONTHLY_INPUT fixture 转契约外运行时防御形态（as unknown as，继续锁定 exporter 守卫，断言零改动）
- [x] [已解决 T14] **report-loader.ts 与 report.service 聚合逻辑重复（技术债）**——report-loader.ts 已删除，reports-export.ipc 数据获取改走 report.service（buildReportExportInput 组装，kind/period/title 语义与 T17 逐字一致）；T17 原 6 个 loader 测试迁移为 tests/unit/export/report-export-input.test.ts（seed 与断言逐字保留，仅换数据路径），export 套件 53 全绿

## Task 9（已按领地规则处理，留档）
- [已处理] **T8 product.repo 在 Task 9 开工时不存在（并行未产出）**——按任务指示在 purchase.repo 内自写 products 读取 SQL（SELECT id,name,barcode,stock WHERE id=?，仅事务内快照用）；T8 后来已落地 products.ipc/products:list（E2E 自适应探测走真实 handler，stub 分支未触发）
- [已处理] **preload 裸 invoke 由 Task 9 补齐**——T10 的段落模式未暴露裸 invoke，Task 3 契约设计（createTypedInvoke 需要裸 invoke 作输入）缺口由本任务补：`api.invoke(channel, payload)`（G8 边界入口，必须经 createTypedInvoke 包装使用）；后续任务如需契约通道（如 products:list）可直接复用

## Task 19（T15 消费提示 + 共享验收现状）
- [ ] **共享质量门被 T12 已提交文件挡住（归责 T12）**——`tests/e2e/receipt-preview.spec.ts` 存在 4 个 TS2304 DOM 全局错误（location/getComputedStyle，该文件被 tsconfig.node.json 收编但用浏览器全局）——当前全量 `npm run typecheck` 无法全绿；T19 自有文件零错误（按文件路径归责验证），F2 审计时需 T12 补 DOM lib 引用或局部声明
- [ ] **T15 打印编排消费 T19 产物的方式**：settings:get 的 AppSettings 直接喂 T7 `getChannel`（key 逐字一致）；logoBuffer 从 settings.logo_path 读文件（勿再走 dataURL）；vars.shopName/shopPhone/receiptNote 从 settings 组装（本任务数据源就绪）；**auto_cut 不进打印决策链**（模板 cutPaper 唯一事实源，设置项仅初始值参考——计划决策，勿透传给生成器）
