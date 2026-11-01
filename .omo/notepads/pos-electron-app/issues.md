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
- [x] [已解决 72ab96d（T12 fix）] **共享质量门被 T12 已提交文件挡住（归责 T12）**——`tests/e2e/receipt-preview.spec.ts` 的 4 个 TS2304 DOM 全局错误已由 72ab96d（`/// <reference lib="dom" />` 文件级注入）修复；T15 交接实测全量 `npm run typecheck` 整链 exit 0
- [x] [已解决 T15] **T15 打印编排消费 T19 产物的方式**——已按约定消费：`rowsToAppSettings(repo.getAll())` 作编排器 deps.getSettings；logoBuffer 走 `readLogoFileBuffer(logo_path)`（文件→Buffer；仅 previewSale 分支转 dataURL）；vars.shopName/shopPhone/receiptNote 从 settings 组装；**auto_cut 未进打印决策链**（生成器只读模板 cutPaper，auto_cut 全链零透传）。补充修正：AppSettings **不能**直接喂 getChannel（`string|null` vs `string|undefined` 严格空类型不容），经 appSettingsToPrintSettings 归一——T19 learnings「可直接喂」表述已修正

## Task 16（领地实录 + F4 审计提示）
- [已处理] **T15 的 repo 读取方法晚于我开工落地**——template.repo.ts 由 T16 先落盘（文件头注释声明领地：list/getDefault 归 T15、CRUD 归 T16），T15 随后追加 getDefault/seedDefaults（惰性 seed 插 58mm+80mm 两行，80mm 置默认）+ 其测试 4 例（追加在我建的 template.repo.test.ts 末尾）；我方 CRUD 测试全程直插 SQL 构造/断言，对读取方法零依赖——"追加不改"承诺双向成立
- [x] [T15 已补全] **F4 审计归因：本任务 commit 按 T10 先例代持 T15 未提交段落**——src/main/index.ts 的 `registerPrintingIpc(db)` 行、preload index.ts/index.d.ts 的 printing preview/print 段（PrintingPreviewResult 等）、template.repo.ts 的 getDefault 段与其测试 describe 块——T15 任务专属 commit 已落（含打印编排全部专属文件），树完整性补全；T15 learnings 已反向记录归因（87a65ca 代持段清单）
- [已记录] **templates:update 契约无 paper_width 字段**（T3 契约冻结）——纸宽变更经 config_json 模板主体生效，repo 同步 paper_width 列（列=主体的投影）；勿按"列不可变"或"透传字段"误判
- [已记录] **全量 E2E 的 pos.spec/sales-history.spec 失败为 T15 替换占位弹窗过渡态**（view 已换新、spec 同步更新中；T15 更新后的断言以'小票预览'弹窗为锚）——归责 T15；共享质量门以 T15 完成后的全绿快照为准
  - **T15 收口（2026-11-01）**：过渡态已消除——pos.spec/sales-history.spec 断言已随新弹窗更新，全量 E2E 63/63 全绿（含 template-editor.spec 9/9 与 T16 的「设默认→结账预览」交叉闭环用例）
