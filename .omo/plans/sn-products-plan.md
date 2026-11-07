# 实施计划：SN 序列号商品支持

> 状态：待评审 | 前置：需求已全部收敛（见「已锁定决策」）
> 范围：全链路（数据库迁移 → 契约 → 主进程 → 渲染层 → 小票 → 测试）

---

## 1. 背景与目标

系统现有商品一律按数量计（`products.stock` 整数计数，允许负库存 D2）。新增第二类商品 **SN 商品**：每个个体有全局唯一 SN，一物一码，入库逐个录 SN，收银扫 SN 直接加购。原【批量计商品】逻辑完全不动。

**术语约定**（下文统一使用）：
- **批量计商品** `tracking='quantity'`：现有逻辑
- **SN 商品** `tracking='sn'`：本次新增

## 2. 已锁定决策（需求快照，不可变更）

| # | 决策 |
|---|---|
| D-SN1 | 商品二分：批量计 / SN，**禁止互转**（products.tracking 建后不可改） |
| D-SN2 | 建档：添加商品时选类型；SN 商品多一项【SN 前缀】（可空），仅用于**进货侧**扫 SN 自动匹配商品 |
| D-SN3 | SN 表：一行一 SN，记录 SN↔商品映射，**无 quantity 列**；**逻辑删除**（deleted 标记） |
| D-SN4 | SN **全局唯一**（partial unique index `WHERE deleted=0`）；已删除 SN 可重新入库（新建 active 行） |
| D-SN5 | 收银扫码路由：**先查 SN 表** → 命中在库即加购；未命中查商品码 → 命中 SN 商品则弹 SN 输入窗（与双击同一弹窗，支持扫码枪扫入）；批量计商品走原逻辑 |
| D-SN6 | SN 拒绝态（不产生负库存语义）：SN 不存在 / 已售 / 不属于该商品 → 明确报错 |
| D-SN7 | 购物车：SN 行 quantity 恒 1、**禁用 D16 合并**、同一 SN 禁止重复加入、单价可改（独立价格） |
| D-SN8 | 结账/作废：单事务内 SN 状态流转（`in_stock→sold` / `sold→in_stock`）+ `products.stock` ±1 同步维护 |
| D-SN9 | 进货：添加行双按钮【SN 商品】【批量计商品】；**新建进货单默认 0 行**；SN 行数量 = SN 个数（禁手填）；单内允许混排两类行；进货页引入扫码（扫 SN 追加 + 即时查重） |
| D-SN10 | 进货行成本价：**UI 同一商品行单一成本价输入，落库展开为每 SN 一行独立 `cost_price_cents`**（值相同） |
| D-SN11 | SN 商品**禁用**手动库存调整（products:updateStock）与建档初始库存字段 |
| D-SN12 | 小票明细展示 SN；销售记录明细、导出带 SN |
| D-SN13 | `products.stock` 对 SN 商品继续冗余维护（= 在库 SN 数，同事务绑定）；`stock_movements` 审计链 source 枚举**不变**（删 SN 走 `manual`） |
| D-SN14 | SN 前缀校验：非空前缀之间**不得相同、不得互为前缀**（商品保存时校验） |
| D-SN15 | 商品删除：**有在库 SN 的 SN 商品禁止删除**（提示先处理 SN）；已售历史靠 sale_items 快照保留 |
| D-SN16 | SN 浏览（商品管理页）：**el-table 展开行**；默认在库，可切换含已售（状态 + 关联单号）；在库 SN 可删（逻辑删除 + manual 流水 -1）；**不提供手动添加 SN**（一律进货录入） |
| D-SN17 | 已售 SN 重复进货 → 拒绝并提示原销售单号（引导作废流程）；不做部分退货/已售重入库 |

## 3. 现状关键事实（代码坐标）

| 模块 | 文件 | 关键点 |
|---|---|---|
| 迁移 | `src/main/db/migrator.ts` + `migrations/00{1,2}_*.sql` | `PRAGMA user_version` 顺序应用；当前 version=2；新迁移 = `?raw` import + 数组注册 |
| 商品契约 | `src/shared/types/domain.ts` | `Product` 7 字段；`CartItem`/`CheckoutItem`/`SaleItem`/`PurchaseItem` 均无 SN 概念 |
| IPC 契约 | `src/shared/types/ipc.ts` | `IpcChannels` 接口 + `IPC_CHANNEL_NAMES` 数组（satisfies 约束，**两处都要加**） |
| 商品服务 | `src/main/services/product.service.ts` | `normalizeBarcode`、`BARCODE_CONFLICT`；`products:update` 仅允许 name/price |
| 商品 DAL | `src/main/db/repositories/product.repo.ts` | `search`（name LIKE %kw% OR barcode LIKE kw%）、`findByBarcode`、`updateStock`、硬删 |
| 销售事务 | `src/main/services/sale.service.ts` | `checkout`（L89：快照→INSERT→adjustStock→movements）、`voidSale`（L157：markVoided→逐行 adjustStock 回滚）；错误码模式 `SaleServiceError` |
| 销售 DAL | `src/main/db/repositories/sale.repo.ts` | `adjustStock`（`stock = stock + ?`）、`createSaleWithItems`、`dailyCount` |
| 进货事务 | `src/main/services/purchase.service.ts` + `purchase.repo.ts` | `validateItems`（事务外快速失败）+ `createOrderWithItemsTx`（单事务：快照→INSERT items→stock+=→movements） |
| 收银台 | `src/renderer/src/views/PosView.vue` | `handleBarcode`→`lookupBarcode`（products:list + 客户端 `barcode===code` 精确比对）；`addToCart` 是扫码/双击**唯一汇聚点**；miss → flashSearchMiss + "未找到条码商品" |
| 购物车 | `src/renderer/src/stores/cart.store.ts` | D16 合并：`find(product_id && unit_price_cents)` → qty+1（L46-51）；`updateQty`/`updatePrice` |
| 购物车 UI | `src/renderer/src/components/cart/CartPanel.vue` | 行编辑（数量/单价）、库存不足黄条（`stockByProduct`） |
| 进货 UI | `src/renderer/src/views/PurchasesView.vue` | 下拉选商品（**无扫码**）+ 数量（step-strictly 正整数）+ 成本价；默认 1 行；前端校验 L79-93 |
| 商品 UI | `src/renderer/src/views/ProductsView.vue` | 表单 4 字段（条码/名称/库存/默认售价）；库存调整入口 |
| 销售记录 | `src/renderer/src/views/SalesHistoryView.vue` | 作废/明细弹窗/重打 |
| 扫码 | `src/main/scanner/*` + `src/preload/index.ts` | 桥全局广播 `scanner:barcode`，任意页面可订阅 `onBarcode`；`BarcodeInput.vue` 有「不处理 Enter 防双路径重复」经验 |
| 打印 | `src/main/printing/` + `src/shared/receipt/` | 模板 JSON 唯一事实源，ESC/POS 与 HTML 双渲染同源；`printing:preview` 消费 `SaleDetail` |

## 4. 数据库设计（migration 003）

新建 `src/main/db/migrations/003_sn_products.sql`，`migrator.ts` 注册 `{ version: 3, name: '003_sn_products.sql', sql }`：

```sql
-- ═══ 商品类型（批量计/sn 计，建后不可转——D-SN1）═══
ALTER TABLE products ADD COLUMN tracking TEXT NOT NULL DEFAULT 'quantity'
  CHECK (tracking IN ('quantity','sn'));
ALTER TABLE products ADD COLUMN sn_prefix TEXT NOT NULL DEFAULT '';  -- 空串=无前缀

-- ═══ SN 台账（一行一个体，无 quantity——D-SN3；逻辑删除——D-SN3/4）═══
CREATE TABLE product_sns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  sn                TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','sold')),
  deleted           INTEGER NOT NULL DEFAULT 0,
  purchase_item_id  INTEGER REFERENCES purchase_items(id),  -- 进货来源行
  sale_item_id      INTEGER REFERENCES sale_items(id),      -- 销售去向行（在库为 NULL）
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- 全局唯一仅约束未删除行（已删 SN 可重新入库——D-SN4）
CREATE UNIQUE INDEX idx_product_sns_sn_active ON product_sns(sn) WHERE deleted = 0;
CREATE INDEX idx_product_sns_product ON product_sns(product_id, status) WHERE deleted = 0;

-- ═══ 明细行 SN 快照（G4 延伸：商品硬删后 SN 历史可读——D-SN12）═══
ALTER TABLE sale_items     ADD COLUMN sn TEXT;  -- 批量计行 NULL
ALTER TABLE purchase_items ADD COLUMN sn TEXT;
```

**存量兼容**：`tracking DEFAULT 'quantity'` 使存量商品无感升级；`sn/sale_items.sn/purchase_items.sn` 均 nullable，存量行不受影响。

**一致性模型**（D-SN8/13）：`products.stock` 对 SN 商品 = 在库 SN 数（冗余汇总），`product_sns` 为明细真相。两者在同一事务内变更（stock ±N 与 SN 状态流转原子绑定），better-sqlite3 同步事务 + SQLite 单写者保证无竞态。

## 5. 契约变更（shared/types）

### 5.1 domain.ts

```typescript
export type ProductTracking = 'quantity' | 'sn'

export interface Product {
  // ...现有字段不变
  tracking: ProductTracking   // 新增
  sn_prefix: string           // 新增（空串=无前缀）
}

export interface CartItem {
  // ...现有字段不变
  sn: string | null           // 新增：SN 行标识；批量计行 null
}

export interface CheckoutItem {
  product_id: number
  quantity: number            // SN 行恒 1（service 校验）
  unit_price_cents: number
  sn: string | null           // 新增：SN 行必填非空（service 校验）
}

export interface SaleItem { /* + */ sn: string | null }
export interface PurchaseItem { /* + */ sn: string | null }

/** 进货行（联合类型——D-SN9/10） */
export type PurchaseInputItem =
  | { kind: 'quantity'; product_id: number; quantity: number; cost_price_cents: number }
  | { kind: 'sn'; product_id: number; sns: string[]; cost_price_cents: number }

/** SN 台账行（商品管理 SN 浏览 / findSn 用——D-SN16） */
export interface ProductSn {
  id: number
  product_id: number
  sn: string
  status: 'in_stock' | 'sold'
  /** 已售时关联销售单（listSns JOIN sale_items 取，跳转用）；在库为 null */
  sale_id: number | null
  sale_no: string | null
  created_at: string
}
```

### 5.2 ipc.ts

```typescript
// 变更（req/res 结构演化，唯一调用方在本计划内同步改造，无兼容负担）
'products:create': { req: { barcode; name; default_price_cents; stock; tracking: ProductTracking; sn_prefix?: string } }
  // service：tracking='sn' 时 stock 强制 0（忽略入参）
'products:update': { req: { id; name; default_price_cents; sn_prefix?: string } }
  // SN 前缀可改（影响以后进货匹配）；tracking 不在可改字段中（D-SN1）
'purchases:create': { req: { note; items: PurchaseInputItem[] } }
'sales:checkout':  { req: { items: CheckoutItem[] } }   // CheckoutItem 加 sn

// 新增通道（IPC_CHANNEL_NAMES 数组同步追加）
'products:findSn':   { req: { sn: string }; res: { sn: ProductSn; product: Product } | null }
  // 仅查 deleted=0；收银扫码第一优先级（D-SN5）+ SN 弹窗校验共用
'products:listSns':  { req: { product_id: number; include_sold: boolean }; res: ProductSn[] }
'products:deleteSn': { req: { sn_id: number }; res: { ok: true } }
  // 仅允许删 in_stock（已售拒绝）；逻辑删除 + stock-1 + movements(source='manual')
```

### 5.3 新增错误码（沿用各 service 的 `*ServiceError(code, 中文文案)` 模式）

```
product.service:  PRODUCT_SN_PREFIX_CONFLICT（前缀相同/互为前缀）
                  PRODUCT_SN_HAS_STOCK（在库 SN 未清空，禁删商品）
                  PRODUCT_SN_NO_MANUAL_STOCK（SN 商品禁手动调整库存）
                  PRODUCT_SN_NOT_DELETABLE（该 SN 已售，不可删除）
purchase.service: PURCHASE_INVALID_SN（空 SN / 非字符串）
                  PURCHASE_SN_EXISTS（SN 已在库或已售——文案带原单号）
                  PURCHASE_SN_DUP_IN_ORDER（本单内 SN 重复）
                  PURCHASE_TYPE_MISMATCH（行类型与商品 tracking 不符）
sale.service:     SALE_SN_REQUIRED（SN 行缺 sn / quantity≠1）
                  SALE_SN_NOT_FOUND / SALE_SN_SOLD / SALE_SN_PRODUCT_MISMATCH
```

## 6. 分阶段任务

### Phase 0：数据层 + 契约冻结（一切并行的前提）

| # | 任务 | 文件 |
|---|---|---|
| T0.1 | 003 迁移 SQL（§4 DDL）+ migrator 注册 version 3 | `migrations/003_sn_products.sql`、`migrator.ts` |
| T0.2 | domain.ts 契约扩展（§5.1 全部类型） | `src/shared/types/domain.ts` |
| T0.3 | ipc.ts 通道扩展（§5.2，含 `IPC_CHANNEL_NAMES`） | `src/shared/types/ipc.ts` |

**验收**：`npm run typecheck` 通过（此阶段会暴露所有未适配点——预期 products.ipc / 各 service / 各 View 报缺字段错误，属预期信号，在 Phase 1/2 内消除）；迁移单测（见 T4.1）通过。

> 执行提示：T0.2/T0.3 会造成编译错误扩散，这是**契约先行**的刻意结果。Phase 0 完成后立即进入 Phase 1，编译错误按 service 归属收敛。

### Phase 1：主进程（repo → service → ipc）

| # | 任务 | 要点 |
|---|---|---|
| T1.1 | product.repo 扩展 | ① `list/search` SELECT 加 tracking/sn_prefix；② `findSnActive(sn)` → JOIN products（deleted=0）；③ `listSns(product_id, include_sold)` → LEFT JOIN sale_items 取 sale_id/sale_no；④ `softDeleteSn(sn_id)`（UPDATE deleted=1, updated_at）；⑤ `listSnPrefixes(excludeId?)` 供前缀互斥校验 |
| T1.2 | product.service 扩展 | ① create：tracking/sn_prefix 入参，sn 时 stock 置 0、sn_prefix 归一化（trim，空→''）；② 前缀互斥校验（非空前缀之间不得相同/互为前缀——D-SN14）；③ update：允许改 sn_prefix（同校验）；④ delete 守卫：SN 商品存在 deleted=0 的 SN 行 → 拒绝（D-SN15）；⑤ updateStock 守卫：tracking='sn' → 拒绝（D-SN11）；⑥ findSn/listSns/deleteSn：删 SN = 单事务 { 逻辑删除 + stock-1 + movements(source='manual', change_qty=-1) }，仅 in_stock 可删 |
| T1.3 | purchase.service/repo 扩展 | ① `validateItems` 适配联合类型：quantity 行原校验；sn 行 = product_id 正整数 + sns 非空数组 + 每 SN 非空字符串 + 无本单重复 + cost_price_cents 非负；② 事务内：逐 SN 查 `findSnActive`——存在 → `PURCHASE_SN_EXISTS`（文案带状态/原单号）；商品 tracking 必须为 'sn'（`PURCHASE_TYPE_MISMATCH`）；③ 落库：每 SN 一行 purchase_items（quantity=1, sn, cost_price_cents=同商品行值——D-SN10）+ INSERT product_sns（in_stock, purchase_item_id）+ stock += sns.length + movements 照写；④ 新增 helper `matchProductBySnPrefix(sn)` → { product } \| { ambiguous: Product[] } \| null（非空前缀 startsWith 匹配，供进货页扫码自动填充用，**不阻塞落库**——落库只信任 product_id） |
| T1.4 | sale.service/repo 扩展 | ① `assertValidItems`：sn 非空行 → quantity 必须 =1（`SALE_SN_REQUIRED`）；② checkout 事务内：SN 行查 `findSnActive(sn)`——null → `SALE_SN_NOT_FOUND`；status='sold' → `SALE_SN_SOLD`；product_id 不符 → `SALE_SN_PRODUCT_MISMATCH`；③ 落库：sale_items 加 sn 快照列；SN 行 UPDATE product_sns（status='sold', sale_item_id, updated_at）+ adjustStock(-1) + movements（D-SN8）；批量计行原逻辑不动；④ voidSale：SN 行（sale_items.sn 非空）→ UPDATE product_sns（status='in_stock', sale_item_id=NULL）+ 原有 stock 回滚；商品已硬删的行维持现状（跳过复原） |
| T1.5 | ipc 装配 | `products.ipc.ts` 注册 findSn/listSns/deleteSn；create/update 透传新字段；`purchases.ipc.ts`/`sales.ipc.ts` 契约随类型自动收窄 |

**验收**：`npm run typecheck:node` 通过；T4.1 对应单测通过（单测随任务同步写，不留尾部欠账）。

### Phase 2：渲染层（契约已冻结，四路并行）

| # | 任务 | 要点 |
|---|---|---|
| T2.A | PosView + cart.store + CartPanel | ① `lookupBarcode` 改造：**第一步** `products:findSn(code)` → 命中 in_stock → 加购 SN 行（qty=1, sn）；命中 sold → ElMessage「该 SN 已售出（单号 xxx）」终止；**第二步**（miss）原商品码链路 → 命中且 tracking='sn' → 打开 SN 输入弹窗；命中批量计 → 原逻辑；② `addToCart` 分流：SN 商品一律先弹 SN 输入窗（扫码/双击双入口同一拦截点）；③ SN 弹窗：复用 `BarcodeInput.vue` 模式（扫码枪可扫入 + 手输），确认时 `findSn` 校验（不存在/已售/不属于该商品 → 对应报错文案），通过则加购；④ cart.store：`CartItem.sn`；`addItem` SN 行 key = product_id + unit_price_cents + **sn**（禁合并）；同 SN 已在车 → 拒绝（ElMessage）；`updateQty` 对 sn≠null 行忽略；⑤ CartPanel：SN 行显示 SN（名称副行），数量控件 disabled，库存不足黄条对 SN 行屏蔽（无负库存语义——D-SN6） |
| T2.B | PurchasesView | ① 新建单默认 **0 行**（空态提示）；「+ 添加行」拆双按钮【SN 商品】【批量计商品】；② 批量计行 = 原结构原校验；③ SN 行 = 商品下拉（filterable）+ SN 子列表（输入框回车/扫码追加，逐条即时查重：本单重复标红；`findSn` 命中标红并提示「已在库/已售」）+ **单一成本价输入框**（对该行全部 SN 生效——D-SN10）+ 单 SN 移除按钮；④ 页面订阅 `onBarcode`（onMounted 订阅/onUnmounted 退订，参照 PosView 模式）：扫码 → 当前聚焦 SN 行追加；若 SN 未入库 → `matchProductBySnPrefix` 唯一命中自动填充该行商品（无前缀/歧义 → 提示手动选择，不自动填）；⑤ 提交：行混合序列化为 `PurchaseInputItem[]`（sn 行数量 = sns.length，禁手填）；前端校验：SN 行商品必选 + SN 列表非空 + 无重复 |
| T2.C | ProductsView | ① 表单：新增类型选择（radio：批量计商品 / SN 商品）；选 SN 时显示【SN 前缀】输入框（placeholder 说明用途）+ **隐藏初始库存字段**；批量计保持原样；② 编辑弹窗：SN 商品显示前缀（可改）；类型不可改（不展示切换）；「调整库存」按钮对 SN 商品隐藏/禁用；③ 列表：tracking 标识（Tag：SN / 空）；库存列 SN 商品显示在库 SN 数（即 stock——D-SN13 冗余值）；④ el-table `type="expand"` 展开行（D-SN16）：懒加载 `listSns`；默认在库，toggle 含已售；表格列 = SN / 状态 / 关联单号（已售，可跳销售记录）/ 入库时间 / 操作（在库行有「删除」，确认弹窗 → `deleteSn`）；⑤ 删除商品：后端守卫错误 → ElMessage 展示（「请先处理在库 SN」）；⑥ 前缀输入即时校验提示（保存时以 service 校验为准） |
| T2.D | SalesHistoryView | 明细弹窗表格加「SN」列（null 显示 —） |

**验收**：`npm run typecheck:web` 通过；`npm run dev` 手动冒烟：全链路（建档 SN 商品→进货扫 SN→收银扫 SN 结账→小票预览→作废→再扫该 SN 提示已售）走通。

### Phase 3：小票打印

| # | 任务 | 要点 |
|---|---|---|
| T3.1 | ESC/POS 生成器 | 明细区 SN 行渲染：名称行 + SN 副行（缩进）；**列宽策略**：80mm/48 列、58mm/32 列，SN 超长截断（保留前 N-1 列 + `…`，全码已在数据层，仅纸面截断）；双倍宽行不用于 SN 副行 |
| T3.2 | HTML 预览 | 与 ESC/POS **同源**渲染（共享 char-grid 数学——现有 G7 铁律），预览所见即纸面 |
| T3.3 | 模板体系适配 | SN 副行作为明细行**默认行为**（数据驱动：item.sn 非空即渲染），**不加模板配置项、不做模板迁移**——所有存量模板自动获得 SN 展示；检查 template-schema 明细渲染管线确认注入点 |

**验收**：golden 字节矩阵新增 SN 用例（58/80 双纸宽）；`printing:preview` 返回的 SaleDetail.items 已含 sn（T1.4 自动获得）；作废重打 footer「已作废」逻辑不受影响。

### Phase 4：测试收口

| # | 任务 | 覆盖 |
|---|---|---|
| T4.1 | vitest 单测（随各 Phase 同步写，此处收口清点） | ① 迁移：003 后新列/新表/partial index 存在性 + 存量数据 tracking='quantity'；② product.service：前缀互斥（相同/互为前缀/空/自身编辑排除自己）、删商品守卫、updateStock 守卫、deleteSn 流水（manual -1）+ 已售拒绝；③ purchase.service：SN 行展开落库（N 行 purchase_items + N 条 SN 台账 + stock+N）、SN 重复（库内/本单）、类型不符、混单、前缀匹配 helper（唯一/歧义/无）；④ sale.service：SN 结账状态流转 + sale_item_id 回写、四类拒绝态、void 回滚（sold→in_stock + stock+1）、批量计回归；⑤ cart.store：SN 行禁合并、同 SN 拒绝、qty 锁 1 |
| T4.2 | Playwright E2E | ① 全链路：建 SN 商品（前缀）→ 进货页双按钮添加 SN 行→扫码录入（mock onBarcode 或 keyboard）→ 提交 → 商品页展开行见在库 SN → 收银台扫 SN 加购 → 结账 → 小票预览含 SN → 作废 → 展开行状态回在库 → 再扫该 SN 提示已售；② 扫商品码弹窗输入 SN 结账；③ 双击 SN 商品弹窗；④ 批量计商品全流程回归（零行为变化）；⑤ 58mm 模板预览 SN 截断 |

**验收**：`npm test` 全绿（存量 423 用例零回归 + 新增全绿）；`npm run test:e2e` 全绿（存量 63 场景零回归 + 新增全绿）；`npm run typecheck` 通过。

## 7. 执行顺序与并行图

```
Phase 0 (T0.1→T0.2→T0.3，串行，~半天)
   │ 契约冻结
   ▼
Phase 1 (T1.1 → T1.2 / T1.3 / T1.4 并行 → T1.5)
   │ 主进程可测（vitest 免 Electron）
   ▼
Phase 2 ──┬── T2.A 收银台链路
          ├── T2.B 进货页            （四路并行）
          ├── T2.C 商品管理页
          └── T2.D 销售记录
   │
Phase 3 (T3.1/T3.2 并行 → T3.3)   ← 依赖 T1.4 落库 + T2.A 预览入口，可与 T2.B/C/D 并行启动
   │
Phase 4 (T4.1 贯穿各 Phase；T4.2 最后收口)
```

## 8. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | `purchases:create` req 结构破坏性变更 | 唯一调用方 PurchasesView 在 T2.B 同步改造；无外部消费者 |
| R2 | SN 弹窗内扫码枪双路径重复（扫码枪 Enter 会同时到达聚焦输入框与全局桥） | 复用 `BarcodeInput.vue` 的「输入框不处理 Enter」既有模式；弹窗内扫码统一走 onBarcode 桥 |
| R3 | 58mm 32 列下 SN 展示溢出 | T3.1 截断策略 + golden 测试锁定；全码保存在数据层 |
| R4 | stock 与 SN count 漂移（理论上一致性破坏） | 全部变更同事务（better-sqlite3 同步事务原子性）；可在 T4.1 加一致性断言用例（每次操作后 stock === COUNT(sns in_stock)） |
| R5 | 契约先行导致 Phase 0 后编译错误大面积泛红 | 预期行为；错误按 service 归属在 Phase 1 收敛，renderer 侧在 Phase 2 收敛 |
| R6 | 模板渲染管线是配置驱动，SN 注入点不清 | T3.3 前先读 template-schema 明细渲染管线再定注入方式；兜底方案 = preview/print 数据组装层注入（模板不变） |
| R7 | 前缀 startsWith 匹配大小写/空白问题 | SN 与前缀统一 trim；匹配大小写敏感（与 barcode BINARY collation 一致），在 service 层归一化处理 |

## 9. 明确不做（边界）

- 手动添加 SN 入口（一律进货录入——D-SN16）
- 已售 SN 重入库 / 部分退货（D-SN17，走整单作废）
- 收银台搜索框按 SN 搜索商品（SN 加购仅扫码/弹窗两入口）
- SN 批量导入（Excel 等，可作后续增强）
- SN 前缀用于收银侧（仅进货侧匹配）
- 库存流水 UI 查询入口（维持现状）

## 10. 交付物清单

1. `migrations/003_sn_products.sql` + migrator 注册
2. shared/types 契约（domain.ts + ipc.ts）
3. 主进程：product/purchase/sale 三条 service+repo 链 + ipc 装配
4. 渲染层：PosView / cart.store / CartPanel / PurchasesView / ProductsView / SalesHistoryView
5. 打印：ESC/POS 生成器 + HTML 预览 SN 渲染 + golden 用例
6. 测试：单测新增（估计 40+ 用例）+ E2E 新增场景（估计 8-10 个）
