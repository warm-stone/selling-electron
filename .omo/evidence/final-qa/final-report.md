# F3 终审 QA 报告（Real Manual QA）

- 执行日期：2026-11-02 00:05–00:30 (+0800)
- 工作目录：/home/wenshi/codeSpace/selling-electron
- QA 驱动方式：Playwright `_electron` 真实驱动 build 产物（launchApp 隔离 userData，参考 tests/e2e/helpers.ts）
- QA spec：tests/e2e-qa/（独立 config playwright.qa.config.ts，不污染基线）
- 证据：本目录（截图 30 张均 1280×800 非空 PNG + 打印字节 bin + GBK 解码 txt + 三格式导出副本 + qa-run.log）

## 执行结果

**Scenarios [12/12 pass] | Integration [5/5] | Edge Cases [6 tested] | VERDICT: APPROVE**

### 前置：build + 基线
- `npm run build` ✅（1.71s）
- `npm run test:e2e` 基线：**60 passed / 1 failed / 2 did not run**（宣称 63）——失败为**测试代码日期敏感缺陷**，非应用缺陷，详见下方发现 #1；2 个未跑用例（空数据日/证据落盘）的等价场景在 B10/A4 中独立验证通过。

### A. 跨任务集成全链路 [5/5]（单一连续会话）
| 场景 | 结果 | 关键证据 |
|---|---|---|
| A1 完整业务流 | PASS | 店名'QA测试店'→3 商品（无条码/生僻/超长名）→进货 2 行→扫码(S6)+双击混合 3 行→改量改价合计 ¥23.00→预览（单号/店名/商品行/合计￥23.00/件数 5/超长名 24 列截断）→立即打印（mock 19911 收 1b40 开头…1d564200 结尾）→销售记录查单→明细 3 行快照正确 + DB 库存联动（P1 5→3/P2 20→18/P3 15→14） |
| A2 作废闭环 | PASS | 再结账 ¥5.00→作废确认弹窗（含'库存将回滚'）→DB 库存回滚 17→18 + void 流水（change+1 before17 after18）→日报 23.00/1 单剔除作废→voided 重打预览含'已作废' |
| A3 模板编辑→打印生效 | PASS | 编辑器：头部字号 标准→倍高（预览 class 实时切换）+ footer '{shopName} 谢谢惠顾'→保存→设默认→DB 恰一默认；结账新单预览含'QA测试店 谢谢惠顾' + 倍高头部 |
| A4 报表导出闭环 | PASS | 日报 31.00/2 单（voided 剔除）→txt/xlsx/docx 三格式导出→exceljs 读回 B2=31.0/B3=2→docx 解压含标题'2026-11-02 销售报表'与 31.00→txt 含合计与双单号、无作废单号 |
| A5 打印机失败恢复 | PASS | settings tcp_port=1→结账→立即打印→错误 toast 含'tcp'与'重打'→mock 零新字节→销售记录该单已完成、重打预览正常、DB status=completed/800 分 |

### B. 边界案例 [6 tested]
| 场景 | 结果 | 关键证据 |
|---|---|---|
| B6 空购物车 | PASS | 结账/清空 disabled，合计 ¥0.00 |
| B7 库存 1 买 5 | PASS | 行内黄条'库存不足(负库存将产生)'不阻断→结账成功 DB=-4→商品列表行 class stock-negative + computed color rgb(245,108,108)（Element Plus danger 红）真实可见 |
| B8 条码边界 | PASS | 未命中条码 error toast'未找到条码商品'+车不变；重复条码'条码已存在'报错且弹窗保留 |
| B9 删除有引用商品 | PASS | 确认弹窗含'关联 1 条历史单据'→硬删→DB product_id 置 NULL→销售明细快照仍可读 |
| B10 空数据日 | PASS | 2030-01-01：汇总 0.00/0 + el-empty'当日无销售' + 空表导出（含'总销售额: 0.00 元'与'（无销售记录）'）——补上基线中断用例的等价覆盖 |
| B11 打包冒烟 | PASS | `npx electron-builder --dir`→release/linux-unpacked/selling-electron（DISPLAY=:0）启动→窗口出现/7 菜单/导航→首启建库 pos.db→app.asar 在位 |

### C. 视觉抽查 [PASS]
7 页截图（c1-pos…c7-settings）全部 1280×800 非空；中文渲染经 DOM 文本断言验证（各页标题/行文本精确匹配）；负库存标红经 computed style 断言（rgb(245,108,108)）。截图供人工复核布局。
注：本环境模型不支持图像输入，视觉验证采用 DOM/CSS 客观断言 + 截图留档的组合方式。

## 发现清单（由 orchestrator 决定修复优先级）

### #1 [测试代码缺陷·日期敏感] 基线月报切月用例期望分支倒置（唯一基线失败）
- 用例：tests/e2e/reports.spec.ts:291「月报切月联动：上月快捷 → 昨日所在月数据」
- 期望 vs 实际：期望 `24.00`，实际 `0.00`（2026-11-02 运行；快照 .omo/evidence/final-qa/../../../../../test-results/reports-Task-18*/error-context.md，基线状态见 baseline-status.md）
- 根因：`PREV_MONTH_TOTAL_CENTS = SAME_MONTH ? 1750 + 650 : 650`（reports.spec.ts:63-65）分支反了——同月运行时（每月 2 号及以后）"上月"= 无 seed 数据的前一自然月 → 正确显示 0.00，但测试期望了本月数据。该用例**仅每月 1 号运行时通过**。
- 应用行为正确性旁证：切月联动本身工作正常（本 QA A4 日报/切日期/导出全链路实测通过）。
- 连带影响：同 describe.serial 后 2 用例未运行（空数据日/证据落盘），等价场景已在本 QA B10/A4 独立覆盖并通过。
- 修复建议（测试侧）：SAME_MONTH=true 分支期望应为 0.00/0/0 桶（或断言改切回"本月"）。

### #2 [QA 指令预期修正·非缺陷] '龘' 是 GBK 内字符，不触发降级
- 事实：龘（U+9F98）iconv-lite EUC-CN 可编码（GBK 0xFD93，roundtrip 成立）——打印字节中**原样保留**（证据 a1-printed-decoded.txt：'QA龘?生僻商品' 中龘=FD93 在位）。
- QA 指令"生僻字'龘'降级'？'"不成立；已改用真正 GBK 外字符 '𠀀'（U+20000，CJK 扩展 B）验证完整降级链路：打印字节出现 '?'（0x3F）✓。
- 关联文档化设计：HTML 预览对 GBK 外字符**原文渲染**（src/shared/receipt/item-columns.ts:74-77 注释明示"与打印侧 '?' 降级的差异已文档化"）——预览含'𠀀'、纸面为'?'，两侧行为均与设计一致。

### #3 [轻微 UX 发现] 全新安装首启直接进「小票模板」页显示空列表
- 现象：出厂默认模板仅由 `template.repo.getDefault()`（结账/打印路径）惰性 seed；`templates:list` 不触发。全新 DB 未结过账时模板编辑器显示"暂无模板，点击「新建」从默认样式开始"。
- 严重度：低（不崩溃、可自建模板、首单结账后自动出现）；但与"出厂默认模板"直觉相悖。
- 建议：`list()` 触发同款惰性 seed，或 DB 迁移时预置两行出厂模板。

### #4 [测试工程提示] Element Plus toast 动画期多实例 strict violation
- 连续两次保存（店名→打印设置）时两个 success toast 同屏（渐入/渐出动画重叠），`locator('.el-message--success')` 无 .first() 会 strict violation。基线部分用例已有等退场（toHaveCount 0）模式；新写用例需统一遵循（本 QA 首轮踩坑实录）。

## 结论

应用在全部 12 组真实 QA 场景（5 集成 + 6 边界 + 视觉抽查 + 打包冒烟）中零失败：业务闭环（销售/进货/库存/报表/作废/模板/打印）全部贯通，跨任务集成无断裂；异常路径（打印失败、空数据、负库存、引用删除、条码边界）行为均符合设计。唯一红灯是基线测试自身的日期敏感期望缺陷（发现 #1），需测试侧一行分支修复后 CI 方可持续全绿。

**VERDICT: APPROVE**
