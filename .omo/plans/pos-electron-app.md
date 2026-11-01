# Electron 桌面销存系统（POS）从零搭建

## TL;DR

> **Quick Summary**: 从零搭建 Windows 桌面销存系统（Electron + Vue 3 + TS + better-sqlite3），含商品/进货/销售/报表全链路，以及独立设计的打印子系统（JSON 模板 → ESC/POS 字节 + HTML 预览双渲染同源）。
>
> **Deliverables**:
> - 可安装的 Windows NSIS 安装包（GitHub Actions windows-latest CI 产出）
> - 完整进销存功能：商品管理、进货入库、销售结账（购物车）、作废销售、销售记录、日/月报表
> - 独立打印子系统：小票模板体系（表单式编辑 + 实时预览）、ESC/POS 指令生成（spooler RAW 主通道 / tcp 辅 / 串口备）、58/80mm 双纸宽
> - 报表导出：.txt / .xlsx / .docx
> - 《Windows 真机验证清单》文档（真机打印验证指引）
>
> **Estimated Effort**: XL（20 个实现任务 + 4 个终审任务，8 个执行波次）
> **Parallel Execution**: YES - 8 waves（1a 脚手架 → 1b 五并行 → 1c → 2a 六并行 → 2b 三并行 → 3a 三并行 → 3b 收尾 → FINAL）
> **Critical Path**: 1 脚手架 → 3 契约 → 10 结账事务 → 11 收银台 UI → 15 打印编排集成 → 20 CI/打包 → F1-F4

---

## Context

### Original Request

用户从零搭建 Windows 桌面 Electron 销存系统（POS/进销存），功能清单：

1. **商品管理**：新增（条码、名称、初始库存）/ 编辑（名称、库存）/ 删除 / 搜索过滤（名称或条码）
2. **销售结账**：条码扫描或双击商品 → 购物车（可自定义数量和单价）；购物车增删改、清空、自动合计；一键结账（自动扣库存、保存销售记录）；结账后弹出小票预览窗口
3. **小票打印**：选择系统打印机；ESC/POS 原始指令直发热敏打印机（粗体、倍高/倍宽、居中、自动切纸）；图片打印（Logo）；销售记录可随时预览/重打
4. **销售记录查询**：双击查看销售明细
5. **报表**：日报（按日统计总销售额、订单数、详细记录）、月报；导出 .txt / .xlsx / .docx

用户第 2 轮追加要求：**软件设计与模块划分**为重点、**良好的 ER 设计**、**打印模块单独设计**（支持打印模板调整小票样式；小票机 ESC/POS 与普通打印机是两种不同机制需区分）。

### Interview Summary

**Key Discussions**:
- 技术栈：Vue 3 + TypeScript（用户选定）
- 业务范围：增加简单进货功能（采购入库单 → 库存自动增加，可查记录）（用户选定）
- 打印无实机：按 ESC/POS 协议实现，字节流断言 + .bin 文件验证，后期真机联调（用户选定）
- 无登录/操作员（用户选定）
- TDD 全覆盖（用户选定）
- 模板编辑：表单式配置 + 实时预览，不做拖拽编辑器（用户选定）
- 纸宽：58mm + 80mm 双支持（用户选定）
- 报表仅导出文件，无普通打印机打印（用户选定）
- 小票预览：HTML 模拟预览 + 立即打印/取消按钮（用户选定）
- 打印机通道：用户打印机已注册为 Windows 系统打印机（Word 可选到）→ **spooler RAW 为主通道**，tcp:// 为辅，串口备（用户确认场景）
- 库存不足：**允许负库存**（用户选定）
- 作废销售：**做简单作废**（回滚库存 + 标记 voided + 报表剔除）（用户选定）
- 数量精度：整数数量 + 金额整数分（用户选定）
- Windows 验收：**GitHub Actions CI（windows-latest）** + 真机打印手动清单（用户选定）

**Research Findings**（librarian 调研 + 源码级验证，2026-11）:
- electron-vite 6.0.0（rolldown-based，externalizeDeps 默认开启，externalizeDepsPlugin 已废弃）；项目结构 src/{main,preload,renderer}
- Electron 45.2.1 才发布 2 天 → **锁 44.x**（Metis 决策）
- better-sqlite3 ^13.0.3：v13 起 N-API、预编译随 npm 包 `prebuilds/`（含 win32-x64），理论上免 rebuild——**但调研内部矛盾（draft L29 vs L52），必须 Day-0 实证 spike**，fallback：12.x + install-app-deps 或 node:sqlite
- node-thermal-printer ^4.6.1（纯 JS 零 rebuild，仅主进程）：接口 `tcp://host:9100` / `printer:名称`（spooler RAW）/ `\\.\COM1`；**无 USB 直连**（USB 打印机装驱动后即系统打印机，走 spooler 通道无碍）；中文 `CharacterSet.CHINA` → iconv-lite 'EUC-CN' 实测输出标准 GBK 字节（'中文测试收银' → `d6d0 cec4 b2e2 cad4 cad5 d2f8`）；切换命令 `ESC R 0x0F`；无 GB18030 全集 → 生僻字降级 printImageBuffer 光栅化；`printImage(path)` / `printImageBuffer(pngBuffer)`（pngjs 解码 → `GS v 0` 光栅位图）；打印机枚举 Electron 内置 `contents.getPrintersAsync()`
- exceljs 4.4.0（维护慢但稳）+ docx 9.15.1（活跃）；主进程 Buffer → `dialog.showSaveDialog` → fs.writeFile
- 扫码枪（keyboard-wedge HID）+ 中文输入法冲突：composition 事件吞快速输入 → 主进程 `before-input-event` 拦截 + 30-50ms 间隔检测 + ≥5 字符阈值；`webContents.sendInputEvent` 大概率不触发 before-input-event（需验证）→ 检测器必须纯函数化
- Electron E2E：Playwright `_electron.launch()` 可驱动 electron-vite 产物

### Metis Review

**Identified Gaps**（全部已解决）:
- 业务规则空洞（库存不足/作废/精度/删除/重复扫码/条码唯一/单号）→ 第 3 轮用户决策全部闭环
- 环境断层（Linux dev → Windows 目标）→ GitHub Actions windows-latest CI + 真机手动清单
- better-sqlite3 v13 信息矛盾 → Day-0 spike S1 + fallback 链
- Electron 45 太新 → 锁 44.x
- 验收标准未落到断言层 → 本计划全部任务带可执行断言（字节序列、CSS 选择器、DB 行数）
- Guardrails G1-G14 → 已写入 Work Objectives 并逐任务引用
- Scope creep 锁定清单 → Must NOT Have（最终 16 项）

---

## Work Objectives

### Core Objective

交付一个可在 Windows 安装运行的桌面销存系统：商品/进货/销售/报表全链路 + 独立打印子系统（模板化小票），全部核心逻辑 TDD 覆盖，CI 在 windows-latest 上自动化验收。

### Concrete Deliverables

- 源码仓库（electron-vite 6 + Vue 3 + TS 项目）
- GitHub Actions workflow（windows-latest：build + vitest + Playwright E2E + NSIS 打包）
- NSIS 安装包（CI artifact）
- 《Windows 真机验证清单》（docs/windows-manual-checklist.md）
- README（含手动备份指引：复制 .db 前关闭应用 / WAL 说明）

### Definition of Done

- [ ] `npm run build` 成功；`npm test`（vitest）全绿；CI windows-latest 全绿
- [ ] Playwright E2E 全场景通过（脚手架 → 结账 → 预览 → 重打 → 报表导出）
- [ ] ESC/POS golden 字节测试矩阵全绿（58/80mm × 粗体/倍高/居中/Logo/切纸）
- [ ] NSIS .exe 在 CI 产出并可启动（CI 内 E2E 验证安装包启动可选）
- [ ] 全部 Must Have 满足、Must NOT Have 为零违反

### Must Have

- 分层架构：renderer → preload(typed contextBridge) → main/ipc → services(纯 TS 可测核心) → repositories → better-sqlite3；打印子系统独立目录
- ER 模型（8 表 + 索引，见 Architecture/ER 章节）：products / purchase_orders + purchase_items / sales + sale_items / stock_movements / print_templates / settings
- 快照不可变：sale_items 与 purchase_items 均含商品快照字段，product_id nullable
- 结账原子性：sales + sale_items + 扣库存 + stock_movements 单事务；任一步失败全回滚（kill-point 测试覆盖）
- 打印与落库解耦：销售先提交；打印异步 best-effort；打印失败绝不丢销售，提供重打路径
- ESC/POS 生成器纯函数：`(template, sale, settings) → Uint8Array`，内部零 I/O
- 双渲染器同源：同一模板 JSON + 共享字符网格数学（58mm=32 列 / 80mm=48 列）→ ESC/POS 字节 + HTML 预览
- 金额端到端整数分（DB INTEGER 列，UI/导出层格式化）；数量整数
- 条码 UNIQUE + nullable；重复扫码合并行（merge key = 商品 + 单价）
- 小票单号 `yyyyMMdd-NNNN`；进货单号同规则
- 负库存允许（无结账拦截）；商品列表负库存标红提示
- 作废销售：事务回滚库存 + status='voided' + 报表剔除
- Schema 版本化：`PRAGMA user_version` + migration runner 从第一天起
- 单实例锁（`app.requestSingleInstanceLock()`）+ DB 在 userData + WAL 模式
- 扫码检测器纯函数（事件流 → 条码 | null）
- 手动改库存必写 stock_movements（source='manual'）
- spooler RAW 主打印通道 + tcp:// 辅 + 串口备，设置页可切换
- 打印任务串行队列（连续结账不交叠）
- 重打使用**当前**模板（决策已定，写入文档）
- GBK 外字符降级策略：该字符替换 `?`（文档化 + 测试）

### Must NOT Have（Guardrails，来自 Metis）

- ❌ G1 违反：任何 float 金额运算（一律整数分）
- ❌ G6 违反：ESC/POS 生成器内部任何网络/打印机 I/O
- ❌ G8 违反：renderer 进程引入 Node 原生依赖；散落的裸 `invoke('xxx')` 魔法字符串（必须走 typed IPC surface）
- ❌ G11 违反：硬编码路径分隔符（一律 path.join）；Windows-only API 无 mock/skip 直接跑 Linux CI
- ❌ 拖拽式模板编辑器、逐行/逐元素级模板样式
- ❌ 部分退货（只做整单作废）
- ❌ 支付方式字段、毛利/利润报表
- ❌ 商品标签/条码打印、Excel 批量导入
- ❌ 低库存预警 / 仪表盘 / 图表
- ❌ 自动更新 / 崩溃上报 / 遥测
- ❌ USB/蓝牙直连打印通道（node-thermal-printer 不支持，不造）
- ❌ 自研 GB18030 编码器（降级到光栅/替换为止）
- ❌ .docx 花式排版（标题 + 简单表格止步）
- ❌ 多窗口并行结账、自定义快捷键系统
- ❌ 备份恢复 UI（README 手动指引代替）
- ❌ 登录/操作员/角色权限体系（用户已确认无登录，打开即用——防止执行期被"顺手"加回）

---

## Architecture Design（用户重点要求：模块划分）

### 分层与目录结构

```
selling-electron/
├── electron.vite.config.ts
├── package.json / tsconfig.json / vitest.config.ts
├── .github/workflows/ci.yml            # windows-latest：build+test+e2e+打包
├── docs/windows-manual-checklist.md    # 真机验证清单
├── resources/                           # 应用图标等
├── src/
│   ├── main/                            # ── 主进程 ──
│   │   ├── index.ts                     # 入口：窗口、单实例锁、IPC 装配
│   │   ├── ipc/                         # 薄层：参数校验 + 调 service + 序列化
│   │   │   ├── products.ipc.ts
│   │   │   ├── purchases.ipc.ts
│   │   │   ├── sales.ipc.ts
│   │   │   ├── reports.ipc.ts
│   │   │   ├── printing.ipc.ts
│   │   │   ├── settings.ipc.ts
│   │   │   └── templates.ipc.ts
│   │   ├── db/
│   │   │   ├── database.ts              # 连接（userData、WAL、外部化依赖）
│   │   │   ├── migrator.ts              # PRAGMA user_version 迁移执行器
│   │   │   ├── migrations/
│   │   │   │   └── 001_init.sql         # ER 全量 DDL（见下节）
│   │   │   └── repositories/            # DAL：纯 SQL，无业务规则
│   │   │       ├── product.repo.ts
│   │   │       ├── sale.repo.ts
│   │   │       ├── purchase.repo.ts
│   │   │       ├── stock-movement.repo.ts
│   │   │       ├── report.repo.ts
│   │   │       ├── settings.repo.ts
│   │   │       └── template.repo.ts
│   │   ├── services/                    # 业务核心：纯 TS + DI（vitest 免 Electron）
│   │   │   ├── product.service.ts       # 含手动改库存→写流水
│   │   │   ├── sale.service.ts          # 结账事务、作废事务
│   │   │   ├── purchase.service.ts      # 进货入库事务
│   │   │   └── report.service.ts        # 日/月聚合（剔除 voided）
│   │   ├── printing/                    # ★ 打印子系统（独立模块）
│   │   │   ├── print.service.ts         # 编排：模板+销售→字节→通道→串行队列/重试
│   │   │   ├── channels/
│   │   │   │   ├── print-channel.ts     # PrintChannel 接口抽象
│   │   │   │   ├── spooler.channel.ts   # 主：Windows spooler RAW（printer:名称）
│   │   │   │   ├── tcp.channel.ts       # 辅：tcp://host:9100
│   │   │   │   ├── serial.channel.ts    # 备：\\.\COM1
│   │   │   │   └── printer-enumerator.ts# getPrintersAsync 封装（Linux 可 mock）
│   │   │   └── escpos/
│   │   │       ├── escpos-generator.ts  # 纯函数：模板+销售→Uint8Array
│   │   │       ├── gb2312-encoder.ts    # GBK 编码 + 生僻字符替换降级
│   │   │       └── char-grid.ts         # 字符网格数学（32/48 列，全角半角宽度）
│   │   ├── export/
│   │   │   ├── export.service.ts        # showSaveDialog + 写文件 + 错误处理
│   │   │   ├── txt.exporter.ts
│   │   │   ├── xlsx.exporter.ts         # exceljs
│   │   │   └── docx.exporter.ts         # docx 库
│   │   └── scanner/
│   │       ├── barcode-detector.ts      # 纯函数：按键事件流→条码|null
│   │       └── scanner-bridge.ts        # before-input-event→喂检测器（薄壳）
│   ├── preload/
│   │   └── index.ts                     # contextBridge 单一类型化 API surface
│   ├── renderer/                        # ── Vue 3 ──
│   │   └── src/
│   │       ├── router/  stores/         # pinia
│   │       ├── views/
│   │       │   ├── PosView.vue          # 收银台（扫码+双击加购+购物车）
│   │       │   ├── ProductsView.vue
│   │       │   ├── PurchasesView.vue
│   │       │   ├── SalesHistoryView.vue # 双击→明细+重打
│   │       │   ├── ReportsView.vue      # 日/月报
│   │       │   ├── TemplateEditorView.vue
│   │       │   └── SettingsView.vue     # 打印机/店铺信息/Logo
│   │       └── components/
│   │           ├── cart/                # CartPanel、CartRow（数量/单价编辑）
│   │           ├── receipt/             # ReceiptPreview（HTML 同源渲染 58/80mm）
│   │           ├── scanner/             # BarcodeInput（扫码焦点管理）
│   │           └── common/
│   └── shared/                          # ── 主/渲染共享契约 ──
│       ├── types/                       # DTO、IPC channel 类型定义（typed invoke）
│       └── receipt/
│           ├── template-schema.ts       # 模板 JSON 类型 + Zod 校验
│           └── default-template.ts      # 默认模板 + 变量插槽定义
└── tests/
    ├── unit/                            # vitest：services/repos/generator/detector/exporters
    ├── e2e/                             # Playwright _electron：全流程
    └── fixtures/                        # .bin golden、seed 数据、模板 JSON
```

### 打印子系统独立设计（用户重点要求）

**核心原则**：模板是唯一事实源；两条渲染路径同源；ESC/POS 生成纯函数化（无实机可测）；通道可插拔。

```
打印模板 JSON（print_templates.config_json）
        │
        ├──→ [ESC/POS 渲染器] escpos-generator (纯函数)
        │        │  char-grid 数学（58mm=32 列/80mm=48 列，全角=2 半角）
        │        │  gb2312-encoder（EUC-CN/GBK + 生僻字替换'?'）
        │        ▼
        │    Uint8Array 字节流 ──→ PrintChannel（串行队列）
        │         ├── spooler.channel（主，printer:名称 RAW）
        │         ├── tcp.channel（辅，net socket 9100）
        │         └── serial.channel（备，\\.\COM1）
        │
        └──→ [HTML 渲染器] ReceiptPreview.vue（等宽 CJK 字体模拟纸宽）
                 └── 预览窗口「立即打印」→ 走同一条 ESC/POS 路径
```

- 模板 schema：段落制（header[] / items / totals[] / footer[]），每段属性：type(text|image|divider)、align、size(normal|double-height|double-width|quad)、bold、content（含 `{变量}` 插槽：shopName/shopPhone/receiptNote/saleNo/datetime/total/itemCount 等）
- 纸宽：模板级 `paperWidth: '58mm' | '80mm'`，两渲染器共享 char-grid 计算
- 打印编排：`print.service.ts` 维护**串行 Promise 队列**（防连续结账交叠）；失败重试 1 次；失败后 UI 明确报错 + 引导历史重打（销售已落库不受影响）

### 数据存储 ER 设计（用户重点要求）

```sql
-- ═══ 商品（含可选默认售价，允许负库存）═══
CREATE TABLE products (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode            TEXT UNIQUE,                    -- 可空：无条码商品靠搜索加购
  name               TEXT NOT NULL,
  default_price_cents INTEGER,                       -- 可空：购物车自动带出可改
  stock              INTEGER NOT NULL DEFAULT 0,     -- 允许负数（用户决策）
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_products_name    ON products(name);
CREATE INDEX idx_products_barcode ON products(barcode);

-- ═══ 进货单（头-行结构，行含商品快照）═══
CREATE TABLE purchase_orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no   TEXT NOT NULL UNIQUE,                   -- yyyyMMdd-NNNN
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE purchase_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id      INTEGER REFERENCES products(id),   -- nullable：商品可硬删
  product_name    TEXT NOT NULL,                     -- ── 快照字段 ──
  barcode         TEXT,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  cost_price_cents INTEGER NOT NULL CHECK (cost_price_cents >= 0)
);
CREATE INDEX idx_purchase_items_order ON purchase_items(order_id);

-- ═══ 销售单（头-行结构，行含商品快照，支持作废）═══
CREATE TABLE sales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_no    TEXT NOT NULL UNIQUE,                   -- yyyyMMdd-NNNN
  total_cents INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  voided_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_sales_created_at ON sales(created_at);
CREATE TABLE sale_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id         INTEGER NOT NULL REFERENCES sales(id),
  product_id      INTEGER REFERENCES products(id),   -- nullable：快照设计
  product_name    TEXT NOT NULL,                     -- ── 快照字段 ──
  barcode         TEXT,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  subtotal_cents  INTEGER NOT NULL
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

-- ═══ 库存流水（审计链：sale/purchase/manual/void 全覆盖）═══
CREATE TABLE stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  change_qty  INTEGER NOT NULL,                      -- 正=入库 负=出库
  before_stock INTEGER NOT NULL,
  after_stock  INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('sale','purchase','manual','void')),
  source_id   INTEGER,                               -- sale_id / order_id / NULL
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_movements_product ON stock_movements(product_id);

-- ═══ 打印模板 / 系统设置 ═══
CREATE TABLE print_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  paper_width TEXT NOT NULL DEFAULT '80mm' CHECK (paper_width IN ('58mm','80mm')),
  config_json TEXT NOT NULL,                         -- 模板 JSON（shared/receipt schema）
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- shop_name/shop_phone/receipt_note/logo_path/
    -- printer_channel('spooler'|'tcp'|'serial')/printer_name/tcp_host/tcp_port/com_port/auto_cut
```

**ER 关系图（文字版）**：
```
products 1───N purchase_items N───1 purchase_orders
products 1───N sale_items     N───1 sales
products 1───N stock_movements（source_id 松引用 sales/purchase_orders）
print_templates、settings 独立
关键设计：sale_items/purchase_items 的 product_id nullable + 快照字段 → 商品硬删后历史完整可读
```

### 关键业务规则（已定案）

| 规则 | 决策 |
|---|---|
| 库存不足结账 | 允许负库存，不拦截；商品列表负库存标红 |
| 作废销售 | 整单作废：事务回滚库存 + status='voided' + 报表剔除 |
| 金额/数量 | 整数分 / 整数数量；单价输入最多 2 位小数 |
| 重复扫码 | 合并行 qty+1；行 key = 商品 + 单价 |
| 条码 | UNIQUE + nullable |
| 单号 | `yyyyMMdd-NNNN`（按日序号，销售/进货各自独立序列） |
| 删除商品 | 硬删 + 确认弹窗（明示库存废弃）；历史靠快照存活 |
| 重打模板 | 用当前模板（非销售时点快照） |
| GBK 外字符 | 替换 `?`（文档化 + 测试） |
| 购物车持久化 | 不持久化，关应用即弃（文档化） |

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - 全部验证 agent 执行。需要真机的项归入《Windows 真机验证清单》并显式标注 deferred。

### Test Decision
- **Infrastructure exists**: NO（随脚手架搭建）
- **Automated tests**: TDD（RED-GREEN-REFACTOR，每任务先写失败测试）
- **Framework**: vitest（unit）+ Playwright `_electron.launch()`（E2E）
- **CI**: GitHub Actions windows-latest（用户选定）+ 本地 Linux dev 双平台

### QA Policy
- **Electron E2E**: Playwright `_electron.launch({ args: [...] })` → 驱动真实窗口，断言 DOM + 通过测试 IPC 通道直读 DB（userData 路径下 .db 文件）
- **ESC/POS**: vitest 单测断言字节序列（`1b 40` init / `1b 61 01` 居中 / `1b 45` 粗体 / `1d 21` 倍高宽 / `1b 52 0f` 中文页 / GBK 字节 `d6d0 cec4` / `1d 56 42 00` 切纸 / `1d 76 30 00` 光栅）+ .bin fixture 字节级 diff
- **导出**: E2E 导出到固定路径 → exceljs 读回断言 / unzip docx 断言 XML / txt 直接字符串断言
- **Evidence**: `.omo/evidence/task-{N}-{scenario-slug}.{ext}`

---

## Execution Strategy

### Parallel Execution Waves

> 波次划分严格闭合依赖矩阵：任何任务依赖的先序任务必须在更早的波次中。

```
Wave 1a（串行起点，1 任务——全计划地基）:
└── Task 1: 脚手架（electron-vite 6 + Vue3 + TS + Element Plus + vitest + CI 骨架）

Wave 1b（五任务并行，全部仅依赖 Task 1）:
├── Task 2: DB 基础设施 + ER schema + 迁移（含 better-sqlite3 v13 spike 决策点）[deep]
├── Task 3: 共享契约层（DTO/IPC 类型/模板 schema/char-grid）[quick]
├── Task 5: 扫码检测器（纯函数 + before-input-event 桥）[quick]
├── Task 6: UI 骨架 + Playwright E2E 基建 [visual]
└── Task 7: 打印通道（spooler/tcp/serial + 枚举 + 串行队列）[high]

Wave 1c（1 任务，依赖 Task 3 模板契约）:
└── Task 4: ESC/POS 生成器（纯函数 + GBK + golden 字节矩阵）[deep]

Wave 2a（六任务并行，依赖 1b/1c 产物）:
├── Task 8:  商品管理（repo+service+IPC+UI+测试）[high]
├── Task 9:  进货管理（repo+service+IPC+UI+测试）[high]
├── Task 10: 销售结账+作废 service（事务核心+kill-point 测试）[deep]
├── Task 12: HTML 小票预览组件（同源渲染 58/80mm）[visual]
├── Task 17: 导出器（txt/xlsx/docx+saveDialog+round-trip 测试）[high]
└── Task 19: 设置页（打印机配置/店铺信息/Logo 上传）[quick]

Wave 2b（三任务并行，依赖 Wave 2a 的 8/10）:
├── Task 11: 收银台 UI（购物车/双击加购/扫码，依赖 8+10）[visual]
├── Task 13: 销售记录查询（依赖 10）[high]
└── Task 14: 报表统计 service（日/月聚合，依赖 10）[deep]

Wave 3a（三任务并行，依赖 4/2b）:
├── Task 15: 打印编排集成（依赖 4+11+12+13）[deep]
├── Task 16: 模板编辑器 UI（依赖 3+12）[visual]
└── Task 18: 报表 UI + 导出集成（依赖 14+17）[visual]

Wave 3b（收尾，1 任务，依赖 15/16/18/19 全部）:
└── Task 20: Windows CI 完善 + NSIS 打包 + 真机验证清单 [high]

Wave FINAL（四并行审查 → 用户确认）:
├── F1: Plan Compliance Audit（oracle）
├── F2: Code Quality Review（unspecified-high）
├── F3: Real Manual QA（unspecified-high，Playwright 全场景）
└── F4: Scope Fidelity Check（deep）
→ 呈现结果 → 用户明确 okay

Critical Path: 1 → 3 → 10 → 11 → 15 → 20 → F1-F4（7 层波次）
Parallel Speedup: ~70%（对比 20 任务串行；波内并发 3-6）
Max Concurrent: 6（Wave 1b/2a）
```

### Dependency Matrix（全量）

| Task | Depends On | Blocks |
|---|---|---|
| 1 | - | 2,3,4,5,6,7 |
| 2 | 1 | 8,9,10,13,14 |
| 3 | 1 | 4,8,9,10,11,12,13,14,15,16,17 |
| 4 | 3 | 15 |
| 5 | 1 | 11 |
| 6 | 1 | 8,9,11,13,18,19（UI 容器） |
| 7 | 1 | 15,19 |
| 8 | 2,3,6 | 11,20 |
| 9 | 2,3,6 | 20 |
| 10 | 2,3 | 11,13,14,15 |
| 11 | 6,8,10,5 | 15 |
| 12 | 3 | 15,16 |
| 13 | 10,2,6 | 15 |
| 14 | 2,10 | 18 |
| 15 | 4,7,11,12,13 | 20,F1-F4 |
| 16 | 12,3 | 20 |
| 17 | 3 | 18 |
| 18 | 14,17,6 | 20 |
| 19 | 7,6 | 20 |
| 20 | 15,16,18,19 | F1-F4 |

### Agent Dispatch Summary

- **Wave 1a**: 1 → `quick`
- **Wave 1b**: 2 → `deep`、3 → `quick`、5 → `quick`、6 → `visual-engineering`、7 → `unspecified-high`
- **Wave 1c**: 4 → `deep`
- **Wave 2a**: 8 → `unspecified-high`、9 → `unspecified-high`、10 → `deep`、12 → `visual-engineering`、17 → `unspecified-high`、19 → `quick`
- **Wave 2b**: 11 → `visual-engineering`、13 → `unspecified-high`、14 → `deep`
- **Wave 3a**: 15 → `deep`、16 → `visual-engineering`、18 → `visual-engineering`
- **Wave 3b**: 20 → `unspecified-high`
- **FINAL**: F1 → `oracle`、F2 → `unspecified-high`、F3 → `unspecified-high`、F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task（TDD：RED→GREEN→REFACTOR）。
> EVERY task MUST have: Agent Profile + Parallelization + References + Acceptance Criteria + QA Scenarios。
> **A task WITHOUT QA Scenarios is INCOMPLETE. No exceptions.**

- [x] 1. 项目脚手架 + 测试基建（含 electron-vite 6 spike）

  **What to do**:
  - `npm create @quick-start/electron`（electron-vite 6 模板）或手动搭：`package.json` + `electron.vite.config.ts`（main/preload/renderer 三目标）+ `tsconfig.json`（三 tsconfig 引用结构）
  - 依赖锁定：`electron@^44.x`（**不要 45，发布仅 2 天**）、`electron-vite@^6.0.0`、`vue@^3.5`、`typescript`、`element-plus@^2.14.7`、`pinia`、`vue-router`、`vitest`、`@playwright/test`
  - 主进程 `src/main/index.ts`：创建 BrowserWindow（`contextIsolation: true, nodeIntegration: false`）+ `app.requestSingleInstanceLock()` 单实例锁
  - preload `src/preload/index.ts`：最小 `contextBridge.exposeInMainWorld('api', { ping: () => 'pong' })` 占位
  - renderer `src/renderer`：Vue 3 挂载 + Element Plus 引入 + 全局 CSS 定义中文字体栈 `"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` + 等宽 CJK 字体 class `.mono-cjk { font-family: "NSimSun", "SimSun", monospace }`（小票预览用）
  - scripts：`dev` / `build` / `typecheck` / `test`（vitest run）/ `test:e2e`（Playwright）
  - `.github/workflows/ci.yml` 骨架：`runs-on: windows-latest`，steps: checkout → setup-node → npm ci → typecheck → test（此时先只跑占位测试）
  - 占位单测 `tests/unit/smoke.test.ts`（`expect(1+1).toBe(2)`）验证 vitest 接线
  - `vitest.config.ts`：`environment: 'node'`（主进程侧测试）+ coverage 配置
  - **S2 spike 验证**：electron-vite 6（rolldown）+ Vue3 + TS + Element Plus 可正常 dev/build；若 rolldown 链不兼容 Element Plus → fallback electron-vite 5（vite 经典链），记录决策

  **Must NOT do**:
  - 不引入任何业务功能代码（只搭骨架）
  - 不安装 better-sqlite3 / node-thermal-printer（Task 2/4/7 职责，避免 Wave 1b 冲突）
  - 不配置 electron-builder 打包（Task 20 职责）
  - 不用 Electron 45.x

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 脚手架是模板化工作，文档齐全，无业务逻辑
  - **Skills**: []
    - 纯初始化工作，无需领域技能
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: 本任务只挂载空壳，无 UI 设计

  **Parallelization**:
  - **Can Run In Parallel**: NO（Wave 1a 唯一任务，全计划起点）
  - **Parallel Group**: Wave 1a（串行起点）
  - **Blocks**: 2, 3, 4, 5, 6, 7（全部）
  - **Blocked By**: None

  **References**:
  **External References**:
  - https://electron-vite.org/guide/ — electron-vite 6 官方文档（项目结构 src/{main,preload,renderer}、三目标构建、`build.externalizeDeps` 默认外部化）
  - https://electron-vite.org/guide/dev#nodejs-versions — Node 宿主要求 20.19+/22.12+
  - Element Plus: https://element-plus.org/en-US/guide/quickstart.html — 按需引入方案（unplugin-vue-components）
  - vitest: https://vitest.dev/config/ — vitest.config.ts 结构
  - **WHY**: executor 需要官方文档确认 electron-vite 6 的配置写法（externalizeDepsPlugin 已废弃，改为 build.externalizeDeps 配置或默认行为——**不要抄旧教程里的 externalizeDepsPlugin()**）

  **Acceptance Criteria**:
  - [ ] `npm run dev` 启动 Electron 窗口，renderer 显示 Vue 3 + Element Plus 按钮
  - [ ] `npm run build` 成功产出 `out/`（main/preload/renderer 三目录）
  - [ ] `npm run typecheck` 0 错误
  - [ ] `npm test` 占位测试通过
  - [ ] 单实例验证：第二次 `npm run dev` 时首个窗口获得 focus 且新进程退出（`requestSingleInstanceLock` 生效）
  - [ ] `.github/workflows/ci.yml` 存在且 `runs-on: windows-latest`

  **QA Scenarios**:

  ```
  Scenario: 脚手架 dev 启动与构建
    Tool: Bash + interactive_bash (tmux)
    Preconditions: Node ≥22.12，目录为空仓库（仅 .omo/ 与 .gitignore）
    Steps:
      1. npm install && npm run dev（tmux 后台运行）
      2. 等待 10s，检查 tmux pane 输出无 error
      3. Ctrl+C 停止 dev；npm run build
      4. ls out/main/index.js out/preload/index.js out/renderer/ 确认三目标产物存在
    Expected Result: dev 无报错启动；build 产出三目录齐全
    Failure Indicators: rolldown 构建报错、Element Plus 引入失败、tsconfig 报错
    Evidence: .omo/evidence/task-1-scaffold-build.txt（终端输出）

  Scenario: 单实例锁验证（failure/edge case）
    Tool: Bash (tmux)
    Preconditions: dev 实例 A 已在 tmux 运行
    Steps:
      1. 在第二个 tmux 窗口再次 npm run dev
      2. sleep 5 后检查进程列表：`pgrep -fc electron` 
      3. 检查第二个实例日志是否退出（app.quit 路径）
    Expected Result: 第二实例自动退出，仅剩实例 A
    Failure Indicators: 两个 dev 实例并存
    Evidence: .omo/evidence/task-1-single-instance-lock.txt
  ```

  **Commit**: YES
  - Message: `chore(init): electron-vite 6 + vue3 + ts + element-plus 脚手架与测试基建`
  - Files: 全部脚手架文件
  - Pre-commit: `npm run typecheck && npm test`

- [x] 2. DB 基础设施 + ER schema + 迁移执行器（含 better-sqlite3 v13 spike 决策点）

  **What to do**:
  - **S1 spike（必须最先做）**：安装 `better-sqlite3@^13.0.3`，在 electron-vite 的主进程最小集成里 `require('better-sqlite3')` 建 in-memory 表跑 CRUD → dev 运行验证。**决策点**：若 v13 N-API 在 Electron 44 加载失败（NODE_MODULE_VERSION 错误）→ fallback 顺序：(a) 锁 `better-sqlite3@12.x` + `electron-builder install-app-deps`；(b) `node:sqlite`（DatabaseSync）。决策写入 commit message 与代码注释
  - `src/main/db/database.ts`：`initDatabase(app.getPath('userData') + '/pos.db')`：`new Database(path)` + `db.pragma('journal_mode = WAL')` + `db.pragma('foreign_keys = ON')` + 执行迁移
  - `src/main/db/migrator.ts`：读 `PRAGMA user_version` → 依次执行 `migrations/00N_*.sql` → 更新 user_version（用户新装=0 → 全量跑）
  - `src/main/db/migrations/001_init.sql`：**抄本计划 ER 章节的完整 DDL**（8 表全量 + 全部索引 + CHECK 约束，逐字使用计划中的 SQL）
  - 导出 `getDatabase()` 单例 accessor（services/repos 通过参数注入，不直接 import 单例——便于 vitest 用 temp DB）
  - 单测 `tests/unit/db/migrator.test.ts`：temp 目录 DB → 迁移 → `PRAGMA user_version` = 1 + 8 张用户表存在（sqlite_master 按具名断言）+ 二次 init 幂等（不重复建表）
  - 单测 seed 工具 `tests/fixtures/seed.ts`（供后续任务复用）

  **Must NOT do**:
  - 不得在 renderer/preload import better-sqlite3（G8）
  - 不得跳过 spike 直接假设 v13 可用（Metis 发现调研自相矛盾，必须实证）
  - 不得手写迁移逻辑内联在 database.ts（必须独立 migrator，G9）
  - 不得用 `datetime('now')`（UTC）——统一 `datetime('now','localtime')`（本地时区，报表日界依赖）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 含技术决策点（spike + fallback 链），schema 正确性影响全部后续任务
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `debugging`: spike 失败时调试是 fallback 决策的一部分，但主流程是标准集成

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1b（with 3, 5, 6, 7）
  - **Blocks**: 8, 9, 10, 13, 14
  - **Blocked By**: 1

  **References**:
  **API/Type References**:
  - 本计划 "数据存储 ER 设计" 章节 — 001_init.sql 的唯一事实源（逐字复制）
  - **External References**:
  - https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md — Database API（pragma、prepare、transaction）
  - https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md — N-API/prebuild 说明（v13 prebuilds 随 npm 包）
  - Electron `app.getPath('userData')`: https://www.electronjs.org/docs/latest/api/app#appgetpathname
  - **WHY**: spike 决策依赖 prebuild 机制的实证理解；WAL/foreign_keys pragma 是 Guardrail（G10）与快照设计（product_id nullable）的前提

  **Acceptance Criteria**:
  - [ ] TDD：先写 migrator.test.ts（RED）→ 实现（GREEN）
  - [ ] spike 记录：v13 在 Electron 44 dev 中 require + CRUD 成功，或 fallback 决策明确记录
  - [ ] `npm run dev` 后 userData 下生成 pos.db，`PRAGMA user_version`=1，WAL 模式生效（`journal_mode` 查询返回 'wal'）
  - [ ] vitest：8 张用户表全部存在于 sqlite_master（按具名断言，忽略 sqlite_sequence 等内部表）；重复 init 幂等
  - [ ] foreign_keys=ON 生效测试：插入 sale_items 引用不存在 sale_id 抛错

  **QA Scenarios**:

  ```
  Scenario: 迁移与 WAL 生效（happy path）
    Tool: Bash
    Preconditions: Task 1 脚手架可运行；node + sqlite3 CLI 或用 vitest 脚本
    Steps:
      1. rm -rf ~/.local/share/<appname>/ （清 userData，模拟首次安装）
      2. npm run dev（tmux），等待窗口出现后关闭
      3. 用 node 脚本打开 userData/pos.db：查 PRAGMA user_version、PRAGMA journal_mode、SELECT name FROM sqlite_master WHERE type='table'
      4. 断言 user_version=1、journal_mode='wal'、8 张用户表齐全（products/purchase_orders/purchase_items/sales/sale_items/stock_movements/print_templates/settings；sqlite_master 还会含 sqlite_sequence 等内部表，按具名断言忽略之）
    Expected Result: 全部断言通过
    Failure Indicators: user_version=0（迁移未跑）、缺表、journal_mode='delete'
    Evidence: .omo/evidence/task-2-db-migration.txt

  Scenario: better-sqlite3 加载失败降级（failure/edge case）
    Tool: Bash
    Preconditions: 安装 better-sqlite3@^13 后
    Steps:
      1. npm run dev，观察主进程 console 是否出现 NODE_MODULE_VERSION / was compiled against a different Node.js version 错误
      2. 若出现：执行 fallback (a) better-sqlite3@12 + electron-builder install-app-deps（或 @electron/rebuild），重试
      3. 仍失败 → fallback (b) node:sqlite DatabaseSync 改写 database.ts，重试
    Expected Result: 任一路径最终在 dev 中 DB 可用；决策记录在 commit message
    Failure Indicators: 三条路径全部失败（阻塞级，升级报告用户）
    Evidence: .omo/evidence/task-2-sqlite-spike.txt（三种尝试的终端输出）
  ```

  **Commit**: YES
  - Message: `feat(db): better-sqlite3 连接、迁移执行器与 ER 全量 schema`
  - Pre-commit: `npm run typecheck && npm test`

- [x] 3. 共享契约层：DTO + typed IPC + 模板 schema + 默认模板

  **What to do**:
  - `src/shared/types/`：全部领域 DTO（TS interface）：`Product`、`CartItem`、`Sale`、`SaleItem`、`PurchaseOrder`、`PurchaseItem`、`StockMovement`、`DailyReport`、`MonthlyReport`、`PrintTemplate`、`Settings`；金额字段命名统一 `*_cents: number`
  - `src/shared/types/ipc.ts`：typed IPC surface：`IpcChannels` 接口（channel 名 → request/response 类型映射），renderer 侧封装 `typedInvoke<K extends keyof IpcChannels>(ch: K, req: IpcChannels[K]['req']): Promise<IpcChannels[K]['res']>`；**Wave 1b 先定义已知的全部通道名**（products:list/create/update/delete/search、sales:checkout/void/list/detail、purchases:create/list、reports:daily/monthly、printing:printers/preview/print、templates:crud、settings:get/set），handler 后续任务逐步实现
  - `src/shared/receipt/template-schema.ts`：模板 JSON 类型（`ReceiptTemplate`：paperWidth、header: Section[]、items: ItemsSection、totals: TotalLine[]、footer: Section[]、cutPaper: boolean；`Section = { type: 'text'|'image'|'divider', content?: string, align?: 'left'|'center'|'right', size?: 'normal'|'doubleHeight'|'doubleWidth'|'quad', bold?: boolean }`）+ `interpolateVariables(content: string, vars: ReceiptVars): string` 纯函数（`{shopName}` 等插槽替换）+ `ReceiptVars` 类型（shopName/shopPhone/receiptNote/saleNo/datetime/total/itemCount/companyFooter 等）
  - `src/shared/receipt/default-template.ts`：内置默认模板（80mm：头部 shopName 倍高居中 + shopPhone 居中 + divider；items 默认四列；totals 合计行加粗；footer datetime + 谢谢惠顾 + 切纸 true）+ 58mm 变体
  - `src/shared/receipt/char-grid.ts`：字符网格数学（`PAPER_COLUMNS = { '58mm': 32, '80mm': 48 }`）+ `stringWidth(s): number`（全角=2、半角=1）+ `truncateToGrid(s, cols): string` + `padLine(s, cols, align): string` —— **此模块被 ESC/POS 生成器与 HTML 预览共同依赖（同源数学，G7）**
  - 单测：interpolate 变量替换（含未知插槽保留原文）、stringWidth（'中文ab' = 6）、truncate/pad 矩阵、default-template 符合 schema 类型

  **Must NOT do**:
  - 不写任何 IpcMain.handle 实现（只定义契约）
  - 不引入 zod 之外的运行时校验依赖（模板校验用简单 TS 函数即可，避免过度工程）
  - char-grid 不得引用任何 DOM/Electron API（必须纯函数，主/渲染两侧可用）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 纯类型与纯函数定义，无 I/O，无 UI，路径明确
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1b（with 2, 5, 6, 7）
  - **Blocks**: 4（模板 schema 是生成器输入）, 8-18（DTO/IPC 契约）
  - **Blocked By**: 1

  **References**:
  **API/Type References**:
  - 本计划 "Architecture Design > 打印子系统独立设计" 章节 — 模板 schema 的段落结构与变量插槽清单
  - 本计划 "数据存储 ER 设计" 章节 — DTO 字段与表结构一一对应（如 SaleItem.product_name ↔ product_name 快照列）
  - **WHY**: 契约层是全部 Wave 2 任务的依赖，字段命名/金额单位必须与 ER 章节逐字一致，否则后续任务对不上

  **Acceptance Criteria**:
  - [ ] TDD：char-grid 与 interpolate 测试先行
  - [ ] `npm run typecheck` 0 错误
  - [ ] vitest：interpolateVariables('{shopName}小票', {shopName:'测试店'}) === '测试店小票'；stringWidth('中文ab') === 6；padLine 居中在 48 列下左右空格数正确
  - [ ] default-template 满足 ReceiptTemplate 类型 + 两纸宽变体存在
  - [ ] IpcChannels 覆盖上述全部通道名（grep 断言）

  **QA Scenarios**:

  ```
  Scenario: 契约层单元测试全绿（happy path）
    Tool: Bash
    Preconditions: Task 1 完成
    Steps:
      1. npx vitest run tests/unit/shared/
      2. 检查退出码 = 0，全部用例 pass
      3. npx tsc --noEmit
    Expected Result: shared 相关测试 ≥10 用例全 pass，typecheck 0 错
    Failure Indicators: 任一用例 fail、类型错误
    Evidence: .omo/evidence/task-3-shared-tests.txt

  Scenario: char-grid 边界（failure/edge case）
    Tool: Bash
    Steps:
      1. vitest 断言：truncateToGrid('a'.repeat(60), 48).length ≤ 48 字符宽
      2. 空字符串/纯全角超宽/emoji（UTF-16 代理对）输入
    Expected Result: 超长截断不越界；emoji 不产生半个代理对（宽 2 处理）
    Failure Indicators: 截断后 stringWidth 超限
    Evidence: .omo/evidence/task-3-chargrid-edge.txt
  ```

  **Commit**: YES
  - Message: `feat(shared): DTO/IPC 类型契约与小票模板 schema`
  - Pre-commit: `npm run typecheck && npm test`

- [x] 4. ESC/POS 生成器（纯函数 + GBK 编码 + golden 字节测试矩阵）

  **What to do**:
  - 安装 `node-thermal-printer@^4.6.1`（仅主进程用；**不安装 printer/electron-printer 原生 driver**——那是 Task 7 通道层职责，且 spooler 通道方案在 Task 7 决策）
  - `src/main/printing/escpos/gb2312-encoder.ts`：封装文本→GBK 字节（node-thermal-printer 的 `setCharacterSet(CharacterSet.CHINA)` + getText 内部走 iconv-lite EUC-CN；另外提供 `detectNonGbk(str): boolean` 检测生僻字符，命中则替换 `?` —— 降级策略 G 决策）
  - `src/main/printing/escpos/escpos-generator.ts`：**纯函数** `generateReceiptBytes(template: ReceiptTemplate, sale: SaleReceiptData, vars: ReceiptVars): Promise<Uint8Array>`：
    - 用 node-thermal-printer 的 `ThermalPrinter` 实例（`type: 'epson'`, `interface: 'file'`→ 不 execute，只取 buffer）或直接用其底层 Epson 类构建指令；**绝不调用 execute/open/网络 I/O（G6）**
    - 渲染顺序：`ESC @`（init）→ characterSet CHINA → header 段落（text: align+size+bold 映射 `setTextDoubleHeight/Width/QuadArea`、`bold()`、`align()`；image: `printImageBuffer(logoPngBuffer)`；divider: 打印 '-' × 列数）→ items 表（char-grid padLine 对齐四列）→ totals → footer → `cut()`（模板 cutPaper=true 时）→ 取 `printer.getBuffer()`
  - `tests/unit/printing/escpos-generator.test.ts`：**golden 字节矩阵**（无实机验证策略的核心）：
    - 断言函数：`bytes.includes(hexSequence)`，用十六进制匹配
    - 矩阵：{58mm, 80mm} × {bold on/off} × {doubleHeight} × {center 对齐} × {Logo 有/无} × {cutPaper on/off}
    - 具体断言：`1b 40`（init）、`1b 61 01`（居中）、`1b 45 01`（粗体开）、`1d 21`（字符尺寸）、`1b 52 0f`（中文页）、中文字符串 GBK 字节（'中文测试收银' → `d6 d0 ce c4 b2 e2 ca d4 ca d5 d2 f8`）、`1d 56 42 00`（切纸，仅 cutPaper 时）、`1d 76 30 00`（光栅，仅 Logo 时）
    - **重打幂等**：同一输入两次生成 → 字节完全相等
    - **GBK 降级**：含 '𠀀'（GBK 外）的商品名 → 输出含 `3f`（'?'）
  - `tests/fixtures/golden/`：提交 2 个 .bin golden 文件（58mm 默认模板 + 80mm 含 Logo 模板的完整输出），测试做字节级 diff

  **Must NOT do**:
  - ❌ 生成器内部任何 `execute()` / `net.connect` / `fs`（除读 Logo Buffer 由调用方传入参数——vars 里带 logoBuffer）（G6）
  - 不得在 renderer import node-thermal-printer
  - 不得自研 GB18030 编码器（降级=替换 '?'，锁定清单）
  - 不得绕过 char-grid 做对齐（HTML 预览将失同源性）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 本任务是无实机验证策略的基石；ESC/POS 指令语义、node-thermal-printer buffer 获取路径、GBK 字节断言都需要深入钻研
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（Wave 1c 唯一任务——依赖 Task 3 契约，此后解锁 Wave 2a/3a 打印链）
  - **Parallel Group**: Wave 1c（串行：在 Task 3 完成后立即开始）
  - **Blocks**: 15（打印编排）
  - **Blocked By**: 3（模板 schema + char-grid）

  **References**:
  **API/Type References**:
  - `src/shared/receipt/template-schema.ts`（Task 3）— 输入类型与变量插槽
  - `src/shared/receipt/char-grid.ts`（Task 3）— 对齐/截断数学
  - **External References**:
  - https://github.com/Klemen1337/node-thermal-printer — README API：bold/alignLeft/Center/Right/setTextNormal/setTextDoubleHeight/setTextDoubleWidth/setTextQuadArea/cut/partialCut/printImage/printImageBuffer/getBuffer
  - 源码关键位置（调研已验证）：core.js L458-L467 `printImageBuffer(buffer)` 外层 wrapper；epson-config.js `CODE_PAGES.CHINA: 'EUC-CN'`；CharacterSet 枚举 core.js L54
  - ESC/POS 指令参考：`ESC @`=1B 40 初始化、`ESC a n`=1B 61 n 对齐、`ESC E n`=1B 45 n 粗体、`GS ! n`=1D 21 n 尺寸、`ESC R n`=1B 52 n 国际字符集、`GS V`=1D 56 切纸、`GS v 0`=1D 76 30 光栅位图
  - **WHY**: executor 需要知道 node-thermal-printer 在不连接打印机时如何取 buffer（interface: 'file' 模式 + getBuffer()），以及中文页配置的确切枚举名

  **Acceptance Criteria**:
  - [ ] TDD：golden 测试先行（RED：生成器未实现时 fail）
  - [ ] vitest 矩阵 ≥12 用例全绿（两纸宽 × 样式组合）
  - [ ] 字节断言含上文全部十六进制序列（逐项核对）
  - [ ] 幂等测试：两次生成 deepEqual
  - [ ] GBK 降级测试：'𠀀' → `3f`
  - [ ] 生成器文件 grep 无 `execute|net\.|require\('fs'\)`（G6 静态验证）

  **QA Scenarios**:

  ```
  Scenario: golden 字节矩阵全绿（happy path）
    Tool: Bash
    Preconditions: Task 3 的 schema/char-grid 已 merge
    Steps:
      1. npx vitest run tests/unit/printing/
      2. 检查 exit 0；统计 pass 数 ≥ 12
      3. 用 node 脚本生成 80mm 默认模板+样例销售的 .bin，xxd 检查前 16 字节
    Expected Result: '1b40'（ESC @）出现在头部；包含 '1b520f'（中文页）
    Failure Indicators: 字节序列缺失、matrix 任一组合 fail
    Evidence: .omo/evidence/task-4-golden-matrix.txt（vitest 输出）+ .omo/evidence/task-4-sample-receipt.bin

  Scenario: 生成器纯度静态检查（failure/edge case）
    Tool: Bash (grep)
    Steps:
      1. grep -nE "execute\(|net\.connect|createSocket|require\(['\"]fs" src/main/printing/escpos/escpos-generator.ts
      2. 预期零匹配（exit code 1）
    Expected Result: 零 I/O 调用（G6 满足）
    Failure Indicators: 任一匹配
    Evidence: .omo/evidence/task-4-purity-check.txt
  ```

  **Commit**: YES
  - Message: `feat(printing): ESC/POS 纯函数生成器（GBK 编码+golden 测试）`

- [x] 5. 扫码枪检测器（纯函数 + before-input-event 桥）

  **What to do**:
  - `src/main/scanner/barcode-detector.ts`：**纯函数/纯类** `BarcodeDetector`：`feed(event: KeyEvent): string | null`：
    - 状态机：累计按键字符；键间隔 ≤50ms 视为连发；遇 Enter 且累计长度 ≥5（数字/字母/常见条码字符）→ 返回条码并重置；间隔 >50ms → 重置缓冲
    - composition 事件忽略规则：主进程 before-input-event 无 composition 概念，但渲染层 IME 激活时输入会走不同路径——检测器以「快速连发 + Enter 结尾」为核心判据（扫码枪特征），人工打字速度天然达不到 50ms 间隔
    - 提供 `reset()`；KeyEvent = { key: string, isComposing?: boolean, timestamp: number }
  - `src/main/scanner/scanner-bridge.ts`：`attachScannerBridge(win: BrowserWindow, onBarcode: (code) => void)`：`win.webContents.on('before-input-event', (e, input) => detector.feed(...))`——薄壳，可整体 mock
  - IPC：扫码结果 `webContents.send('scanner:barcode', code)` → preload 暴露 `onBarcode(cb)`
  - 单测 `tests/unit/scanner/barcode-detector.test.ts`：合成事件流驱动（时间戳可控）：
    - 快速连发 13 字符 + Enter（间隔 20ms）→ 返回条码
    - 慢速输入（间隔 200ms）→ 不触发
    - <5 字符 + Enter → 不触发
    - 两次独立扫码（中间 >50ms 空隙）→ 互不拼接
    - 长度 5 边界 → 触发
  - **S6 spike 记录**：在 E2E 里用 `webContents.sendInputEvent` 尝试触发 before-input-event，若不触发（预期如此）→ 记录结论：E2E 扫码场景改走「直接调用渲染层注入的测试钩子」或 Page.keyboard（Playwright keyboard 走 OS 级输入管线，可能触发）——**实测哪个可行并记录**

  **Must NOT do**:
  - 不得把检测逻辑写在 bridge 里（必须纯函数可测，G13）
  - 不得用固定 setTimeout/debounce 全局状态（用事件时间戳判定）
  - 不得在渲染层用 password 输入框 hack（主进程拦截方案已定，避免双方案混淆）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单一纯函数 + 薄桥，逻辑边界清晰
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1b（with 2, 3, 6, 7）
  - **Blocks**: 11（收银台消费扫码事件）
  - **Blocked By**: 1

  **References**:
  **External References**:
  - Electron before-input-event: https://www.electronjs.org/docs/latest/api/web-contents#event-before-input-event — 事件结构 { type, key, isAutoRepeat, isComposing }
  - webContents.sendInputEvent: https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventevent — S6 spike 用
  - **WHY**: before-input-event 在输入到达页面之前拦截，绕过 IME composition——这是中文环境扫码枪可靠性的关键机制

  **Acceptance Criteria**:
  - [ ] TDD：detector 测试先行
  - [ ] vitest ≥5 用例：快速连发/慢速/短码/两次扫码隔离/长度边界
  - [ ] bridge attach 后 E2E（或手动 dev）中 Playwright `page.keyboard.type('6901234567890')` + Enter 能收到 barcode 事件（S6 实测结论记录）
  - [ ] detector 文件无 Electron import（纯度）

  **QA Scenarios**:

  ```
  Scenario: 检测器状态机（happy path，单元级）
    Tool: Bash
    Steps:
      1. npx vitest run tests/unit/scanner/
      2. 断言 5 用例全 pass
    Expected Result: 快速连发+Enter 返回条码；慢速/短码/跨间隙不误报
    Failure Indicators: 慢速输入触发、两码拼接
    Evidence: .omo/evidence/task-5-detector-tests.txt

  Scenario: E2E 键盘注入路径验证（S6 spike，edge case）
    Tool: Bash (Playwright 脚本)
    Preconditions: Task 6 未完成时可写独立最小 E2E 脚本（自己开 BrowserWindow）
    Steps:
      1. 启动最小窗口 attach bridge，console.log 收到的条码
      2. Playwright: page.keyboard.type('6901234567890', {delay: 15}); page.keyboard.press('Enter')
      3. 若 page.keyboard 不触发 before-input-event → 改 webContents.sendInputEvent 重试
      4. 记录两条路径结论到 spike 记录
    Expected Result: 至少一条注入路径可触发检测器（供 Task 11 E2E 复用）；结论记录
    Failure Indicators: 两条路径都无法触发（Task 11 E2E 需降级为直接调用 preload 测试钩子——记录决策即可，不算失败）
    Evidence: .omo/evidence/task-5-s6-spike.txt
  ```

  **Commit**: YES
  - Message: `feat(scanner): 扫码枪检测器（纯函数+IME 兼容桥）`

- [x] 6. UI 骨架 + Playwright E2E 基建

  **What to do**:
  - `src/renderer/src/router/`：7 路由（/pos、/products、/purchases、/sales-history、/reports、/template-editor、/settings）+ 侧边导航布局（Element Plus `el-menu`，图标+中文标签：收银台/商品管理/进货管理/销售记录/报表统计/小票模板/系统设置）
  - `App.vue`：布局壳（左侧导航 200px + 主区域 router-view）+ 全局字体（Task 1 的中文字体栈）
  - 每个路由挂**空态占位页**（标题 + "建设中" 提示，Element Plus `el-empty`）
  - Pinia store 骨架（不实现业务，只建文件）
  - **E2E 基建（S5 spike）**：`tests/e2e/` + `playwright.config.ts`：
    - `_electron.launch({ args: ['.'], env: {...} })` 或驱动 `npm run dev`（记录可行方案）
    - E2E 环境隔离：设置 `app.getPath('userData')` 重定向到 temp 目录（`--user-data-dir` 或 env 变量 + main 侧支持），**每测试隔离 DB**
    - `tests/e2e/helpers.ts`：`launchApp()`（返回 { electronApp, page, dbPath }）、`waitForRoute(path)`
    - 首个冒烟 E2E `tests/e2e/smoke.spec.ts`：启动 → 断言 7 个导航项存在 → 点击切换路由 → 断言 URL hash 变化
  - CI 更新：ci.yml 增加 `npm run test:e2e` step（windows-latest 上跑）

  **Must NOT do**:
  - 不实现任何业务页面内容（空态占位即可）
  - E2E 不得依赖真实 userData（必须 temp 隔离）
  - 不做主题切换/暗色模式（锁定清单外，勿加）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 布局/导航/字体是 UI 工作；E2E 基建是支撑性工程
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 导航布局需要基本设计感（间距、层级、中文排版）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1b（with 2, 3, 5, 7）
  - **Blocks**: 8, 9, 11, 13, 18, 19（页面容器）
  - **Blocked By**: 1

  **References**:
  **External References**:
  - Playwright Electron: https://playwright.dev/docs/api/class-electron — `_electron.launch()`、`electronApp.firstWindow()`
  - Element Plus Menu: https://element-plus.org/en-US/component/menu.html — 侧边导航模式
  - Vue Router: https://router.vuejs.org/guide/essentials/history-mode.html — createWebHashHistory（Electron 文件协议下必须 hash 模式）
  - **WHY**: hash 路由是 Electron file:// 的硬约束；E2E userData 隔离决定全部后续 E2E 的可重复性

  **Acceptance Criteria**:
  - [ ] `npm run dev` 侧边 7 项导航 + 中文标签渲染正确
  - [ ] `npm run test:e2e` 冒烟用例通过（7 导航项 + 路由切换）
  - [ ] E2E userData 隔离：跑完 E2E 后 temp 目录存在 pos.db 且用户真实 userData 未被创建测试数据（用固定 marker settings 行验证）
  - [ ] typecheck 0 错

  **QA Scenarios**:

  ```
  Scenario: 导航与路由（happy path）
    Tool: Playwright _electron E2E
    Preconditions: E2E 基建就绪
    Steps:
      1. const { page } = await launchApp()
      2. await page.locator('.el-menu-item').nth(0).click()
      3. expect(page).toHaveURL(/#\/pos/)
      4. 依次点击 7 项，断言 URL 与标题
    Expected Result: 7 路由全部可达，el-empty 占位可见
    Failure Indicators: 路由 404、白屏
    Evidence: .omo/evidence/task-6-nav-e2e.png（截图）+ .txt

  Scenario: E2E 数据隔离（edge case）
    Tool: Bash + node
    Steps:
      1. 运行 E2E 前记录真实 userData/pos.db 的 mtime（若存在）
      2. npm run test:e2e
      3. 比对 mtime 未变；temp 目录存在本次运行产物
    Expected Result: 真实 userData 未被测试污染
    Failure Indicators: 真实 userData 的 pos.db 被修改
    Evidence: .omo/evidence/task-6-isolation.txt
  ```

  **Commit**: YES
  - Message: `feat(ui): 应用骨架布局路由与 E2E 基建`

- [x] 7. 打印通道层（PrintChannel 抽象 + spooler/tcp/serial + 枚举 + 串行队列）

  **What to do**:
  - `src/main/printing/channels/print-channel.ts`：接口 `interface PrintChannel { name: string; send(bytes: Uint8Array): Promise<void>; }` + `listSystemPrinters(): Promise<PrinterInfo[]>`（封装 `win.webContents.getPrintersAsync()`，Linux/无窗口环境返回空数组不抛错——G11 可 mock）
  - `src/main/printing/channels/spooler.channel.ts`：**主通道**。实现决策（重要）：
    - 首选：node-thermal-printer 的 `printer:名称` interface（`new ThermalPrinter({ interface: 'printer:' + name, ... })` → `printer.print(buffer)` + `execute()`）——但其 driver 依赖 `printer`/`electron-printer` 老原生包（2022 停更、需 rebuild）
    - **推荐实现**：绕开原生包，用 **PowerShell RawPrinterHelper** 发送 RAW：`System.Drawing.Printing.RawPrinterHelper` + `Add-Type`，将字节写入 `LPT1:`-style spooler（Windows 标准方案，零原生依赖）；封装为 `sendRawToPrinter(printerName: string, bytes: Uint8Array): Promise<void>`，用 `child_process.execFile('powershell.exe', [...])` 执行；**Linux 上调用时抛明确错误 'spooler channel 仅 Windows'**（CI Linux 跳过该通道测试）
    - 两方案都 spike：若 `printer:` interface 在不装 driver 时可 import 不崩（driver 仅在 execute 时 require）→ 保留为 fallback 注释；主路径 PowerShell
  - `src/main/printing/channels/tcp.channel.ts`：`net.createConnection({ host, port: 9100 })` → 写字节 → drain → close；connect timeout 3s（可配置）；错误上抛
  - `src/main/printing/channels/serial.channel.ts`：`fs.createWriteStream('\\\\.\\COM1')` 写入（node-thermal-printer file interface 同理）；端口名参数化
  - `src/main/printing/print.service.ts`（通道编排部分）：
    - `getChannel(settings): PrintChannel`（按 settings.printer_channel 分发）
    - **串行队列**：`enqueuePrintJob(bytes): Promise<void>`——内部 Promise 链保证连续任务不交叠；失败自动重试 1 次；二次失败抛错（调用方 UI 引导重打，G3 落库解耦）
  - 单测：tcp channel 用 vitest 的 `net` mock server（本地 127.0.0.1 监听 → 断言收到字节）；串行队列单测（两个 job 顺序完成、第二个等第一个）；spooler 在 Linux 断言抛 '仅 Windows' 错

  **Must NOT do**:
  - 不得把 execute/IO 放进 escpos-generator（那是 Task 4 的禁区，本任务负责 I/O 侧——职责分离）
  - 不得引入 `printer`/`electron-printer` 原生包为默认依赖（可选 fallback 注释除外——避免 rebuild 链）
  - tcp channel 不得无超时（防挂死）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: PowerShell interop + Windows/Linux 双平台兼容 + 网络编程，需要扎实的系统编程能力
  - **Skills**: [`debugging`]
    - `debugging`: 跨平台通道行为差异需要假设驱动排查（尤其 PowerShell RAW 转义）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1b（with 2, 3, 5, 6）
  - **Blocks**: 15（打印编排集成）, 19（设置页选打印机）
  - **Blocked By**: 1

  **References**:
  **External References**:
  - node-thermal-printer interfaces（README）：`printer:auto`/`printer:Name`（spooler）、`tcp://host:9100`、`\\.\COM1`
  - Electron getPrintersAsync: https://www.electronjs.org/docs/latest/api/web-contents#contentsgetprintersasync
  - PowerShell RawPrinterHelper 模式：搜索 "RawPrinterHelper SendBytesToPrinter"——Windows 经典方案（System.Drawing.Printing；`Add-Type -AssemblyName System.Drawing`）
  - Node net: https://nodejs.org/api/net.html — createConnection + timeout 事件
  - **WHY**: spooler 是主通道（用户打印机=系统打印机），PowerShell RAW 是零原生依赖的唯一路径；tcp mock server 测试模式来自 vitest 生态标准做法

  **Acceptance Criteria**:
  - [ ] TDD：tcp channel 与串行队列测试先行
  - [ ] vitest：本地 mock TCP server 收到完整字节序列；两个 job 串行（时间戳顺序断言）；spooler 在 Linux 抛 'spooler channel 仅 Windows'
  - [ ] `listSystemPrinters()` 在 dev 运行时返回数组（Linux 可能空）不抛错
  - [ ] PowerShell 脚本字符串单测：参数（打印机名/字节 base64）正确拼装（不实际执行，断言命令结构）

  **QA Scenarios**:

  ```
  Scenario: TCP 通道回环测试（happy path）
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run tests/unit/printing/channels/
      2. 用例：起 127.0.0.1:19910 mock server → tcp.channel.send(Uint8Array.of(0x1b,0x40)) → server 收到 2 字节且内容一致
    Expected Result: 字节完整到达；连接关闭干净
    Failure Indicators: 字节丢失、连接悬挂、无超时
    Evidence: .omo/evidence/task-7-tcp-channel.txt

  Scenario: 串行队列与失败重试（failure/edge case）
    Tool: Bash (vitest)
    Steps:
      1. mock channel：第一次 send reject，第二次 resolve
      2. enqueuePrintJob(bytes) → await
      3. 断言 send 被调用 2 次且最终 resolve
      4. 再测：两次都 reject → 断言 enqueuePrintJob reject 且队列清空（后续 job 不阻塞）
    Expected Result: 重试 1 次成功；二次失败抛错且队列可继续
    Failure Indicators: 队列死锁、无重试
    Evidence: .omo/evidence/task-7-queue-retry.txt
  ```

  **Commit**: YES
  - Message: `feat(printing): 打印通道抽象（spooler/tcp/serial+串行队列）`

- [x] 8. 商品管理全链路（repo + service + IPC + UI + 手动库存流水）

  **What to do**:
  - `src/main/db/repositories/product.repo.ts`：`list(search?: string)`（name LIKE / barcode 精确或前缀）、`create({barcode?, name, defaultPriceCents?, initialStock})`、`update(id, {name?, defaultPriceCents?})`、`updateStock(id, newStock, source, sourceId?)`（**内部写 stock_movements**，before/after 快照）、`delete(id)`、`findByBarcode(code)`、`getById(id)`
  - `src/main/services/product.service.ts`：参数校验（name 非空；barcode 唯一冲突→友好错误 '条码已存在'；stock 整数；price ≥0 整数分）；delete 前查关联提示信息（返回 willOrphan: number 历史引用数——UI 弹窗文案用）；**手动改库存必走 updateStock → 流水（G5）**
  - `src/main/ipc/products.ipc.ts` + preload `typedInvoke` 接线（通道名用 Task 3 契约：products:list/create/update/delete/updateStock）
  - `ProductsView.vue`：顶部搜索框（单输入同时匹配名称/条码，防抖 300ms）+ 新增按钮 → `el-dialog` 表单（条码/名称/初始库存/默认售价，单价输入元两位小数→内部转分）+ 表格（el-table：条码/名称/库存[负数标红 class]/默认售价/操作[编辑/删除]）+ 分页（el-pagination，20/页）+ 删除确认弹窗（含历史引用数提示 + '库存将废弃' 明示）
  - 单测：service 层（barcode 冲突、负库存创建允许、手动改库存产生流水且 before/after 正确）；repo 层（LIKE 搜索匹配名称与条码）

  **Must NOT do**:
  - 不得绕过 service 直接在 IPC 里写 SQL
  - 手动库存修改不得只 UPDATE products 不写流水（G5）
  - 删除商品不得物理删 sale_items/purchase_items（快照设计，product_id 置 NULL 由外键行为处理——实际保留原值，行本身不动）
  - 金额不得以元（float）存 DB（一律分）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 全栈 CRUD + 事务性流水写入 + 表格交互，标准高工作量业务任务
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 表格/表单/弹窗的信息层级与中文排版

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a（with 9, 10, 12, 17, 19）
  - **Blocks**: 11（收银台搜索/加购依赖商品数据）, 20
  - **Blocked By**: 2（DB）, 3（契约）, 6（页面容器）

  **References**:
  **Pattern References**:
  - 本计划 ER 章节 — products 表结构 + stock_movements 流水结构（updateStock 的写入模板）
  - `src/shared/types/ipc.ts`（Task 3）— 通道名与请求/响应类型逐字使用
  - **External References**:
  - better-sqlite3 transaction: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfn---function — db.transaction() 同步事务 API
  - Element Plus Table/Form/Dialog: https://element-plus.org/en-US/component/table.html — 标准模式
  - **WHY**: updateStock 的流水写入是审计链关键（G5），transaction API 决定写法；Element Plus 表单校验模式（rules）直接复用

  **Acceptance Criteria**:
  - [ ] TDD：service 测试先行（含：barcode 冲突报错、改库存写流水）
  - [ ] vitest：updateStock(1, 5→3) 后 stock_movements 有行 {change_qty:-2, before:5, after:3, source:'manual'}
  - [ ] vitest：create 重复条码抛 '条码已存在'（service 错误码 BARCODE_CONFLICT）
  - [ ] E2E：搜索 '可乐' 过滤生效；新增→列表出现→编辑→值更新→删除→消失；删除带历史商品的确认弹窗含引用数文案
  - [ ] 负库存商品行 class 含 `stock-negative`（红色）

  **QA Scenarios**:

  ```
  Scenario: 商品 CRUD 全链路（happy path）
    Tool: Playwright _electron E2E
    Preconditions: E2E userData 隔离就绪（Task 6 helpers）；空 DB
    Steps:
      1. await launchApp() → 导航到 #/products
      2. 点击「新增」→ 填 name='可口可乐', barcode='6901234567890', stock=100, price='3.50'
      3. 提交 → 表格出现行 text 含 '可口可乐' 且库存列 '100'
      4. 搜索框输入 '6901234567890' → 仅剩该行
      5. 编辑库存 100→80 → 行更新；node 读 DB：stock_movements 有 source='manual' 行
      6. 删除 → el-message-box 确认 → 行消失
    Expected Result: 全链路通过；DB 流水正确
    Failure Indicators: 表单校验缺失、流水缺失、删除无确认
    Evidence: .omo/evidence/task-8-products-e2e.png + .omo/evidence/task-8-crud-flow.txt

  Scenario: 条码冲突与负库存（failure/edge case）
    Tool: Playwright E2E
    Steps:
      1. 新增条码 '6901234567890' 成功后再次新增同条码 → 提交
      2. 断言页面出现 .el-message--error 含 '条码已存在'
      3. 手动 DB 将商品库存改为 -5（service.updateStock）→ 列表该行库存显示 '-5' 且 class 含 stock-negative
    Expected Result: 冲突被友好拦截；负库存可见且标红（允许负库存 G 决策）
    Failure Indicators: 重复条码入库、负库存报错
    Evidence: .omo/evidence/task-8-error-cases.png
  ```

  **Commit**: YES
  - Message: `feat(products): 商品管理全链路（CRUD+搜索+库存调整流水）`

- [x] 9. 进货管理全链路（repo + service + IPC + UI + 入库事务）

  **What to do**:
  - `src/main/db/repositories/purchase.repo.ts`：`createOrderWithItems(order, items[])`（事务）、`list(page)`、`getDetail(id)`（join items）
  - `src/main/services/purchase.service.ts`：`createPurchase(items: {productId, quantity, costPriceCents}[], note?)`：
    - **单事务**：生成 order_no（`yyyyMMdd-NNNN`，按当日已有单数+1，序列锁在事务内查询）→ 插 purchase_orders → 逐项插 purchase_items（**写入商品快照** product_name/barcode 从 products 读）→ 逐项 `product.stock += quantity` + 写 stock_movements（source='purchase', source_id=orderId）
    - 校验：quantity > 0、cost ≥ 0、productId 存在
  - `src/main/ipc/purchases.ipc.ts` 接线
  - `PurchasesView.vue`：「新建进货单」按钮 → dialog：动态行表格（选择商品[el-select 可搜索名称/条码] + 数量 + 成本价[元→分] + 行删除）+ 备注 → 提交；列表页（单号/时间/品种数/备注/操作[查看明细]）；明细 dialog（商品名/条码/数量/成本价）
  - 单测：入库后库存正确增加；流水 source='purchase' 且 source_id=订单 id；快照在商品改名后依然原值（改商品名→查历史进货明细名称不变）

  **Must NOT do**:
  - 入库不得只改库存不写流水
  - 快照不得实时 join products 读名称（必须存列）
  - order_no 生成不得在事务外查询（并发竞态）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 与 Task 8 同构的全栈任务 + 事务细节
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 动态行表格编辑交互

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a（with 8, 10, 12, 17, 19）
  - **Blocks**: 20
  - **Blocked By**: 2, 3, 6

  **References**:
  **Pattern References**:
  - Task 8 的 repo/service/ipc/view 四件套结构 — 同构复用（命名与文件布局一致）
  - ER 章节 purchase_orders/purchase_items/stock_movements — 外键与快照列
  - **WHY**: 同构复用降低 review 成本；order_no 序列查询必须看 ER 的 UNIQUE 约束兜底

  **Acceptance Criteria**:
  - [ ] TDD：事务测试先行（部分失败全回滚：第二个 item 的 productId 不存在 → 整单不入库、库存不变）
  - [ ] vitest：入库 3 个商品后各 stock 正确、movements 3 行、order_no 格式 `20261101-0001`
  - [ ] vitest：快照不可变（改名后历史明细原名称）
  - [ ] E2E：新建进货单（2 行商品）→ 列表出现 → 库存相应增加（商品页验证）→ 明细弹窗内容正确

  **QA Scenarios**:

  ```
  Scenario: 进货入库全链路（happy path）
    Tool: Playwright E2E
    Preconditions: 预置 2 个商品（E2E 内通过 IPC 或 seed）
    Steps:
      1. 导航 #/purchases → 新建 → 添加两行（商品A qty=10 cost=2.00；商品B qty=5 cost=3.00）→ 提交
      2. 列表出现单号 20261101-0001
      3. 导航 #/products → 商品A 库存 +10
      4. 打开进货明细 → 商品名/数量/成本价逐项核对
    Expected Result: 库存联动 + 明细快照正确
    Failure Indicators: 库存未加、明细空
    Evidence: .omo/evidence/task-9-purchase-e2e.png

  Scenario: 进货事务回滚（failure/edge case）
    Tool: Bash (vitest)
    Steps:
      1. service 测试：items 含不存在 productId → expect throws
      2. 断言 purchase_orders 无行、两商品 stock 不变、movements 无行
    Expected Result: 原子性成立
    Failure Indicators: 孤儿行/库存变化
    Evidence: .omo/evidence/task-9-txn-rollback.txt
  ```

  **Commit**: YES
  - Message: `feat(purchases): 进货入库全链路（单据+库存+流水）`

- [x] 10. 销售结账 + 作废 service（事务核心 + kill-point 测试）

  **What to do**:
  - `src/main/db/repositories/sale.repo.ts`：`createSaleWithItems(sale, items[])`、`list(page, {from?, to?, status?})`、`getDetail(id)`、`voidSale(id)`、`findByNo(saleNo)`、`dailyCount(dateStr)`（单号序列用）
  - `src/main/services/sale.service.ts`（**全应用最核心的事务**）：
    - `checkout(cart: CartItem[], opts): SaleReceiptData`：
      - **单事务**：生成 sale_no（`yyyyMMdd-NNNN`，dailyCount+1，事务内）→ 计算 total_cents/item_count（整数分累加，subtotal = qty × unit_price_cents）→ 插 sales(status='completed') → 逐项插 sale_items（**快照** product_name/barcode 实时读 products + product_id）→ 逐项 `stock -= qty`（**允许负数，无拦截**——用户决策）→ 写 stock_movements（source='sale', source_id=saleId, before/after）
      - 返回 `SaleReceiptData`（供打印/预览：sale + items + vars）
    - `voidSale(saleId)`：**单事务**：校验 status='completed' → status='voided' + voided_at → 逐 sale_item 反向 `stock += qty` → 写 movements（source='void', source_id=saleId）；已作废再作废 → 抛 'SALE_ALREADY_VOIDED'
    - **kill-point 测试**：用 better-sqlite3 同步事务的 throw 自动回滚特性测：注入坏数据（如某 item product_name 超长违反约束/手工触发器失败）→ 断言全回滚（sales 0 行、库存不变）
  - `src/main/ipc/sales.ipc.ts`（checkout/void 通道）
  - 单测覆盖矩阵：正常结账（库存扣减+流水）、负库存允许（qty 100×2 库存 5 → after=-195 不报错）、作废回滚、重复作废报错、kill-point 回滚、sale_no 连续（同日 0001/0002）

  **Must NOT do**:
  - 结账事务不得包含打印（G3：打印在落库后异步）
  - 金额不得用浮点（subtotal 整数分乘加）
  - 不得在事务里调用 channel/网络
  - 作废不得物理删除任何行

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 资金与库存一致性核心；事务边界/单号序列/kill-point 是精细工作
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a（with 8, 9, 12, 17, 19）
  - **Blocks**: 11（收银台调 checkout）, 13（列表）, 14（报表）, 15（打印消费 SaleReceiptData）
  - **Blocked By**: 2, 3

  **References**:
  **API/Type References**:
  - ER 章节 sales/sale_items/stock_movements — CHECK 约束与 status 枚举
  - `src/shared/types/ipc.ts` — sales:checkout/void 的 req/res 契约
  - **External References**:
  - better-sqlite3 transaction: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfn---function — 同步事务 + throw 回滚语义（kill-point 测试的理论依据）
  - **WHY**: 单号序列 '事务内 count+1' 依赖 better-sqlite3 串行写入特性（WAL 单写者），executor 必须理解为什么不会竞态

  **Acceptance Criteria**:
  - [ ] TDD：全部测试先行（此任务 service 是纯逻辑，测试即规格）
  - [ ] vitest：结账 2 商品 → sales 1 行 total 正确、sale_items 2 行快照、stock 各减、movements 2 行 source='sale'
  - [ ] vitest：负库存（qty=10 库存=3）成功结账 stock=-7
  - [ ] vitest：作废后 stock 复原 + movements source='void' 2 行 + status='voided'
  - [ ] vitest：kill-point 注入失败全回滚（4 表零变化）
  - [ ] vitest：sale_no 同日递增、跨日重置（mock 日期或直接构造两条不同 created_at）

  **QA Scenarios**:

  ```
  Scenario: 结账事务正确性（happy path，单元级）
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run tests/unit/services/sale.service.test.ts
      2. 断言 6 组用例全 pass（矩阵如上）
    Expected Result: 全绿；金额全程整数分
    Failure Indicators: 任一断言 fail，尤其 kill-point
    Evidence: .omo/evidence/task-10-sale-service.txt

  Scenario: kill-point 原子性（failure/edge case）
    Tool: Bash (vitest)
    Steps:
      1. 构造 cart，第 2 项 product_name 预置 5000 字符（违反 TEXT 无约束则改用手动触发器 RAISE，二选一在实现时定——测试必须包含一个真实的注入失败点）
      2. checkout → expect throws
      3. 断言：sales/sale_items/stock_movements 全空，两商品 stock 原值
    Expected Result: 全回滚
    Failure Indicators: 出现孤儿 sale_items 或库存变动
    Evidence: .omo/evidence/task-10-killpoint.txt
  ```

  **Commit**: YES
  - Message: `feat(sales): 结账与作废事务核心（原子性+kill-point 测试）`

- [ ] 11. 收银台 UI（扫码 + 双击加购 + 购物车编辑 + 合计）

  **What to do**:
  - `PosView.vue` 布局：左 60% 商品搜索区（搜索框[自动聚焦，扫码枪焦点锚点] + 结果表格[名称/条码/库存/默认售价]，行**双击**→加购）+ 右 40% 购物车（CartPanel：行[商品名/数量 el-input-number/单价 el-input 元两位小数/小计/删除]、合计行、清空按钮、结账按钮[空车 disabled]）
  - **扫码集成**：preload `onBarcode(cb)` 订阅（Task 5 桥）→ 回调里 `typedInvoke('products:list', {search: code})` 精确条码命中 → 加购并 toast；未命中 → `.el-message--error` '未找到条码商品' + 高亮搜索框
  - **加购规则（已定案）**：购物车行 key = productId + unitPriceCents；同 key 重复加购 qty+1 合并（G 决策）；新行单价 = 商品 default_price_cents（可空→0.00 手输）
  - `cart.store.ts`（pinia）：items、addItem、updateQty、updatePrice、removeItem、clear、totalCents getter（整数分乘加）
  - 结账按钮 → `typedInvoke('sales:checkout', {items})` → 成功后**清空购物车 + emit 事件给 Task 15 的预览流程**（本任务先 console/占位 dialog 处理返回的 SaleReceiptData，Task 15 替换为真预览窗口）
  - 库存提示：加购时若当前 qty+1 > stock → 行内黄条提示 '库存不足(负库存将产生)'（**不阻断**）
  - E2E：扫码（用 Task 5 S6 结论的注入路径）→ 购物车出现行 → 双击另一商品 → 改数量/单价 → 合计实时更新 → 删除行 → 清空

  **Must NOT do**:
  - 不得在渲染层做金额浮点累计（一律 cents）
  - 扫码回调不得阻塞 UI（async 但即时反馈）
  - 结账按钮空车不得可点

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 高交互密度收银界面，是全应用使用频率最高的 UI
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 收银场景的信息密度、焦点流、快捷操作布局

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2b（with 13, 14）
  - **Blocks**: 15（预览流程挂接点）
  - **Blocked By**: 6（容器）, 8（商品搜索）, 10（checkout IPC）, 5（扫码桥）

  **References**:
  **Pattern References**:
  - `src/main/scanner/`（Task 5）— onBarcode 订阅 API
  - `src/shared/types/ipc.ts` — sales:checkout 请求的 items 结构（productId/quantity/unitPriceCents）
  - **WHY**: 合并规则（key=商品+单价）与负库存不阻断是定案行为，测试断言直接引用

  **Acceptance Criteria**:
  - [ ] vitest（cart.store）：合并规则、合计计算、清空
  - [ ] E2E：扫码 '6901234567890' → 购物车行出现；重复扫码 → qty 2（合并）
  - [ ] E2E：改数量 3、单价 3.50 → 小计 10.50、合计 10.50（显示元，内部 1050 分）
  - [ ] E2E：空车结账按钮 disabled；双击商品行加购生效
  - [ ] E2E：结账成功 → 购物车清空 + DB sales 1 行（node 断言）

  **QA Scenarios**:

  ```
  Scenario: 扫码→购物车→结账（happy path）
    Tool: Playwright E2E
    Preconditions: seed 商品（可口可乐 6901234567890 库存 100 售价 3.50）
    Steps:
      1. 导航 #/pos；用 S6 结论路径注入条码（或 page.keyboard.type）+ Enter
      2. 购物车出现行 '可口可乐' qty=1 单价 '3.50'
      3. 再注入一次 → qty=2
      4. 点击结账 → 购物车清空
      5. node 读 DB：sales 1 行 total_cents=700, item_count=1（合并后单行 qty2）
    Expected Result: 全链路通；DB 断言通过
    Failure Indicators: 合并未发生（两行）、合计错、DB 空
    Evidence: .omo/evidence/task-11-pos-e2e.png + task-11-db.txt

  Scenario: 未命中条码与负库存提示（failure/edge case）
    Tool: Playwright E2E
    Steps:
      1. 注入条码 '0000000000000' → 断言 .el-message--error 含 '未找到'
      2. 加购库存 1 的商品，数量改 5 → 断言行内出现 '库存不足' 提示且可继续结账
      3. 结账成功 → 商品页该商品库存 -4
    Expected Result: 错误友好；负库存放行
    Failure Indicators: 结账被阻断、报错崩溃
    Evidence: .omo/evidence/task-11-edge-cases.png
  ```

  **Commit**: YES
  - Message: `feat(pos): 收银台界面（扫码/双击加购/购物车编辑）`

- [x] 12. HTML 小票预览组件（同源渲染 58/80mm）

  **What to do**:
  - `src/renderer/src/components/receipt/ReceiptPreview.vue`：props `{ template: ReceiptTemplate, data: SaleReceiptData, vars: ReceiptVars }`：
    - 按 paperWidth 渲染容器宽度（80mm ≈ 48 字符列 → CSS width: 307px@96dpi 等比，58mm ≈ 32 列 → 221px；用 `.mono-cjk` 等宽字体，font-size 12px/14px 档）
    - 段落渲染：text → `padLine`（char-grid 同源数学）后按 align/size/bold 映射 CSS（size doubleHeight → line-height×2 + font-size×2 或 transform scale；quad → 双向）；image → img 标签（vars.logoBuffer 转 dataURL）+ maxWidth 网格列宽换算；divider → border-top dashed
    - items 段：`<table>` 四列（列宽用模板 columnWidths 比例），行内容 truncateToGrid
    - **同源断言的基石**：文本行集合 = ESC/POS 生成器同一 `padLine/interpolate` 函数产出（shared/receipt 直接 import——渲染层可用因为纯函数无 Node API）
  - 独立故事书式演示路由（dev only，`#/receipt-preview-demo`）：可选模板/纸宽/样例数据切换，供开发与 E2E 用
  - 单测（vitest + @vue/test-utils）：给定模板+数据 → 组件渲染的文本行序列 === char-grid 计算的期望行序列（**同源一致性测试**：用 generateReceiptBytes 的行数据结构对照——若 Task 4 生成器暴露 `renderLines()` 辅助则直接比对）

  **Must NOT do**:
  - 不得自写一套对齐/截断逻辑（必须 import shared/receipt/char-grid，G7）
  - 不得用非等宽字体渲染小票内容
  - 不得在此组件做打印动作（只渲染，打印按钮由外层 Task 15 编排）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 纯视觉组件 + 数学一致性
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 小票拟真排版（纸宽比例、字体、虚线分隔）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a（with 8, 9, 10, 17, 19）
  - **Blocks**: 15（预览窗口）, 16（模板编辑器实时预览）
  - **Blocked By**: 3（char-grid/schema）

  **References**:
  **Pattern References**:
  - `src/shared/receipt/char-grid.ts`（Task 3）— padLine/truncateToGrid/stringWidth 全部直接复用
  - `src/shared/receipt/template-schema.ts`（Task 3）— Section 类型映射
  - Task 4 的 golden 输出行结构 — 同源一致性对照源
  - **WHY**: 同源双渲染是本计划打印设计的核心约束，预览与打印的行集合一致才能"所见即所打"

  **Acceptance Criteria**:
  - [ ] vitest：同源一致性测试——同一模板+数据下组件文本行 === 期望行（≥10 断言：居中偏移、截断、倍高标记）
  - [ ] E2E（demo 路由）：80mm 与 58mm 切换容器宽度变化；变量（shopName）正确插值
  - [ ] 视觉：mono-cjk 字体生效、divider 虚线、合计加粗（E2E 截图 + class 断言 `.receipt-line--bold`）

  **QA Scenarios**:

  ```
  Scenario: 同源渲染一致性（happy path）
    Tool: Bash (vitest + @vue/test-utils)
    Steps:
      1. npx vitest run tests/unit/components/ReceiptPreview.test.ts
      2. 用例：默认模板+样例销售 → mount → 提取 .receipt-line 文本数组
      3. 与 char-grid padLine 逐行生成的期望数组 deepEqual
    Expected Result: 行集合一致（含居中空格数）
    Failure Indicators: 任一行不匹配
    Evidence: .omo/evidence/task-12-parity-test.txt

  Scenario: 58/80mm 与超长商品名（edge case）
    Tool: Playwright E2E (demo 路由)
    Steps:
      1. 打开 #/receipt-preview-demo，选 58mm → 容器宽度 ≈221px（getBoundingClientRect 容差 ±5px）
      2. 样例数据含 40 字符商品名 → 行文本 stringWidth ≤ 32（截断生效，末尾 '…' 或空格按实现断言）
    Expected Result: 纸宽约束生效
    Failure Indicators: 文本溢出容器
    Evidence: .omo/evidence/task-12-paperwidth.png
  ```

  **Commit**: YES
  - Message: `feat(receipt): HTML 小票预览组件（同源渲染 58/80mm）`

- [ ] 13. 销售记录查询（列表 + 明细 + 重打入口）

  **What to do**:
  - `SalesHistoryView.vue`：日期范围筛选（el-date-picker type=daterange，默认今天）+ 状态筛选（全部/已完成/已作废）+ 表格（单号/时间/商品数/合计/状态[voided 红 tag]/操作[查看明细、作废(仅 completed)、重打小票]）+ 分页
  - 明细 dialog：销售头信息 + 行表格（商品名/条码/数量/单价/小计——全部读快照列）
  - 作废操作：确认弹窗（明示库存将回滚）→ `sales:void` → 刷新列表（状态变 tag）
  - **重打入口**：按钮 emit → Task 15 的打印编排（本任务先接 `printing:print` IPC 的占位实现 console.log，Task 15 补真实现——接口契约按 Task 3 定义）
  - `sale.repo.list` 支持筛选参数（Task 10 已建 repo，本任务主要是 IPC 参数透传 + UI）
  - E2E：seed 3 单（含 1 作废）→ 筛选生效 → 双击行 → 明细正确 → 作废 1 单 → 状态变化 + 商品页库存回滚

  **Must NOT do**:
  - 明细不得实时 join products（读快照）
  - 作废不得无确认直接执行
  - 重打按钮在 voided 单上不得隐藏（作废单也允许重打——打印其内容但状态行显示作废？**决策：voided 单重打时小票加印 '已作废' 标记**——vars 透传 status）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 中等复杂度全栈页面 + 与 Task 10/15 的契约衔接
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 表格筛选与状态可视

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2b（with 11, 14）
  - **Blocks**: 15（重打接线）
  - **Blocked By**: 10（sale repo/service）, 2, 6

  **References**:
  **Pattern References**:
  - Task 8/9 的列表页模式（搜索+表格+分页+dialog）— 同构
  - ER 章节 sales.status CHECK — 状态枚举 'completed'|'voided'
  - **WHY**: 作废单重打加印标记是定案决策，需在明细/预览 vars 里透传

  **Acceptance Criteria**:
  - [ ] E2E：日期筛选 + 状态筛选组合生效
  - [ ] E2E：双击行 → 明细弹窗内容与 seed 一致（快照名）
  - [ ] E2E：作废流程（确认→tag 变化→商品库存 +qty 回滚）
  - [ ] vitest（若 repo 有新逻辑）：筛选组合 SQL 正确

  **QA Scenarios**:

  ```
  Scenario: 列表筛选与明细（happy path）
    Tool: Playwright E2E
    Preconditions: seed 3 单：D-1 两单 completed、D-2 一单 voided
    Steps:
      1. #/sales-history 默认今天 → 仅显示今日 1 单 voided tag
      2. 日期范围含 D-1 → 3 行
      3. 状态筛选 '已完成' → 2 行
      4. 双击 D-1 第一单 → 明细弹窗行数/名称/合计核对
    Expected Result: 筛选与明细正确
    Failure Indicators: 时间过滤错、明细 join 实时名
    Evidence: .omo/evidence/task-13-history-e2e.png

  Scenario: 作废回滚验证（failure/edge case——作废是危险操作）
    Tool: Playwright E2E
    Steps:
      1. 记录某商品当前库存 S（商品页读）
      2. 历史页作废该商品参与的 1 单（qty 合计 Q）
      3. 确认弹窗出现 '库存将回滚' 文案 → 确认
      4. 列表该单 status tag='已作废'；商品页库存 = S+Q
      5. 再次点击作废 → 按钮不可用/提示已作废
    Expected Result: 库存复原 + 幂等保护
    Failure Indicators: 库存不变、二次作废成功
    Evidence: .omo/evidence/task-13-void-flow.png + task-13-void-db.txt
  ```

  **Commit**: YES
  - Message: `feat(history): 销售记录查询与明细`

- [ ] 14. 报表统计 service（日/月聚合 + 剔除作废 + 跨午夜）

  **What to do**:
  - `src/main/db/repositories/report.repo.ts`：
    - `daily(dateStr)`: `{ totalCents, orderCount, items: SaleRow[] }`——SUM(sales.total_cents) + COUNT + 明细列表，**WHERE status='completed'**（剔除 voided）+ `date(created_at) = dateStr`
    - `monthly(ymStr)`: 同构按 `strftime('%Y-%m', created_at)`
    - 月报额外：按日分桶数组（[{date, totalCents, orderCount}]，图表式表格用）
  - `src/main/services/report.service.ts`：日期参数校验（格式）、聚合结果组装（**空数据日返回零值不抛错**）
  - `src/main/ipc/reports.ipc.ts` 接线
  - 单测（**时间边界矩阵**）：seed 跨午夜 3 单（23:59×2 + 00:01×1）→ 日报各自正确分桶 2/1；月报跨月同理；voided 剔除（seed 1 voided 不计入 total/count 但明细可选显示带标记）；零销售日 → {totalCents:0, orderCount:0, items:[]}
  - 注意时区：created_at 由 SQLite `datetime('now','localtime')` 写入（Task 2 定案）→ date() 取的也是本地语义，一致

  **Must NOT do**:
  - 不得把 voided 计入合计/单数（定案）
  - 不得用 JS Date 重新解析 created_at 做分桶（SQL 内完成，避免时区错位）
  - 空数据不得抛错

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SQL 聚合边界正确性（午夜/月界/空值/剔除）是数据准确性核心，测试矩阵设计需要严谨
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2b（with 11, 13）
  - **Blocks**: 18（报表 UI）
  - **Blocked By**: 2, 10（sales 表语义）

  **References**:
  **API/Type References**:
  - ER 章节 sales.created_at 默认值 `datetime('now','localtime')` — 分桶依据
  - SQLite date/strftime: https://www.sqlite.org/lang_datefunc.html — date(x) 与 strftime('%Y-%m', x) 语义
  - **WHY**: 跨午夜测试直接依赖 created_at 本地时间语义；strftime 是月分桶唯一正确工具

  **Acceptance Criteria**:
  - [ ] TDD：边界矩阵测试先行
  - [ ] vitest：跨午夜 2/1 分桶正确；跨月正确；voided 剔除（total 不含但 orderCount 不含、明细若含需带 status 标记）；零销售日零值
  - [ ] vitest：日报 total = 明细行 total_cents 之和（自洽断言）

  **QA Scenarios**:

  ```
  Scenario: 聚合边界矩阵（happy path，单元级）
    Tool: Bash (vitest)
    Steps:
      1. seed：2026-10-31 23:59:59 ×2 单、2026-11-01 00:00:01 ×1 单（含 1 voided）
      2. daily('2026-10-31') → orderCount=2, totalCents=两单和
      3. daily('2026-11-01') → orderCount=0（该日唯一单被 void 或计入——按 seed 设计精确断言）
      4. monthly('2026-10') → 含 31 日两单
    Expected Result: 全部分桶与剔除正确
    Failure Indicators: UTC 偏移导致跨日错桶
    Evidence: .omo/evidence/task-14-report-matrix.txt

  Scenario: 空数据日（edge case）
    Tool: Bash (vitest)
    Steps:
      1. daily('2030-01-01') on 空 DB
      2. 断言 resolve {totalCents:0, orderCount:0, items:[]} 而非 reject
    Expected Result: 优雅空态
    Failure Indicators: 抛错
    Evidence: .omo/evidence/task-14-empty-day.txt
  ```

  **Commit**: YES
  - Message: `feat(reports): 日/月报统计服务（剔除作废+跨午夜）`

- [ ] 15. 打印编排集成（结账→预览→打印全流程 + 失败恢复 + 重打）

  **What to do**:
  - `src/main/printing/print.service.ts` 补全编排层：
    - `printSale(saleId): Promise<void>`：读 sale 明细（repo）→ 读默认模板（template.repo，含 logoBuffer 从 settings.logo_path 读文件）→ 组装 vars → `generateReceiptBytes` → `getChannel(settings)` → `enqueuePrintJob(bytes)`
    - `previewSale(saleId): Promise<PreviewPayload>`：同源数据但返回 `{template, data, vars}`（渲染层 ReceiptPreview 消费）——**预览与打印用同一份数据组装代码路径**（G7 落实）
  - `src/main/ipc/printing.ipc.ts`：`printing:printers`（listSystemPrinters）、`printing:preview`、`printing:print`（含 settings.printer_name 透传）
  - **预览窗口**：主窗口内 `el-dialog`（全屏遮罩，宽度随模板纸宽）内嵌 ReceiptPreview + 「立即打印」「取消」按钮——结账成功回调（Task 11 挂接点）触发 `printing:preview` → 弹窗
  - **打印失败恢复（G3）**：enqueuePrintJob reject → `.el-message--error`（含通道名与错误信息）+ 引导文案 '销售已保存，可稍后在销售记录中重打'；**绝不回滚销售**
  - **重打接线**：Task 13 的重打按钮 → `printing:preview`（带 saleId）→ 同一预览弹窗（voided 单 vars.status='voided' → 模板 footer 上方加印 '=== 已作废 ===' 行，倍高居中）
  - E2E 全流程：结账 → 预览弹窗出现（内容正确）→ 取消（无打印）→ 历史重打 → 预览 → 立即打印（**通道 mock**：E2E 环境 settings.printer_channel='tcp' + 127.0.0.1:19910 本地 mock server，断言 server 收到含 `1b40` 的字节流）
  - 打印失败路径 E2E：mock server 拒连（端口 1）→ 点立即打印 → 错误消息出现 + 销售记录完好

  **Must NOT do**:
  - 打印失败不得影响/回滚销售数据（G3）
  - 预览与打印不得用两套数据组装（必须同一 previewSale 数据源）
  - 连续结账打印不得并行（必须过串行队列）
  - 不得在预览弹窗内改打印机（设置页职责，保持弹窗简单）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 全应用集成密度最高的任务——打印子系统、销售流程、UI 弹窗、失败恢复闭环
  - **Skills**: [`debugging`]
    - `debugging`: 集成点多，失败路径需要系统性排查

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3a（with 16, 18）
  - **Blocks**: 20, F1-F4
  - **Blocked By**: 4（生成器）, 7（通道）, 11（结账挂接）, 12（预览组件）, 13（重打入口）

  **References**:
  **Pattern References**:
  - `src/main/printing/print.service.ts`（Task 7 的队列部分）— enqueuePrintJob API
  - `src/main/printing/escpos/escpos-generator.ts`（Task 4）— generateReceiptBytes 签名
  - Task 11 结账成功回调点 + Task 13 重打按钮 emit 点 — UI 挂接位置
  - Task 6 E2E helpers 的 mock TCP server 模式（Task 7 建立）— E2E 打印验证复用
  - **WHY**: 本任务是"胶水核心"，全部上游 API 签名必须逐字核对；E2E 的 tcp mock 是无实机验证策略的最终闭环

  **Acceptance Criteria**:
  - [ ] E2E：结账 → 2s 内预览弹窗出现且 `.receipt-line` 行含 shopName/单号/商品行/合计
  - [ ] E2E：预览「立即打印」（tcp mock）→ mock server 收到字节流含 `1b 40`（init）且以 `1d 56`（切纸，默认模板开）结尾
  - [ ] E2E：打印失败（拒连端口）→ `.el-message--error` 出现 + 销售记录页该单存在且可再次重打
  - [ ] E2E：voided 单重打 → 预览含 '已作废' 文本
  - [ ] vitest：printSale 数据组装（模板+销售+vars）单测（mock channel 断言传入字节）

  **QA Scenarios**:

  ```
  Scenario: 结账→预览→打印闭环（happy path）
    Tool: Playwright E2E + 本地 mock TCP server（node 脚本 127.0.0.1:19910）
    Preconditions: settings: printer_channel='tcp', tcp_host='127.0.0.1', tcp_port=19910；seed 商品与模板默认
    Steps:
      1. #/pos 加购 2 商品 → 结账
      2. 断言 el-dialog 可见且含 .receipt-line ≥ 8 行、含 '20261101-' 单号
      3. 点击「立即打印」→ await mock server 收满
      4. 断言字节流 hex 含 '1b40'、'1d56'；长度 > 200 字节
    Expected Result: 预览内容与打印字节同源闭环
    Failure Indicators: 弹窗空、mock 无数据、字节缺指令
    Evidence: .omo/evidence/task-15-print-flow.png + task-15-received-bytes.bin（mock server 落盘）

  Scenario: 打印失败不丢销售（failure/edge case）
    Tool: Playwright E2E
    Preconditions: settings tcp_port=1（不可达）
    Steps:
      1. 结账 → 预览 → 立即打印
      2. 断言 .el-message--error 出现且文案含 '重打'
      3. 导航 #/sales-history → 该单存在 status='已完成'
      4. 重打 → 预览弹窗正常（数据未受影响）
    Expected Result: G3 满足——落库与打印完全解耦
    Failure Indicators: 销售记录缺失、二次预览报错
    Evidence: .omo/evidence/task-15-failure-recovery.png
  ```

  **Commit**: YES
  - Message: `feat(printing): 打印编排集成（结账→预览→打印→失败恢复→重打）`

- [ ] 16. 小票模板编辑器（表单配置 + 实时预览 + CRUD）

  **What to do**:
  - `src/main/db/repositories/template.repo.ts`：list/getByDefault/create/update/delete/setDefault（config_json 存取）
  - `src/main/ipc/templates.ipc.ts` 接线
  - `TemplateEditorView.vue`：
    - 左侧：模板列表（名称/纸宽/默认标记）+ 新建/复制/删除按钮
    - 右侧上：**表单区**（el-form）：
      - 基本信息：名称、纸宽 radio（58mm/80mm）、切纸 switch、默认模板 radio
      - 头部/底部段落：**段落行列表**（每行：类型 select[text/image/divider]、内容 input（含变量插槽提示 popover 列出可用 `{shopName}` 等）、对齐 select、字号 select(normal/doubleHeight/doubleWidth/quad)、加粗 switch、上移/下移/删除/添加按钮）
      - 明细列：四列标题（商品/数量/单价/小计 input）+ 列宽比例（4 个 el-slider 总和 100）
      - 合计区：合计行 label input + 字号/加粗
    - 右侧下：**实时预览**（ReceiptPreview 组件，watch 表单 → 本地即时渲染，样例数据填充）
    - 保存 → templates:update → 重新加载列表
  - Logo 段落：type=image 时提示 'Logo 在系统设置中上传'（引用 settings.logo_path，不在模板里存图）
  - E2E：改头部字号为倍高 → 预览对应行 class 变化（`.receipt-line--double-height`）；关闭 Logo 段落 → （打印字节在 Task 15 的 E2E 已覆盖模板影响，此处 UI 断言预览变化即可）；保存后设为默认 → 新结账用新模板（可断言 preview IPC 返回的 template.name）

  **Must NOT do**:
  - 不做拖拽/绝对定位/逐元素样式（锁定清单，段落级为止，G14）
  - 预览不得等保存才刷新（watch 实时）
  - 不得允许删除最后一个模板（至少保留 1 个——UI 禁用删除按钮 + service 校验）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 复杂表单 + 实时预览联动，UI 工作为主
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 表单-预览双栏布局、段落行操作交互

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3a（with 15, 18）
  - **Blocks**: 20
  - **Blocked By**: 12（预览组件）, 3（schema）

  **References**:
  **Pattern References**:
  - `src/shared/receipt/template-schema.ts`（Task 3）— 表单模型即 schema 类型的 UI 映射
  - `ReceiptPreview.vue`（Task 12）— 预览组件 props 契约
  - 默认模板 default-template.ts（Task 3）— 新建模板的初始值来源
  - **WHY**: 表单字段必须与 schema 字段一一对应（type/align/size 枚举逐字复用），否则保存的模板渲染不了

  **Acceptance Criteria**:
  - [ ] vitest：template repo CRUD + setDefault 互斥（只能一个默认）
  - [ ] E2E：新建模板（改名称+58mm）→ 列表出现 → 编辑改头部字号 'doubleHeight' → 预览区该行 class 变化（10s 内实时）
  - [ ] E2E：设为默认 → 结账预览弹窗使用该模板（断言预览含模板特征内容）
  - [ ] E2E：最后一个模板删除按钮 disabled

  **QA Scenarios**:

  ```
  Scenario: 模板编辑实时预览（happy path）
    Tool: Playwright E2E
    Preconditions: 默认模板存在
    Steps:
      1. #/template-editor → 选中默认模板
      2. 头部第一段字号 select 改 'doubleHeight'（倍高）
      3. 断言预览区第一行 .receipt-line 增加/变为 class 'receipt-line--double-height'
      4. 添加 footer 段落 type=text content='测试变量 {shopName}' → 预览出现 '测试变量'（shopName 为空时原样或空——断言插槽文本渲染）
      5. 保存 → toast 成功 → 刷新页面后表单值保持
    Expected Result: 实时联动 + 持久化
    Failure Indicators: 预览不刷新、保存丢字段
    Evidence: .omo/evidence/task-16-template-editor.png

  Scenario: 纸宽切换与非法状态（edge case）
    Tool: Playwright E2E
    Steps:
      1. 纸宽切 58mm → 预览容器宽度变窄（getBoundingClientRect < 240px）
      2. 尝试删除唯一模板 → 删除按钮 disabled
      3. 名称清空 → 保存按钮 disabled 或校验红字（form rules）
    Expected Result: 输入约束生效
    Failure Indicators: 空名入库、唯一模板被删
    Evidence: .omo/evidence/task-16-constraints.png
  ```

  **Commit**: YES
  - Message: `feat(templates): 小票模板编辑器（表单+实时预览）`

- [x] 17. 导出器（txt/xlsx/docx + saveDialog + round-trip 测试）

  **What to do**:
  - `src/main/export/txt.exporter.ts`：报表 → 纯文本（表头/分隔线/行/合计，char-grid 对齐复用，**UTF-8 with BOM**——Windows 记事本兼容）
  - `src/main/export/xlsx.exporter.ts`：`exceljs` Workbook：Sheet1 '汇总'（总销售额/订单数/日期），Sheet2 '明细'（单号/时间/商品/数量/单价/小计/状态）；列宽自适应；金额列数字格式 `0.00`（**写入时除以 100 转元**——导出层格式化，G1 不变）
  - `src/main/export/docx.exporter.ts`：`docx` 库：标题（日期/月度 + '销售报表'，Heading）+ 汇总段落 + 明细 Table（Table/TableRow/TableCell，简单边框）——**标题+表格止步（锁定清单）**
  - `src/main/export/export.service.ts`：`exportReport(report, format)`：`dialog.showSaveDialog({ defaultPath: '日报2026-11-01.xlsx', filters: [...] })` → 用户取消返回 null → 写文件 → `shell.showItemInFolder(path)`
  - `src/main/ipc/reports.ipc.ts` 增加 export 通道
  - 单测（**round-trip 矩阵**）：
    - xlsx：exporter 产出 Buffer → exceljs 重新加载 → 断言单元格值（汇总 total、明细行数、状态列）
    - docx：Buffer → 解压（docx 是 zip）→ 断言 document.xml 含标题文本与合计数字
    - txt：直接字符串断言（含合计行、BOM 头 `EF BB BF`）

  **Must NOT do**:
  - 不得在 exporter 里弹 UI（dialog 在 export.service 层）
  - docx 不得加图片/复杂样式
  - 金额不得以分写入 xlsx 单元格（导出层转元，保持人类可读）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 三格式导出 + round-trip 测试矩阵，工作量大但模式明确
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a（with 8, 9, 10, 12, 19）
  - **Blocks**: 18（报表 UI 调用）
  - **Blocked By**: 3（DTO）

  **References**:
  **External References**:
  - exceljs: https://github.com/exceljs/exceljs/blob/master/README.md — workbook.xlsx.writeBuffer()、worksheet.columns、numFmt
  - docx: https://docx.js.org/#/ — Document/Paragraph/Table/Packer.toBuffer
  - Electron dialog: https://www.electronjs.org/docs/latest/api/dialog#dialogshowsavedialogbrowserwindow-options — showSaveDialog + filters（{ name: 'Excel', extensions: ['xlsx'] }）
  - Electron shell.showItemInFolder: https://www.electronjs.org/docs/latest/api/shell
  - **WHY**: round-trip 断言依赖 exceljs 读回 API 与 docx 的 zip 结构；BOM 是 Windows 中文 txt 的兼容性关键

  **Acceptance Criteria**:
  - [ ] TDD：round-trip 测试先行
  - [ ] vitest：xlsx 读回断言汇总/明细单元格（≥8 断言）；docx 解压含标题与合计；txt 含 BOM 与合计行
  - [ ] E2E：导出 xlsx（dialog mock 为固定路径——E2E 里用 `page.on('filechooser')` 不适用，改用环境变量 E2E_EXPORT_DIR 跳过 dialog 直写，**实现需支持此测试钩子**）→ 文件存在且 exceljs 脚本读回断言
  - [ ] 用户取消 dialog → 无文件写入且不报错

  **QA Scenarios**:

  ```
  Scenario: 三格式 round-trip（happy path，单元级）
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run tests/unit/export/
      2. 用例组：txt（BOM+合计行）、xlsx（exceljs 读回 Sheet1!A2 == 总额、Sheet2 行数 == 明细数）、docx（unzip document.xml 含 '销售报表'）
    Expected Result: 全 pass
    Failure Indicators: 读回值错、中文乱码
    Evidence: .omo/evidence/task-17-roundtrip.txt

  Scenario: E2E 导出落盘（happy path）
    Tool: Playwright E2E
    Preconditions: E2E_EXPORT_DIR=/tmp/opencode/e2e-exports；seed 报表数据
    Steps:
      1. 触发导出（通过测试钩子直接调 export 通道，路径注入）
      2. 断言 /tmp/opencode/e2e-exports/日报YYYY-MM-DD.xlsx 存在
      3. node 脚本 exceljs 读回 → total 单元格 == seed 合计
    Expected Result: 文件正确落盘可读
    Failure Indicators: 文件缺失/内容错
    Evidence: .omo/evidence/task-17-e2e-export.txt + 导出文件副本

  Scenario: 取消保存（edge case）
    Tool: Bash (vitest, mock dialog)
    Steps:
      1. mock showSaveDialog 返回 { canceled: true }
      2. exportReport → resolve null，无 fs 写调用（mock fs 断言未调用）
    Expected Result: 优雅取消
    Failure Indicators: 抛错/写空文件
    Evidence: .omo/evidence/task-17-cancel.txt
  ```

  **Commit**: YES
  - Message: `feat(export): txt/xlsx/docx 导出器`

- [ ] 18. 报表 UI + 导出集成

  **What to do**:
  - `ReportsView.vue`：Tabs（日报/月报）：
    - 日报 tab：日期选择（默认今天）→ 汇总卡片（总销售额/订单数，大数字展示）+ 明细表格（单号/时间/商品数/合计/状态）+ 导出按钮组（.txt/.xlsx/.docx，el-dropdown）
    - 月报 tab：月份选择 → 汇总卡片 + 按日分桶表格（日期/销售额/订单数）+ 导出同上
    - 空数据态（el-empty '当日无销售'）
  - 导出交互：点击 → `reports:export {type, date, format}` → 成功 toast '已导出并打开所在文件夹'
  - E2E：seed 跨午夜数据 → 日报切换日期正确联动 → 三格式导出落盘断言（复用 Task 17 钩子）→ 空数据日显示 empty

  **Must NOT do**:
  - 不得在 UI 层重新计算合计（用 service 返回值）
  - 不得加图表组件（锁定清单）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 数据展示页面，UI 为主
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 汇总卡片信息层级、表格密度

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3a（with 15, 16）
  - **Blocks**: 20
  - **Blocked By**: 14（service）, 17（导出器）, 6（容器）

  **References**:
  **Pattern References**:
  - Task 14 的 DailyReport/MonthlyReport DTO — UI 绑定字段
  - Task 17 的 export 通道契约 — 按钮组调用参数
  - **WHY**: 字段逐字绑定，避免 UI 自造字段名

  **Acceptance Criteria**:
  - [ ] E2E：日报汇总卡片显示 seed 合计（元格式 'XX.XX'）+ 明细行数正确
  - [ ] E2E：切日期/切 tab 数据联动；空数据日 el-empty 可见
  - [ ] E2E：三格式导出各落盘一个文件（Task 17 钩子路径断言）

  **QA Scenarios**:

  ```
  Scenario: 报表查看与导出（happy path）
    Tool: Playwright E2E
    Preconditions: seed：今日 2 单 completed（合计 1750 分）+ 1 单 voided
    Steps:
      1. #/reports 日报 tab 默认今天
      2. 断言汇总卡片 '17.50'、订单数 '2'（voided 剔除）
      3. 明细表 2 行（若实现含 voided 标记则 3 行带 tag——按 DTO 断言）
      4. 导出 .xlsx → 落盘断言 + exceljs 读回 total==17.50
    Expected Result: 数据准确 + 导出闭环
    Failure Indicators: voided 计入、导出失败
    Evidence: .omo/evidence/task-18-reports-e2e.png + 导出文件

  Scenario: 空数据日（edge case）
    Tool: Playwright E2E
    Steps:
      1. 日期选 2030-01-01 → 断言 el-empty 可见且导出按钮仍可用（导出空表）
      2. 导出 .txt → 内容含 '0.00' 合计行
    Expected Result: 空态优雅
    Failure Indicators: 报错/按钮禁用
    Evidence: .omo/evidence/task-18-empty-day.png
  ```

  **Commit**: YES
  - Message: `feat(reports): 报表界面与导出集成`

- [x] 19. 系统设置页（打印机配置 + 店铺信息 + Logo 上传）

  **What to do**:
  - `src/main/db/repositories/settings.repo.ts`：get/getAll/set（KV upsert）
  - `src/main/ipc/settings.ipc.ts` + `printing.ipc` 的 printers 通道复用
  - `SettingsView.vue` 三个卡片：
    - **店铺信息**：店名/电话/小票备注（对应 vars.shopName/shopPhone/receiptNote——模板变量源头）el-input + 保存
    - **打印设置**：
      - 通道 radio：'spooler'（系统打印机，**默认**）/ 'tcp'（网络）/ 'serial'（串口）
      - spooler：打印机下拉（`printing:printers` 拉取 getPrintersAsync 列表 + '自动选择(RAW)' 选项对应 printer:auto）+ 「测试打印」按钮（发送最小 ESC/POS 测试字节——init+居中 'test'+切纸；成功 toast/失败 error）
      - tcp：host + port(默认 9100) 输入 + 测试打印
      - serial：COM 口下拉（串口列表用 fs 探测 /dev/tty* 或 Windows `\\\\.\\COM` 探测——**Linux 下显示手输框**，G11）
      - 自动切纸 switch（写入 settings.auto_cut——print.service 透传给生成器覆盖模板？**决策：模板 cutPaper 优先，此开关仅作默认模板初始值**——避免双事实源，文档化）
    - **Logo**：上传按钮（`dialog.showOpenDialog` 选 png）→ 复制到 userData/logos/logo.png → settings.logo_path；预览缩略图 + 清除按钮
  - E2E：保存店名 → 结账预览小票头部含新店名（变量链路闭环）；切换通道到 tcp+mock → 测试打印按钮 → mock server 收到字节

  **Must NOT do**:
  - 不得把 Logo 存 DB BLOB（文件系统 + 路径引用）
  - 不得让 auto_cut 与模板 cutPaper 形成双事实源冲突（模板优先，设置项只作为模板默认值的说明文案）
  - 测试打印不得绕过串行队列

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 表单页 + 少量集成，模式成熟
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 设置页三卡片布局

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2a（with 8, 9, 10, 12, 17）
  - **Blocks**: 20
  - **Blocked By**: 7（通道）, 6（容器）

  **References**:
  **Pattern References**:
  - ER 章节 settings 表 KV 结构 — key 清单（shop_name/shop_phone/receipt_note/logo_path/printer_channel/printer_name/tcp_host/tcp_port/com_port）
  - Task 7 的 listSystemPrinters + 通道工厂 — 下拉与测试打印的后端
  - Electron dialog.showOpenDialog: https://www.electronjs.org/docs/latest/api/dialog#dialogshowopendialogbrowserwindow-options
  - **WHY**: key 清单是契约；Logo 文件流（userData/logos/）路径规则需与 print.service 的 logoBuffer 读取一致

  **Acceptance Criteria**:
  - [ ] E2E：改店名 '我的小店' → 保存 → 结账 → 预览头部含 '我的小店'
  - [ ] E2E：通道切 tcp + 127.0.0.1:19910 → 测试打印 → mock server 收到含 `1b40` 字节
  - [ ] E2E：上传 Logo（E2E 注入固定 png）→ settings.logo_path 指向 userData/logos/ → 预览含 `<img>`（dataURL）
  - [ ] vitest：settings repo KV upsert 语义

  **QA Scenarios**:

  ```
  Scenario: 店名变量闭环（happy path）
    Tool: Playwright E2E
    Steps:
      1. #/settings 店名输入 '我的小店' → 保存 → toast 成功
      2. #/pos 结账任意商品 → 预览弹窗
      3. 断言首个 .receipt-line 文本含 '我的小店'
    Expected Result: 设置→模板变量→小票全链路生效
    Failure Indicators: 预览仍是旧名/空
    Evidence: .omo/evidence/task-19-shopname-flow.png

  Scenario: 无打印机环境优雅降级（edge case）
    Tool: Playwright E2E
    Steps:
      1. spooler 通道（Linux E2E 环境 printers 列表可能为空）→ 断言下拉显示 '自动选择' 选项且不崩溃
      2. 测试打印 → 预期 error toast（Linux 无 spooler）——断言错误被捕获非崩溃
    Expected Result: G11 满足——Windows-only 能力在 Linux 优雅降级
    Failure Indicators: 未捕获异常白屏
    Evidence: .omo/evidence/task-19-graceful-degrade.png
  ```

  **Commit**: YES
  - Message: `feat(settings): 系统设置页（打印机/店铺/Logo）`

- [ ] 20. Windows CI 完善 + NSIS 打包 + 真机验证清单

  **What to do**:
  - `electron-builder` 配置（`electron-builder.yml` 或 package.json build 段）：appId/productName（中文产品名如 '销存系统'）、win.target nsis、nsis.oneClick=false（允许选目录）、`asarUnpack`（若 better-sqlite3 v13 需要——按 Task 2 spike 结论）、artifactName 含版本
  - `.github/workflows/ci.yml` 完善（windows-latest）：
    - job1 test：npm ci → typecheck → vitest → Playwright E2E（含 tcp mock 打印场景）
    - job2 build：npm run build → electron-builder --win nsis → upload artifact（.exe）
    - 可选 job3（linux）：vitest 子集（验证 G11 双平台）
  - **打包后启动验证**：CI 里下载 artifact 解包运行 smoke（或 `npx electron-builder --dir` 后 `Start-Process` 运行 out 目录 exe + Playwright attach——若复杂则记录为真机清单项，CI 只验证 build 产出存在 + E2E 全绿）
  - `docs/windows-manual-checklist.md`《Windows 真机验证清单》：
    1. 安装 NSIS .exe → 启动 → 首启建库
    2. 设置页能看到系统打印机列表（含小票机）
    3. spooler 通道选小票机 → 测试打印 → 出纸（若乱码/空走纸 → 装 Generic/Text Only 驱动指引步骤）
    4. 真实结账 → 预览 → 打印 → 检查中文/粗体/倍高/居中/切纸/Logo
    5. tcp 通道（若打印机有网口）重复 3-4
    6. 扫码枪实枪扫 5 个真实商品条码 → 加购
    7. 连续快速结账 3 单 → 打印串行不交叠
    8. 中文生僻字商品（如 '龘'）小票降级 '?' 不崩
    每项：操作步骤 + 预期 + 勾选框
  - `README.md`：运行/开发/打包说明 + **手动备份指引**（关闭应用后复制 userData/pos.db；WAL 三文件说明 .db/.db-wal/.db-shm）+ 数据位置说明
  - 验证：push 到 GitHub → CI 全绿 → artifact 下载确认 .exe 存在

  **Must NOT do**:
  - 不得在 CI 跑 spooler 通道真打印（无打印机，跳过）
  - 不得配置自动更新（锁定清单）
  - 清单不得写"应该没问题"类模糊项（每项可勾选、有预期）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: CI/打包跨平台细节多、真机清单需要从全部任务汇总验证点
  - **Skills**: [`git-master`]
    - `git-master`: workflow 文件与仓库管理（若需推送验证 CI）

  **Parallelization**:
  - **Can Run In Parallel**: NO（Wave 3b 收尾单任务——依赖 15/16/18/19 全部完成）
  - **Parallel Group**: Wave 3b（串行收尾）
  - **Blocks**: F1-F4
  - **Blocked By**: 15, 16, 18, 19（全部功能完成后打包验证才有意义）

  **References**:
  **Pattern References**:
  - Task 2 spike 结论 — asarUnpack 需求
  - 全部任务 QA 场景 — 真机清单条目来源（尤其 Task 15/19 打印场景、Task 5 扫码）
  - **External References**:
  - electron-builder NSIS: https://www.electron.build/configuration/nsis — oneClick/allowToChangeInstallationDirectory
  - GitHub Actions: https://docs.github.com/en/actions/using-jobs/using-jobs-in-a-workflow — matrix/needs/upload-artifact
  - **WHY**: asarUnpack 配置错误是原生模块打包后启动失败的头号原因；清单条目必须回溯各任务 QA 场景保证覆盖

  **Acceptance Criteria**:
  - [ ] `npm run dist`（本地 Linux）产出 NSIS .exe（或记录必须 Windows/CI 构建的原因）
  - [ ] GitHub Actions windows-latest 全绿（typecheck + vitest + E2E + build + artifact）
  - [ ] artifact 含 .exe 且体积合理（< 150MB）
  - [ ] docs/windows-manual-checklist.md 存在且 ≥8 项每项有步骤/预期/勾选框
  - [ ] README 含备份指引与数据位置

  **QA Scenarios**:

  ```
  Scenario: CI 全绿产出安装包（happy path）
    Tool: Bash (gh / git)
    Preconditions: 仓库已推 GitHub；全部功能任务完成
    Steps:
      1. git push 触发 workflow
      2. gh run watch 或轮询 gh run list --limit 1
      3. gh run download 拉取 artifact
      4. ls artifact/*.exe 确认存在；file 命令确认 PE32+ Windows executable
    Expected Result: CI 全绿 + .exe artifact 存在
    Failure Indicators: 任一 job 红、artifact 缺失
    Evidence: .omo/evidence/task-20-ci-run.txt（gh run 输出）+ .omo/evidence/task-20-artifact-list.txt

  Scenario: E2E 在 windows-latest 通过（edge case——Linux 开发的镜像验证）
    Tool: GitHub Actions 日志
    Steps:
      1. 检查 job1 的 Playwright 输出：打印 mock 场景（tcp 127.0.0.1）通过
      2. 确认无 Windows-only 路径在 Linux job3（若有）红
    Expected Result: 双平台行为一致（G11 验证）
    Failure Indicators: Windows 路径分隔符/编码差异导致红
    Evidence: .omo/evidence/task-20-windows-e2e-log.txt
  ```

  **Commit**: YES
  - Message: `build(ci): windows-latest CI + NSIS 打包 + 真机验证清单`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command, curl endpoint). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .omo/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `npm run typecheck` + `npm run build` + `npm test`. Review all changed files for: `as any`/`@ts-ignore`、empty catches、console.log in prod、commented-out code、unused imports。Check AI slop: excessive comments、over-abstraction、generic names。Check guardrails G1/G6/G8 violations（float 金额、generator I/O、renderer 原生依赖）。
  Output: `Build [PASS/FAIL] | Typecheck [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state（删除 userData DB）。Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence。Test cross-task integration（扫码→购物车→结账→预览→打印失败→重打→报表→导出全链路）。Test edge cases：空购物车结账、库存扣负、删除有历史商品后查记录、模板编辑后重打。Save to `.omo/evidence/final-qa/`。
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff)。Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep)。Check "Must NOT do" compliance。Detect cross-task contamination。Flag unaccounted changes。
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Task 1**: `chore(init): electron-vite 6 + vue3 + ts + element-plus 脚手架与测试基建`
- **Task 2**: `feat(db): better-sqlite3 连接、迁移执行器与 ER 全量 schema`
- **Task 3**: `feat(shared): DTO/IPC 类型契约与小票模板 schema`
- **Task 4**: `feat(printing): ESC/POS 纯函数生成器（GBK 编码+golden 测试）`
- **Task 5**: `feat(scanner): 扫码枪检测器（纯函数+IME 兼容桥）`
- **Task 6**: `feat(ui): 应用骨架布局路由与 E2E 基建`
- **Task 7**: `feat(printing): 打印通道抽象（spooler/tcp/serial+串行队列）`
- **Task 8**: `feat(products): 商品管理全链路（CRUD+搜索+库存调整流水）`
- **Task 9**: `feat(purchases): 进货入库全链路（单据+库存+流水）`
- **Task 10**: `feat(sales): 结账与作废事务核心（原子性+kill-point 测试）`
- **Task 11**: `feat(pos): 收银台界面（扫码/双击加购/购物车编辑）`
- **Task 12**: `feat(receipt): HTML 小票预览组件（同源渲染 58/80mm）`
- **Task 13**: `feat(history): 销售记录查询与明细`
- **Task 14**: `feat(reports): 日/月报统计服务（剔除作废+跨午夜）`
- **Task 15**: `feat(printing): 打印编排集成（结账→预览→打印→失败恢复→重打）`
- **Task 16**: `feat(templates): 小票模板编辑器（表单+实时预览）`
- **Task 17**: `feat(export): txt/xlsx/docx 导出器`
- **Task 18**: `feat(reports): 报表界面与导出集成`
- **Task 19**: `feat(settings): 系统设置页（打印机/店铺/Logo）`
- **Task 20**: `build(ci): windows-latest CI + NSIS 打包 + 真机验证清单`
- 每 Task 一个 commit；Pre-commit：`npm run typecheck && npm test`

---

## Success Criteria

### Verification Commands
```bash
npm run typecheck          # Expected: 0 errors
npm test                   # Expected: all pass（unit + golden 字节矩阵）
npm run build              # Expected: 成功产出 out/
npm run test:e2e           # Expected: Playwright 全场景通过
gh workflow run ci.yml     # Expected: windows-latest 全绿 + NSIS artifact
```

### Final Checklist
- [ ] All "Must Have" present（分层架构/ER/快照/事务/纯函数生成器/双渲染同源/整数分/作废/负库存/串行队列/单实例/WAL）
- [ ] All "Must NOT Have" absent（16 项 Guardrails 零违反）
- [ ] 全部测试绿（unit + E2E + golden）
- [ ] CI windows-latest 全绿，NSIS .exe 产出
- [ ] 《Windows 真机验证清单》与 README（备份指引）交付
- [ ] 用户对 F1-F4 结果明确 okay
