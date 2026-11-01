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

## Task 5 扫码枪检测器落地记录（S6 spike 实测，2026-11-01）

### ★ S6 spike 结论（修正调研期预判——实测与预判相反，Task 11 E2E 关键输入）
- **Playwright page.keyboard（CDP 路径）在 Electron 44 完全不触发 before-input-event**（3 阶段独立实测 count=0）——CDP Input.dispatchKeyEvent 绕过浏览器进程 PreHandleKeyboardEvent 钩子；调研期"OS 级管线可能触发"的预判不成立
- **webContents.sendInputEvent({type:'keyDown'}) 可靠触发 before-input-event**，15ms 间隔连发 13 字符被检测器完整识别为条码（全链路真实事件）——调研期"大概率不触发"的预判不成立
- sendInputEvent({type:'char'}) 不产生 keyDown 类 before-input-event（仅 keyDown Enter 到达）→ 字符不累计，扫码注入不可用
- **Task 11 E2E 扫码注入策略**：electronApp.evaluate 内循环 `win.webContents.sendInputEvent({type:'keyDown', keyCode: ch})`（间隔 ≤15ms）+ 结尾 keyDown Enter；禁用 page.keyboard / type:'char'
- 证据：`.omo/evidence/task-5-s6-spike.txt`

### 检测器设计要点
- BarcodeDetector 纯类零 Electron 依赖；判定全基于事件自身 timestamp（无 setTimeout/debounce，G13）
- 细节规则（实测锁行为）：修饰键（Shift 等）不打断序列（兼容配置大小写转换的扫码枪）；其他控制键（Tab 等）打断序列；间隔恰 50ms 仍连发、51ms 重置
- bridge 薄壳三件事：过滤 type==='keyDown'、feed、命中后 onBarcode 回调 + send('scanner:barcode')；bridge/main 装配与 preload onBarcode 暴露留给 T11

## Task 3 共享契约层落地记录（2026-11-01）

### tsconfig / 结构
- tsconfig.node.json 与 tsconfig.web.json 的 include 均已加入 `src/shared/**/*.ts`——主/渲染两侧 typecheck 都覆盖 shared（Task 1 脚手架未包含，本任务补上）
- 目录：`src/shared/types/{domain,ipc,index}.ts`（barrel 统一 import）+ `src/shared/receipt/{char-grid,template-schema,default-template}.ts`；测试 `tests/unit/shared/`（4 文件 49 用例）

### char-grid 数学约定（T4 生成器 / T12 预览直接消费，签名已冻结）
- `PAPER_COLUMNS = { '58mm': 32, '80mm': 48 }`；`stringWidth(s)`（全角=2 半角=1）、`truncateToGrid(s, cols)`、`padLine(s, cols, align='left')`
- 宽字符判定区间：0x1100-0x115F / 0x2E80-0xA4CF / 0xA960-0xA97F / 0xAC00-0xD7A3 / 0xF900-0xFAFF / 0xFE10-0xFE19 / 0xFE30-0xFE6F / 0xFF00-0xFF60 / 0xFFE0-0xFFE6 / 0x1F300-0x1F64F / 0x1F680-0x1F6FF / 0x1F900-0x1FAFF / 0x20000-0x3FFFD；emoji（含代理对区）宽 2
- **U+FE0E/U+FE0F（变体选择符）宽 0**：'✌️'（U+270C+VS16）= 1（U+270C 是 East Asian Ambiguous 半角，别按宽 2 测试）
- 全部函数按 code point 迭代（`for...of`）——UTF-16 代理对安全，emoji 截断不产生孤立代理
- **padLine 不截断超宽输入**（纯 pad 语义）——T4/T12 必须「先 truncateToGrid 再 padLine」同一顺序组合，保证双渲染同源
- padLine center 奇数余量**左少右多**（floor(pad/2)）

### 模板 schema / 默认模板
- ReceiptTemplate 段落制：header: Section[] / items: ItemsSection / totals: TotalLine[] / footer: Section[] / cutPaper；Section 为扁平联合（type: 'text'|'image'|'divider' + content?/align?/size?/bold?）
- `interpolateVariables` 用 **function replacer**——vars 值含 `$&`/`` $` ``/`$1` 等 replace 元字符按字面插入，不被二次解释（有测试锁定）
- ReceiptVars：金额/数量都是**已格式化字符串**（'12.00'）——分→元格式化由渲染编排层在组装 vars 时完成（G1：模板层零金额运算）；index signature `[key: string]: string | undefined`（可选 named 字段 companyFooter 兼容写法，TS2411 坑）
- 默认模板金额符号用**全角 '￥'（U+FFE5，GBK 0xA3A4）**——半角 '¥'（U+00A5）在 EUC-CN 无映射会触发 D20 降级 '?'
- DEFAULT_TEMPLATES: Record<PaperWidth, ReceiptTemplate>（'58mm'/'80mm' 两变体同构）

### typed IPC
- `IpcChannels`：channel → { req, res }；**req: void 表示无参通道**——TypedInvoke 用条件 tuple `...args: req extends void ? [] : [req]` 实现「void 通道调用不传实参」（编译期强制）
- `IPC_CHANNEL_NAMES = [...] as const satisfies readonly (keyof IpcChannels)[]`——satisfies 保证常量 ⊆ 通道键；反向一致性由测试里 Equal<keyof IpcChannels, (typeof IPC_CHANNEL_NAMES)[number]> 编译期断言锁定
- `createTypedInvoke(invoke)`：纯函数转发 + cast（renderer 拿 preload 暴露的裸 invoke 包装成 TypedInvoke，G8 无魔法字符串路径）
- 通道清单 24 个（products 5 / sales 4 / purchases 2 / reports 3 / printing 3 / templates 5 / settings 2），与计划 Task 3 一致；handler 实现留给 Wave 2 各任务

### 并行环境
- Wave 1b 并行期间全量 `npm test` 会看到他人任务 TDD RED 阶段测试 FAIL（如 T7 printing 通道 Cannot find module）——**按文件路径归责，验收只看自己目录**；commit 只 add 自己的文件

## Task 2 DB 基础设施落地记录（S1 spike 结论，2026-11-01 实证）

### S1 spike：通过（无需 fallback）
- better-sqlite3@13.0.3 在 **Electron 44.10.1 主进程内**（内嵌 Node 24.22.1，注意与本机 node v22.22.1 ABI 不同也无碍）require 加载成功，零 rebuild
- 原因：v13 起 N-API（ABI 稳定跨 Node/Electron）+ prebuilds/ 随 npm 包（linux-x64/win32-x64 全平台）
- in-memory 表 CRUD（含中文）正常；无 NODE_MODULE_VERSION 错误
- fallback 链（12.x + install-app-deps / node:sqlite）**未触发**
- Linux 下 Electron userData = `~/.config/<name>`（非 ~/.local/share——计划 QA 场景原文笔误，以 app.getPath('userData') 实测为准）

### 工程结论（后续任务复用）
- better-sqlite3 v13 **不自带 TS 类型**且未装 @types（依赖锁定）：`src/main/db/better-sqlite3.d.ts` 提供最小 ambient 声明（`import Database from 'better-sqlite3'` + `Database.Database` 实例类型）。后续任务直接用，勿重复声明
- SQL 迁移文件经 **vite `?raw` import 内联进主进程 bundle**（`*.sql?raw`，声明在 src/main/db/migrations.d.ts）：vitest / electron-vite dev / build 三环境均验证 OK——打包 asar 后无需运行时读 .sql 文件
- `require('electron')` 懒加载（函数体内、非顶部 import）使含 electron 依赖的模块可被 vitest 纯 Node 环境导入；rolldown CJS 输出下正常工作
- `PRAGMA user_version = N` 在事务内可回滚：迁移器每步 `db.transaction(() => { db.exec(sql); db.pragma('user_version = N') })`，失败自动回滚不留半成品 schema
- WAL 持久化在 DB 文件头：独立连接（readonly 亦可）读 `PRAGMA journal_mode` 返回 'wal'，QA 验证即用此法
- 迁移幂等机制 = user_version 守卫（001_init.sql 逐字抄计划、无 IF NOT EXISTS，重启靠版本号跳过）
- fixture seed：`tests/fixtures/seed.ts`（4 商品 → 进货+24/+18/+30 → 手工+6 → 销售-2/-1，审计链 6 条流水，前后库存衔接可断言）——T8/T9/T10/T13/T14 测试直接复用

## Task 7 打印通道层落地记录（2026-11-01 实证）

### ★ PowerShell RAW 打印转义坑（spooler 主通道，真机调试必读）
- **execFile 不经 shell**：`execFile('powershell.exe', args)` 免 cmd 注入；Node spawn 自动做 Windows 参数引号转义（脚本内的 `"` → 命令行 `\"`），powershell `-Command` 能正确还原 —— 转义链：PS 脚本(单引号) → Node 参数转义 → PS -Command 还原
- **PS 脚本内统一用单引号字符串**：单引号内唯一需转义的字符是单引号本身（`'` → `''`，`escapePowerShellSingleQuoted`）；双引号字符串有变量插值风险，C# 代码放 here-string `@'...'@`（**闭合 `'@` 必须顶行**，脚本用 `\n` join 无 `\r`，PS 5.1 接受）
- **若真机 -Command 引号仍被吃**（罕见）：备选 `-EncodedCommand`（整脚本 base64(UTF-16LE)，零引号问题）；生成：`[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))`
- **命令行 32K 上限**：CreateProcess 命令行 ≤32767 字符；base64 内联超 24000 字符（脚本本体约 4KB）自动改走 **stdin**（`[Console]::In.ReadToEnd()`）——Logo 光栅字节可能触发该路径
- **中文打印机名**：经典 KB322091 RawPrinterHelper 是 ANSI 版（OpenPrinterA/CharSet.Ansi，非 zh-CN 代码页会挂）；已改 **W 系 API**（OpenPrinterW/StartDocPrinterW/CharSet.Unicode）全程 Unicode
- **exit code 约定**：0=成功 / 2=SendBytesToPrinter 失败（stderr 带 win32 错误码 GetLastWin32Error）；`$ErrorActionPreference='Stop'` 让 Add-Type/FromBase64String 硬失败
- **性能**：powershell.exe 进程 + Add-Type 每次 .NET 冷编译 ≈1-3s/单；真机高频打印若嫌慢，优化方向：预生成 .ps1 到 userData 用 -File 调用（PS 会缓存编译类型）
- **Linux 调 execFile('powershell.exe') = ENOENT**：sendRawToPrinter 先判 `process.platform !== 'win32'` 抛『spooler channel 仅 Windows 可用』（比 ENOENT 可诊断）

### 打印机枚举（G11 实证）
- **真机 spike（Linux + Electron 44 + DISPLAY=:0）**：`win.webContents.getPrintersAsync()` → `[]` **不抛错** —— printer-enumerator 的外部假设成立；封装层再叠加 try/catch + 无窗口守卫（无 provider / 窗口销毁 / 抛错 → 全部返回 `[]`）
- `printer:auto` 的 RAW-ONLY 过滤在 node-thermal-printer `lib/interfaces/printer.js getPrinterName()`（`attributes.indexOf('RAW-ONLY')`）；Electron getPrintersAsync **不暴露 attributes** → 枚举层只做注释语义，设置页引导选热敏机，真机清单覆盖
- `printer:` interface 源码确认：构造时无 driver 对象即抛 `No driver set!`（依赖 2022 停更的 printer/electron-printer）→ 维持不装，PowerShell 方案为唯一主路径

### 串口通道跨平台陷阱
- **`\\.\COM1` 在 Linux 是合法文件名**：`fs.createWriteStream(port,{flags:'w'})` 会**静默创建垃圾文件**（TDD 期间踩过：构造签名不匹配导致默认口写入 cwd，已修复+清理）。串口通道仅供 Windows 真机设备路径使用；Linux 下测试用临时文件路径做等价验证

### tcp 通道实现要点
- 自实现与 node-thermal-printer Network 接口（`lib/interfaces/network.js`）同构：`net.createConnection` → write 回调（drain 语义）→ `end()` → `close` 收尾
- 超时守护覆盖连接+写阶段（防对端不读挂死）；写完即 FIN，等对端 close 才 resolve（『连接关闭干净』断言）；RFC 5737 `192.0.2.1` 做不可路由地址测试（CI 安全）

### 队列实现要点（PrintQueue）
- **串行队列死锁防线**：`this.queueTail = run.then(()=>{},()=>{})`（队尾吞失败）+ 返回原 `run` 给调用方 —— 前序 job 双败后队列必须继续，这是"队列死锁"失败指示器的根因解法

## Task 6 E2E 基建落地记录（S5 spike 结论，2026-11-01 实证）

### 启动方案决策：驱动 build 产物，不用 dev server
- `_electron.launch({ args: ['.'] })` → 读 package.json main → out/main/index.js（构建产物）
- **方案**：`playwright.config.ts` 的 `globalSetup` 里 `execSync('npm run build', { stdio: 'inherit' })`；package.json 的 test:e2e 只需 `playwright test`（先 build 后测的链路收在 config 内，一处可控）
- dev server 方案需先起 electron-vite dev 再等 HMR 就绪，链路长、时序不稳，弃用
- **无需 `npx playwright install`**：_electron 用应用自带 Electron 二进制（postinstall install-electron 保证）；无浏览器项目也无需 projects 配置

### userData 隔离（全部后续 E2E 依赖）
- main/index.ts **顶部**（app ready 前）检查 `process.env['E2E_USER_DATA_DIR']` → `app.setPath('userData', dir)`；正常 dev/生产不注入则零影响
- helpers.launchApp()：`mkdtempSync(join(tmpdir(), 'pos-e2e-'))` + `env: { ...process.env, E2E_USER_DATA_DIR }`
- **权威断言在应用内**：`electronApp.evaluate(({ app }) => app.getPath('userData'))` === 临时目录——比文件系统侧比对更硬
- 实测隔离成立：整轮 E2E 前后真实 userData tree-hash 逐字节一致；隔离 temp 目录产出完整 Chromium 状态树 + pos.db 90KB（T2 initDatabase 落库于隔离目录）

### 坑：并行任务同仓库时隔离验证的归因
- 复跑 E2E 时发现真实 userData 有写入——实际是并行任务 T2 的 dev 实例（时间窗早于 E2E 启动 39s+；真实目录残留其 SingletonLock → PID，E2E 干净退出则锁被移除）
- 隔离验证必须：① 记录精确时间窗（globalSetup build 完成时间 + 截图 mtime）② 无并行实例时复跑比对 tree-hash ③ SingletonLock 残留可归因进程

### Playwright/Electron 其他要点
- **强制串行**：`workers: 1` + `fullyParallel: false`（单实例锁 + 窗口焦点互扰）；spec 内 `test.describe.serial` + beforeAll 共享一次 launch（一次启动 ≈3s，省时且窗口状态连续）
- hash 路由等待：`page.waitForURL((url) => url.hash === '#' + path)` 精确匹配（createWebHashHistory 下稳定）
- `import { _electron } from 'playwright'`——playwright 是 @playwright/test 的依赖（已 hoist），无需加依赖
- tsconfig.node.json 的 `tests/**/*.ts` 会 typecheck E2E 文件（好事）；vitest include 已限定 tests/unit/**，smoke.spec.ts 不会被 vitest 误收
- el-menu 侧边导航：`router` 属性 + `:default-active="computed(route.path)"` 即可路由联动高亮；深色定制走 `--el-menu-*` 令牌（bg/text/hover-bg/active-color/item-height）
- @element-plus/icons-vue 是 element-plus 的依赖（传递可用，未加直接依赖）
