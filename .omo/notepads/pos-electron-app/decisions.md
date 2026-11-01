# Decisions — pos-electron-app

## 用户已定案决策（不得偏离）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 技术栈 | Vue 3 + TypeScript（+ Electron 44.x + electron-vite 6 + Element Plus + better-sqlite3） |
| D2 | 库存不足 | **允许负库存**，结账不拦截；商品列表负库存标红 |
| D3 | 作废 | 简单作废：整单作废（事务回滚库存 + status='voided' + 报表剔除）；无部分退货 |
| D4 | 金额/数量 | 整数分存储（DB INTEGER）+ 整数数量；单价 UI 输入元 2 位小数 |
| D5 | 打印通道 | **spooler RAW 主**（用户打印机已是 Windows 系统打印机）+ tcp 辅 + 串口备，设置页可切 |
| D6 | 打印验证 | 无实机 → ESC/POS 字节断言 + golden .bin + CI mock TCP；真机后期联调（手动清单） |
| D7 | 模板 | 表单式配置 + 实时预览；段落制 JSON；**不做拖拽编辑器** |
| D8 | 纸宽 | 58mm + 80mm 双支持（共享 char-grid：32/48 列） |
| D9 | 预览 | 结账后 HTML 模拟预览弹窗 + 立即打印/取消；与打印同源渲染 |
| D10 | 报表 | 仅导出 .txt/.xlsx/.docx；**无普通打印机打印** |
| D11 | 登录 | 无登录/操作员/权限，打开即用 |
| D12 | 测试 | TDD 全覆盖（RED-GREEN-REFACTOR）+ vitest + Playwright _electron E2E |
| D13 | CI | GitHub Actions windows-latest（build+test+e2e+NSIS artifact） |
| D14 | 进货 | 简单进货：单据（商品+数量+成本价）→ 库存自动增加 + 流水 |
| D15 | 删除商品 | 硬删 + 确认弹窗（明示库存废弃）；历史靠快照存活 |
| D16 | 重复扫码 | 合并行 qty+1；行 key = 商品 + 单价 |
| D17 | 条码 | UNIQUE + nullable（无条码商品靠搜索加购） |
| D18 | 单号 | `yyyyMMdd-NNNN`（销售/进货各自独立日序列） |
| D19 | 重打 | 用**当前**模板（非销售时点快照）；voided 单重打加印 '已作废' 标记 |
| D20 | GBK 降级 | 生僻字符替换 '?' |
| D21 | 购物车 | 不持久化，关应用即弃 |
| D22 | 无登录锁定 | Must NOT Have 显式锁定（防执行期回加） |

## 架构铁律（Guardrails）
- G1 金额整数分端到端，禁止 float 金额
- G2 结账原子性：sales+items+扣库存+movements 单事务（kill-point 测试）
- G3 打印落库解耦：先提交后打印，打印失败不丢销售
- G4 快照不可变：sale_items/purchase_items 含商品快照，product_id nullable
- G5 手动改库存必写 stock_movements
- G6 ESC/POS 生成器纯函数，内部零 I/O
- G7 双渲染器同源同数学（char-grid 共享）
- G8 renderer 零 Node 依赖；typed IPC surface（无裸 invoke 魔法字符串）
- G9 schema 版本化（user_version + migrator）
- G10 单实例锁 + userData + WAL
- G11 path.join；Windows-only API Linux 可 mock/skip
- G12 Electron 44.x；better-sqlite3 spike 失败即走 fallback 链
- G13 扫码检测器纯函数
- G14 模板编辑只到段落级
