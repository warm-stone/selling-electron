# Learnings — pos-electron-app

## 技术调研核心结论（2026-11，源码级验证）

### 脚手架
- electron-vite 6.0.0 = rolldown-based，支持 Vite 7/8；**externalizeDepsPlugin 已废弃**（v5 起），依赖外部化默认开启——**不要抄旧教程里的 externalizeDepsPlugin()**
- 项目结构 src/{main,preload,renderer}；Node 宿主要求 20.19+/22.12+
- **Electron 锁 44.x**（45.2.1 发布仅 2 天，2026-10-30）
- Vue Router 必须 hash 模式（Electron file:// 约束）

### better-sqlite3（Day-0 spike S1 必做）
- v13.0.3 起 N-API，预编译随 npm 包 `prebuilds/`（含 win32-x64），理论上免 @electron/rebuild——**必须实证**（调研存在内部矛盾）
- fallback 链：(a) 12.x + electron-builder install-app-deps → (b) node:sqlite (DatabaseSync)
- WAL 模式 + `PRAGMA user_version` 迁移 + `datetime('now','localtime')`（非 UTC，报表日界依赖）
- 同步事务 API：db.transaction(fn)（throw 自动回滚 → kill-point 测试的理论依据）

### node-thermal-printer 4.6.1
- 纯 JS（iconv-lite/pngjs/unorm/write-file-queue），主进程用，零 rebuild
- 通道：`tcp://host:9100`（net socket，最稳）/ `printer:名称`（spooler RAW，需 driver——老原生包 2022 停更）/ `\\.\COM1`（fs 写）
- **无 USB/蓝牙直连**（USB 打印机装驱动后即系统打印机 → spooler 通道无碍）
- 中文：`CharacterSet.CHINA` → iconv-lite 'EUC-CN' → 标准 GBK 字节（'中文测试收银' → `d6d0 cec4 b2e2 cad4 cad5 d2f8`）；切换命令 `ESC R 0x0F`（1b 52 0f）；**无 GB18030 全集，生僻字替换 '?'**
- 图片：`printImage(path)` / `printImageBuffer(pngBuffer)`（core.js L458 wrapper → epson.js `GS v 0` 光栅位图）
- 关键 ESC/POS 字节：init `1b 40`、居中 `1b 61 01`、粗体 `1b 45 01`、尺寸 `1d 21`、切纸 `1d 56 42 00`、光栅 `1d 76 30 00`
- 取 buffer 不连接打印机：interface 'file' 模式 + printer.getBuffer()

### 打印机枚举 / Windows
- Electron 内置 `contents.getPrintersAsync()`；spooler RAW 兜底 = PowerShell RawPrinterHelper（零原生依赖）
- `printer:auto` 在 node-thermal-printer 内部过滤 RAW-ONLY 打印机

### 扫码枪（中文环境关键坑）
- keyboard-wedge HID + 中文输入法冲突：composition 事件吞快速输入
- 方案：主进程 `before-input-event` 拦截 + 纯函数检测器（事件时间戳，间隔 ≤50ms + ≥5 字符 + Enter）
- `webContents.sendInputEvent` 大概率不触发 before-input-event（S6 spike 验证）；Playwright `page.keyboard` 走 OS 级管线可能触发——实测记录

### E2E / CI
- Playwright `_electron.launch()` 驱动 electron-vite 产物；E2E userData 必须重定向 temp 隔离
- CI：GitHub Actions windows-latest（用户选定）；真机打印无法 CI → 《Windows 真机验证清单》手动文档
- G11：Windows-only API 在 Linux 必须 mock/skip（spooler 通道 Linux 抛明确错误）

### Element Plus
- 中文 POS 生态最成熟；按需引入 unplugin-vue-components
- 全局字体栈："Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC"；等宽 CJK（小票预览）："NSimSun", "SimSun", monospace

### 导出
- exceljs 4.4.0（最后发布 2024-12，稳）；docx 9.15.1（活跃）
- 模式：主进程 Buffer → dialog.showSaveDialog → fs.writeFile → shell.showItemInFolder
- txt 必须 UTF-8 with BOM（Windows 记事本）；xlsx round-trip 用 exceljs 读回断言；docx 是 zip（解压断言 document.xml）

## Task 1 脚手架落地记录（S2 spike 结论，2026-11-01 实证）

### S2 spike：通过（无需 fallback）
- 组合实测：electron-vite 6.0.0 + vite ^8.3.5（rolldown 链）+ vue 3.5.44 + TS 5.9.3 + element-plus 2.14.7（全量引入）+ pinia 4.1.0 + vue-router 4.6.4（hash）→ dev/build/typecheck/test 全部正常
- externalizeDepsPlugin 废弃再次确认：config 留 `main: {}, preload: {}` 即可，依赖外部化默认开启
- 官方 vue-ts 模板（alex8088/quick-start master）基准：vite ^8.3.4、electron ^44.7.2、TS ^5.9.3（模板也未上 TS 7）、@types/node ^24、vue-tsc ^3.3.13、@vitejs/plugin-vue ^6.0.10
- main/preload 输出 CJS（package.json 不设 "type": "module" → `__dirname` 可用）；官方模板即此方案
- vitest 5.0.5 + vite 8：有 "configLoader: native" 警告（vitest.config.ts ESM 语法被当 CJS 加载）——纯警告不影响运行，无需处理
- Element Plus 采用全量引入（import + dist/index.css），未用 unplugin-vue-components 按需——降低 rolldown 链风险；renderer bundle 2.36MB，Task 6/20 如需可再切按需

### ★ Electron 44+ 二进制下载机制变更（坑，Wave 1b+ 与 CI 都受影响）
- Electron ≥44 npm 包**已移除 postinstall**（`npm view electron@44 scripts` 为空；32.x 时代才有 postinstall）
- 新机制：按需下载。`node_modules/.bin/install-electron`（幂等）或 electron/index.js 在被 require 时懒下载
- electron-vite 的 getElectronPath 直读 `node_modules/electron/path.txt`，不触发懒下载 → npm install 后直接 `npm run dev` 报 **`Error: Electron uninstall`**
- 修复：项目 package.json 加 `"postinstall": "install-electron"`（幂等：已安装 exit 0；CI npm ci 后自动补齐二进制）
- Task 20 打包 CI、Task 6 E2E 依赖此机制，勿删 postinstall

### 单实例锁实测
- 第二实例 `npm run dev`：electron 启动后干净退出（exit code 0），实例 A 存活且触发 second-instance 回调（restore+focus 路径）
- dev 双实例会各起 renderer dev server（5173/5174），但 app 进程仅存活一个 —— 符合验收

### 环境记录
- 本机 node v22.22.1 / npm 9.2.0 / Linux（DISPLAY=:0 可跑 GUI dev）
- Windows 差异（CI）：spooler 打印、路径分隔符等留待各任务 mock/skip（G11）
