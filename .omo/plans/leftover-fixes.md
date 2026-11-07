# 遗留三题修复（leftover-fixes）

> customer-order-extras 终审后用户确认的三项遗留修复。方案已在终审呈报中给出并获用户确认。
> 状态：✅ 全部完成（commits 4d9bab4 / 4e1f25a / a1fdcc5）
>
> **最终验收（四绿）**：typecheck 零错误 · vitest 693 passed · 基线 e2e 88/88 · qa 套件 20/20（级联 11 个全恢复）
> 附注：qa-helpers 扫码注入改同步连发（对共享机负载免疫）；发现 printing.store.ts 第 5 份 extractIpcErrorMessage 拷贝（不在授权集，留档未动）

## L1. qa 套件存量失败修复（A1-进货 / A3-模板编辑）

**根因**（4920f1f 实证存量）：SN 商品波次后进货表单改"空态+手动加行"、模板列表断言过期；qa 套件 serial 级联掩盖 A3。

**修复**：
- `tests/e2e-qa/qa-integration.spec.ts` A1：适配新表单（点「+ 批量计商品」加行后再走原断言链）
- A3：对比基线 template-editor.spec.ts 的造数/断言方式，修正 qa 版陈旧断言
- **只修测试适配，不改生产代码**（基线套件全绿证明 UI 无恙）

**验收**：`npx playwright test -c playwright.qa.config.ts` 全绿（21/21）

## L2. 客户备注缝隙：service 层纵深防御

**问题**：只填【客户备注】不填电话 → service 宽松放行 → note 无建档载体静默丢弃（UI 已拦截，但 IPC 可绕过 UI——前端规则不是防线）。

**修复**（用户知悉语义边界后确认固化）：
- `sale.service.ts` assertValidExtras/updateExtra 校验：note 与 name/address 同列触发 phone 必填
- 文案统一：`'填写客户信息时，电话不能为空'`（原 name/address 版文案 + UI note 版文案合一）
- 同步：CheckoutDialog 校验器文案、sale.service.extras.test.ts、customer-extras.spec.ts 场景 4 断言

**验收**：单测新增 note 触发用例；全量 vitest/e2e 绿

## L3. F2 三 nit 清理

- a) `sales.ipc.ts:51` `req?.extras ?? undefined` → `req?.extras`
- b) `extractIpcErrorMessage` 提取 shared util（PosView/ProductsView/SnEntryDialog/CustomersView 四处统一）
- c) `sale-extra.repo.ts` upsert UPDATE 语句缓存（照 customer.repo updateStmtCache 模式）

**验收**：typecheck + vitest 全绿；行为零变化

## 最终验收（四绿）

`npm run typecheck` + `npx vitest run` + `npm run test:e2e` + `npx playwright test -c playwright.qa.config.ts`

---

## 追加需求变更（2026-11-07）：销售记录列表增强 —— ✅ 已完成（commits fd137ae/39f08f7/a64597c）

- 列表新增 5 列：姓名/电话/是否国补/销售人员/订单备注（状态后、操作前；国补 tag 照既有惯例；null → — 占位）
- 筛选新增 3 项：姓名（模糊）/电话（模糊）/是否国补（全部/是/否 三态——无附加行归非国补，与报表口径一致）
- 契约：SaleListItem extends Sale（五平铺列）；sales:list req + 三筛选键；双 LEFT JOIN 平铺；全参数绑定 + escapeLike
- 验收四绿：typecheck 0 错误 / vitest 702 / 基线 e2e 91/91（+3 新场景 10a/10b/10c）/ qa 20/20
