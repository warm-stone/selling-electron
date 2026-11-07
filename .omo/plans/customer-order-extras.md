# 结账客户信息与订单附加信息（customer-order-extras）

## TL;DR

> **Quick Summary**: 在不改 `sales` 表的前提下，新建 `customers` + `sale_extras`（1:1）两张表与全栈链路：结账弹窗采集客户/订单附加信息（电话唯一去重建档、国补布尔、订单备注、销售人员缓存快选），新增客户管理模块，销售记录侧可改国补/备注/客户/销售人员，日报汇总加国补小计 + 明细加两列（页面与 txt/xlsx/docx 三导出器同步）。
>
> **Deliverables**:
> - 005 迁移（customers + sale_extras 表）+ 全链路（repo/service/IPC/preload）
> - CheckoutDialog 结账弹窗（客户信息 + 订单信息 + 校验 + 销售人员快选）
> - CustomersView 客户管理模块（列表/搜索/新增/编辑，无删除）+ 路由 + 菜单
> - SalesHistoryView 明细弹窗扩展（显示客户信息 + 可编辑国补/订单备注/客户/销售人员）
> - 日报：汇总国补小计 + 明细两列（ReportsView + 三导出器）
> - salesperson 最近输入缓存（settings KV `recent_salespersons`）
> - vitest 单测 + Playwright E2E 适配与新增场景
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 5 waves（W1 基础 3 任务 → W2 数据层 3 → W3 业务层 3 → W4 前端 3 → W5 E2E 2）+ FINAL 四审
> **Critical Path**: 1 → 5 → 8 → 10 → 13/14 → F1-F4

---

## Context

### Original Request

用户需求（三轮访谈收敛后的最终形态）：

1. **结账时新增输入**：客户信息【姓名】【电话】【地址】【客户备注】+ 订单信息【是否参与国补】【订单备注】【销售人员】（销售人员缓存最近输入可快选）
2. **数据库设计**：sales 表完全不动；新建 customers 表 + sale_extras 表（1:1，sale_id PK，可更新）；sale_extras.customer_id 引用 customers（客户信息修改后订单查询 JOIN 显示最新）；电话唯一（结账输入已有电话→关联，不存在→新建）
3. **订单侧可修改**：国补/订单备注/客户关联/销售人员；其余订单信息仍不可修改
4. **客户管理模块**：可修改任意客户信息、可新增（无删除）
5. **报表导出**：日报汇总加国补小计 + 日报明细加【是否参与国补】【订单备注】两列

### Interview Summary

**Key Discussions**:
- 三轮访谈：R1 需求合理性分析（发现系统无客户概念、结账无表单、订单无 update 通道）→ R2 数据模型定案（1:1 附加表、引用式客户、电话去重）→ R3 业务规则定案（必填规则、预填覆盖、报表口径、范围裁剪）
- 最终必填规则：**填【姓名】或【地址】⇒ 必填【电话】**；勾选国补 ⇒ 姓名+电话必填；其他均可空
- 散客快单（什么都不填）不写 sale_extras 行、不建客户，查询一律 LEFT JOIN

**Research Findings**（3 个 explore agents + Metis 代码核验）:
- 结账链路：CartPanel → PosView.checkout() → `sales:checkout` → sale.service.checkout() 单事务（G2/G3 铁律）→ cart.clear() → 小票预览；当前**无任何结账表单**
- `sale.repo.ts` 唯一 UPDATE 是 markVoided；IPC 仅 4 个 sales 通道——"订单不可改"是架构级约束（不提供修改通道）
- 迁移机制：PRAGMA user_version，当前 4，下一个 005；004 为 ALTER TABLE 先例
- `foreign_keys = ON`（database.ts:26）：sale_extras 必须在拿到 saleId 后 INSERT
- 报表同步面 **~8 处**（明细 4 处 + 汇总块 4 处）；xlsx 硬编码 `getCell('D')`（xlsx.exporter.ts:71）
- E2E 爆炸半径：`.cart-panel__checkout` 点击点 **17 处 / 6 个 spec 文件** + `checkoutAndWaitPreview` helper + reports.spec 的 `汇总!B2` / `dailyStatValues nth(0)` 序号断言
- `DailyReport.sales: Sale[]` 复用核心 Sale DTO（domain.ts:174）——需新增 `SaleWithExtras extends Sale`，禁止污染 Sale
- `sale.service.checkout(items)` 位置参数（sale.service.ts:108）——追加可选第二参可保 423 存量单测零破坏
- settings 表白名单映射（settings.ipc.ts:75-87）确认 `recent_salespersons` 独立 key 不会泄漏进 settings:get
- PosView 有弹窗期扫码守卫先例（SnEntryDialog，PosView.vue:125-127）
- D-SN8 事务 owner 约定（sale.repo.ts:10-11）：跨 repo 事务调用需显式豁免说明——被调 repo 方法必须单条预编译语句、无自有 db.transaction（settings.repo.set 已核实符合）

### Metis Review

**Identified Gaps** (addressed):
- Q1 电话查找键规则：结账链路**永不 UPDATE customer.phone**（只 find-or-create；改电话=切换目标客户；电话失焦重查覆盖预填；换手机号只能去客户管理）→ 消除事务级 UNIQUE 崩溃陷阱，已采纳
- Q4 voided 单禁改：updateExtra 抛 `SALE_ALREADY_VOIDED`，UI 编辑区置灰，已采纳
- Q3 PUT 语义：结账表单对已有客户预填后保存=全量覆盖（空=清空档案值），已采纳
- Q6 salesperson 缓存写入在 checkout 事务内（回滚不残留），已采纳
- Q7 电话归一化：全部文本字段 trim 后校验/落库；**不做**全角/+86 归一化（文档化为已知局限），已采纳
- Q8 扫码串扰守卫：CheckoutDialog 打开期间 handleBarcode 提前 return（复用 SnEntryDialog 模式），已采纳
- Q9 尾部追加原则：新列/新卡片/新汇总行一律 append 尾部（E2E 兼容三坐标证据），已采纳
- Q2/Q5/Q10：CUSTOMER_PHONE_EXISTS 友好错误；updateExtra 客户语义（find-or-create/清空解绑/旧单勾国补同样要求姓名+电话/全空行保留）；D-SN8 跨 repo 豁免文档化，已采纳

---

## Work Objectives

### Core Objective

在不动 sales 表的前提下，为结账/订单侧增加客户信息与订单附加信息的采集、存储（1:1 附加表）、管理（客户模块）、事后修改（updateExtra）与报表呈现（日报国补小计+两列）。

### Concrete Deliverables

- `src/main/db/migrations/005_customer_order_extras.sql` + migrator 注册
- `customers.repo.ts` / `sale_extras.repo.ts`（DAL，单语句无自有事务）
- `salesperson-history.ts`（纯函数：去重置顶/上限 10/损坏容错）
- `customer.service.ts` + `customers.ipc.ts`（list/create/update，电话冲突友好错误）
- `sale.service.ts` 扩展：`checkout(items, extras?)`、`updateExtra()`、`getDetail` 扩展
- `shared/types/domain.ts` + `ipc.ts` + `preload/index.ts` 契约扩展
- `CheckoutDialog.vue` + PosView 接线（扫码守卫）
- `CustomersView.vue` + 路由 + 菜单
- `SalesHistoryView.vue` 明细弹窗扩展
- 报表：`report.repo/service` + 三导出器 + `ReportsView` + `export-report.fixture.ts`
- vitest 单测全套 + Playwright 既有 17 点适配 + 新场景 spec

### Definition of Done

- [ ] `npm run typecheck` 双侧零错误
- [ ] `npm test` 全绿（存量 423 + 新增用例）
- [ ] `npm run test:e2e` 全绿（存量适配 + 新场景）
- [ ] fresh DB 与 v4 老库均迁移至 user_version=5，双表结构正确

### Must Have

- sales 表、sale.repo 的 markVoided、既有 4 个 sales 通道契约**零改动**
- 结账事务内完成：客户 find-or-create/更新 + sale_extras INSERT + salesperson 缓存写入（全 DB 操作，G3 合规）
- service 层镜像校验（IPC 可直达，前端规则不是防线）
- 回滚原子性：事务失败 → customers/sale_extras/settings.recent_salespersons/sales 全部零残留
- 电话 = 只读查找键（结账链路永不 UPDATE phone）
- `checkout(items, extras?)` 追加可选参签名（存量单测零破坏）
- 新列/新卡片/新汇总行一律尾部追加
- `IPC_CHANNEL_NAMES` 数组与 `tests/unit/shared/ipc.test.ts` grep 断言同步
- 所有文本字段 trim 后校验、trim 后落库，`'' ≡ null` 归一

### Must NOT Have (Guardrails)

- **不动 sales 表任何列**；不动月报（dailyBucketsStmt/monthlyTotalsStmt 一行不碰）
- **小票打印/模板零接触**（SaleDetail.extras 会流经 printing:preview 编排，模板忽略即无害，禁改打印链）
- **客户删除不做**（防 customer_id 悬空）
- **`sales:list` 契约与 `Sale[]` res 完全不动**（列表页不是需求面）
- **Sale 核心 DTO 不加报表专用字段**（用 `SaleWithExtras extends Sale`）
- **日报明细不加客户姓名列**（需求定案两列，防放大同步面）
- **不做**电话格式校验/全角/+86 归一化（写入文档"已知局限：电话按精确字符串去重"）
- **不做**销售人员实体管理（缓存是字符串数组非实体表）、会员卡/记住上次客户
- **不修** `sales:checkout` res 契约既有 Sale/SaleDetail 不一致（范围纪律）
- **不做** customers:list 的订单数/最后消费聚合列、导入/导出/合并工具
- E2E 适配改动**限于**"点击结账后补一次确认"，禁止顺手重构无关断言
- 禁止 `as any`/`@ts-ignore`/空 catch/生产 console.log

### Spec Framework Integration

- **Detected Framework**: None（无 openspec/ 或 .specify/ 目录）
- 设计决策事实源：`.omo/plans/pos-electron-app.md`（G1-G8 铁律与 D 系列决策）

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES（vitest 423 用例 + Playwright 63 场景）
- **Automated tests**: Tests-after（遵循项目惯例：每任务随实现交付 vitest 单测；E2E 集中在 W5 两任务）
- **Framework**: vitest（单元）+ Playwright `_electron`（E2E）
- **主验收测试**：结账事务回滚原子性（见任务 8）

### QA Policy

每任务包含 Agent-Executed QA Scenarios，证据存 `.omo/evidence/task-{N}-{slug}.{ext}`：
- **Service/Repo 层**：Bash 运行 `npx vitest run <file>`，断言具体用例数与通过数；node 直读 DB 断言行数
- **UI 层**：Playwright 驱动真实 Electron（复用 tests/e2e 既有 helper 模式），具体 selector + 断言 + 截图
- **导出层**：vitest 断言输出内容 + E2E 读回导出文件断言坐标（`汇总!B2`、表头列序）
- 数据使用具体值（电话 `13800138000`、姓名 `张三`）

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (基础层，3 并行):
├── Task 1: 005 迁移（customers + sale_extras DDL + migrator 注册 + 单测）[quick]
├── Task 2: 共享契约层（domain/ipc/preload/ipc.test，全类型定义）[unspecified-high]
└── Task 3: salesperson-history 纯函数（去重置顶/上限10/损坏容错）[quick]

Wave 2 (数据层，3 并行，依赖 W1):
├── Task 4: customers.repo（findByPhone/insert/update/list，无 delete）[quick]
├── Task 5: sale_extras.repo（insert/upsert/getWithCustomer LEFT JOIN）[unspecified-low]
└── Task 6: salesperson 读通道（settings:getRecentSalespersons 组装）[quick]

Wave 3 (业务层，3 并行，依赖 W2):
├── Task 7: customer.service + customers.ipc（校验/电话冲突友好错误）[unspecified-high]
├── Task 8: sale.service 扩展（checkout 事务/updateExtra/getDetail）★核心 [deep]
└── Task 9: 报表原子任务（repo/service/三导出器/ReportsView/夹具）[unspecified-high]

Wave 4 (前端，3 并行，依赖 W3):
├── Task 10: CheckoutDialog + PosView 接线（校验/预填/扫码守卫）[visual-engineering]
├── Task 11: CustomersView + 路由 + 菜单 [visual-engineering]
└── Task 12: SalesHistoryView 明细弹窗扩展（显示+编辑区）[visual-engineering]

Wave 5 (E2E，2 并行，依赖 W4):
├── Task 13: E2E 存量适配（17 点击点/6 spec + helper）[unspecified-high]
└── Task 14: E2E 新场景（9 组场景全覆盖）[unspecified-high]

Wave FINAL (4 并行审查 + 用户确认):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: 1 → 5 → 8 → 10 → 13 → F1-F4
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 3（实现波次）/ 4（FINAL 只读审查波）
```

### Dependency Matrix (FULL)

| Task | Depends On | Blocks |
|---|---|---|
| 1 | - | 4, 5 |
| 2 | - | 4, 5, 6, 7, 8, 9, 10, 11, 12 |
| 3 | - | 6, 8 |
| 4 | 1, 2 | 7, 8 |
| 5 | 1, 2 | 8, 9 |
| 6 | 2, 3 | 8 |
| 7 | 2, 4 | 11 |
| 8 | 2, 3, 4, 5, 6 | 10, 12 |
| 9 | 2, 5 | - |
| 10 | 8 | 13, 14 |
| 11 | 7 | 14 |
| 12 | 8 | 14 |
| 13 | 10 | F |
| 14 | 10, 11, 12 | F |
| F1-F4 | all | - |

### Agent Dispatch Summary

- **W1**: 3 — T1 → `quick`，T2 → `unspecified-high`，T3 → `quick`
- **W2**: 3 — T4 → `quick`，T5 → `unspecified-low`，T6 → `quick`
- **W3**: 3 — T7 → `unspecified-high`，T8 → `deep`，T9 → `unspecified-high`
- **W4**: 3 — T10/T11/T12 → `visual-engineering`
- **W5**: 2 — T13/T14 → `unspecified-high`
- **FINAL**: 4 — F1 → `oracle`，F2/F3 → `unspecified-high`，F4 → `deep`

---

## TODOs

- [x] 1. 005 迁移：customers + sale_extras 表

  **What to do**:
  - 新建 `src/main/db/migrations/005_customer_order_extras.sql`：
    ```sql
    CREATE TABLE customers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL DEFAULT '',
      phone      TEXT NOT NULL UNIQUE,
      address    TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE sale_extras (
      sale_id             INTEGER PRIMARY KEY REFERENCES sales(id),
      customer_id         INTEGER REFERENCES customers(id),
      is_national_subsidy INTEGER NOT NULL DEFAULT 0,
      order_note          TEXT,
      salesperson         TEXT
    );
    CREATE INDEX idx_sale_extras_customer_id ON sale_extras(customer_id);
    ```
  - `src/main/db/migrator.ts` 顶部 import + 迁移数组登记 version 5（照 004 模式，L13-18）
  - 迁移单测（`tests/unit/db/migrator.test.ts` 追加）：空库 v0 直升 5；v4 老库升 5；两表列结构与 DDL 逐列一致
  - 测试断言 `INSERT INTO customers(phone) VALUES('')` 两次 → 第二次 UNIQUE 失败（锁定 NOT NULL UNIQUE 语义）

  **Must NOT do**:
  - 不 ALTER sales 表任何列；不建删除相关的外键级联（customers 无删除）

  **Recommended Agent Profile**:
  - **Category**: `quick`（照 004 先例的模板化迁移任务）
  - **Skills**: []（纯 SQL + 注册，无领域技能重叠）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with Tasks 2, 3）
  - **Blocks**: 4, 5
  - **Blocked By**: None

  **References**:
  - `src/main/db/migrations/004_product_soft_delete.sql` — 迁移 SQL 文件格式先例（注释风格、命名）
  - `src/main/db/migrator.ts:13-18` — import + 数组注册模式
  - `src/main/db/database.ts:26` — `foreign_keys = ON`：REFERENCES 是实约束，sale_extras 必须在 saleId 落库后 INSERT（FK 顺序约束，任务 8 执行）
  - `tests/unit/db/migrator.test.ts` — 既有迁移测试模式（版本断言）

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/db/migrator.test.ts` → PASS（含 005 新用例）
  - [ ] node 直读 DB：`PRAGMA user_version` === 5；`PRAGMA table_info(customers)` 7 列、`PRAGMA table_info(sale_extras)` 5 列

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: v4 老库升级路径（happy path）
    Tool: Bash
    Preconditions: 构造 user_version=4 的临时 DB（跑 migrations 001-004）
    Steps:
      1. node 脚本调用 migrate(db) 后读 PRAGMA user_version
      2. PRAGMA table_info('customers') 与 PRAGMA table_info('sale_extras') 逐列比对
    Expected Result: user_version===5；customers 7 列(id/name/phone/address/note/created_at/updated_at)；sale_extras 5 列(sale_id/customer_id/is_national_subsidy/order_note/salesperson)
    Evidence: .omo/evidence/task-1-migration-upgrade.txt

  Scenario: 空 DB 直建路径 + phone UNIQUE 语义（edge）
    Tool: Bash
    Preconditions: 全新空 DB
    Steps:
      1. migrate(db) → user_version===5
      2. INSERT INTO customers(phone) VALUES('') 成功
      3. 再次 INSERT INTO customers(phone) VALUES('')
    Expected Result: 第二次抛 SQLITE_CONSTRAINT_UNIQUE 错误（'' 也受 UNIQUE 约束——空电话建档由 service 层拦截，DB 层兜底）
    Evidence: .omo/evidence/task-1-phone-unique-error.txt
  ```

  **Commit**: YES
  - Message: `feat(db): 005 迁移新增 customers 与 sale_extras 表`
  - Files: `src/main/db/migrations/005_customer_order_extras.sql`, `src/main/db/migrator.ts`, `tests/unit/db/migrator.test.ts`

- [x] 2. 共享契约层：domain 类型 + IPC 通道 + preload API

  **What to do**:
  - `src/shared/types/domain.ts` 新增：
    - `Customer`（id/name/phone/address/note/created_at/updated_at，字段与 DB 列 snake_case 一一对应）
    - `CheckoutExtrasInput = { customer?: { name: string; phone: string; address: string; note: string } | null; is_national_subsidy?: boolean; order_note?: string; salesperson?: string }`
    - `SaleExtraInfo`（sale_id/customer_id/is_national_subsidy/order_note/salesperson + customer: Customer | null）
    - `SaleWithExtras extends Sale { is_national_subsidy: boolean; order_note: string | null }`（日报明细行用，**Sale 本体零改动**）
    - `DailyReport` 扩展：`subsidy_total_cents: number`；`sales: SaleWithExtras[]`
    - `SaleDetail` 扩展：`extras: SaleExtraInfo | null`（旧单无行 → null，**禁止空对象冒充**）
  - `src/shared/types/ipc.ts`：
    - 新通道（IpcChannels 接口 + IPC_CHANNEL_NAMES 数组两处同步）：`'customers:list'`（req: { keyword?: string; limit?: number; offset?: number }, res: { items: Customer[]; total: number }）、`'customers:create'`（req: Customer 可编辑字段, res: Customer）、`'customers:update'`（req: { id: number; patch } , res: Customer）、`'sales:updateExtra'`（req: { sale_id: number; is_national_subsidy?/order_note?/salesperson?/customer?: {name/phone/address/note} | null }, res: SaleDetail）、`'settings:getRecentSalespersons'`（req: {}, res: string[]）
    - `'sales:checkout'` req 扩展为 `{ items: CheckoutItem[]; extras?: CheckoutExtrasInput }`（嵌套 extras，res 契约不动）
  - `src/preload/index.ts`：`api.customers.list/create/update`、`api.sales.updateExtra`、`api.settings.getRecentSalespersons`、`api.sales.checkout(items, extras?)` 签名扩展
  - `tests/unit/shared/ipc.test.ts`：新通道进 grep 断言清单

  **Must NOT do**:
  - 不动 `Sale` 核心 DTO 任何字段；不动 `sales:list`/`sales:void`/`sales:detail` 的 req/res 形状（detail 的 res 因 SaleDetail 扩展自动带 extras，属类型派生非契约改动）
  - 不修 `sales:checkout` res 既有 Sale/SaleDetail 不一致（范围纪律）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`（跨 4 文件类型设计，全下游任务的编译基座，需精确性）
  - **Skills**: []（纯类型层，无领域技能重叠）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with Tasks 1, 3）
  - **Blocks**: 4, 5, 6, 7, 8, 9, 10, 11, 12（全部下游依赖此契约）
  - **Blocked By**: None

  **References**:
  - `src/shared/types/domain.ts:60-88` — Sale/SaleItem/SaleDetail 现有定义（SaleWithExtras 继承基点；SaleDetail 含 items 的结构）
  - `src/shared/types/domain.ts:174-180` — DailyReport 现有形状（扩展基点）
  - `src/shared/types/ipc.ts` — IpcChannels + IPC_CHANNEL_NAMES 双处登记模式（L69 checkout 契约、通道命名风格）
  - `src/preload/index.ts` — 命名空间 API 模式（api.sales/api.settings 组装方式）
  - `tests/unit/shared/ipc.test.ts` — 通道名 grep 断言（新通道遗漏会挂此测试）

  **WHY Each Reference Matters**: ipc.ts 的双处登记是 typed IPC 铁律的机械要求；ipc.test.ts 的断言清单必须同步否则 CI 红灯——这是通道注册的"第三处"。

  **Acceptance Criteria**:
  - [ ] `npm run typecheck` 双侧零错误（此时无实现，仅类型——handler 未注册不报错，preload 层纯类型）
  - [ ] `npx vitest run tests/unit/shared/ipc.test.ts` → PASS（5 个新通道全在断言中）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 契约完备性编译验证（happy path）
    Tool: Bash
    Preconditions: 任务 1-3 同波完成后
    Steps:
      1. npm run typecheck && npm run typecheck:node && npm run typecheck:web
      2. npx vitest run tests/unit/shared/ipc.test.ts
    Expected Result: typecheck 零错误；ipc.test 中 IPC_CHANNEL_NAMES 与 IpcChannels 键集一致性断言通过（含 customers:list/create/update、sales:updateExtra、settings:getRecentSalespersons 共 5 个新通道）
    Evidence: .omo/evidence/task-2-contract-typecheck.txt

  Scenario: Sale DTO 不可变护栏（edge）
    Tool: Bash
    Preconditions: 契约层已提交
    Steps:
      1. git diff src/shared/types/domain.ts 中 grep 'interface Sale ' 的 diff 块
    Expected Result: Sale 接口定义块零 diff（只有新增类型与 DailyReport/SaleDetail 扩展）
    Evidence: .omo/evidence/task-2-sale-dto-untouched.txt
  ```

  **Commit**: YES
  - Message: `feat(shared): 客户/附加信息契约层（domain/ipc/preload）`
  - Files: `src/shared/types/domain.ts`, `src/shared/types/ipc.ts`, `src/preload/index.ts`, `tests/unit/shared/ipc.test.ts`

- [x] 3. salesperson 最近输入纯函数

  **What to do**:
  - 新建 `src/main/services/salesperson-history.ts`（纯函数，零依赖）：
    - `parseRecentSalespersons(raw: string | null): string[]` — JSON.parse try/catch，损坏/非数组 → `[]`；逐项 trim + 过滤空串
    - `pushRecentSalesperson(list: string[], name: string): string[]` — trim 后 name；去重置顶（同名移到队首非追加）；超上限 10 逐出最旧；返回新数组（不可变风格）
    - 常量 `RECENT_SALESPERSONS_KEY = 'recent_salespersons'`、`RECENT_SALESPERSONS_LIMIT = 10`（上限**定死 10**）
  - 单测 `tests/unit/services/salesperson-history.test.ts`：11 个不同名字 → 长度 10 且最旧被逐；重复名字 → 置顶且不重复；损坏 JSON → []；空串/纯空白 → 不记录；合法数组透传

  **Must NOT do**:
  - 不做销售人员实体管理/持久化格式设计（就是 JSON 字符串数组）；不引入 localStorage

  **Recommended Agent Profile**:
  - **Category**: `quick`（零依赖纯函数 + 单测，边界清晰）
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with Tasks 1, 2）
  - **Blocks**: 6, 8
  - **Blocked By**: None

  **References**:
  - `src/main/ipc/settings.ipc.ts:63-67` — parseBool 的脏值防御风格（容错解析的先例）
  - `src/main/db/repositories/settings.repo.ts` — KV 存取面（本任务只写纯逻辑，DB 读写由任务 6/8 组装）

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/services/salesperson-history.test.ts` → PASS（≥5 用例）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 上限与去重置顶（happy path）
    Tool: Bash
    Preconditions: 纯函数已实现
    Steps:
      1. node/tsx 直接调用 pushRecentSalesperson(['a','b','c'], 'b') → ['b','a','c']
      2. 依次 push 's1'...'s11' 到 [] → 长度 10，'s1' 被逐出，'s11' 在队首
    Expected Result: 与上述字面值完全一致
    Evidence: .omo/evidence/task-3-push-semantics.txt

  Scenario: 损坏 JSON 容错（edge）
    Tool: Bash
    Steps:
      1. parseRecentSalespersons('{"broken":') → []
      2. parseRecentSalespersons('["a","", "  "]') → ['a']
      3. parseRecentSalespersons(null) → []
    Expected Result: 三例均无异常抛出，返回值如上
    Evidence: .omo/evidence/task-3-parse-robustness.txt
  ```

  **Commit**: YES
  - Message: `feat(main): salesperson 最近输入纯函数`
  - Files: `src/main/services/salesperson-history.ts`, `tests/unit/services/salesperson-history.test.ts`

- [x] 4. customers.repo（客户 DAL）

  **What to do**:
  - 新建 `src/main/db/repositories/customer.repo.ts`（照 settings.repo/product.repo 模式）：
    - `findByPhone(phone: string): Customer | undefined`（精确匹配，trim 后的值）
    - `insert(data: { name; phone; address; note }): Customer`（RETURNING 或 lastInsertRowid 回读）
    - `update(id: number, patch: { name?; phone?; address?; note? }): void`（**含 phone 列**——客户管理模块可改电话，冲突处理在 service 层）
    - `getById(id): Customer | undefined`
    - `list(keyword: string, limit: number, offset: number): { items: Customer[]; total: number }`（keyword LIKE name OR phone，`ORDER BY id DESC`，照 products:list 模式）
  - 全部单条预编译语句、**无自有 db.transaction**（D-SN8 跨 repo 豁免前提：被 checkout 事务调用的方法必须无嵌套事务）
  - 单测 `tests/unit/db/customer.repo.test.ts`：findByPhone 精确性、insert/update/list 分页与模糊搜索、updateById 不存在时静默

  **Must NOT do**:
  - 不做 delete；不做电话归一化（trim 由 service 层完成，repo 收到的已是 trim 后值）；不做订单数聚合

  **Recommended Agent Profile**:
  - **Category**: `quick`（模板化 DAL，照现有 repo 抄）
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with Tasks 5, 6）
  - **Blocks**: 7, 8
  - **Blocked By**: 1（005 迁移）、2（Customer 类型）

  **References**:
  - `src/main/db/repositories/settings.repo.ts` — 最小 repo 模式（prepare 缓存 + 返回形态）
  - `src/main/db/repositories/product.repo.ts` — list 分页/keyword LIKE 模式（若名称不符以实际文件为准，products 相关 repo）
  - `src/main/db/repositories/sale.repo.ts:3-11` — D-SN8 事务 owner 约定与 SAVEPOINT 降级注释（本任务必须遵守"无自有事务"）

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/db/customer.repo.test.ts` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 电话精确查找与列表搜索（happy path）
    Tool: Bash
    Preconditions: 内存 DB 已跑全部迁移
    Steps:
      1. insert({name:'张三', phone:'13800138000', address:'', note:''})
      2. findByPhone('13800138000') → id 匹配；findByPhone(' 13800138000 ') → undefined（精确匹配，证明 trim 责任在上层）
      3. list('张', 20, 0) → items 含该行；list('138', 20, 0) → 含该行；list('', 20, 0) → total=1
    Expected Result: 上述断言全部成立
    Evidence: .omo/evidence/task-4-repo-crud.txt

  Scenario: id 不存在的 update 静默（edge）
    Tool: Bash
    Steps:
      1. update(9999, {name:'x'}) → 不抛错、无行变化（getById(9999) === undefined）
    Expected Result: 静默完成（service 层负责存在性校验）
    Evidence: .omo/evidence/task-4-update-missing.txt
  ```

  **Commit**: YES
  - Message: `feat(db): customers repo`
  - Files: `src/main/db/repositories/customer.repo.ts`, `tests/unit/db/customer.repo.test.ts`

- [x] 5. sale_extras.repo（订单附加信息 DAL）

  **What to do**:
  - 新建 `src/main/db/repositories/sale-extra.repo.ts`：
    - `insert(saleId, data: { customer_id: number | null; is_national_subsidy: 0 | 1; order_note: string | null; salesperson: string | null }): void`（结账事务内调用，在 saleId 落库后）
    - `upsert(saleId, patch): void` — `INSERT ... ON CONFLICT(sale_id) DO UPDATE`（updateExtra 用；旧单无行时建行）
    - `getWithCustomer(saleId): SaleExtraInfo | null` — LEFT JOIN customers（customer_id NULL → customer: null；is_national_subsidy NULL 行不存在——getWithCustomer 无行返回 null）
    - `findBySaleIds(saleIds: number[]): Map<number, {is_national_subsidy, order_note}>`（报表明细批量查询备用——若任务 9 直接在 report.repo 写 JOIN 则此方法可省，二选一以实现简者为准）
  - 全部单条预编译语句、无自有事务
  - 单测 `tests/unit/db/sale-extra.repo.test.ts`：insert 后 getWithCustomer 返回完整信息；customer 档案更新后 getWithCustomer 反映最新（引用语义验证）；upsert 幂等（二次调用更新同 sale_id 行，不重复建行）；无行 → null

  **Must NOT do**:
  - 不做行删除（全空结果行保留——定案）；不 JOIN sales（只按 sale_id 存取）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`（含 LEFT JOIN 与 upsert 语法，略复杂于模板）
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with Tasks 4, 6）
  - **Blocks**: 8, 9
  - **Blocked By**: 1（005 迁移）、2（SaleExtraInfo 类型）

  **References**:
  - `src/main/db/repositories/sale.repo.ts` — DAL 风格 + FK 注意事项（foreign_keys=ON）
  - `src/main/db/migrations/005_customer_order_extras.sql`（任务 1 产出）— 表结构事实源
  - `src/shared/types/domain.ts` 的 `SaleExtraInfo`（任务 2 产出）— getWithCustomer 返回形状

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/db/sale-extra.repo.test.ts` → PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 引用语义——客户档案更新后查询反映最新（happy path，★需求核心定案）
    Tool: Bash
    Preconditions: 内存 DB 全迁移；已有 customer(id=1, phone='13800138000', name='张三')
    Steps:
      1. insert(100, {customer_id: 1, is_national_subsidy: 1, order_note:'备注A', salesperson:'李四'})
      2. getWithCustomer(100) → customer.name === '张三'
      3. customers 表 UPDATE name='张三丰' 后再查
    Expected Result: 第二次查询 customer.name === '张三丰'（JOIN 最新，非快照）
    Evidence: .omo/evidence/task-5-reference-semantics.txt

  Scenario: upsert 幂等与无行 null（edge）
    Tool: Bash
    Steps:
      1. getWithCustomer(999) → null（无行）
      2. upsert(200, {...}) 建行；再次 upsert(200, {order_note:'新'}) 
      3. SELECT COUNT(*) FROM sale_extras WHERE sale_id=200
    Expected Result: COUNT === 1 且 order_note === '新'（ON CONFLICT 更新非重复建行）
    Evidence: .omo/evidence/task-5-upsert-idempotent.txt
  ```

  **Commit**: YES
  - Message: `feat(db): sale_extras repo`
  - Files: `src/main/db/repositories/sale-extra.repo.ts`, `tests/unit/db/sale-extra.repo.test.ts`

- [x] 6. salesperson 历史读通道（main 组装）

  **What to do**:
  - 在 `src/main/ipc/settings.ipc.ts`（或新文件 `src/main/ipc/salesperson-history.ipc.ts`，与现有组织一致性优先）注册 `'settings:getRecentSalespersons'` handler：`settingsRepo.get(RECENT_SALESPERSONS_KEY)` → `parseRecentSalespersons()` → `string[]`
  - `src/main/index.ts` 注册点接线（若新增独立 ipc 文件）
  - 单测：handler 层组装（repo 返回 null/损坏 JSON/合法 JSON 三态 → []/[]/数组）
  - **写入路径不在本任务**——checkout 事务内与 updateExtra 内写（任务 8），本任务只交付读通道

  **Must NOT do**:
  - 不把 recent_salespersons 加进 AppSettings 白名单/rowsToAppSettings/appSettingsPatchToKv（定案：不进契约）
  - 不做写通道（写入随结账事务，避免独立写通道造成缓存与销售脱钩）

  **Recommended Agent Profile**:
  - **Category**: `quick`（一个 handler + 接线 + 单测）
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with Tasks 4, 5）
  - **Blocks**: 8
  - **Blocked By**: 2（通道契约）、3（parse 纯函数）

  **References**:
  - `src/main/ipc/settings.ipc.ts:183-200` — registerSettingsIpc 的 handler 注册模式（懒 require electron）
  - `src/main/services/salesperson-history.ts`（任务 3 产出）— parse 函数与 KEY 常量
  - `src/main/db/repositories/settings.repo.ts:26-33` — get(key) 返回 null 语义

  **Acceptance Criteria**:
  - [ ] `npx vitest run`（settings/ipc 相关测试）→ PASS
  - [ ] settings:get 通道的 AppSettings 返回值不含 recent_salespersons（白名单不泄漏——回归断言）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 读通道三态（happy path）
    Tool: Bash
    Preconditions: handler 已注册（vitest 环境模拟 repo）
    Steps:
      1. repo 无 key → invoke 返回 []
      2. repo 返回 '["张三","李四"]' → 返回 ['张三','李四']
    Expected Result: 两断言成立
    Evidence: .omo/evidence/task-6-read-channel.txt

  Scenario: 白名单不泄漏（edge，V6 定案回归）
    Tool: Bash
    Steps:
      1. settings 表写入 recent_salespersons='["x"]'
      2. rowsToAppSettings(repo.getAll()) 返回对象
    Expected Result: 返回对象无 recent_salespersons 键（白名单拾取）
    Evidence: .omo/evidence/task-6-whitelist-isolation.txt
  ```

  **Commit**: YES
  - Message: `feat(ipc): salesperson 历史读通道`
  - Files: `src/main/ipc/settings.ipc.ts`（或新 ipc 文件）, `src/main/index.ts`, 对应测试文件

- [x] 7. customer.service + customers.ipc（客户管理业务层）

  **What to do**:
  - 新建 `src/main/services/customer.service.ts`：
    - `list(keyword, limit, offset)` — 透传 repo（keyword trim）
    - `create(input)` — 全字段 trim；phone trim 后非空必填（CUSTOMER_PHONE_REQUIRED）；UPDATE 前查重：findByPhone 已存在 → 抛 `CUSTOMER_PHONE_EXISTS`（中文 message：`该电话已被客户「{name}」使用`）；insert
    - `update(id, patch)` — 同样 trim/查重（**查重排除自身 id**：findByPhone 命中且 id !== 自身 → 冲突）；repo.update + updated_at 刷新；id 不存在 → `CUSTOMER_NOT_FOUND`
    - 错误模式照抄 `sale.service.ts:29-46`（ServiceError 类 + 错误码常量 + 中文 message），如 `CustomerServiceError`
    - UNIQUE 兜底：insert/update 捕获 SQLITE_CONSTRAINT_UNIQUE → 映射为 CUSTOMER_PHONE_EXISTS（belt-and-suspenders）
  - 新建 `src/main/ipc/customers.ipc.ts`：三通道薄层注册（照 sales.ipc 模式：参数校验 + 调 service）；`src/main/index.ts` 接线
  - 单测 `tests/unit/services/customer.service.test.ts`：创建冲突（含错误 message 内容断言）、更新排除自身（改自己的电话为原值不冲突）、更新撞他人电话冲突、trim 落库（' 138… ' → '138…'）、list 搜索

  **Must NOT do**:
  - 不做删除；不做订单数/消费统计聚合；不在 service 里做电话格式校验（只 trim 非空）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`（校验/冲突/trim 语义多，错误码模式需精确复刻）
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（with Tasks 8, 9）
  - **Blocks**: 11
  - **Blocked By**: 4（customers.repo）、2（契约）

  **References**:
  - `src/main/services/sale.service.ts:29-46` — ServiceError 类 + 错误码 + 中文 message 模式（**逐字复刻此风格**）
  - `src/main/ipc/sales.ipc.ts` — IPC 薄层模式（参数校验 + service 调用 + 注册函数签名）
  - `src/main/db/repositories/customer.repo.ts`（任务 4 产出）— 可用方法面

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/services/customer.service.test.ts` → PASS（≥6 用例）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 电话冲突友好错误（happy path，Q2 定案）
    Tool: Bash
    Preconditions: 已有 customer(phone='13800138000', name='张三')
    Steps:
      1. create({name:'李四', phone:'13800138000', address:'', note:''})
    Expected Result: 抛 CustomerServiceError，code='CUSTOMER_PHONE_EXISTS'，message 含「张三」
    Evidence: .omo/evidence/task-7-phone-conflict.txt

  Scenario: 更新排除自身 + trim（edge）
    Tool: Bash
    Preconditions: customer(id=1, phone='13800138000')
    Steps:
      1. update(1, {phone:'13800138000', name:'张三改'}) → 成功（同号同人不冲突）
      2. update(1, {phone:' 13900139000 '}) → 落库后 getById(1).phone === '13900139000'
    Expected Result: 两断言成立（trim 落库定案）
    Evidence: .omo/evidence/task-7-update-self-trim.txt
  ```

  **Commit**: YES
  - Message: `feat(customer): 客户管理 service 与 IPC`
  - Files: `src/main/services/customer.service.ts`, `src/main/ipc/customers.ipc.ts`, `src/main/index.ts`, `tests/unit/services/customer.service.test.ts`

- [x] 8. sale.service 扩展：checkout 事务 + updateExtra + getDetail（★核心任务）

  **What to do**:
  - `src/main/services/sale.service.ts` 扩展（**签名追加可选参，存量 423 单测零破坏**）：
    - `checkout(items: CheckoutItem[], extras?: CheckoutExtrasInput): SaleDetail`
    - `assertValidExtras(extras)` service 层镜像校验（前端规则不是防线，IPC 可直达）：全字段 trim 后判定——name 或 address 非空 ⇒ phone 必填（`SALE_EXTRAS_PHONE_REQUIRED`）；is_national_subsidy=true ⇒ name+phone 必填（`SALE_EXTRAS_SUBSIDY_REQUIRES_CUSTOMER`）
    - checkout 事务内（现有流程全部不动，在 `createSaleWithItems` 拿到 saleId **之后**追加——FK 顺序）：
      1. 判断"有无任一附加内容"（trim 后 customer 四字段/subsidy/order_note/salesperson 全空 → 不写任何附加行，散客快单路径与现状完全一致）
      2. 有 phone：`customerRepo.findByPhone(trim(phone))` → 命中 → `customerRepo.update(id, {name, address, note})`（**PUT 全量覆盖，phone 列不动——Q1 电话只读查找键定案**）；未命中 → `customerRepo.insert(...)`
      3. `saleExtraRepo.insert(saleId, { customer_id, is_national_subsidy, order_note, salesperson })`
      4. salesperson trim 后非空 → `settingsRepo.get(KEY)` → `pushRecentSalesperson` → `settingsRepo.set(KEY, json)`（**事务内**，Q6 定案——回滚不残留）
    - `updateExtra(saleId, patch): SaleDetail` — 自有事务：
      - `saleRepo.getById` 不存在 → `SALE_NOT_FOUND`；status === 'voided' → `SALE_ALREADY_VOIDED`（Q4 定案，复用现有错误码命名风格）
      - 校验同 assertValidExtras（旧单勾国补同样要求 name+phone——Q5 定案）
      - 客户 patch 语义（Q5）：`customer: null` 或电话空 → customer_id 置 NULL（解绑）；电话非空 → find-or-create（同 checkout 路径，永不 UPDATE phone）
      - `saleExtraRepo.upsert(saleId, ...)`（全空结果**行保留**，Q5 定案）
      - salesperson 变更 → 更新缓存（本事务内）
    - `getDetail` 扩展：现有查询后 `saleExtraRepo.getWithCustomer(saleId)` → `SaleDetail.extras`（无行 → null）
    - **D-SN8 豁免注释**：在 checkout 函数头部注释显式引用 D-SN8 并说明"本事务跨 repo 调用（customer/sale-extra/settings），被调方法均单语句无自有事务，SAVEPOINT 降级安全（sale.repo.ts:4-7 先例）"
  - `src/main/ipc/sales.ipc.ts`：checkout handler 解析 `req.extras` 透传；注册 `'sales:updateExtra'`
  - 单测 `tests/unit/services/sale.service.extras.test.ts`（新建文件，不动存量 sale.service.test.ts）：
    - **回滚原子性主测试**（Metis 指定的验收主测试）：extras 全填 + 预置 SN 已售商品触发校验失败（校验先于 INSERT，sale.service.ts:117-157 模式）→ 事务抛错 → 断言 customers 0 行、sale_extras 0 行、settings 无 recent_salespersons、sales 0 行
    - 快单（extras undefined/全空）→ sale_extras 0 行、customers 0 行
    - 新电话+姓名 → customers 1 行、extras 行 customer_id 正确、国补/备注/销售人员落库
    - 同电话二次结账 → customers 仍 1 行、两单 extras 同一 customer_id
    - 预填客户被改 name/address（含清空 note）→ 档案 PUT 更新、phone 未变
    - salesperson='张三' 结账 → settings recent_salespersons 含 ["张三"]；连续 11 个名字 → 长度 10
    - updateExtra：voided 单拒绝；旧单无行 upsert 建行；电话清空解绑；新电话 find-or-create；国补无客户拒绝
    - getDetail：有/无 extras 两态

  **Must NOT do**:
  - **不改动现有 checkout 主流程任何一行逻辑**（单号/快照/SN/库存/流水）；不把 checkout 改成单 req 对象签名（V9 红线）；不在事务内做任何非 DB 操作（G3）
  - 不 UPDATE customers.phone（结账链路，Q1）；不删除 sale_extras 行（Q5）

  **Recommended Agent Profile**:
  - **Category**: `deep`（全应用最核心事务的扩展 + 回滚原子性验证，一处顺序错误即数据损坏）
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 7/9 不同文件）
  - **Parallel Group**: Wave 3（with Tasks 7, 9）
  - **Blocks**: 10, 12
  - **Blocked By**: 2（契约）、4（customer.repo）、5（sale-extra.repo）、6（KEY 常量虽在任务 3，读通道不依赖但复用常量）

  **References**:
  - `src/main/services/sale.service.ts:108-157` — checkout 现有事务结构（校验→INSERT→SN→库存）；追加点的精确位置
  - `src/main/services/sale.service.ts:13-15` — G3 零 I/O 论证与单线程竞态论证先例（新注释同款风格）
  - `src/main/services/sale.service.ts:29-46` — 错误码模式（SALE_NOT_FOUND 等命名风格）
  - `src/main/db/repositories/sale.repo.ts:3-11` — D-SN8 + SAVEPOINT 豁免依据
  - `src/main/services/salesperson-history.ts`（任务 3）— pushRecentSalesperson/KEY
  - `src/shared/types/domain.ts` 的 CheckoutExtrasInput（任务 2）

  **WHY Each Reference Matters**: checkout 是 G2 定义的全应用最核心事务——扩展点选错（如 INSERT 前做 customer upsert 会在校验失败时残留客户行）。插入顺序 = createSaleWithItems 之后是 FK 强制，也是原子性边界。

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/services/sale.service.extras.test.ts` → PASS（≥12 用例）
  - [ ] `npx vitest run tests/unit/services/sale.service.test.ts` → 存量全绿（零破坏证明）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 回滚原子性主测试（★验收主测试）
    Tool: Bash
    Preconditions: 内存 DB；预置 SN 商品且 SN 已售（触发校验失败）；checkout 请求带完整 extras（电话 13800138000/姓名张三/国补 true/备注/销售人员李四）
    Steps:
      1. 调 checkout(items 含已售 SN, extras) → 抛 SALE_SN_SOLD
      2. 逐表断言：SELECT COUNT(*) FROM customers / sale_extras / sales → 全 0
      3. SELECT value FROM settings WHERE key='recent_salespersons' → 无行
    Expected Result: 四表零残留（缓存写入随事务回滚）
    Evidence: .omo/evidence/task-8-rollback-atomicity.txt

  Scenario: 同电话二次结账去重（happy path）
    Tool: Bash
    Steps:
      1. checkout(A, extras: phone=13800138000, name=张三) → 成功
      2. checkout(B, extras: phone=13800138000, name=张三) → 成功
      3. SELECT COUNT(*) FROM customers → 1；两单 getDetail().extras.customer_id 相同
    Expected Result: 客户表单行、两单同引用（电话去重定案）
    Evidence: .omo/evidence/task-8-phone-dedup.txt

  Scenario: 电话只读查找键（Q1 定案，edge）
    Tool: Bash
    Preconditions: customer(id=1, phone='13800138000', name='张三')
    Steps:
      1. checkout(extras: phone='13800138000', name='张三丰', address='新路', note='')
      2. getById(1)
    Expected Result: name='张三丰'、address='新路'、note=''（PUT 清空）、phone 仍 '13800138000'
    Evidence: .omo/evidence/task-8-phone-readonly-key.txt

  Scenario: voided 单 updateExtra 拒绝（Q4 定案，edge）
    Tool: Bash
    Steps:
      1. checkout 成功后 voidSale(saleId)
      2. updateExtra(saleId, {is_national_subsidy: true})
    Expected Result: 抛 SaleServiceError code='SALE_ALREADY_VOIDED'，sale_extras 行内容不变
    Evidence: .omo/evidence/task-8-voided-guard.txt
  ```

  **Commit**: YES
  - Message: `feat(sale): 结账附加信息事务与 updateExtra`
  - Files: `src/main/services/sale.service.ts`, `src/main/ipc/sales.ipc.ts`, `tests/unit/services/sale.service.extras.test.ts`
  - Pre-commit: `npm run typecheck && npx vitest run tests/unit/services/`

- [x] 9. 报表原子任务：国补小计 + 明细两列（后端 + 三导出器 + 前端）

  **What to do**（**8 处同步面必须一个任务原子完成，禁止拆分造成中间态**）:
  - `src/main/db/repositories/report.repo.ts`：
    - `dailyTotalsStmt` 扩展：`LEFT JOIN sale_extras se ON se.sale_id = s.id` + `COALESCE(SUM(CASE WHEN se.is_national_subsidy = 1 THEN s.total_cents ELSE 0 END), 0) AS subsidy_total_cents`（同 WHERE 剔除 voided 自动成立；NULL 行天然归非国补）
    - `dailySalesStmt` 扩展：LEFT JOIN 取 `se.is_national_subsidy, se.order_note`（无行 → repo 层映射 is_national_subsidy=false、order_note=null）
    - **月报两语句一字不动**（Must NOT）
  - `src/main/services/report.service.ts`：DTO 组装透传（subsidy_total_cents + sales 映射为 SaleWithExtras）
  - `src/main/export/txt.exporter.ts`：`DETAIL_COLUMNS` **尾部**追加【是否国补(8)】【订单备注(20)】两列（备注超宽 truncateToGrid 截断——文档化接受）；行组装数组尾部加 2 值（国补渲染 '是'/'否'）；汇总块**尾部**追加"国补销售额:"行（照"总销售额"行格式）
  - `src/main/export/xlsx.exporter.ts`：明细 sheet.columns 尾部 2 列 + addRow 尾部 2 值；**`getCell('D')` 金额格式引用不动**（尾部追加零偏移，L71）；汇总 sheet 尾部追加"国补销售额"行（`汇总!B2` 断言坐标不变）
  - `src/main/export/docx.exporter.ts`：明细 makeTable headers 尾部 2 项 + 行 map 尾部 2 值；汇总段落尾部追加国补行
  - `src/renderer/src/views/ReportsView.vue`：日报明细 el-table **尾部** 2 列（国补贴标签 tag、备注 tooltip）；汇总 stat-card **尾部**追加国补销售额卡（`dailyStatValues nth(0)` 存量断言坐标不变）
  - `tests/unit/export/export-report.fixture.ts`：夹具补 extras 场景（国补单/非国补单/无行旧单）
  - 单测断言：txt 输出含"国补销售额:"行且新列在「状态」列之后；xlsx 明细表头 7 列、汇总!B2 仍为总销售额；docx 表 7 表头；subsidy_total_cents = 国补完成单合计（作废剔除）

  **Must NOT do**:
  - 不动月报任何语句/UI/导出；日报明细不加客户姓名列（定案两列）；不改既有列的顺序/宽度（尾部追加原则）；不修导出器间列配置重复的既有结构（范围纪律）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`（8 处同步面 + 夹具 + 多处测试，跨 main/renderer 单一关注点）
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 7/8 不同文件；report.repo/service 与 sale.service 无交集）
  - **Parallel Group**: Wave 3（with Tasks 7, 8）
  - **Blocks**: -（无下游实现任务，E2E 由任务 13/14 覆盖）
  - **Blocked By**: 2（SaleWithExtras/DailyReport 扩展契约）、5（sale_extras 表存在）

  **References**:
  - `src/main/db/repositories/report.repo.ts:27-49` — 四条 prepared statement 现状（dailyTotals/dailySales 扩展点；monthly 两语句为禁区）
  - `src/main/export/txt.exporter.ts:19-31, 42, 56-57, 70` — DETAIL_COLUMNS/BUCKET_COLUMNS 结构、truncateToGrid、汇总块、行组装
  - `src/main/export/xlsx.exporter.ts:43-46, 62-73` — 汇总 sheet、明细 columns/addRow、**L71 getCell('D') 硬编码**（尾部追加的唯一理由）
  - `src/main/export/docx.exporter.ts:55-56, 67-74` — 汇总段、makeTable headers/rows
  - `src/renderer/src/views/ReportsView.vue:206-217, 226-243` — stat-card 区与日报 el-table（尾部追加锚点）
  - `tests/unit/export/export-report.fixture.ts` — 共享夹具（补 extras 场景）
  - `tests/e2e/reports.spec.ts:223, 262, 283-296` — `dailyStatValues nth(0)`/`汇总!B2` 存量断言坐标（尾部追加的 E2E 兼容依据）

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/export/ tests/unit/db/report.repo.test.ts` → PASS（含新列/小计断言）
  - [ ] `npm run typecheck` 零错误（SaleWithExtras 映射链）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 国补小计口径（happy path，含作废剔除）
    Tool: Bash
    Preconditions: 3 笔完成单（2 国补 10.00+20.00 元、1 非国补 5.00 元）+ 1 笔作废国补单 99.00 元
    Steps:
      1. service.daily(当日)
      2. 断言 subsidy_total_cents === 3000、总合计 === 3500
      3. 明细 3 行：国补行 is_national_subsidy===true、order_note 正确；无 extras 旧单 is_national_subsidy===false && order_note===null
    Expected Result: 上述字面值断言全部成立
    Evidence: .omo/evidence/task-9-subsidy-subtotal.txt

  Scenario: 三导出器尾部追加坐标（edge，E2E 兼容性）
    Tool: Bash
    Steps:
      1. txt 导出 buffer → 解码断言：'国补销售额:' 行存在；明细行头含'是否国补'且位于'状态'之后
      2. xlsx 导出 → 解析明细 sheet 表头第 6/7 列为'是否国补'/'订单备注'；汇总!B2 仍为总销售额数值
      3. docx 导出 → 表头数组长度 7
    Expected Result: 三格式断言全部成立，既有列坐标零位移
    Evidence: .omo/evidence/task-9-export-columns.txt
  ```

  **Commit**: YES
  - Message: `feat(report): 日报国补小计与明细两列（含导出器）`
  - Files: `report.repo.ts`, `report.service.ts`, `txt/xlsx/docx.exporter.ts`, `ReportsView.vue`, `export-report.fixture.ts`, 相关测试
  - Pre-commit: `npm run typecheck && npx vitest run tests/unit/export/`

- [x] 10. CheckoutDialog 结账弹窗 + PosView 接线

  **What to do**:
  - 新建 `src/renderer/src/components/cart/CheckoutDialog.vue`（或 `src/renderer/src/components/checkout/`，与现有组织一致）：
    - 顶部显示合计金额（读 cart store）
    - 客户信息组：【姓名】【电话】【地址】【客户备注】四输入框
    - 订单信息组：【是否参与国补】switch、【订单备注】textarea、【销售人员】el-select（filterable + allow-create + default-first-option，选项来自 `api.settings.getRecentSalespersons()`）
    - 交互规则：
      - **电话失焦 → `api` 查客户（需一个按电话查的途径：customers:list keyword=phone 或专用——用 customers:list keyword 精确匹配后取 phone 全等项）→ 命中 → 预填姓名/地址/客户备注（提示"已关联客户 张三"）**；未命中清提示
      - ElForm 校验（镜像 service 规则）：name 或 address 非空 ⇒ phone 必填；国补开 ⇒ name+phone 必填；错误文案中文
      - 确认按钮：提交中 loading（防双击）；成功 → 关闭 + 走现有后续（cart.clear + 小票预览）；失败 → ElMessage 错误、弹窗不关
      - 取消 → 直接关闭，购物车完整保留（零落库）
    - 挂载时加载销售人员历史（下拉选项）
  - `PosView.vue` 接线：
    - `checkout()` 改为打开 CheckoutDialog（弹窗内确认时才调 `api.sales.checkout(items, extras)`）
    - **扫码守卫**：`handleBarcode` 头部追加 `if (checkoutDialogVisible.value) return`（照 PosView.vue:125-127 SnEntryDialog 模式）
  - 组件单测（vitest + @vue/test-utils，照 tests/unit/components 既有模式）：校验规则矩阵、电话失焦预填、取消保留

  **Must NOT do**:
  - 不改 cart.store 结构；不改小票预览调用链；不做"记住上次客户"/会员卡；不在弹窗内改价/改数量（那些仍在 CartPanel）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`（表单 UI 密集 + 交互规则 + Element Plus 组件）
  - **Skills**: [`frontend-ui-ux`]（无设计稿的表单弹窗 UI 打磨）
  - **Skills Evaluated but Omitted**: `playwright`（E2E 在任务 13/14 统一处理）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4（with Tasks 11, 12）
  - **Blocks**: 13, 14
  - **Blocked By**: 8（checkout IPC 就绪）

  **References**:
  - `src/renderer/src/views/PosView.vue:120-128` — SnEntryDialog 扫码守卫先例（**逐字复刻**）；`checkout()` 现有实现（改造基点：183-185 附近的成功后处理保留）
  - `src/renderer/src/components/cart/CartPanel.vue` — 结账按钮 emit 模式（不改此文件，按钮行为不变，只是 PosView 响应改为开弹窗）
  - `src/renderer/src/components/sn/SnEntryDialog.vue`（如存在，以实际为准）— 对话框组件组织模式
  - Element Plus el-select filterable/allow-create — 销售人员快选交互
  - `src/preload/index.ts` 的 api.customers.list / api.settings.getRecentSalespersons / api.sales.checkout（任务 2/6 产出）

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/components/CheckoutDialog.test.ts` → PASS（校验矩阵 + 预填 + 取消）
  - [ ] `npm run typecheck:web` 零错误

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 散客快单路径不被拖慢（happy path，★核心 UX 底线）
    Tool: tmux + Bash（npm run dev）
    Preconditions: 购物车有 1 件商品；打开 CheckoutDialog
    Steps:
      1. 不填任何字段，直接点「确认结账」
      2. 断言：落库成功、sale_extras 0 行（node 直读 DB）、小票预览打开、购物车清空
    Expected Result: 零填写一步确认完成结账（与现状等价路径）
    Evidence: .omo/evidence/task-10-quick-checkout.txt

  Scenario: 国补必填联动 + 电话预填（happy path）
    Tool: tmux（npm run dev）
    Preconditions: 已有客户 phone=13800138000 name=张三
    Steps:
      1. 打开弹窗，电话框输入 13800138000 → blur → 姓名框自动出现"张三"
      2. 打开国补 switch，清空姓名 → 点确认 → 表单报"参与国补需填写客户姓名和电话"
      3. 恢复姓名，确认 → 落库，DB 断言 is_national_subsidy=1
    Expected Result: 预填与校验联动正确
    Evidence: .omo/evidence/task-10-subsidy-validate.txt

  Scenario: 扫码守卫（edge，Q8 定案）
    Tool: tmux（npm run dev）
    Steps:
      1. CheckoutDialog 打开状态下模拟扫码输入（barcode 字符序列）
    Expected Result: 不触发商品查询/加购，购物车不变（handleBarcode 提前 return）
    Evidence: .omo/evidence/task-10-scanner-guard.txt

  Scenario: 取消路径（edge）
    Tool: tmux（npm run dev）
    Steps:
      1. 填写客户信息后点「取消」
    Expected Result: 弹窗关闭、购物车完整保留、DB 零新行
    Evidence: .omo/evidence/task-10-cancel-path.txt
  ```

  **Commit**: YES
  - Message: `feat(pos): 结账弹窗 CheckoutDialog`
  - Files: `src/renderer/src/components/.../CheckoutDialog.vue`, `src/renderer/src/views/PosView.vue`, 组件测试

- [x] 11. CustomersView 客户管理页面 + 路由 + 菜单

  **What to do**:
  - 新建 `src/renderer/src/views/CustomersView.vue`（照 ProductsView 模式）：
    - 顶部搜索框（keyword，同时匹配姓名/电话）+「新增客户」按钮
    - 表格列：姓名/电话/地址/客户备注/创建时间/更新时间 + 操作列【编辑】
    - 新增/编辑弹窗（el-dialog + el-form）：四字段，电话必填（前端校验）；提交后 CUSTOMER_PHONE_EXISTS 错误 → ElMessage 展示后端中文 message
    - 分页（照 products 分页模式）
  - `src/renderer/src/router/index.ts` 追加路由 `/customers`
  - `src/renderer/src/App.vue` menus 数组追加「客户管理」（菜单项放置位置：销售记录之后、报表之前，与业务流一致）
  - 组件单测：列表加载/搜索、新增冲突错误展示、编辑保存

  **Must NOT do**:
  - 不做删除按钮/接口；不做订单数/消费额列；不做导入导出

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`（标准 CRUD 页面 + 弹窗表单）
  - **Skills**: [`frontend-ui-ux`]
  - **Skills Evaluated but Omitted**: `playwright`（E2E 在任务 13/14）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4（with Tasks 10, 12）
  - **Blocks**: 14
  - **Blocked By**: 7（customers IPC 就绪）

  **References**:
  - `src/renderer/src/views/ProductsView.vue` — CRUD 页面 + 搜索 + 分页 + 弹窗表单的完整模板（**主要参照**）
  - `src/renderer/src/router/index.ts` — 路由注册模式（7 条既有路由）
  - `src/renderer/src/App.vue` — menus 数组（侧边菜单追加锚点）
  - `src/preload/index.ts` 的 api.customers.list/create/update

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/components/CustomersView.test.ts` → PASS
  - [ ] `npm run typecheck:web` 零错误

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 增改查闭环 + 电话冲突（happy path）
    Tool: tmux（npm run dev）
    Steps:
      1. 导航到 /customers（菜单点击）
      2. 新增：姓名=张三 电话=13800138000 → 列表出现
      3. 再新增：姓名=李四 电话=13800138000 → ElMessage 显示「该电话已被客户「张三」使用」
      4. 编辑张三 → 改姓名张三丰 → 列表更新
      5. 搜索"138" → 1 行；搜索"李四" → 0 行
    Expected Result: 五步全部符合预期
    Evidence: .omo/evidence/task-11-crud-flow.png + .txt

  Scenario: 空列表态（edge）
    Tool: tmux
    Steps:
      1. 全新 userData 启动 → /customers
    Expected Result: 空态提示正常渲染（无报错、无幽灵行）
    Evidence: .omo/evidence/task-11-empty-state.png
  ```

  **Commit**: YES
  - Message: `feat(customer): 客户管理页面与路由菜单`
  - Files: `src/renderer/src/views/CustomersView.vue`, `src/renderer/src/router/index.ts`, `src/renderer/src/App.vue`, 组件测试

- [x] 12. SalesHistoryView 明细弹窗扩展：显示客户信息 + 编辑附加信息

  **What to do**:
  - `src/renderer/src/views/SalesHistoryView.vue` 明细弹窗（el-dialog）扩展：
    - **展示区**：客户信息块（姓名/电话/地址/客户备注——来自 detail.extras.customer，extras 为 null 时显示"散客/未填写"占位）；订单附加块（国补贴 tag、订单备注、销售人员）
    - **编辑区**（仅 status==='completed' 单可见；voided 单整体禁用置灰——Q4 UI 面）：
      - 国补 switch / 订单备注 textarea / 销售人员（快选下拉，同 CheckoutDialog 模式）/ 客户电话输入（失焦查客户显示"将关联：张三"；清空 → 显示"将解绑客户"）
      - 「保存修改」→ `api.sales.updateExtra(sale_id, patch)` → 成功后刷新 detail（新客户信息立即反映——引用语义的 UI 验证点）；CUSTOMER_PHONE_EXISTS/校验错误 → ElMessage
  - sales:list 列表页本身**零改动**（Must NOT）
  - 组件单测：编辑区可见性（voided 置灰）、保存后刷新、电话解绑提示

  **Must NOT do**:
  - 不动 sales:list 列格/筛选；不允许编辑金额/商品/数量/时间（编辑区仅四个附加字段）；不做作废入口变更

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`（弹窗 UI 扩展 + 编辑表单）
  - **Skills**: [`frontend-ui-ux`]
  - **Skills Evaluated but Omitted**: `playwright`（E2E 在任务 13/14）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4（with Tasks 10, 11）
  - **Blocks**: 14
  - **Blocked By**: 8（updateExtra/detail IPC 就绪）

  **References**:
  - `src/renderer/src/views/SalesHistoryView.vue` — 现有明细弹窗结构（扩展锚点：明细表格后的区域）
  - `src/shared/types/domain.ts` 的 SaleDetail.extras / SaleExtraInfo（任务 2）
  - 任务 10 的销售人员快选模式（复用同一组件或抽取共用子组件——若抽取，仅限 renderer 内部共用，不做过早抽象）
  - `src/preload/index.ts` 的 api.sales.updateExtra / api.sales.detail

  **Acceptance Criteria**:
  - [ ] `npx vitest run tests/unit/components/`（SalesHistory 相关）→ PASS
  - [ ] `npm run typecheck:web` 零错误

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 引用语义 UI 验证（happy path，★需求核心定案）
    Tool: tmux（npm run dev）+ Bash（node 直读 DB）
    Preconditions: 结账建档客户张三(phone=13800138000) 的一笔单
    Steps:
      1. 销售记录双击该单 → 明细弹窗显示客户"张三"
      2. 去客户管理把张三改名为"张三丰"
      3. 回销售记录重新打开同一单明细
    Expected Result: 第三步显示"张三丰"（JOIN 最新，引用定案的端到端验证）
    Evidence: .omo/evidence/task-12-reference-ui.png

  Scenario: voided 单编辑区禁用（edge，Q4）
    Tool: tmux
    Steps:
      1. 作废一笔带附加信息的单 → 打开明细
    Expected Result: 编辑区不可见或整体 disabled；仅展示信息
    Evidence: .omo/evidence/task-12-voided-disabled.png

  Scenario: 订单侧换绑客户（happy path）
    Tool: tmux + Bash
    Steps:
      1. 明细编辑区电话改为新号码 13900139000 → 保存 → DB 断言 find-or-create 建档且 sale_extras.customer_id 指向新客户
      2. 电话清空 → 保存 → customer_id === NULL
    Expected Result: 两步均成立（Q5 语义）
    Evidence: .omo/evidence/task-12-rebind-customer.txt
  ```

  **Commit**: YES
  - Message: `feat(sales): 销售记录明细扩展与附加信息编辑`
  - Files: `src/renderer/src/views/SalesHistoryView.vue`, 组件测试

- [x] 13. E2E 存量适配：17 个结账点击点 + helper

  **What to do**:
  - 适配 CheckoutDialog 引入后的存量 E2E（改动**仅限**"点击结账后补一次确认点击"）：
    - 逐文件逐点击点处理 `.cart-panel__checkout` 点击序列（点击结账 → 弹窗出现 → 点击「确认结账」）：
      - `tests/e2e/pos.spec.ts` × 5 处
      - `tests/e2e-qa/qa-integration.spec.ts` × 4 处（★注意：qa 套件在独立目录 `tests/e2e-qa/`，由 `playwright.qa.config.ts` 驱动，**不在** `npm run test:e2e` 的 testDir 内）
      - `tests/e2e-qa/qa-edge.spec.ts` × 4 处
      - `tests/e2e/print-flow.spec.ts` × 2 处
      - `tests/e2e/sn-products.spec.ts` × 1 处 + `checkoutAndWaitPreview` helper（L86 附近）更新——helper 更新后部分调用点自动兼容
      - `tests/e2e/template-editor.spec.ts` × 1 处
    - 验证 reports.spec 存量断言零改动仍绿（`dailyStatValues nth(0)`、`汇总!B2`——任务 9 尾部追加的回报）
  - **执行前先 grep 确认清单**：`grep -rn "cart-panel__checkout" tests/e2e/ tests/e2e-qa/` 输出即完整工作清单（两个目录都要），逐项勾选
  - 全量跑两套件至全绿：`npm run test:e2e`（基线）+ `npx playwright test -c playwright.qa.config.ts`（qa 套件）

  **Must NOT do**:
  - 禁止顺手重构无关断言/选择器/等待策略；禁止改动测试的业务语义（只加确认步骤）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`（机械但要求精确，17 处一处遗漏即挂）
  - **Skills**: [`playwright`]（E2E 调试与运行）
  - **Skills Evaluated but Omitted**: `frontend-ui-ux`（不改 UI，只改测试）

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 14 改不同文件：13 改既有 spec，14 新建 spec）
  - **Parallel Group**: Wave 5（with Task 14）
  - **Blocks**: F（FINAL 四审前置）
  - **Blocked By**: 10（CheckoutDialog 就绪）

  **References**:
  - `tests/e2e/sn-products.spec.ts:86-87` — checkoutAndWaitPreview helper（改造基点）
  - `tests/e2e/pos.spec.ts` — 结账路径的既有写法（locator/等待风格）
  - `tests/e2e/reports.spec.ts:223, 262, 283-296` — 不动但必须绿的坐标断言
  - 任务 10 产出的 CheckoutDialog 确认按钮 selector（以实际实现为准）

  **Acceptance Criteria**:
  - [ ] `npm run test:e2e` → 全绿（基线存量场景含适配后全部通过）
  - [ ] `npx playwright test -c playwright.qa.config.ts` → 全绿（qa 套件 8 点击点适配验证——独立门禁，不可遗漏）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 存量全量回归（happy path）
    Tool: Bash
    Preconditions: 任务 1-12 全部完成
    Steps:
      1. npm run test:e2e
      2. npx playwright test -c playwright.qa.config.ts
    Expected Result: 两套件全部场景 PASS，0 fail（17 点击点——含 e2e-qa 的 8 点——全部适配完成的无声证明）
    Failure Indicators: 任何 spec timeout on .cart-panel__checkout 后续流程 = 遗漏未适配点
    Evidence: .omo/evidence/task-13-e2e-regression.txt

  Scenario: reports 存量断言零改动证明（edge）
    Tool: Bash
    Steps:
      1. git diff tests/e2e/reports.spec.ts
    Expected Result: diff 为空（或仅空白）——日报坐标断言未被触碰
    Evidence: .omo/evidence/task-13-reports-spec-untouched.txt
  ```

  **Commit**: YES
  - Message: `test(e2e): 结账弹窗存量场景适配`
  - Files: `tests/e2e/` 4 个 spec 文件 + `tests/e2e-qa/` 2 个 spec 文件
  - Pre-commit: `npm run test:e2e && npx playwright test -c playwright.qa.config.ts`

- [x] 14. E2E 新场景：客户与附加信息全覆盖

  **What to do**:
  - 新建 `tests/e2e/customer-extras.spec.ts`（9 组场景，复用既有 helper/page-object 模式）：
    1. **散客快单**：结账零填写 → 落库成功 + node 直读 DB 断言 sale_extras 0 行
    2. **新客建档**：结账填姓名+电话+地址 → DB 断言 customers 1 行 + extras 关联
    3. **同电话关联**：二次结账同电话 → DB 断言 customers 仍 1 行
    4. **必填校验×2**：填姓名不填电话 → 阻断；勾国补不填姓名 → 阻断（表单红字）
    5. **预填**：已有客户电话失焦 → 姓名自动带出
    6. **salesperson 记忆**：结账填"张三" → 第二次结账下拉出现"张三"
    7. **订单侧改附加**：销售记录明细改国补/备注/换绑客户 → 保存后 detail 刷新正确
    8. **客户管理**：新增/编辑/搜索 + 电话冲突 ElMessage
    9. **日报导出三格式**：勾国补结账后日报导出 txt/xlsx/docx → 读回断言新列与国补小计（照 reports.spec 既有读回模式）
  - 全量 `npm run test:e2e` 三绿收尾

  **Must NOT do**:
  - 不为测试目的给生产代码加测试钩子/环境变量（用既有 E2E_EXPORT_DIR 等已备钩子）；场景断言用具体值

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`（9 组场景业务语义覆盖 + DB 断言 + 导出读回）
  - **Skills**: [`playwright`]
  - **Skills Evaluated but Omitted**: `frontend-ui-ux`（纯测试）

  **Parallelization**:
  - **Can Run In Parallel**: YES（与 13 不同文件）
  - **Parallel Group**: Wave 5（with Task 13）
  - **Blocks**: F
  - **Blocked By**: 10, 11, 12（三前端任务就绪）

  **References**:
  - `tests/e2e/pos.spec.ts` — 结账 E2E 的 locator/DB 断言既有风格
  - `tests/e2e/reports.spec.ts:283-296` — 导出读回断言模式（E2E_EXPORT_DIR + 坐标断言）
  - `tests/e2e/` 既有 page-object/helper（复用，不重造）

  **Acceptance Criteria**:
  - [ ] `npm run test:e2e` → 全绿（含新 spec ≥9 场景）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 9 组新场景全绿（happy path）
    Tool: Bash
    Preconditions: 任务 13 已合并（或同波完成）
    Steps:
      1. npx playwright test tests/e2e/customer-extras.spec.ts
    Expected Result: 全部场景 PASS；每个场景含至少一个具体值断言（电话 13800138000/姓名张三/小计 3000 等）
    Evidence: .omo/evidence/task-14-new-scenarios.txt

  Scenario: 导出读回含新列（edge）
    Tool: Bash
    Steps:
      1. 场景 9 执行后读 E2E_EXPORT_DIR 产物
      2. xlsx 明细表头第 6 列 === '是否国补'；汇总块含国补销售额且数值正确
    Expected Result: 坐标断言成立
    Evidence: .omo/evidence/task-14-export-readback.txt
  ```

  **Commit**: YES
  - Message: `test(e2e): 客户与附加信息新场景`
  - Files: `tests/e2e/customer-extras.spec.ts`
  - Pre-commit: `npm run test:e2e`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .omo/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `npm run typecheck` + `npx vitest run`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state (`npm run dev` in tmux). Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration（结账建档 → 客户管理改档案 → 订单查询显示最新；勾国补结账 → 日报小计+导出两列）. Test edge cases（取消结账/双击确认/空散客快单）. Save to `.omo/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance (sales 表未动/月报未动/打印未动/sales:list 未动). Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

每任务一 commit（波内并行任务各自独立 commit，Sisyphus 编排顺序合并）：

- 1: `feat(db): 005 迁移新增 customers 与 sale_extras 表`
- 2: `feat(shared): 客户/附加信息契约层（domain/ipc/preload）`
- 3: `feat(main): salesperson 最近输入纯函数`
- 4: `feat(db): customers repo`
- 5: `feat(db): sale_extras repo`
- 6: `feat(ipc): salesperson 历史读通道`
- 7: `feat(customer): 客户管理 service 与 IPC`
- 8: `feat(sale): 结账附加信息事务与 updateExtra`
- 9: `feat(report): 日报国补小计与明细两列（含导出器）`
- 10: `feat(pos): 结账弹窗 CheckoutDialog`
- 11: `feat(customer): 客户管理页面与路由菜单`
- 12: `feat(sales): 销售记录明细扩展与附加信息编辑`
- 13: `test(e2e): 结账弹窗存量场景适配`
- 14: `test(e2e): 客户与附加信息新场景`

Pre-commit: `npm run typecheck && npx vitest run`（涉及对应测试文件）

---

## Success Criteria

### Verification Commands

```bash
npm run typecheck          # Expected: node+web 双侧零错误
npm test                   # Expected: 全部通过（存量 423 + 新增）
npm run test:e2e           # Expected: 全部通过（适配 + 新场景）
node -e "..."              # PRAGMA user_version === 5；表结构核对
```

### Final Checklist

- [ ] All "Must Have" present（事务原子性/镜像校验/尾部追加/通道同步）
- [ ] All "Must NOT Have" absent（sales 表/月报/打印/sales:list/Sale DTO 零触碰）
- [ ] All tests pass（三绿门槛）
- [ ] 回滚原子性主测试通过
- [ ] 散客快单路径保留（一键结账不被拖慢）
