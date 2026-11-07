-- ═══ 商品逻辑删除（软删行保留：FK 引用全部有效，历史单据/审计链完整）═══
ALTER TABLE products ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
