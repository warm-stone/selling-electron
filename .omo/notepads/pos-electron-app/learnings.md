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
