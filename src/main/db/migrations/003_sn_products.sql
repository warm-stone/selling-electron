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
