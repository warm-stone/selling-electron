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

## Task 4 ESC/POS 生成器落地记录（2026-11-01）

### ★ node-thermal-printer 库字节 quirk 三连（真机联调与后续任务必读）
- **cut() 不发计划契约的 `1d 56 42 00`**：库 cut() = `1b 64 04`（ESC d 4 走纸）×2 + `1d 56 00`（m=0 无走纸全切）+ 再 init（追加 `1b 40`）——生成器按契约直发 `1d 56 42 00`（GS V 66 0，走纸 0 单位后全切）+ 前置 2×LF
- **printImageBuffer 光栅头 m 字节固定 0x30**（epson.js `Buffer.from([0x1d,0x76,0x30,48])`，48=0x30 非规范值 0-3）：经 scratch 打印机产出光栅字节后 patch `raster[3]=0x00`（Epson 规范正常尺寸），再 add 进主管线——golden 断言锁定 `1d 76 30 00`
- **setTextSize 有十六进制拼装 bug**（`Buffer.from(`${h}${w}`,'hex')`，(1,1)→0x11=2×2 倍率）：尺寸一律用 setTextNormal/DoubleHeight/DoubleWidth/QuadArea（ESC ! 族）；`1d 21 00`（GS ! 归一）与 `1b 40`（ESC @，.d.ts 未暴露 initHardware）按规范字节直发常量
- **构造时不传 characterSet**（否则 `1b 52 0f` 会排在 `ESC @` 之前）：显式 `add(HW_INIT)` → `setCharacterSet(CHINA)` 得到计划顺序 `1b 40 1b 52 0f` 开头

### 生成器工程结论（T15/T16/T12 直接消费）
- **breakLine 必须 NONE**：库 print() 的 `_fold` 按 UTF-16 码元数折叠，会把 char-grid 已对齐的网格行折断；行折叠全部交给 shared char-grid（padLine/truncateToGrid，先降级→再 truncate→再 pad 顺序）
- **GBK 降级必须在交给 ThermalPrinter 之前**：库 append() 对 iconv 产生 '?' 的字符会遍历全部代码页找映射（EUC-JP/Big5 命中时**插入代码页切换指令**污染 GBK 流）——degradeToGbk 用 iconv 'EUC-CN' roundtrip 判定（与打印链路同 codec 零偏差；EUC-CN 覆盖 GBK 大集，'镕' roundtrip true，'¥'U+00A5/'𠀀' false→'?'）
- **vars.logoBuffer 类型形态**：ReceiptVars 索引签名 `string|undefined` 容不下 Buffer，TS2411 禁止接口扩展改宽——escpos-generator.ts 独立声明 `ReceiptPrintVars`（索引 `string|Buffer|undefined`）；ReceiptVars 对象可直接赋值给它；interpolateVariables 调用点单次收窄 cast（ReceiptPrintVars→ReceiptVars 合法）
- **SaleReceiptData 为 display-ready**：items 的数量/单价/小计均为已格式化字符串（T15 组装，G1：生成器零金额运算）；单号/时间等走 vars 插槽
- items 列宽（ITEM_COLUMN_WIDTHS）：58mm 12/4/8/8、80mm 24/4/10/10（和=PAPER_COLUMNS）；名称左对齐+截断，数量/单价/小计右对齐
- **golden .bin 再生机制**：`GOLDEN_UPDATE=1 npx vitest run tests/unit/printing/escpos-generator.test.ts`（describe.skipIf 门控）重写 tests/fixtures/golden/*.bin + .omo/evidence/task-4-sample-receipt.bin；**光栅字节=f(像素) 与 pngjs deflate 无关 → golden 跨 zlib/Node 版本稳定**；pngjs 无自带类型 → 测试侧 createRequire + 最小接口消费
- 每段落自含完整状态块（GS! 归一 + ESC! 字号 + bold + 对齐；段落尾显式关粗体）——字节流对段落重排鲁棒，不依赖前段残留态

## Task 10 销售事务核心落地记录（2026-11-01）

### ★ sale_no 序列竞态分析（"事务内 COUNT+1"为何无竞态——D18 实现依据）
- better-sqlite3 的 `db.transaction(fn)` 是**同步**事务：fn 在单次 JS 调用栈内跑完 BEGIN…COMMIT，Node 单线程下事务中途**不可能**插入其它 JS 代码（无 await、无事件循环让出点）→ 两个 checkout 不可能交错 → `dailyCount(COUNT LIKE 'yyyyMMdd-%') + 1` 无竞态
- WAL 单写者只防多连接/多进程；真正让 COUNT 语义安全的是"同步事务 + 单线程"这一组合——若将来改 async 事务库（如 node:sqlite 异步版）此假设即失效，序列需改 `INSERT ... SELECT MAX+1` 或独立计数表
- 序列语义是 **COUNT 计数**（当日第 N 单），不是 MAX 续接：手工插入跳号单 `xx-0007/xx-0012` 后下一单是 `xx-0003`；正常流程单号连续，UNIQUE 兜底。测试已锁定此语义

### 事务嵌套模式（T9/T10 共用）
- repo 层 `createSaleWithItems` 内嵌 `db.transaction()`，service 层大事务再包一层 → better-sqlite3 自动把内层降级为 **SAVEPOINT**（非嵌套 BEGIN），两层各自独立可用、组合安全——repo 可单测、service 保证编排原子性
- kill-point 证明：trigger 注入在 movements INSERT 上时，sales 头 + sale_items 行 + stock UPDATE 均已执行，ABORT 后全部回滚——SAVEPOINT 不破坏外层回滚语义

### kill-point 注入点实测结论（比 Inherited Wisdom 预判更细）
- **RAISE(ABORT) trigger 是最真实可靠的 DB 层注入**：`CREATE TRIGGER … BEFORE INSERT ON stock_movements WHEN NEW.source='sale' BEGIN SELECT RAISE(ABORT, '…') END`——错误发生在写入序列**中途**（部分写入后），直击"事务性"而非"校验"
- FK 注入路径分析：sale_items.product_id **nullable**（G4 快照）→ FK 不拦不存在商品；stock_movements.product_id NOT NULL FK 理论可拦，但 service 快照读取（`SELECT … FROM products WHERE id=?` 判 undefined）先于 movements INSERT 抛 PRODUCT_NOT_FOUND——FK 永远没机会触发。故第二注入测试断言的是"service 校验抛错同样触发全回滚"（此时 sales 头已 INSERT、第 1 项已完整写入，仍零变化）——证明回滚不依赖错误来源
- 结论：kill-point 矩阵 = trigger 版（DB 层中途失败）+ 业务校验版（service 层中途失败），双覆盖

### 作废边界（D15 × D3 交叉）
- 商品硬删后作废：T8 硬删商品必然伴随 sale_items.product_id 断链（products 行删除被 stock_movements FK 拦截——movements.product_id NOT NULL，T8 的删除逻辑要处理引用）。voidSale 对 product_id 断链的行**跳过库存复原**（库存随硬删废弃），快照行不删、不写复原流水——已测试锁定
- `DELETE FROM products` 直接删有流水的商品 → `FOREIGN KEY constraint failed`（本任务测试实测）——T8 删除实现的输入事实

### 语义确认（T11/T13/T15 消费前必读）
- `sales.item_count` = **Σquantity**（件数），非行数——seed 数据佐证（2 行明细 item_count=3）
- `checkout` 返回 `SaleDetail`（头+items 快照行，全整数分）= 任务规格的 SaleReceiptData 实质；IPC 契约 `res: Sale` 是其超集，items 字段透传给 renderer（T15 组装 vars 时再格式化分→元）
- 同车重复商品（不同价）service 不合并且逐行落库——合并（D16）是 renderer 购物车职责，service 保持无状态直传
- preload/index.ts 出现并行混编（T9 purchases 段落 + 本任务 sales 段落同文件）——共享装配文件按"谁的段落谁保证 typecheck"归责，commit 时如实提交整文件（对方段落已过 typecheck 才提交）

## Task 17 导出器落地记录（2026-11-01）

### ★ exceljs 4.4.0 三坑（T18 E2E / 后续报表导出复用必读）
- **无默认导出**：index.d.ts 全部顶层命名导出 → `import { Workbook } from 'exceljs'`（不要 `import ExcelJS from`）；其 d.ts 顶部 `declare interface Buffer extends ArrayBuffer` 遮蔽全局 Buffer——`writeBuffer()` 返回值可直接 `Buffer.from(x)`，但 **`xlsx.load()` 入参需 `as unknown as ArrayBuffer` cast**（Node Buffer 非 ArrayBuffer 子类型，类型不容、运行时无碍）
- **writeBuffer 产物含 docProps 创建时间戳（毫秒级）→ 同秒两次调用字节也不同**（实证：same-second equal=false）——xlsx round-trip 断言必须基于 load 回读，**永远不要对 xlsx 产物做字节 diff/golden**
- numFmt 逐格设置：`addRow([...])` 后 `getCell(\`D${sheet.rowCount}\`).numFmt = '0.00'`（rowCount 含表头自增）；金额值 `cents / 100` 写为数值 + numFmt，单元格保持可再计算类型（G1 边界格式化）

### ★ TS 判别联合解构陷阱（本任务踩过：vitest 全绿但 tsc 报错）
- `const { report } = input` 解构发生在判别收窄**之前** → 解构变量永远是联合类型；`if (input.kind === 'daily')` 只收窄 `input` 本身，**不影响已解构的 `report`**——分支内必须写 `input.report.sales`
- 教训：**vitest 绿 ≠ typecheck 绿**（vite 转译不做类型检查）——验收必须双跑 `npx vitest run` + `npx tsc --noEmit`

### 导出子系统结构（T18 消费）
- `ReportExportInput` 判别联合（kind: daily|monthly + period + title + report）：exporter 纯函数（零 dialog/fs），export.service 编排（DI 注入 showSaveDialog/writeFile/revealInFolder——electron 懒加载 require，vitest 零依赖可测；取消路径断言零写入靠 writeFile 注入而非 mock fs）
- **E2E_EXPORT_DIR 钩子**：env 存在时跳过 dialog 直写 `${dir}/${日报2026-11-01.xlsx}` 并返回路径、**不 reveal**（CI 不弹资源管理器）；正常路径零影响（分支仅 env 存在时进入）；默认 writeFile 含 mkdir -p → E2E 目录无需预建
- txt：UTF-8 BOM（EF BB BF）+ **CRLF** 行尾（Windows 记事本双保险）；列对齐复用 char-grid padLine（先 truncate 再 pad 同源顺序），对齐不变量测试=全部明细行 stringWidth 相同
- docx 9.15.1：ESM+CJS 双发（named import 直接用）；Table borders 一步到位（top/bottom/left/right/insideHorizontal/insideVertical 全给 `{ style: SINGLE, size: 4 }`）；jszip 解压断言 document.xml 子串（CJK/数字无转义问题）
- 文件名/标题约定：`{日报|月报}{period}.{txt|xlsx|docx}`、标题 `{period} 销售报表`（period: 日报 yyyy-MM-dd / 月报 yyyy-MM）；状态列 completed→已完成

### IPC 注册统一模式（Wave 2a 首个落地实例，T14 及后续 reports 域任务照此）
- `registerReportsExportIpc(db)` 独立文件 `src/main/ipc/reports-export.ipc.ts`（T14 后续注册 reports:daily/monthly 在**另一文件**——避免并行冲突）；index.ts 锚定 `const db = initDatabase()` 注册块逐行追加
- 参数校验抽纯函数 `parseReportsExportRequest(req: unknown)`（throw 带字段名的可诊断错误）+ electron 懒加载 require（函数体内）→ ipc 文件可被 vitest 纯 Node 导入单测
- preload 双文件同步：`index.ts` 实现 + `index.d.ts` 类型（renderer window.api 类型源）——两处都要加；用 `IpcChannels['通道']['req'|'res']` 索引类型防契约漂移

## Task 9 进货管理落地记录（2026-11-01）

### 进货事务模式（T10/T13/T14 可参照）
- **order_no 序列全 SQL 侧**：`strftime('%Y%m%d','now','localtime')` 同语句内做前缀与 COUNT 过滤（`LIKE strftime(...) || '-%'`）——与 created_at 默认值同源同钟，午夜零竞态；序列号 `String(n+1).padStart(4,'0')`；purchase 与 sales 序列天然独立（COUNT 只查本表）
- **快照/库存/流水全在事务内逐行串行**：每行 SELECT products(name/barcode/stock) → INSERT purchase_items(快照列) → UPDATE stock=stock+qty → INSERT movements(before=SELECT 时 stock, after=before+qty, source='purchase', source_id=orderId)——productId 缺失在 SELECT 处抛错即整单回滚（better-sqlite3 throw 自动回滚）
- **IPC 层 req 防御**：`service.createPurchase(req?.items ?? [], req?.note)`——req 整个 undefined 时靠 service 空数组校验兜底（"至少需要一行商品"）
- **service 校验分两层**：结构校验（正整数/非空数组）在事务外快速失败；存在性校验天然在事务内（SELECT 不到即抛）

### ★ Element Plus el-select E2E 双坑（T11/T13/T16 表单类 E2E 必读）
- **关闭态 dropdown 的 DOM 残留**：el-select 选中后 popper 只是隐藏不销毁——`.el-select-dropdown__item` 定位 + `.first()` 会命中**隐藏 dropdown 的同名选项**（"element is not visible" 死等 30s）
- **`:visible` 伪类也不可靠**：实测 `:visible` 解析到的元素 click 时仍判 not visible（多个 popper 共存时解析/判定不同步）
- **正解：`page.getByRole('option', { name: /关键字/ })`**——a11y 树只含展开 dropdown 的选项，天然过滤 DOM 残留；type-filter+Enter 键盘流实测**不可靠**（fill('可乐')+Enter 后 select 显示残留输入文本而非选中值）
- 动态行表格操作模式：`.el-table__row` nth 定位行 + 行内 `.el-input-number input` first()/nth(1) 区分数量/成本列

### ★ E2E 检测 handler 是否已注册（并行任务自适应）
- **主进程 `ipcMain.listenerCount()` 探测不到 `handle()` 注册的 handler**（handle 走内部 _invoke_handlers，不进 listeners 链）——实测用 listenerCount 判定"未注册"再 handle 会炸 "Attempted to register a second handler"
- **正解：renderer 侧探测**——`window.api.invoke('products:list', {})` resolve=已有 handler；reject 且 message 含 "No handler registered"=未注册（preload 必须暴露裸 invoke 做探测底座）
- E2E 预置商品用 better-sqlite3 直插 dbPath（WAL 多连接，主进程下条语句即见）；E2E 侧只读断言同理（只读打开也行，写后记得 close）

### E2E 共享工作树的现实
- 并行任务（T12 等）的半成品会实时阻塞 `npm run build`（globalSetup 必跑）——重试即可（对方写完就恢复）；不要动对方文件
- smoke.spec 的占位断言已结构性演进：新增 `IMPLEMENTED_ROUTES` 集合（各任务替换占位后追加自己的路由），占位断言只对未实现路由生效

## Task 12 HTML 小票预览落地记录（2026-11-01）

### G7 契约缺口闭合（issues.md Task 4 两条待办清零）
- `src/shared/receipt/item-columns.ts`：ITEM_COLUMN_WIDTHS（58mm 12/4/8/8、80mm 24/4/10/10）+ `buildItemLine(name, qty, price, subtotal, paperWidth, degrade?)`（组合顺序冻结：**降级→truncate→pad**）+ ReceiptItemLine/SaleReceiptData display-ready 类型上提
- **降级注入设计**：TextDegrader 默认恒等——renderer 无 iconv（G8 零 Node 依赖），GBK 降级由调用方注入：escpos-generator 传 degradeToGbk，预览默认恒等。**GBK 内业务文本两侧行集完全一致**；GBK 外字符（生僻字/emoji）预览原样渲染 vs 打印 '?'（宽度差 1 的已知几何差异，组件注释已文档化）
- escpos-generator.ts 仅改 import 来源 + re-export（ITEM_COLUMN_WIDTHS/类型），T4 golden .bin **字节零变化**（159 用例回归全绿）；composeItemRow 删除，renderItems 直调 buildItemLine(..., degradeToGbk)

### 金额格式化定案（T15/T18 直接消费）
- `src/shared/utils/money.ts`：formatMoney（整数分→'12.50'，**恰好 2 位小数、无千分位**）+ parseMoneyToCents（'12.5'/'12' 容忍、trim、千分位/全角/3 位小数→NaN）
- **坑：formatMoney(-0.5) 伪负零**——sign 判断必须在 Math.trunc **之后**（-0.5 trunc → -0，-0 < 0 为 false；先判符号得 '-0.00'）。有测试锁定
- parse 实现为整数十进制搬移（intPart + dec.padEnd(2,'0') 拼接后 Number），零浮点运算（G1）

### vitest 组件测试接线（方案与计划原文的偏差）
- **vitest 5.0.5 已移除 environmentMatchGlobs**（vitest 3 deprecated → 移除；node_modules/vitest dist 全域无此配置项）——计划推荐的 `environmentMatchGlobs: [['tests/unit/components/**', 'jsdom']]` 不可用
- 实际方案：**文件级 docblock `// @vitest-environment jsdom`**（vitest 5 官方替代）+ vitest.config.ts 顶层加 `plugins: [vue()]`（**.vue SFC 编译必需**，对纯 .ts 测试零副作用）；jsdom@30 为唯一 devDependencies 新增
- **tsconfig 归属**：tests/unit/components/** 从 tsconfig.node.json exclude、加入 tsconfig.web.json include——组件测试 import .vue + @vue/test-utils DOM 类型属 web 侧（node 侧无 DOM lib 会炸；与 E2E 被 node include 的先例相反，因为 Playwright 类型自带 lib dom reference 而 @vue/test-utils 不带）

### @vue/test-utils 坑（同源断言的关键细节）
- **`el.text()` 会 trim**——pad 空格全部丢失；提取行文本必须用 `el.element.textContent`（原生，不受 CSS/工具处理影响）
- **scoped CSS 在 mount 中不注入**——getComputedStyle 断言（white-space: pre / fontFamily / fontWeight）必须放 E2E（真实构建产物 CSS 生效）；单测只断言 class/文本/几何
- td 间文本干净：Vue 3 whitespace: 'condense' 会删除元素间空白节点，`<td v-for>` 拼接的 textContent 无杂质 → tr.textContent === buildItemLine 整行（同源断言成立的前提）

### 测试侧坑（第二次犯，记死）
- **中文测试标题内的引号**：单引号字符串里写 `'?（宽 1）'` → esbuild/oxc PARSE_ERROR（内层 ' 提前终止字符串）——标题含引号时改双引号或去引号
- **UTF-16 slice ≠ 显示宽度切片**：BMP 中文每字符 1 码元、显示宽 2——`line.slice(0, 24)` 取的是 24 码元（显示宽 48）。列片段断言必须用按 stringWidth 累计的 sliceByWidth 辅助（或 slice(n, -m) 负索引取中段）

### 预览组件几何模型（T15/T16 消费必读）
- **双尺度模型**：容器宽 = 纸张物理宽（80mm→307px、58mm→221px，96dpi 圆整，E2E ±5px 断言锚点）；墨迹区 = PAPER_COLUMNS × 6px（12px 字号下 NSimSun 全角 12/半角 6）——墨迹窄于纸宽（288/192px），左起渲染模拟 ESC/POS 物理起点，纸宽留右边距（拟真）
- **同源语义分层**：items 行 = buildItemLine（字符级同源，可从生成字节流 GBK 解码逐行找到——组件测试已锁）；text/total 行 = 预览 pad+truncate 模拟打印机 ESC a 物理对齐的**几何**（Epson 居中偏移 floor((n-w)/2) 与 padLine center 左空格数一致），打印侧 println 原文由打印机固件做对齐——两侧字符内容同源（trim 后相等），pad 空格是 HTML 侧的几何载体
- 倍宽/倍高：transform scale（doubleHeight→scaleY(2) 起锚 `${align} top` + margin-bottom 1.35em 布局补偿防叠压；doubleWidth→scaleX(2)；quad→scale(2)）；容器 overflow: hidden 模拟真机纸宽物理边界（倍宽溢出截断）
- divider = border-top dashed（视觉等效打印侧 '-'×cols 的虚线观感，不占 receipt-line 文本集）；cutPaper = 底部虚线 + ✂ 示意（HTML 不切纸）；image 段落收 `logoUrl?: string`（dataURL——Buffer 不跨 IPC）
- ReceiptVars 维持 T3 冻结契约（纯字符串）：Logo 走独立 prop，不扩 vars 索引类型

### demo 路由
- `#/receipt-preview-demo`（router 注册但**不进侧边菜单**——URL 直达，菜单约束在路由文件注释中声明防误加回）；E2E 用 `page.evaluate(() => location.hash = ...)` + waitForRoute 导航
- demo vars 的 total/itemCount 用 parseMoneyToCents+formatMoney 组装（display-ready 约定的活样例）

## Task 8 商品管理落地记录（2026-11-01）

### ★ 删除商品的 FK 约束决策（DDL 与 D15 的落地点，T9-T11 消费）
- 计划 DDL 的 `stock_movements.product_id INTEGER NOT NULL REFERENCES products(id)` 无 ON DELETE 动作 → foreign_keys=ON 下删除有任何流水的商品必然 SQLITE_CONSTRAINT_FOREIGNKEY
- **落地决策**：repo.delete 单事务 = 断链（`UPDATE sale_items/purchase_items SET product_id = NULL`，应用层等价 ON DELETE SET NULL，快照行与快照字段原样保留——G4）→ `DELETE FROM stock_movements WHERE product_id = ?`（NOT NULL 无法断链，流水随商品清除）→ `DELETE FROM products`
- willOrphan = 断链前 sale_items + purchase_items 关联行数（删除弹窗「N 条历史单据」文案）

### willOrphan 的获取途径（通道封闭约束下的模式）
- T3 契约 24 通道封闭、禁动 shared/，但 UI 删除弹窗需在删除前拿到引用数 → **list 返回行做运行时结构超集**：`(Product & { willOrphan })[]`（子查询聚合，契约 res `Product[]` 的合法超集）
- preload 侧 `ProductRow` 双份定义（index.ts 实现 + index.d.ts 类型权威）——TS 同名 .ts/.d.ts 模块冲突无法单源 import；两处注释互指，改动需同步
- T11 收银台消费 products:list 拿到的行也带 willOrphan（超集无害）

### E2E 并发 build 竞态（多任务并行时 E2E 共享仓库的关键坑）
- **page.reload() 会 ERR_FILE_NOT_FOUND**：其他并行任务的 E2E globalSetup 触发 `npm run build`，out/ 重建瞬间（clean→写文件）file:// 重载撞空窗——同 spec 首跑全绿复跑挂，纯时序
- **规避**：需要"刷新页面数据"时走 SPA 路由离开再回来（点别的菜单→点回），组件重挂载即重新拉数据，零文件重载
- Element Plus el-pagination 页码是 `li.number` **不是 button**——`getByRole('button', { name: '2' })` 永远超时；用 `.el-pager li.number` 定位
- el-table 行排序 id DESC（新创建在前）时，翻页断言的"第 2 页首行"是第 5 条而非第 6 条

### IPC 错误消息链路（T9-T19 通用）
- service 抛 `XxxServiceError`（code + 中文 message）→ Electron invoke 序列化后 renderer 收到的 message 带前缀 `Error invoking remote method 'products:create': Error: 条码已存在`
- renderer 侧剥除：`raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)` → 纯中文消息进 ElMessage.error（E2E 断言 `.el-message--error` 含原文案）

### 并行任务同文件冲突实录
- **index.ts 多任务同锚点 Edit 撞行**：T8/T9/T10 同时把 `initDatabase()` 改成 `const db = initDatabase()`，磁盘合并出残缺行 `const db =     const db = initDatabase()`（TS1109）——修复=恢复正常行并保留各任务的 registerXxxIpc(db)
- **smoke.spec.ts 占位断言**：T9 先建立了模块级 `IMPLEMENTED_ROUTES = new Set([...])` 机制（测试体引用它）——后到任务应**复用该 Set 追加自己的路由**，不要另起IMPLEMENTED_VIEWS 之类平行机制（会 noUnusedLocals 报错）
- preload 段落化追加安全；goods.spec 单文件归责验收不变

### 商品业务细节（复用给 T11 收银台）
- service.create：初始库存非 0 会写一条流水（before=0, after=stock, source='manual'）——审计链起点；初始 0 不写（无噪音）
- updateStock 同值调整也写流水（change_qty=0，留"人工确认"痕迹）
- 搜索：name LIKE %kw%（子串）+ barcode LIKE kw%（前缀，走索引）；LIKE 通配符 `escapeLike` 转义（%/_/\ 按字面）；SQLite TEXT 比较大小写敏感（= 精确匹配 abc≠ABC）但 LIKE 对 ASCII 不敏感
- 元↔分边界转换（UI 层）：`Math.round(yuan * 100)` 入分（3.5*100=350.00000000000006 必须 round）；`(cents / 100).toFixed(2)` 显示（cent 精度恒两位小数，toFixed 无边界风险）

## Task 19 系统设置页落地记录（2026-11-01）

### settings KV 序列化约定（T15/T16 消费）
- KV 值一律 TEXT：字符串原样存；**可空字段 null ≡ ''**（双向归一，清除路径即存空串）；tcp_port 存十进制串（非数字/越界读取时归 null）；auto_cut 存 '1'/'0'；**脏 printer_channel 读写两侧均回落 spooler**（rowsToAppSettings/appSettingsPatchToKv 双向 round-trip 测试锁定）
- `AppSettings` → `PrintSettings`（T7 getChannel 参数）key 逐字一致可直接喂；ipc 薄层 toPrintSettings 入参放宽 Partial（invoke 运行时边界防御）
- auto_cut **不参与打印决策**（模板 cutPaper 优先——计划决策），设置页仅文案说明 + 仅作新建默认模板初始值参考

### ipc 薄层可测性模式（T2 懒 require 复用）
- `registerXxxIpc` 函数体内 `require('electron')`（非顶部 import）→ 模块级纯映射/常量（rowsToAppSettings/appSettingsPatchToKv/importLogoFile/readLogoDataUrl/TEST_PRINT_BYTES）可在 vitest 纯 Node 导入单测；与 T9/T10 顶部 import 的 ipc 文件并存，两种形态按需选用（需要单测纯逻辑时用懒 require）

### Logo 文件流（文件系统 + 路径引用，非 DB BLOB）
- 上传 = dialog 选 png → **覆盖式复制** `userData/logos/logo.png`（固定单文件名）→ settings.logo_path 写路径；取消 → 返回当前 logo_path（renderer 比较前后值判取消，不误报 toast）
- `settings:getLogoDataUrl` 通道：主进程读文件转 dataURL（renderer 无任意文件读权限）；mime 固定 image/png（dialog filters 已限定）；**文件缺失/不可读 → null 优雅降级不抛错**；userData 运行时取 app.getPath（E2E 隔离目录兼容）

### E2E 技巧（原生对话框可测化）
- **`electronApp.evaluate` 里替换 `electron.dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[注入路径] })`** → 原生文件对话框场景全链路可 E2E（主进程 handler 持有 electron 单例对象引用，运行时补丁生效；懒 require 析构的 `dialog` 同样指向该单例）
- mock 打印 server 复用 T7 模式（127.0.0.1:19910）：收 chunk 后 `socket.on('end', () => socket.end())` 回 FIN 才触发 TcpChannel 的 close resolve
- 测试打印字节契约（与 T4 逐段对齐）：`1b40` init + `1b6101` 居中 + 'test' ASCII + `0a0a` 走纸 + `1d564200` 全切——E2E 断言 hex contains

### 共享装配文件的"先提交者代持"现象（Wave 并行实测）
- T10 提交 index.ts/preload 时把工作区当时的**全部**注册行与命名空间（含我 T19 已写入的 registerSettingsIpc/registerPrintingIpc/settings/printing 段）一并提交——共享文件无领地边界，先提交者代持后来者的已写入行；F4 审计 diff 归因时需对照本记录（T19 的共享文件改动被 7072aa9 吸收，任务专属 commit 仅含新文件）
- smoke.spec.ts 的 `IMPLEMENTED_ROUTES` Set 机制（T9 建立）是占位断言的唯一扩展点——后到任务追加自己的路由即可（本任务追加 '/settings'）

### Task 12 fix：E2E spec DOM 全局类型（2026-11-01）
- **`/// <reference lib="dom" />` 文件级注入**：tests/e2e/*.spec.ts 的 `page.evaluate` 回调（location/getComputedStyle 等 DOM 全局）在浏览器执行，但 tsconfig.node.json 无 DOM lib——文件顶部 lib 三斜线指令为**单个文件**注入 DOM 声明（零 tsconfig/归属改动；Playwright 官方类型同款机制）。备选 rejected：改 evaluate 写法（回调必然用 DOM 全局，不可移）、tsconfig 拆分（动全局归属）
- **typecheck `&&` 短路假绿**：`typecheck:node && typecheck:web` 在 node 侧失败时 web 侧不跑——并行任务提交时只看到自己侧的错误（T8 提交时 ProductsView 的 web 侧错误被短路掩盖，node 侧修复后暴露 11 个）。**提交门禁必须 `npm run typecheck` 整链通过（exit 0），不能只看自己侧**
- **views → shared 相对路径是 3 级**（`../../../shared/...`）；4 级只适用于 components/receipt/ 的深度。同款层级坑第二次出现（T12 demo 页 → T8 ProductsView import type 路径）——**`import type` 编译期擦除使 build/E2E 完全无感，只有 vue-tsc 才暴露**（运行时零影响，纯类型层修复）

### ★★ Task 9 fix：el-select 下拉选项定位的终极方案（四轮实测迭代，T11 收银台必读）
- **修正此前错误结论**：本文件早前"getByRole('option') 是正解——隐藏 dropdown 的选项不在 a11y 树"**不完整**——popper 关闭是**渐隐动画**，动画中（未 display:none）的残留选项仍在 a11y 树/:visible，全量运行负载高时动画重叠窗口拉长 → strict violation（2 个匹配）或拿到残留目标（not stable→not visible 死等 30s）
- **失败方案全谱（勿再试）**：`.first()`/`.last()`（DOM 顺序假设在动画重叠窗口失效）、`:visible` 过滤（动画中残留仍 :visible）、`getByRole('option')`（同 :visible 问题）、`toHaveCount(1)` 收敛断言（**"假唯一"窗口提前通过**：残留可见+新项未展开到非零框时 count=1 是残留的那个）
- **实证细节**：隐藏的是外层 `.el-select__popper`（display:none + 0x0），`.el-select-dropdown__item` 本体永远 display:block——item 级 visibility 判定全靠边界框传递；popper 在 select 挂载时即 teleport（DOM 顺序=挂载顺序，与打开顺序无关）
- **✅ 终极方案：aria-controls 锚点域**——每行 select 的内部 `input[aria-controls]` 静态精确指向本下拉的 listbox（`UL.el-select-dropdown__list`）元素 id：**click 前读 `getAttribute('aria-controls')`**（静态属性，不依赖展开态）→ `page.locator('#' + id + ' .el-select-dropdown__item', { hasText })` 圈定本域 → toBeVisible 等打开动画非零框 → .first().click()。零时序/零残留歧义，多行动态表格（动态行内嵌 select）唯一可靠模式
- 证据链：debug spec 两轮 DOM dump（popper/popperIdx/popperDisplay/aria-controls 归属）实证全部中间态；修复后 purchases 5/5 两轮 + 全量 25/25 全绿

## Task 18 报表 UI + 导出集成落地记录（2026-11-01）

### ★★ el-date-picker / el-dropdown 的 $attrs 落点（E2E 定位必读，el-select 之外的另一族坑）
- **el-date-picker 的 $attrs 落在 ElTooltip（popper）上**（time-picker/src/common/picker.mjs：`createBlock(ElTooltip, mergeProps({...}, $attrs, {...}))`）——`data-testid` 等普通 attr **fallthrough 到 teleport 的隐藏 popper 容器**（display:none → locator.click 死等 30s）；但 **class/style 被单独摘出用于内部 input wrapper**（`class: $attrs.class`）——**E2E 定位 date-picker 用修饰 class（`--daily/--monthly`），勿用 data-testid**
- **el-dropdown 的 menu 常驻 DOM**（非 lazy 挂载：teleport + v-show，未打开过也在 DOM）——`.el-dropdown-menu__item` CSS/text 定位在**两个 dropdown 共存**时必然 strict violation（月报 menu 隐藏但 DOM 在）；**✅ `getByRole('menuitem', { name })` 唯一可靠**（display:none 不进 a11y 树，天然过滤；与 el-select 渐隐动画问题不同族——dropdown 关闭无渐隐态歧义）
- **el-table / 原生 div 的 attr fallthrough 正常**（单根默认 fallthrough）——testid 混用策略：原生 div/el-table 用 data-testid，el-date-picker/el-dropdown 用 class/原生 wrapper div
- **el-date-picker 远期日期直输可用**：`input.fill('2030-01-01') + press('Enter')`（editable 默认 true，Enter parse 输入值生效）——空数据日零日历翻页/零 shortcut hack；date 型与 month 型同理

### 报表契约对齐（以代码为准，非计划原文）
- `reports:export` req = **`{ kind: 'daily'|'monthly', period, format }`**（非任务简报的 {type, date}）；period 日报 'yyyy-MM-dd' / 月报 'yyyy-MM'；文件名 `{日报|月报}{period}.{ext}`（E2E 落盘断言锚点）
- DailyReport.sales **仅 completed**（repo 聚合与明细共用 WHERE）——日报明细表无 voided 行，状态 tag 列实际恒为"已完成"（按 DTO 断言 2 行）
- helpers.launchApp env = `{...process.env, E2E_USER_DATA_DIR}` **透传 process.env** → spec 内 `process.env['E2E_EXPORT_DIR'] = dir` 先设再 launchApp 即可（**零基建改动**，afterAll delete 还原）

### E2E 时序与状态细节
- **ElMessage toast 连续断言**：每次导出后等 `.el-message--success` `toHaveCount(0, timeout 6000)` 退场（3s 自动关）再下一次——否则下一次 toast 叠加触发 strict violation（T13 双 toast 陷阱同款）
- **serial 测试序列的组件状态残留**：测试 8 月报切"上月"后 activeMonth 跨测试保持——后续断言当月数据的测试必须先点"本月" shortcut 复位（组件状态不随 test 边界重置）
- **月报期望动态推导**：月初 1 号运行时昨日跨月（SAME_MONTH=false）——当月/上月期望值按 `ym(-1)===ym(0)` 分支计算，任何日期运行均成立
- **dropdown 只点一个实例**：日报 dropdown 打开 4 次（三格式+空数据 txt）同 menu 无歧义；月报导出仅断言 enabled 不点击（避免第二个 menu 实例引入定位歧义——月报导出与日报同一 T17 链路，round-trip 已被单元测试覆盖）
- 测试期望金额 `(cents/100).toFixed(2)`：测试侧期望值计算非 UI 金额运算（G1 管渲染层），分值为 .5 倍数时 /100 浮点精确

### 并行归责快照（Wave 3a）
- Task 16（模板编辑器）半成品 template.repo.ts / template.repo.test.ts 在我两轮 typecheck 之间落盘（TS6133/TS2352）——按 T9 归责规则：我的文件（ReportsView/reports.spec/smoke.spec）node+web 双侧零错误、vitest 401 全绿、E2E 51/51 全绿；commit 只 add 自己的文件

### ★ Task 18 fix：月报 E2E 期望的日期敏感倒置（F3 终审发现，2026-11-02）
- **「上月」≠「昨日所在月」**：月报 shortcut 的 monthDate(-1) 是**上一个日历月**（相对今天 `setMonth(-1)`），`ym(-1)` 是昨日所在月——**仅每月 1 号重合**。月中运行时上月无 seed 数据（实际 0.00），原 `PREV_MONTH_* = SAME_MONTH ? 本月总额 : 昨日单` 分支却给了 24.00 → 仅 1 号跑得绿（日期 flaky，serial 模式还连带 2 用例未跑）
- **修复范式：期望由 seed 分布动态聚合**——`monthAgg(目标月)` 遍历 seed 单落月（今日×2 + 昨日×1），期望与 UI 实际值同源于同一批数据，运行日期只决定数据落哪个月、不再参与期望分支；「上月」目标月用与 UI **相同的 setMonth(-1) 算法复制**（3-31 滚月行为两侧一致，恒同步——测试测的是「切月联动」而非「上月语义」）
- **日期稳定性验证可执行化**：`task-18-date-stability-verify.mjs`（逐字同构逻辑 + 五日期参数化：1 号/月中/月末/跨年/3-31 滚月）5/5 PASS + 推演写进 spec 注释——比纯注释推演更硬
- **教训（与时区 flaky 同族）**：相对日期 seed（今日/昨日）+ **语义相近但不同的目标**（日历上月 vs 昨日所在月）是 E2E 日期敏感 bug 的温床——相对 seed 的期望必须从 seed 分布推导（单一真相源），禁止从「今天」的日历分支推导期望；E2E 首绿≠稳定，跨日期窗口（尤其月末/月初边界）是必查项

## Task 13 销售记录查询落地记录（2026-11-01）

### ★ sales:list 分页契约现状（T15/后续报表消费前必读）
- **T10 IPC 未暴露 page 参数**：service.list(query, page=1) 有分页形参，但 sales.ipc.ts 透传时固定 page=1 → 单次最多返回 SALE_PAGE_SIZE=50 条（repo 层常量）。T13 按"只消费 T10"约束走**本地分页 20/页**（slice）；已知边界：单筛选窗口 >50 条时尾部不可见，真正服务端分页需 T3 契约 + T10 IPC 扩 page 字段（记录待 F4 审计）
- 日期筛选语义（实测确认）：repo `date(created_at) >= from AND <= to` **两端 inclusive**，传 'YYYY-MM-DD'，created_at 是 localtime——E2E 直插昨日/今日 created_at 后按此断言无歧义

### ★ Element Plus locale 中文化（全应用生效，T8/T9/T19 E2E 回归全绿）
- `app.use(ElementPlus, { locale: zhCn })`（import 路径 `element-plus/es/locale/lang/zh-cn`）——el-pagination total 文案默认英文 'Total 3'，配置后 '共 3 条'；message-box/empty 等内置文案同源中文化
- E2E 断言 Element Plus **内置**文案前先确认 locale（自定义文案/显式传 prop 的按钮文本不受影响）

### el-date-picker daterange 的 E2E 交互定式（T18 报表日期筛选直接复用）
- **shortcuts 是唯一稳定路径**：组件配 shortcuts（今天/昨天/最近 7 天/最近 30 天）→ E2E 点 `.el-picker-panel__shortcut` 完成范围选择，**零日历面板操作**（无 popper 残留/渐隐动画/跨月翻页问题——el-select 四轮踩坑的同族风险全部绕开）
- shortcuts 同时是 POS 历史查询的真实高频入口（生产与测试双赢，不是 test-only hack）
- value-format="YYYY-MM-DD" 下 v-model 直接是 `[string, string]`，shortcuts value 返回 Date[] 由组件内部 format

### 重打占位模式（T15 接管契约）
- `window.api.printing as unknown as { preview?: (saleId) => Promise<unknown> }` optional chaining 调用：preload 未暴露时 `?.()` 得 undefined 不抛错 → console.log 占位 + ElMessage.info('打印功能集成中')；**方法存在则透传调用（错误如实显示）**——T15 实装 preview 后按钮零改动自然升级
- E2E 双 toast 陷阱：两次点击占位按钮 3s 内会叠 2 个 `.el-message--info` → strict violation；只对一次点击断言 toast，另一次仅断言 enabled

### 明细行精确断言（el-table 行内 td 列序定位）
- `.el-table__row td.nth(n)` 按列序断言（数量/单价/小计），比行级 containsText 强（避免 '300' 撞条码子串之类的假阳性）；列序 = template 中 el-table-column 声明序
- 双击行用 `row.locator('td').first().dblclick()`（单号格无交互元素，避开行内按钮误触）

## Task 14 报表统计落地记录（2026-11-01）

### 分层结构（T18 消费）
- `report.repo`（createReportRepo：daily/monthly/dailyBuckets 三方法）由 T17 report-loader 演进而来：聚合与明细**共用同一 WHERE**（status='completed' + date()/strftime 过滤）→ 日报 total 与明细自洽由构造保证；**COALESCE(SUM(total_cents),0) 空集归 0**（SQL SUM 空集返回 NULL——空态不抛错的关键）；date()/strftime 与 created_at 写入默认值 `datetime('now','localtime')` 同钟，零 JS Date 重解析
- `report.service`（createReportService）：格式校验（DATE_RE/MONTH_RE，`typeof !== 'string' ||` 先行——防 toString 巧合匹配正则的契约外对象）+ 组装 + 空态；ReportServiceError（code + 中文 message，与 Sale/Product service 同模式）
- reports:export 与 reports:daily/monthly 同走一个 service（**单一数据源**，T17 临时 loader 已删除；issues 两条待办清零）

### MonthlyReport buckets 契约统一（T17 兼容别名而非删除）
- shared `MonthlyReport.buckets: DailyBucket[]` **必填**（service 恒提供，空月 []）；T17 的 `MonthlyReportInput`/`MonthlyBucket` 降级为兼容别名（`= MonthlyReport` / `= DailyBucket`）——**exporter 三文件零改动**（xlsx 的 `import type { MonthlyBucket } from './export.types'` 继续成立）
- BUCKETLESS_MONTHLY_INPUT fixture 转 `as unknown as` **契约外运行时防御形态**：T14 前"T17 前兼容形态"已不存在（类型必填），但 exporter 的 `?? []`（txt/docx）/truthiness（xlsx）守卫仍在代码里——cast 样例继续锁定防御行为，断言零改动（微调允许范围内最小 diff）

### ★ xlsx buckets 空数组语义（T18 报表 UI 必读）
- xlsx.exporter `else if (input.report.buckets)` 对 **[] 是 truthy** → 空月导出会建"仅表头的按日分桶 sheet"；txt/docx `?? []` + `length===0` 才跳过区块 → 三格式对空月行为**不一致但都是 T17 原有行为**（经 reports:export 真实链路：T17 loader 空月就返回 buckets:[]，undefined 形态从未在生产路径出现）。T18 如需统一空月表现须另立决策，勿顺手改 exporter

### TS 判别联合解构陷阱第二次踩中（vitest 全绿 tsc 报错——T17 learnings 已记，仍再犯）
- `const { report } = buildReportExportInput(...)` 解构先于收窄 → report 永远是 `DailyReport | MonthlyReport` 联合，`.date/.sales/.month/.buckets` 全 TS2339；vitest（esbuild 转译不查类型）6/6 全绿，`npx tsc --noEmit` 报 10+ 错
- **正解（与 T17 记录一致）**：保留 input 整体 + `if (input.kind !== 'daily') throw new Error(...)` 收窄后写 `input.report.*`——报错时 RED 快（kind 不符直接 throw，不走到错误分支）
- 教训强化：**共享门禁必须 `npm run typecheck`（整链 exit 0），vitest 绿只证明运行时**

### T17 测试迁移策略（53 计数保持的归责法）
- report-loader.test.ts 6 用例**迁移而非删除**：seed（7 单含 1 voided）与断言**逐字保留**，仅数据路径从 loadXxxReport(db) 换为 buildReportExportInput(service, kind, period)——"导出行为不变"的可审计证据 = 断言值零漂移；export 套件 53 = 47 原有 + 6 迁移
- buildReportExportInput(service, kind, period) 放 reports-export.ipc.ts（export 编排层转换点；懒 require electron 模式 → vitest 纯 Node 可导入）；DailyReport/MonthlyReport 与 exporter 输入逐字段一致 → 零结构转换，title/period 语义逐字同 T17
- IPC 接线：registerReportsIpc(db) 独立文件（reports.ipc.ts，顶部 import ipcMain——无纯逻辑需单测，走 sales.ipc 同款薄层；与懒 require 的 reports-export.ipc 两种形态并存按需选用）；req 运行时防御 `typeof req?.date === 'string' ? req.date : ''`——空串被 service 正则拒绝（可诊断错误），与 sales.ipc 的 `?? -1` 哨兵同模式

### 共享装配文件代持记录（F4 审计归因用）
- 本任务 commit 的 main/index.ts（attachScannerBridge 导入+装配两行）与 preload index.ts/index.d.ts（onBarcode 段）含 **Task 11 并行未提交的扫码桥接线**（T5 交付的装配点）——按"先提交者代持"先例一并提交（共享文件无领地边界）；T11 自有文件（scanner/、cart.store、组件测试）未上船，T11 提交时归因对照本条
- ★ 共享文件撞行实录（第二次，比 T8/T9/T10 那次更隐蔽）：T11 加 attachScannerBridge import 时**撞掉了我刚写入的 `import { registerReportsIpc }`**——注册行还在、import 行消失 → tsc TS2552；更险的是 `npm run typecheck | tail; echo $?` 的 **$? 取的是 tail 退出码（假绿）**——门禁必须 `npm run typecheck >/dev/null 2>&1; echo $?` 直存变量。撞行后修复=只补自己的行，不动对方段落

## Task 11 收银台落地记录（2026-11-01）

### ★★ el-input 受控回吞陷阱（单价编辑必读，T15/T16 表单复用前必看）
- **现象**：CartPanel 单价用 `<el-input :model-value="formatMoney(cents)">`（不监听 update:model-value 意图 blur 提交）→ Playwright fill('2.50') 后 input.value 神秘回滚为 '3.50'（实测 `after fill, value = 3.50`）
- **根因（element-plus input 源码）**：handleInput 内 `emit('update:modelValue')` 之后 `await nextTick(); setNativeInputValue()` 强制把 input.value 回写为 `String(props.modelValue)`——父组件不 v-model 回写时（受控只读），程序化输入必被回吞；真实键入同样会在 nextTick 被吞（焦点在时的 userInput 不保护 el-input，那是 input-number 的机制）
- **正解**：**单价用 el-input-number（元浮点 + `Math.round(yuan*100)` 边界转换 + precision 2 + controls=false）**——T8 默认售价同款模式，其内部 userInput 在聚焦期保护显示、blur 自管提交（handleInputChange 组件级，不依赖浏览器 dirty flag），fill+blur 实证可用
- 同族坑：**el-input 的原生 change 事件依赖浏览器 dirty flag**——Playwright fill 是程序化赋值不置 dirty，blur 不触发 change（实测 NATIVE CHANGE 不 fire）；el-input-number 不受影响（自管 blur）

### ★ S6 注入 evaluate 签名实证（修正早前 learnings 模板）
- `electronApp.evaluate(fn, arg)` 运行时实际调用 `fn(electron模块, arg)`——**第一参数就是 `require('electron')` 模块本身**（实测 keys: BrowserWindow/app/dialog/ipcMain…；官方文档示例 `({ app }) => app.getPath()` 解构的就是它）；TS 类型 `PageFunctionOn<ElectronType, Arg, R> = (on, arg2) => R` 两参签名直接匹配
- **正解模板**：`electronApp.evaluate(async (electron, { code }) => { const wc = electron.BrowserWindow.getAllWindows()[0]?.webContents; … }, { code })`——早前 learnings 的 `from.windows()` 写法无此 API（`from` 即 electron 模块，无 windows() 方法）
- 注入后字符不进入聚焦输入框（keyDown 无 text 不产生 input 事件），但 **Enter keyDown 会到达聚焦元素**——见下条焦点安全

### ★ E2E 焦点安全：fill 后必须 blur()，严禁 Tab 遍历
- **扫码注入 + 表单混合场景的隐形炸弹**：fill('3') 后按 Tab 会把焦点送进行内删除按钮/结账按钮；S6 扫码注入的结尾 Enter keyDown 到达聚焦元素 → **误点删除行/误触结账**。Tab 遍历在此页面 = 不可预测的状态污染
- **正解**：`locator.fill(v)` 后 `locator.blur()`（`node.blur()` 派发真实 blur 事件，el-input-number 的组件级 blur 处理照常触发提交）；BarcodeInput **不处理 Enter**（扫码唯一入口 = 主进程桥，双路径消费同一次扫码 = 重复加购）

### 收银台工程结论（T15 消费必读）
- **结账成功占位 dialog**（PosView 内，title='结账成功'）：单号/合计/件数 + `<pre>` JSON 全量 SaleDetail——T15 替换点：`checkout()` 内 `sales:checkout` 返回后、`cart.clear()` 前，把 dialog 换成 printing:preview 真预览窗口；结构已按"单点替换"组织
- **cart.store**：`stockByProduct` 快照（加购时点库存，行内"库存不足(负库存将产生)"提示数据源——D2 仅提示不阻断）；`subtotalCents(item)` 为 action 而非 getter（参数化行）；`updateQty/updatePrice` 无效输入静默忽略（Number.isInteger + 下界守卫，不产生半状态）
- **typedInvoke 首个落地视图**：`createTypedInvoke((ch, p) => window.api.invoke(ch, p))` 在 PosView 顶层构造——products:list/sales:checkout 全走 typed 契约（G8）；`res: Sale` 运行时是 SaleDetail 超集，`as SaleDetail` 下行 cast 取 items
- **共享文件代持**：main/index.ts（attachScannerBridge 装配）+ preload index.ts/index.d.ts（onBarcode）已被 T14 的 2437d6f 先行代持提交（T14 learnings L430 已双向记录）；本任务 commit 仅含自有文件 + smoke.spec '/pos' 追加
- toContainText 锚点正则坑：`/^\d{8}-\d{4}$/` 撞「单号 」前缀必败——含前缀文案用 `toHaveText(/单号 \d{8}-\d{4}/)`
- vue-tsc 对模板内联事件 handler 参数**不做上下文类型推断**（`(v) => f(v)` 报 TS7006 隐式 any）——模板内需显式注解 `(v: number | undefined) => …`（Vue 3.3+ 模板支持 TS 语法）；`:row-class-name` 等复杂表达式抽 script 方法（同 T8 模式）
- E2E 断言金额显示用 `toHaveValue('3.50')`（el-input-number 精度 2 显示）与 `.cart-row__subtotal` 文本（formatMoney 恰 2 位小数）双层验证——显示层与 store 整数分由 DB 断言闭环（total_cents=1700 硬校验）

## Task 16 小票模板编辑器落地记录（2026-11-01）

### ★ Element Plus attrs fallthrough 分裂（表单类 E2E testid 策略必读，与 T9 aria-controls 配套）
- **el-input 的非 class attrs（含 data-testid）落在原生 `<input>` 上**（2.14.7 源码实证：input.vue `useAttrs()` + `v-bind="attrs"` 绑到 native input 节点）——`getByTestId('tpl-name')` 拿到的就是 input 本身，**再 `.locator('input')` = 0 匹配**（"element(s) not found"）
- **el-select/el-radio-group/el-switch/el-button/el-tag 走 Vue 默认 fallthrough 到根元素**——el-select 的 testid 在根 div 上，`.locator('input')` 取 aria-controls 照常可用
- 结论：el-input 用 testid 直接定位（fill/toHaveValue 原生可用）；el-select 维持 aria-controls 锚点域方案

### ★ el-tag 渐隐动画残留 strict violation（popper 残留同族第三例，T19/后续引用 tag 的 E2E 必读）
- 状态切换（draft→已保存）时旧 tag `el-zoom-in-center-leave-active` 退场动画期间与新 tag `enter-active` **并存** → `getByTestId('tpl-draft-tag')` 解析到 2 元素
- 正解：`.last()` 锚定新挂载元素（enter-active 在 DOM 后位）；与 el-select popper 残留、el-message 叠加同一治理思路

### 断言子串陷阱（列表 tag 断言通用）
- 模板名「默认小票」含子串「默认」→ `toContainText('默认')` 恒假通过；默认标记断言改用 **`.el-tag--success` 计数**（toHaveCount(1)/(0)），语义精确零歧义
- toast 断言：`.el-message--success` 必须 `filter({ hasText }) + .first()`——3s 寿命内跨测试叠加触发 strict violation

### ★ T15 并行领地实录（共享 template.repo.ts 的"追加不修改"实证）
- 我先落盘 CRUD + list（文件头注释声明：list/getDefault 归 T15，CRUD 归 T16）；T15 随后在同文件追加 `stmtGetDefault`/`seedDefaults`/`getDefault()`——**惰性 seed 插两行**（58mm + 80mm，80mm 置默认，单事务）
- T15 的 getDefault 测试（4 例）追加在我建的 tests/unit/db/template.repo.test.ts 末尾 describe 块——合计 24 用例全绿；我的 CRUD 测试全程**直插 SQL 构造数据 + 直读 DB 断言**，对 T15 读取方法零依赖，合并顺序无碍
- 写入时序插曲：T15 的 stmtGetDefault/seedDefaults 先于 getDefault 接线落盘 → 期间 typecheck 的 TS6133 unused 错误归 T15 段落（我的文件零错），接线完成后整链恢复 exit 0

### 模板 CRUD 语义定案（F4 审计 / T20 消费必读）
- **create：首个模板自动 is_default=1**（表恒有默认的不变量起点）；config_json 序列化 + isValidReceiptTemplate 类型守卫（repo 层落库前校验——枚举值与 T3 schema 联合类型逐字对应，shared/schema 零改动）
- **delete：唯一模板不可删**（count>1 守卫抛 CANNOT_DELETE_LAST_TEMPLATE）+ **删默认模板时剩余最早一员晋升默认**（单事务，互斥不变量不破）
- **update：换模板时 paper_width 列同步**（列声明是 config_json 主体的投影；契约 update 无 paper_width 字段——纸宽变更经 config_json 主体生效）；IPC create 校验 req.paper_width === 模板 paperWidth 一致性（不一致拒绝）
- IPC 五通道薄层 = settings.ipc 同款：parseTemplatesCreateRequest/parseTemplatesUpdateRequest/parseTemplateIdRequest 纯函数（JSON.parse + 结构校验）+ registerTemplatesIpc 懒 require

### 模板编辑器数据流（G14 段落级为止）
- draft（reactive）→ previewTemplate（**computed = 表单的响应式 watch**，"不保存也实时刷新"由 computed 链天然成立）→ ReceiptPreview（样例 shopName='测试商店' + 两行商品，金额经 shared/utils/money 组装——G1）
- 新建 = DEFAULT_TEMPLATES['80mm'] 深拷贝草稿（id=null，保存走 create）；复制 = 当前 draft 快照 +『 副本』名；空表 fallback = 直接进入新建草稿态（T15 getDefault 惰性 seed 属打印链路，编辑器 list 为纯 SELECT 不 seed）
- 设默认 UI 语义：radio（设为默认/非默认）+ @change 边界——取消默认被拒（回滚 + warning，无"取消默认"IPC）；草稿设默认被拒（先保存）；保存后 defaultChoice 从行数据重同步

### E2E 过渡态归责 + 设默认闭环实测
- 全量 E2E 撞上 T15 替换 PosView/SalesHistoryView 占位弹窗的瞬间（view 已换新、spec 更新中）→ pos.spec/sales-history.spec 各 1 例失败为 T15 领地过渡态；我的 template-editor.spec 9/9 独立绿
- **设默认→结账预览闭环实测 PASS**：E2E 末用例探测 printing:preview handler（renderer 侧 invoke 探测法）——T15 已接线 → 真实结账 → 预览弹窗含本模板特征行 'E2E专用模板标记'（打印链路消费默认模板的端到端证明）；T15 未合并环境的 skip 分支保留（appendFileSync 记录 evidence）
- "刷新页面值保持"用 SPA 路由离开再回来（T8 page.reload 竞态规避惯例）；autoSelect 恒选默认模板

## Task 15 打印编排集成落地记录（2026-11-01）

### ★ AppSettings「可直接喂」PrintSettings 是假象（T19 learnings 修正——strictNullChecks 陷阱）
- T19 learnings 称"AppSettings → PrintSettings key 逐字一致可直接喂"——**不成立**：PrintSettings 的 `printer_name?: string`（string | undefined）容不下 AppSettings 的 `printer_name: string | null`（strictNullChecks 下 null ⊄ undefined），直接传 TS2345
- 正解：print.service 内 `appSettingsToPrintSettings(s)` 归一（`?? ''` / `?? undefined`）；T19 的 toPrintSettings（ipc 边界防御）与它语义相同但签名不同（Partial 入参），两者并存勿合并——toPrintSettings 被 settings.ipc.test 锁定导出路径

### ★ 打印成功后弹窗自动关闭的 E2E 时序坑（print-flow 首败根因）
- store.print() 成功 → toast + close() **自动关弹窗**；E2E 若再点「取消」→ 目标已在关闭动画（not stable→detached）→ locator.click 30s 超时
- 正解：成功路径断言 `expect(dialog).toBeHidden()`（自动关闭），取消点击只留给"取消/失败后仍在开"的路径

### 组装链路（G7 同源铁律的落地形态）
- **单一组装源**：`createPrintOrchestrator(deps).buildReceiptPayload()` 是预览与打印的唯一数据源——previewSale 只做 logoBuffer→dataURL 分叉、printSale 只做 →generateReceiptBytes→enqueuePrintJob；ReceiptVars 纯字符串（IPC 安全）、ReceiptPrintVars（含 logoBuffer Buffer）仅主进程
- **DI 编排器**：deps = { getSaleDetail / getDefaultTemplate / getSettings / readLogoFile / createChannel? }——vitest 全 mock 零真打印机；`createChannel` 缺省 getChannel（测试注入捕获通道断言字节）
- **串行队列实例级单例**：PrintQueue 在编排器实例内构建一次，包一个"send 时按当前设置解析通道"的 settings-bound lazy channel（`get name()` 委派）——连续 printSale 严格串行 + 设置变更下一次打印即生效（不必重建队列）；printSale 并发串行测试用门控 send 事件序锁定
- **voided 标记组装期生效（D19）**：`withVoidedMark(template)` 在 buildReceiptPayload 里改模板副本（footer 前 insert '=== 已作废 ===' 倍高居中加粗）——预览与打印字节**同步**含标记（E2E 场景 3 双证）；原模板对象不可变（copy-on-write）
- **Logo 读取条件化**：模板 header/footer 无 image 段落时不读文件（readLogoFile 零调用）；有段落且读失败 → null 优雅降级（同 T19 语义）
- **坏 config_json 兜底**：`parseTemplateRow` 用 T16 的 isValidReceiptTemplate 做结构校验，脏 JSON/残缺结构按行声明纸宽回落 DEFAULT_TEMPLATES[paper_width]——T2 fixture `seedDefaultTemplate` 插的就是**非法最小结构**（仅 {paperWidth, cutPaper}），打印链路靠此兜底不崩

### printing:preview res 的结构超集（T3 契约冻结下的第 4 例）
- 契约 res 只声明 `{ template, sale }`；PreviewPayload 附加 data/vars/logoUrl——renderer 侧 `res as PrintingPreviewResult` 下传 cast（PosView `as SaleDetail` 同款）；preload 侧 PrintingPreviewResult 双声明（index.ts 实现 + index.d.ts 权威，ProductRow 先例）；renderer 经 `Awaited<ReturnType<typeof window.api.printing.preview>>` 单源取型
- 错误路径分层：previewSale 错误**原样 reject**（renderer errorMessage 展示）；printSale 错误在 ipc 层转 `{ ok:false, error: '打印失败（${channel} 通道）：…。销售已保存，可稍后在销售记录中重打' }`（G3 文案 + 通道名由 ipc 层取当前设置补全）

### E2E 编排要点（print-flow 三场景）
- settings 直插 DB（printer_channel/tcp_host/tcp_port/shop_name…）+ mock TCP server 19910（T19 模式）；**tcp_port 直改 '1' 模拟不可达**——编排器按次读设置，DB 直改即时生效（无需重启/走设置页 UI）
- 断字节三件套：poll hex contains '1b40' → contains '1b520f'（中文页）→ poll endsWith '1d564200'（全切）；字节落盘 evidence + `1b40…` 头部与 GBK 店名（`b4f2 d3a1 d0a1 b5ea`=「打印小店」）可 xxd 目检
- voided 直插单技巧：sale_no 用 `-0901` 段避开 D18 自动序列（COUNT 语义不受手插跳号影响）；product_id NULL + 快照名（G4 断链形态原生合法）
- sales-history 刷新用 SPA 路由离开再回来（T8 page.reload 竞态规避）

### 共享文件代持实录（F4 审计归因用——反向代持）
- **我的共享段落被 T16 的 87a65ca 先行代持提交**：main/index.ts `registerPrintingIpc(db)` 行、preload index.ts/index.d.ts printing preview/print 段（PrintingPreviewResult 双声明）、template.repo.ts getDefault/seedDefaults 段及其测试 describe 块——T16 issues.md 已记录代持归因；本任务 commit 仅含打印编排专属文件（print.service/printing.ipc/store/dialog/两 view 改造/两 spec/两单测/task-15 证据）
- template.repo.ts 领地协作（先后落地顺序与计划相反）：T16 先建 CRUD + list（文件头留言邀请 T15 追加 getDefault），我在其文件/测试文件末尾**只追加**——"追加不改"双向成立（T16 learnings 已互证）
- pos.spec/sales-history.spec 的占位弹窗断言更新属本任务领地（占位 dialog 替换的必然伴生——T11 的 `.sale-summary__*` 断言随占位 UI 一同退役，新断言锚 '小票预览' 弹窗 + receipt-line 计数 + 全角 '￥' 金额）

### T16 交叉闭环实测（打印链路消费默认模板的端到端证明）
- T16 的 template-editor.spec 末用例（设默认→结账预览含特征行）在本次全量 E2E 63/63 中 PASS——证明打印编排真实消费 DB 默认模板（非硬编码），且 T15/T16 并行改动在合并态下互洽

## Task 20 CI/NSIS 打包落地记录（2026-11-01 实证）

### ★ electron-builder 26.18.0 Linux 产 NSIS 的 wine 真相（任务简报预判修正）
- **"24+ 任何平台可产 NSIS 无需 wine"不完全成立**：makensis（stub 安装包）确实 Linux 原生零 wine（本地产出 销存系统-0.1.0-setup.exe PE32 确认）；但 **uninstaller 提取步骤**（makensis 产 stub → 运行一次安装器提取 `__uninstaller.exe` → 再产最终安装器）在非 win32 走 `WineVmManager → getWineToolset()`（需 wine）
- **win32 上零 wine 依赖**（WineVm.js 源码：`process.platform === "win32"` 直接 exec 目标）→ CI windows-latest 打包干净
- **决策**：本地 Linux 不装 wine（重量级环境变更 + 非权威产出路径），记录「CI 产出」；本地以 --dir asar 冒烟 + NSIS stub 产出（PE32 确认）作为配置正确性实证

### ★ npmRebuild:false + packElevateHelper:false（两个反默认值配置，勿"修复"回 true）
- **npmRebuild 默认 true 会跑 @electron/rebuild**：Linux 上 `--win` 目标对 better-sqlite3 报 `node-gyp does not support cross-compiling native modules from source`（@electron/rebuild 不识别 v13 的 node-gyp-build 风格 prebuilds/ 静态目录，尝试源码重建）；而 v13 N-API + prebuilds 全平台随包（win32-x64.node 物理存在，S1）→ `npmRebuild: false` 语义与事实双正确（CI windows 上还免掉 VS 源码编译耗时）
- **packElevateHelper 默认 true 会打包 elevate.exe**：其 rcedit 后处理在 Linux 需 wine；该 helper 仅供 electron-updater per-machine 提权升级（本项目锁定清单禁止自动更新）→ `false` 语义正确且解锁 Linux NSIS stub 产出

### smartUnpack 与 asarUnpack 决策（勿加 asarUnpack）
- electron-builder **smartUnpack 自动**把 `.node` 原生文件 unpack 到 `app.asar.unpacked/`（无需配置 asarUnpack）——asar 头 overlay：`asar listPackage` 仍列出 prebuilds/*.node 路径，物理文件在 unpacked
- better-sqlite3 v13 加载链（lib/binding.js 源码）：`fs.existsSync(prebuilds/<platform>-<arch>.node)`（Electron fs patch 支持 asar 内路径）→ `require(filename)` → **Electron 自动把 asar 内 .node 重定向到 app.asar.unpacked 副本**（N-API 无 ABI 问题）
- **实证**：--dir 产物启动冒烟（E2E_USER_DATA_DIR 隔离）→ pos.db 出现（user_version=1、WAL、8 表）= asar 内 better-sqlite3 全链路加载成功 → asarUnpack 不配置决策锁定

### files 配置行为（官方 d.ts 原文实证）
- 自定义 `files: [out/**]` 时默认 `**/*` **不**追加，但 **`package.json` 与 `**/node_modules/**/*`（仅生产依赖）任何情况都自动追加**——electron-vite externalizeDeps（主进程运行时 require 生产依赖）下打包正确的前提

### 打包产物命名与 userData
- **Linux --dir 二进制名 = package.json name**（selling-electron，非 productName——PlatformSpecificBuildOptions L107 注释：Linux 用 productName 是 breaking change 故特例）；**win-unpacked/NSIS 安装侧 = productName**（销存系统）
- asar 内 package.json **不注入 productName**（实测 name=selling-electron, productName=undefined）→ Electron app.name = name → **userData = %APPDATA%\selling-electron\**（Windows）/ ~/.config/selling-electron（Linux）——真机清单/README 数据位置按此写

### 生僻字 GBK 行为实测（清单第 8 项预期的事实依据）
- '龘'（U+9F98）/ '堃'（U+5803）：GBK 内（fd93/88d2）→ **正常打印不降级**；'𠀀'（U+20000）/ '✔'（U+2714）：GBK 外 → '?'——清单用 𠀀𡈽（降级）+ 龘（不降级）双锚点，勿想当然按"生僻=降级"写

### 其他
- actionlint 从 GitHub releases 下载单二进制即用（v1.7.7）：本仓库 ci.yml 校验 exit=0
- electron-builder 无 icon：`default Electron icon is used` 警告不失败（platformPackager getOrConvertIcon 源码）——"默认 icon"决策实证
- CI job2 必须先 `npm run build`（electron-builder 只打包现有 out/，不会自跑构建）

### ★ Task 9 fix：toISOString 日期构造的 UTC/本地时区窗口 flaky（CI 必读）
- **根因**：`new Date(Date.now()+24h).toISOString().slice(0,10)` 取的是 **UTC 日期**——UTC+N 时区的本地 00:00–08:00 窗口内 UTC 日期=本地日期-1，"明天"被算成"今天"，过滤断言命中种子数据 → flaky（写测试时晚间 UTC 日期=本地日期所以绿，纯时区窗口 bug）
- **修复模式**：测试日期构造一律本地格式化（`getFullYear/getMonth/getDate` + padStart 2）——与 SQLite `datetime('now','localtime')` / `strftime('%Y%m%d','now','localtime')` 同源同语义（JS Date 本地与 SQLite localtime 都由进程 TZ 驱动，同进程内严格一致）；purchase.service.test 的 `localIsoDate(offsetDays)` / `localYmd()` 即此模式
- **验证矩阵**：`TZ=Asia/Shanghai` 与 `TZ=UTC` 各跑一遍 + 默认 TZ——三窗口全绿才证明时区无关（UTC+N 午夜后窗口正是 bug 触发窗口）
- **CI 含义（重要）**：GitHub Actions windows-latest/ubuntu-latest 跑在 **UTC 时区**——本地（UTC+8）白天绿的测试 CI 可能挂（反之亦然）；所有涉及"当前日期"的断言必须走本地格式化或注入固定时钟，禁止 toISOString 构造业务日期

## Windows CI EBUSY fix：测试 teardown 删 temp DB 目录（2026-11-02）

### ★ unlink 语义的 Windows/Linux 分裂（G11 又一实证，CI 失败两例：settings.repo/seed）
- **Linux 允许 unlink 打开中的文件**（inode 引用计数，句柄在文件也"消失"）——本地全绿**掩盖了连接泄漏**；Windows 不允许（rmSync 直接 EBUSY），CI windows-latest 才炸。与 spooler/路径分隔符同族：**"本地 Linux 绿"只是单平台绿，Windows CI 是另一套文件系统语义**
- **better-sqlite3 连接泄漏两形态**（全仓 grep 定位）：① **freshDb 自建连接从不 close**（settings.repo/template.repo/settings.ipc——afterEach 直接 rmSync）；② **initDatabase 模块级单例不关闭**（seed/sale.service/purchase.service/migrator 第二 describe——单例跨测试持有最后连接）。已有 try/finally close 的（report.service/report-export-input）不泄漏
- **修复范式（三件套）**：`closeDatabase()` 导出（关单例，幂等）+ `openDbs` 模块级登记（自建连接 afterEach 逐个 close，免逐测试手写）+ `rmTempDirSync`（tests/helpers/cleanup.ts——rmSync 带 maxRetries:5/retryDelay:100）。**不变量：每个 rmTempDirSync 前本文件打开的所有连接已 close**（grep 结构性可证）
- **maxRetries 兜底的必要性**：即使连接已关，Windows 仍可能有第三方进程**短暂持有句柄**（防病毒扫描/索引服务）——node fs 的 maxRetries/retryDelay 专为 EBUSY/EPERM 竞态设计（线性退避重试）；Linux 上 maxRetries 无害（rmSync 一次成功）
- **幂等测试的细节**：migrator"二次迁移"用例保留 `first.close()` 内联（顺序重开语义不漂移），仅 second 走 openDbs 登记——close 不能双调（better-sqlite3 对已关连接再 close 会 throw）
- **顺带排查结论**：tests/e2e 与 e2e-qa **均无 rmSync**（temp userData 目录用后不删）——electronApp.close() 后立即 rm 的 Chromium 句柄延迟风险不存在；serial.channel 的 fs 流在 send 内 `stream.end()` 已关
- **验收矩阵**：`npm test`（423+1 skip）+ `TZ=UTC npm test`（CI 时区，顺防时区 flaky 复发）+ `npm run typecheck` 三绿；断言语义零改动（只动 teardown/连接生命周期）

## Windows CI 跨平台坑（第二批，2026-11-02 实证）

### mkdtemp 硬编码 /tmp/opencode → os.tmpdir()（G11 违规实例）
- Windows 无 `/tmp`：`join('/tmp/opencode', ...)` 被解析为当前盘根 `D:\tmp\opencode`（不存在）→ mkdtemp ENOENT
- 触发面：tests/e2e/reports.spec.ts + tests/e2e-qa/{qa-helpers,visual-css-check.mjs,packaged-smoke.mjs}——统一改 `join(tmpdir(), ...)`（node:os）
- 判别方法：unit 测试里 mock 字符串路径（stub writeFile 不落盘）无害（export.service.test 的 '/tmp/opencode/saved' 即此类，CI vitest 过为证）；**实际执行 mkdtempSync/mkdirSync/writeFileSync 的才必须跨平台**
- 教训：**一切实际触文件系统的临时路径一律 os.tmpdir()**——G11 的'禁硬编码路径'不止分隔符，还有 POSIX 绝对路径本身
