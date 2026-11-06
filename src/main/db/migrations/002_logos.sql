-- ═══ 店铺 Logo（多文件架构：userData/logos/<uuid>.png，DB 只存元数据）═══
CREATE TABLE logos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL UNIQUE,                    -- logos 目录内文件名（<uuid>.png；不存绝对路径——userData 运行时可变）
  display_name TEXT NOT NULL DEFAULT '',                -- 展示名（默认上传文件名去扩展）
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
