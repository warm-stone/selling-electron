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
    -- printer_channel('spooler'|'tcp'|'serial'|'driver')/printer_name/tcp_host/tcp_port/com_port/auto_cut
