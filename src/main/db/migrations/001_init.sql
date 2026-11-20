-- ═══════════════════════════════════════════════════════════════════════
-- 全量初始化 schema（合并版——单文件直接建库，无增量迁移历史）。
--
-- 历史：原 001~005 增量迁移（init / logos / sn_products / product_soft_delete /
-- customer_order_extras）已合并为本文件；因无线上数据，旧增量库不做兼容升级，
-- migrator 启动守卫检测到旧库（user_version 2~5，或 =1 但缺哨兵表
-- product_change_logs）直接报错，要求删除 pos.db 重新初始化。
--
-- 铁律索引：G1 金额整数分；G4 单据明细存商品快照；G5 库存变动必写
-- stock_movements 审计链；D2 允许负库存；D3 作废不物理删除行。
-- ═══════════════════════════════════════════════════════════════════════

-- ═══ 商品（含可选默认售价，允许负库存；SN 计存二分——D-SN1；软删——deleted）═══
CREATE TABLE products (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode            TEXT UNIQUE,                    -- 可空：无条码商品靠搜索加购
  name               TEXT NOT NULL,
  default_price_cents INTEGER,                       -- 可空：购物车自动带出可改
  stock              INTEGER NOT NULL DEFAULT 0,     -- 允许负数（用户决策——D2）
  tracking           TEXT NOT NULL DEFAULT 'quantity'
    CHECK (tracking IN ('quantity','sn')),           -- 计存类型（建后不可转——D-SN1）
  sn_prefix          TEXT NOT NULL DEFAULT '',       -- SN 前缀（空串=无前缀——D-SN2）
  deleted            INTEGER NOT NULL DEFAULT 0,     -- 软删标记（行保留，历史单据/审计链完整）
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_products_name    ON products(name);
CREATE INDEX idx_products_barcode ON products(barcode);

-- ═══ 进货单（头-行结构，行含商品快照；支持整单作废——不物理删除行）═══
CREATE TABLE purchase_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no    TEXT NOT NULL UNIQUE,                  -- yyyyMMdd-NNNN
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed','voided')),        -- 整单作废状态
  voided_at   TEXT,                                  -- 作废时间（作废时写入）
  void_reason TEXT,                                  -- 作废原因（作废时必填）
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE purchase_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id      INTEGER REFERENCES products(id),   -- nullable：快照设计（G4）
  product_name    TEXT NOT NULL,                     -- ── 快照字段 ──
  barcode         TEXT,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  cost_price_cents INTEGER NOT NULL CHECK (cost_price_cents >= 0),
  sn              TEXT                               -- SN 快照（SN 行每 SN 一行——D-SN10/12）；批量计行 NULL
);
CREATE INDEX idx_purchase_items_order ON purchase_items(order_id);

-- ═══ 销售单（头-行结构，行含商品快照，支持作废——D3）═══
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
  subtotal_cents  INTEGER NOT NULL,
  sn              TEXT                               -- SN 快照（D-SN12）；批量计行 NULL
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

-- ═══ 库存流水（审计链：sale/purchase/manual/sale_void/purchase_void 全覆盖——G5）═══
-- source 语义：sale=销售出库 purchase=进货入库 manual=手动调整/SN 删除
--              sale_void=销售作废回滚 purchase_void=进货作废冲减
CREATE TABLE stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  change_qty  INTEGER NOT NULL,                      -- 正=入库 负=出库
  before_stock INTEGER NOT NULL,
  after_stock  INTEGER NOT NULL,
  source      TEXT NOT NULL
    CHECK (source IN ('sale','purchase','manual','sale_void','purchase_void')),
  source_id   INTEGER,                               -- sale_id / purchase order_id / NULL(manual)
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_movements_product ON stock_movements(product_id);

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
-- 进货作废按来源行回滚台账（purchase_void 守卫/执行均以 purchase_item_id 定位）
CREATE INDEX idx_product_sns_purchase_item ON product_sns(purchase_item_id);

-- ═══ 商品改动记录（商品管理审计：一次保存一条，含逐字段旧→新明细）═══
-- action 语义：update=编辑保存（可含库存联动） stock=独立手动调库
--              delete=删除商品（软删） sn_delete=删除在库 SN
-- changes_json：[{field, old, new}]，old/new 保留原始类型（分为整数、null 保留）；
-- delete 动作无字段明细，存 '[]'。
CREATE TABLE product_change_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES products(id),  -- 软删商品行仍在，FK 有效、历史可查
  action       TEXT NOT NULL CHECK (action IN ('update','stock','delete','sn_delete')),
  reason       TEXT NOT NULL,                             -- 改动原因（必填，service 层校验非空）
  changes_json TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_product_change_logs_product ON product_change_logs(product_id, id DESC);

-- ═══ 客户档案 + 订单附加信息（sale_extras 旁挂，sales 表零改动）═══
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

-- ═══ 店铺 Logo（多文件架构：userData/logos/<uuid>.png，DB 只存元数据）═══
CREATE TABLE logos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL UNIQUE,                 -- logos 目录内文件名（<uuid>.png；不存绝对路径——userData 运行时可变）
  display_name TEXT NOT NULL DEFAULT '',             -- 展示名（默认上传文件名去扩展）
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

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
    -- printer_channel('spooler'|'tcp'|'serial'|'driver')/printer_name/tcp_host/tcp_port/com_port/auto_cut
