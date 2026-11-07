# Problems（T13 存量 E2E 适配期间发现——非本任务范围，报告不修）

## 1. smoke.spec.ts 菜单计数过期（阻塞基线套件全绿）
- 现象：`侧边导航渲染 7 个中文菜单项` 失败——`.el-menu-item` 期望 7 实际 8（其后 2 用例 serial 级联跳过）
- 归因：T11（ab3c65f）新增「客户管理」菜单项未同步 smoke.spec.ts 的 NAV_ITEMS/计数断言
- 证据：git stash 后干净 HEAD 复现同失败——与 T13 改动无因果
- 建议：smoke.spec.ts 补「客户管理」到 NAV_ITEMS 并 7→8（属 T11 收尾遗漏，一处小改）

## 2. qa-integration A1-进货 陈旧：进货表单已进化（阻塞 qa 套件 serial 链）
- 现象：`locator('.create-form__table .el-table__row').first().locator('.el-select input')` 30s 超时——错误现场快照显示新建进货单弹窗为空态（「请添加商品行」+「+ 批量计商品」「+ SN 商品」按钮）
- 归因：SN 波次（T4.2）后进货表单改为空态+手动加行，存量测试仍假设预置行；其失败导致 serial 下游（含 4 处结账用例）长期未跑，连带掩盖了 #3
- 证据：git stash 后干净 HEAD 复现同失败
- 建议：A1-进货 适配新表单（先点「+ 批量计商品」加行），属 qa 套件非结账用例（T13 禁改清单）

## 3. qa-integration A3-模板编辑 陈旧：`toHaveCount(2)` 收到 0（被 #2 掩盖的潜伏失败）
- 现象：A3-模板编辑首个断言模板列表计数失败（期望 2 得 0）
- 归因：疑似小票模板列表 UI/初始数据演进未同步该存量断言（基线 template-editor.spec.ts 全绿，仅 qa 版陈旧）
- 证据：因 #2 级联跳过长期未暴露；本次 --grep 定向跑首次暴露；干净 HEAD 亦复现
- 建议：核对 qa 版模板列表断言与当前 UI（属 qa 套件非结账用例，T13 禁改清单）

## T13 收口更新（Wave 5）：归属判别实证 + smoke 修复

### 判别结论（实证法：stash → checkout 4920f1f → qa 定向 → 恢复）
- **A1-进货：本计划前存量**——4920f1f（fix: 商品删除改为软删除，本计划前一 commit）复现同款 30s 超时；本计划 12 commits 零触碰 tests/e2e-qa/（git diff 4920f1f HEAD --stat -- tests/e2e-qa/ 为空）。最终全量 qa：8 passed / 1 failed（A1-进货）/ 11 serial 级联 did not run——无本计划新增失败
- **A3-模板编辑：本计划前存量**——4920f1f 复现同款 toHaveCount(2) 收 0；此前被 A1-进货 级联掩盖长期未跑，本次定向首暴露。两处均属 SN/模板波次 UI 进化未同步 qa 存量断言，留待后续计划（修复方向：A1 先点「+ 批量计商品」加行；A3 核对模板列表断言）
- **smoke.spec.ts 已修**（T11 收尾遗漏）：NAV_ITEMS 加 { path: '/customers', label: '客户管理' }（照菜单序插在销售记录后）+ IMPLEMENTED_ROUTES 加 '/customers'（不加则第 3 用例会误断言占位页）+ count/标题 7→8——migrator.test 版本 bump 同款机械同步

## 遗留修复 L1 收口（Wave 6）：qa 套件两存量失败已修 + 全绿

### 修法 1：A1-进货适配新表单（tests/e2e-qa/qa-integration.spec.ts）
- 断言链前照基线 purchases.spec.ts 补：`expect(rows).toHaveCount(0)` + 空态「请添加商品行」→ `getByTestId('add-quantity-row')` → `toHaveCount(1)`；原「+ 添加行」按钮（已拆双按钮）替换为 `add-quantity-row` + `toHaveCount(2)`
- selectProduct 的 aria-controls 锚点写法与基线一致，无需动

### 修法 2：A3-模板编辑造数兜底（同文件）
- 根因补充实证：lazy seed 由 `printing:preview → getDefaultTemplate() → repo.getDefault()` 触发，serial 全链靠 A1-结账预览先行触发；**定向跑/上游失败时不经过结账 → 表空 → toHaveCount(2) 收 0**
- 修法（基线 template-editor.spec.ts 直插模式）：用例头部查 `print_templates` 计数，为 0 则直插出厂双模板（import DEFAULT_TEMPLATES，与 template.repo seedDefaults 同构：58mm 非默认 + 80mm 默认）——幂等，serial/定向两路径列表恒 2 项

### 修法 3：scanBarcode 同步连发（tests/e2e-qa/qa-helpers.ts，级联恢复后暴露的 flake）
- 现象：A3-结账新单 `scanBarcode(P3)` 后 cart 0 行；快照实证搜索框 [active] 且值为 `220234 5678904`（含杂散空格）+「未找到匹配商品」
- 机理：bridge 不 preventDefault（字符同时落入聚焦搜索框，检测命中后 handleBarcode 用干净 code 覆写）；原 10ms/键 setTimeout 在共享机高负载（L2/L3 并行 vitest/编辑）下漂移可超检测器 BURST_GAP_MS=50 → 连发中断 → 检测失败；杂散击键（同轮 A1-设置 收 'QA测试店c' 的 'c'，真窗口焦点泄露）混入空格加剧
- 修法：去掉人为 10ms 间隔改同步连发（detector 仅上限阈值无下限，0ms 间隔合法），对负载免疫且把杂散击键可混入窗口 ~130ms → ~1ms

### 收口证据
- qa 全套件：**20/20 全绿**（含此前被 A1 级联跳过的 11 用例：A1-收银/结账/销售记录、A2×4、A3×2、A4、A5 全部恢复执行通过）
- 基线 `npm run test:e2e`：79 passed / 2 failed——均为非 L1 回归：①customer-extras 场景 4 = L2 飞行中改动（其计划明列该断言同步，git diff 实证文件正被修改）；②template-editor 列宽「合计 12/48 vs 0/48」= 共享机并发负载 flake（孤立复跑 11/11 全绿，spec 与 TemplateEditorView.vue 零改动）
- 环境教训：共享机上并行跑 E2E 会互相制造负载类 flake（按键注入漂移、el-input 清空竞态、真窗口焦点泄露击键）——终审/基线全量验证宜避开并行任务高峰
