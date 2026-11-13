# 销存系统（selling-electron）

Windows 桌面销存系统（POS / 进销存）：Electron + Vue 3 + TypeScript + better-sqlite3，含商品、进货、销售、报表全链路与独立设计的小票打印子系统（ESC/POS 原始指令直发热敏打印机 + HTML 同源预览）。

## 功能

- **商品管理**：新增（条码/名称/初始库存）/ 编辑 / 删除 / 搜索（名称或条码）；库存调整留审计流水
- **进货管理**：采购入库单（多商品行），事务内自动增加库存并写流水
- **销售结账**：扫码或双击加购、购物车数量/单价可改、自动合计；结账弹窗可填客户信息（姓名/电话/地址/客户备注，电话自动关联已有客户）与订单信息（是否参与国补/订单备注/销售人员，销售人员缓存最近输入快选）；事务扣库存后弹小票预览；允许负库存（商品列表标红提示）
- **客户管理**：客户档案（电话唯一去重），列表搜索 / 新增 / 编辑；结账与订单侧按电话自动建档关联，客户信息修改后历史订单实时显示最新
- **作废销售**：整单作废（事务回滚库存，报表自动剔除）
- **销售记录**：按日期/状态/客户姓名/电话/是否国补筛选，列表含国补/销售人员/订单备注/客户列，双击查看明细（可修改国补/订单备注/销售人员/客户关联），随时重打小票（使用当前模板）
- **报表**：日报 / 月报（按日分桶，日报含国补销售额小计与明细两列），导出 `.txt` / `.xlsx` / `.docx`
- **小票打印**：模板体系（表单式编辑 + 实时预览 + 可用变量说明区，58mm/80mm 双纸宽）、ESC/POS 指令直发（粗体/倍高倍宽/居中/自动切纸/Logo 光栅钳制纸宽）、四种通道（Windows spooler RAW 主通道 / tcp 辅 / 串口备 / driver 驱动渲染兜底——「云」打印机兼容）、打印串行队列（连续结账不交叠）
- **设置**：店铺信息、打印机通道配置、Logo 上传；打印机诊断面板（一键采集 → 15 条规则判定 → L1/L2 修复建议与执行 → 三层报告导出）

## 架构（文字版）

```
renderer (Vue 3 + Element Plus, hash router)
    │  window.api（typed invoke，无魔法字符串）
preload (contextBridge 单一类型化 API surface)
    │  IPC（typed IpcChannels 契约）
main (Electron 主进程)
    ├── ipc/*          薄层：参数校验 + 调 service
    ├── services/*     业务核心（纯 TS + DI，vitest 免 Electron 可测）
    ├── repositories/*  DAL（纯 SQL）
    ├── db/            better-sqlite3（WAL + PRAGMA user_version 迁移）
    ├── printing/      ★ 打印子系统
    │     ├── escpos/  ESC/POS 纯函数生成器（GBK 编码 + 生僻字降级 '?' + Logo 光栅钳制纸宽/8 点对齐）
    │     │            + 字符网格数学（58mm=32 列 / 80mm=48 列，三渲染同源）
    │     ├── driver/  收据 HTML 生成器（driver 通道载荷——驱动渲染兜底的第三渲染器）
    │     ├── channels/ spooler(主) / tcp(辅) / serial(备) / driver(驱动渲染兜底) + 串行队列
    │     └── diagnostics/ 打印机诊断（PowerShell 采集 → 规则引擎 15 条 → L1/L2 修复动作 → 渲染自检 → 三层报告导出）
    ├── export/        txt / xlsx / docx 导出器
    └── scanner/       扫码枪检测器（纯函数状态机 + before-input-event 桥）

模板 JSON（print_templates 表）是唯一事实源：
  同一模板 + 共享字符网格数学 → [ESC/POS 字节流] 与 [HTML 预览] 与 [driver 渲染 HTML] 三渲染同源
```

数据模型（10 表）：`products`、`purchase_orders` + `purchase_items`、`sales` + `sale_items`、`customers` + `sale_extras`（1:1 订单附加：客户引用/国补/订单备注/销售人员）、`stock_movements`（审计链）、`print_templates`、`settings`。销售/进货明细行均含**商品快照字段**；客户信息为引用（改档案后历史订单显示最新）；商品删除为逻辑删除（软删行保留，`product_id` 引用持续有效），历史单据与审计链完整可读。

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron 44 + electron-vite 6（rolldown）+ Vue 3.5 + TypeScript 5.9 |
| UI | Element Plus 2.x（中文 locale） |
| 存储 | better-sqlite3 v13（N-API prebuilds，免 rebuild；WAL 模式；`PRAGMA user_version` 迁移） |
| 打印 | node-thermal-printer（ESC/POS 指令生成，纯函数零 I/O） |
| 导出 | exceljs（xlsx）/ docx（.docx）/ 原生 txt（UTF-8 BOM + CRLF） |
| 测试 | vitest（单元 + golden 字节矩阵，968 用例）+ Playwright `_electron`（E2E 99 场景，含打印机诊断 8 场景） |
| 打包 | electron-builder 26（NSIS） |

## 开发

环境要求：Node.js ≥ 22.12，npm ≥ 9。Linux/macOS 亦可开发（Windows-only 功能已 mock/skip）。

```bash
npm install        # postinstall 自动补齐 Electron 二进制（install-electron）
npm run dev        # 启动开发（HMR）
npm run typecheck  # 类型检查（node + web 两侧）
npm test           # vitest 单元测试（968 用例）
npm run test:e2e   # Playwright E2E（globalSetup 自动先构建 out/）
npm run build      # 构建 out/（main/preload/renderer）
```

## 打包与 CI

本地（Linux 开发机）可做**冒烟级**打包验证：

```bash
npm run build
npx electron-builder --dir    # 产出 release/linux-unpacked（asar 产物直接可跑）
npx electron-builder --win nsis   # Linux 上产出未含 uninstaller 的 stub（见下）
```

> **注意**：完整的 Windows NSIS 安装包在 **GitHub Actions（windows-latest）** 上产出——NSIS 的
> uninstaller 提取步骤在非 Windows 平台需要 wine，本项目不作此依赖。推送到 GitHub 后 CI 自动执行：

CI（`.github/workflows/release.yml`）——**正式发布流程**：推送 `v*` tag（与 package.json 版本一致，如 `v0.3.0`）→ 全质量门 → 自动发布到 GitHub Releases：

1. **test**（windows-latest）：typecheck → vitest → Playwright E2E（驱动真实 Electron 窗口，含 tcp mock 打印场景）
2. **release**（windows-latest，依赖 test）：tag 与版本号防呆校验 → `npm run build` → `electron-builder --win nsis --publish always` → GitHub Releases 上架 `销存系统-<版本>-setup.exe`（中文安装向导、可选安装目录）

> 日常 push 验证的旧 ci.yml 已停用（`ci.yml.bak` 留档）；GitCode 镜像的同步发布为手动（GitHub Releases 下载 exe → GitCode Release 页上传）。

## 数据位置与手动备份

所有业务数据保存在单个 SQLite 文件中（WAL 模式）：

| 系统 | 路径 |
|---|---|
| Windows | `%APPDATA%\selling-electron\pos.db`（即 `C:\Users\<用户名>\AppData\Roaming\selling-electron\`） |

**手动备份步骤**：

1. **先完全关闭**「销存系统」（数据写入中直接复制可能得到不一致快照）
2. 打开数据目录，复制 `pos.db`；若同目录存在 `pos.db-wal`、`pos.db-shm`，一并复制
3. 恢复：关闭应用后，将备份文件复制回原位置（覆盖）即可

WAL 说明：`.db` 是主数据库文件；`.db-wal` 是预写日志（应用运行期间的最近写入暂存）；`.db-shm` 是 WAL 共享内存索引。应用正常退出时 WAL 日志会自动合并回 `.db`（此时目录里可能只剩 `pos.db`）——但备份时**三文件一起复制最稳妥**。

## 真机验证

安装包与打印/扫码等真机环节的逐项验证指引：**[docs/windows-manual-checklist.md](docs/windows-manual-checklist.md)**（10 项：安装建库、打印机列表、spooler 测试打印、结账打印全要素、tcp 通道、扫码枪（含中文输入法状态）、连续结账串行、生僻字降级、数据备份、打印机诊断（含 spike 验证））。

## 已知设计边界

- 无登录/操作员体系（打开即用，用户决策）
- 购物车不持久化（关应用即弃，用户决策）
- 无自动更新 / 崩溃上报 / 遥测（锁定清单）
- 重打小票使用**当前**模板（非销售时点模板）
- GBK 外字符（部分生僻字/emoji）在小票纸上降级为 `?`（数据不受影响）
- 打印失败不影响销售落库（销售先保存，打印异步 best-effort，可从销售记录重打）
