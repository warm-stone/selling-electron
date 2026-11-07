-- ═══ 结账客户信息与订单附加信息（customers 客户档案 + sale_extras 订单附加：sales 表零改动，附加数据旁挂）═══
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
