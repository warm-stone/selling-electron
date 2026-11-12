# printer-diagnostics 学习笔记

## Task 1 契约地基落地记录（2026-11-12）

### ★ shared → main 反向 import 的可行性实证（本任务最大决策点）
- 计划允许 `src/shared/types/ipc.ts` import `src/main/printing/diagnostics/schema` 的**纯类型模块**，实证可行，条件三条缺一不可：
  1. **type-only import**（`import type { DiagnosticReport, RepairActionId }`）——编译期擦除，preload/renderer bundle 不会把 src/main 代码拉进去（rolldown 不追踪 type import）
  2. **schema.ts 零 Node/Electron 依赖**（纯 TS 内置类型 + 一个 const）——web tsconfig 无 `"types": ["node"]` 也能编
  3. **TS include 只定 rootFiles**：`tsconfig.web.json` 不含 `src/main/**`，但 ipc.ts（被 web rootFile 传递 import）引用 schema.ts 时后者仍会被拉入 web 侧编译——所以 schema.ts 必须两侧 lib 都能过（无 DOM 冲突、无 node API）
- 首创先例：shared 目录此前零 `from '.*main/'` 引用，本任务开了先河——后续 shared 若再 import main 模块，必须同样满足上述三条（或者干脆把类型沉到 shared）

### LSP 幽灵目录确认（计划预警属实）
- LSP 持续报 `src/main/printing/diagnosis/`（triage.ts / ps-collector.ts / report-writer.ts / diagnosis.types）的模块找不到错误——**文件系统不存在该目录**（`ls src/main/printing` 只有 channels/driver/escpos/print.service.ts + 本任务新建的 diagnostics/），陈旧缓存，tsc/vitest 均不受影响，忽略即可
- 注意拼写：契约目录是 **diagnostics**（诊断子系统），幽灵是 **diagnosis**——别被 LSP 带偏去"修复"不存在的文件

### 契约设计决策
- **RULE_DEPENDS_ON 值类型收窄**：计划写 `Record<FindingCode, string[]>`，实际落成 `Record<FindingCode, DiagnosticSectionName[]>`——新增 `DiagnosticSectionName` 十段联合类型，把段名值域从"注释约定"升级为编译期锁（与 `IPC_CHANNEL_NAMES as const satisfies` 同款仓库惯例）
- **logo-measurement-race 依赖为 `[]`**：该规则消费 T7 renderSnapshot（renderer 侧注入），不属于 PS 采集段——空数组合法且语义诚实；schema.test.ts 单独断言"其余 14 条至少依赖一段"
- **依赖段映射的预声明**：snmp-false-offline 写了 `['printers','ports','tcpProbe']`（离线标志 + SNMP 位 + 可达性三方佐证），jobs-stuck-deleting 带 spoolDir（.spl/.shd 残留佐证）——T5 实现规则时若需调整，改 RULE_DEPENDS_ON 即可，键集/值域有测试锁
- **settings 快照归一为 string**：snapshot.app.settings 的 printerName 用 `string` 而非 AppSettings 的 `string | null`——踩过 pos-electron-app learnings 527 的 null 陷阱（strictNullChecks 下 null 不喂下游），归一责任在 T4 合成侧

### IPC 五处联动（本任务四处 + T9 收口第五处）
- 实测 `IPC_CHANNEL_NAMES` 原有 **32** 通道（非直觉的 30），+3 = 35；三处同步缺一不可：IpcChannels 表 ×1 + 数组 ×1 + tests/unit/shared/ipc.test.ts EXPECTED_CHANNELS ×1，漏一处测试立即红
- preload typed 契约模式（与 testPrint 豁口的差异）：三方法返回类型全走 `IpcChannels['printing:diagnose']['res']` 索引引用——通道 res 改类型时 preload 自动跟随；testPrint 的教训是 req 类型在表外手工重复声明，契约改了它不报错
- 通道名正则约束 `/^[a-z]+:[a-zA-Z]+$/` 对 `printing:diagnoseExport`（驼峰 action）天然兼容，无需放宽

### 验证基线（后续任务回归参照）
- `npm run typecheck` node+web 双绿；`npm test -- tests/unit/shared/ipc.test.ts tests/unit/printing/diagnostics/schema.test.ts` → 9/9
- 证据：`.omo/evidence/task-1-contract-check.txt`（typecheck + 测试 + ipc.ts 三通道 ≥6 次出现）+ `.omo/evidence/task-1-no-raw-string.txt`（preload typed 引用清单）
- 契约锁测试在 `tests/unit/printing/diagnostics/schema.test.ts`（非 src 内 spec——仓库零 src spec 先例；EXPECTED_FINDING_CODES 硬编码 15 清单，改契约必须同步改测试，EXPECTED_CHANNELS 同款模式）

## Task 3 采集脚本构建器落地记录（2026-11-12）

### ★ TS 内联 PS 脚本的最大坑：反斜杠静默丢失
- 注册表行 `HKLM:\SYSTEM\...` 与 spoolDir 回退路径 `"$env:SystemRoot\System32\..."` 在 TS 字符串里**必须写 `\\`**——JS/TS 单双引号字符串对未知转义（`\S`）不报错、直接丢反斜杠，脚本内容会静默损坏成 `HKLM:SYSTEMCurrentControlSet...`（运行时注册表查询悄悄失败，无任何编译期信号）
- 全脚本仅这 2 行含反斜杠（PS 双引号串里 `\` 本身是字面量，只有 TS 侧需要转义）；无 `${`/反引号 → 数组 join('\n') 模式（spooler.channel.ts 同款）安全可用
- 静态性实现：模块级 `const COLLECT_SCRIPT = SCRIPT_LINES.join('\n')` 一次成型，函数只 return——比每次调用重 join 更直白；字符串 `===` 是值比较，两条路径测试都过

### 规格伪码 → 可运行 PS 的必要修补（events 段）
- 规格伪码直接写 `$out.events.admin = @(...)`，但 PS 里对 $null 的属性赋值会抛 PropertyNotFound——**必须先 `$out.events = @{ admin=@(); app1000=@(); operationalEnabled=$false }` 初始化**再逐部分赋值（初始化同时给了稳定空形状：子查询 SilentlyContinue 返回空时不缺键）
- 段模板的「10 段同构」实为「5+5」：printers/wmi/jobs/ports/drivers 是 `cmd | Select-Object | ConvertTo-Json -Depth 4` 同构列表段（段内 JSON 字符串化，段级序列化错误不外溢）；spooler/spoolDir/events/tcpProbe/printConfig 按显式规格输出 hashtable/数组，靠尾部 `-Depth 6 -Compress` 总序列化。**两层输出形状不同是故意的**——T4 归一化解析要统一消化（"JSON 字符串数组 → 对象数组"）

### 计数断言比 toContain 硬（测试设计）
- `count(script, '$_.Exception.Message') === 10` 恰好锁段级 catch 全覆盖——tcpProbe/printConfig 的内层 catch 按规格**故意不记** error（`$reachable=$false` / 空 `{ }`），出现 11 就说明有人破坏了内层语义
- 其他精确锁：`try {`=12（10 段级+2 内层）、`ConvertTo-Json -Depth 4`=5、`ConvertTo-Json`=6、`# --- section: `=10 且顺序单调递增、末行恒 `exit 0` 且全脚本无 exit 1/2/3
- 禁词断言先做误伤排查再写：`Start-Service` vs 脚本中 `$svc.StartType`（不冲突：后者无 `-Service`）；`.Connect(` vs `ConnectAsync(`（不冲突：Connect 后跟 A 非 `(`，恰好反证没退化成同步 Connect）；`net stop` vs `Network`（整串不出现）——禁词稍宽就自己打自己

### 其他落地事实
- `$host` 是 PS 只读自动变量——tcpProbe 用 `$targetHost/$targetPort`（比 $host2/$port2 可读）；`$targetPort = if ($p.PortNumber) { ... } else { 9100 }` 是 PS 5.1 合法的 if 赋值（禁的是三元 `?:`）
- exit 0 恒定契约已落测试断言（无 exit 1/2/3）——与 spooler.channel 的 exit 2 契约形成镜像对照：**采集通道「有输出=可解析」，打印通道「exit code=成败」**
- 本 Linux 开发机无 pwsh（`command -v pwsh` 空）——真机 PS 5.1 语法/运行时验证只能归 T4 Windows 执行环节；本任务的结构断言 + 禁词锁是 Linux 侧能做到的全部
- 验证基线：`npm test -- tests/unit/printing/diagnostics/` → 3 文件 25 用例全绿（T1 9 + T3 13 + 既有 3）；`npm run typecheck` node+web 双绿；证据 `.omo/evidence/task-3-script-assertions.txt` + `.omo/evidence/task-3-field-alignment.txt`（段→schema 字段全对照，T4 按它写归一化解析）

## Task 2 黄金样本 fixtures 落地记录（2026-11-12）

### ★ as 断言 vs 类型注解直赋——JSON 黄金样本唯一的正确姿势（本任务最大坑）
- `const x: PrintDiagnosticSnapshot = json`（注解直赋）走 **assignability**：JSON 导入的属性是 widened 类型（string/number/boolean/null），`state: string` 不可赋给 `'online'|'offline'|...` 联合 → **6/7 个 export 全红**（spoolerDead 例外：printers 空数组无 state）
- `const x = json as PrintDiagnosticSnapshot`（as 断言）走 **comparability**：放宽 string ↔ 字面量联合、null → `string | null` → 全绿；但字段缺失/多余/形状漂移仍报 TS2352——编译锁保真
- 先在 /tmp 用项目 tsc 实验验证再落文件（5 分钟实验省掉一轮全目录返工）
- vitest 运行时 esbuild 只剥类型不查类型——**as 锁的生效路径全靠 typecheck:node**（tsconfig.node.json include `tests/**/*.ts` + `resolveJsonModule: true` 均已就位，T1 基建恰好够用）

### 相对路径层级：fixtures/ 子目录比任务说明多一级
- 任务说明写 `../../../../src/...`（4 级）——那是 diagnostics/ 直下文件（schema.test.ts）的层级；fixtures/index.ts 在子目录，实际 **5 级** `../../../../../src/main/printing/diagnostics/schema`，照抄任务说明会解析到 `tests/src/` 编译即红

### fixture 设计决策（T5/T8 消费方注意）
- **spooler-dead 的 jobs 抑制验证**：printers=[]（RPC 死）+ errors 记 printers/jobs 双段失败——spoolFiles 挂在 printer.queue 里，printers 空则 spool 残留数据自然缺失，jobs-stuck-deleting 的"数据缺失不触发"语义零成本成立，无需发明 system 层新字段
- **healthy/log-disabled 的 printConfig 宽度对齐**：printConfigs[0].widthMicrons=80000 与模板 80mm 一致，避免 driver-page-size-ignored/printable-area-clip 在全绿基线上误触发；PDF 虚拟机给 Letter（215900×279400μm）——非目标机 + spooler 通道双保险，规则应只看 settings.printerName 对应机器
- **云打印机 local/network 标志**：DL-5801PW 走 IP_192.168.1.66 端口但 local=true/network=false——Windows Get-Printer 对 IP 端口打印机 Type=Local（IP 端口仍是本地打印机对象），网络语义在 port.type='tcp-raw' 上表达，勿用 network 标志做云判定
- **预期命中清单只留在任务说明与 evidence，不进 fixture/测试**（fixtures.test.ts 只锁特征字段，findings 期望归 T5 表驱动）

### 验证基线（后续任务回归参照）
- `npm test -- tests/unit/printing/diagnostics/fixtures.test.ts` → 9/9；`npm run typecheck` node+web 双绿
- 证据：`.omo/evidence/task-2-fixtures-check.txt`（测试+typecheck）+ `.omo/evidence/task-2-symptom-fidelity.txt`（DL-5801PW/2107/副本 2 grep 各 ≥1）

## Task 4 采集执行器落地记录（2026-11-12）

### ★ ExecFileFn 不能直接复用 import——maxBuffer 字段逼出同构定义
- spooler.channel 的 `ExecFileFn` options 只有 `{windowsHide, timeout}`，而诊断采集必须显式传 `maxBuffer: 4MB`（Node 默认 1MB 会 mid-stream 杀进程）；类型复用 import 会在对象字面量处 excess property 报红，且 MUST NOT 改 spooler.channel → 任务说明预埋的「或同构定义+注释」是唯一出路，落地为 `CollectExecFileFn`（多 maxBuffer 字段 + 注释说明两个通道 options 形状刻意不同）
- 超时可测性的正确形态：**执行器自有看门狗**（setTimeout reject）而非只依赖 execFile 的 timeout 选项——fake execFile 永不回调时选项形同虚设；`timeoutMs` 可注入（默认 30000）+ 测试传 50ms 即可在真实计时器下快速断言（<5s 防退化护栏），无需 vitest fake timers

### 双层 JSON 防御解析的形状谱系（T3 交接坑的实测消化）
- 五列表段实测三种形状：空列表 → `[]`；N≥2 项 → `['<JSON 数组文本>']`；恰 1 项 → `['<JSON 对象文本>']`（@() 包裹内层 ConvertTo-Json 单对象输出——PS 经典陷阱传导到外层）。统一消化公式：string→parse、数组元素 string→逐个 parse、解析后单元素嵌套数组 `[[a,b]]` 解包一层、单对象包成 `[obj]`
- **{error} 形状检查必须在二次解析之前**：段级失败是 `{error:'...'}` 对象，若先跑列表解析会把它当"单对象记录"包装吞掉；`jobs: {error}` 与 `jobs: ['{"a":1}']` 只隔一个检查顺序
- 测试构造双层 fixture 的 JS 写法：`{ printers: [JSON.stringify(list)] }` 再整体 `JSON.stringify`——外层 stringify 自动做转义，与 PS 外层 ConvertTo-Json 的产物逐字节同构
- 测试里故意让五段各用一种形状（printers/wmi/ports/drivers 用 `[str]`、jobs 用裸字符串）+ 专项形状谱测试（单对象/原生对象数组/损坏字符串）——防御分支全锁定

### 归一化的实测坑
- **打印机名可含逗号**（"前台, 备用机"）：Win32_PrintJob.Name "printerName, jobID" 必须按 `lastIndexOf(',')` 切，按首个逗号切会把打印机名截断
- **WMI Owner 是 `MACHINE\user` 而 env USERNAME 是裸 `user`**：isOwnedByCurrentUser 用「全等 OR 反斜杠后缀匹配（大小写不敏感）」双命中，否则生产上永远 false
- **状态判定优先级**：WorkOffline=true → offline（source 'wmi-workoffline'，printer-offline-flag 规则的判定信号，PrinterStatus=Normal 也覆盖）> PrinterStatus 映射（Normal/Paused/Offline/其他→unknown）> 无 printers 段记录 → unknown（source 'wmi'）。schema state 联合里的 'error' 值 T4 映射不产出（T5 按 detectedError 组合判定）
- **printers/wmi 按 name 双向 union**（大小写不敏感）：printers 损坏时 wmi 单段撑起列表（4/5 台）、wmi 缺记录的打印机（"前台, 备用机"）由 printers 单段撑起——单段失败列表不塌
- **spoolFiles 归属从简决策落地**：挂 settings.printerName 匹配机 → 挂第一台 → 无打印机丢弃（raw.spoolDir 留档）；测试用「设置的打印机 ≠ 列表第一台」的 fixture 才能区分"匹配"与"兜底"两条路径（同目标时断言无区分度）
- **faulting 提取的两处规格外超集**（不改变给定模式命中集）：中文实际措辞是「错误应用程序名称:」——补 `(?:错误|故障)?` 前缀 + `(?:称)?` 后缀；stop 类补全角逗号 `，` 否则捕获吞到行尾。已注释说明
- AppInfoSnapshotProvider 设计成**全字段可空的数据接口**（settings 结构兼容 AppSettings 打印子集）：归一责任（printer_name null → ''）收在 composeAppSection，T9 只管喂原始值；默认 provider 的 electronVersion 取 `process.versions.electron ?? 'unknown'`（纯 node 测试环境下 'unknown'，断言用同表达式计算期望值避免环境依赖）

### 验证基线（后续任务回归参照）
- `npm test -- tests/unit/printing/diagnostics/` → 6 文件 60 用例全绿（T1 9 + T2 9 + T3 13 + 既有 3 + T4 22 + 报告/渲染侧）；全量 `npm test` → 54 文件 828 用例全绿；`npm run typecheck` node+web 双绿
- 证据：`.omo/evidence/task-4-runner-success.txt`（成功路径 4 用例）+ `task-4-partial-failure.txt`（部分失败 4 用例：{error} 双段/双段塌空/嵌套损坏/段缺失）+ `task-4-guardrails.txt`（BOM/maxBuffer/timeout/windowsHide/平台守卫专项 + 源码锚点 + typecheck）
- 本 Linux 开发机 fake execFile 全覆盖，真机 PS 5.1 实际输出形状（尤其 @() 包裹的单字符串形状）只能在 T9 Windows 编排环节验证——形状谱系防御解析就是为此买的保险

## Task 7 渲染自检 render-check 落地记录（2026-11-12）

### ★ 并行在途任务的 inline snapshot 污染（本任务最大意外——后续任务必读）
- 跑 `npx vitest run tests/unit/printing/diagnostics/` 全目录回归时，**并行 T8 的在途 untracked 文件** report.exporter.test.ts 带空 `toMatchInlineSnapshot()` 槽——vitest 直接把快照写进他们的文件（`Snapshots 1 written`），mtime 变成我的运行时刻
- 恢复：python 正则 `toMatchInlineSnapshot\(\`\n.*?\n\s*`\)` → `toMatchInlineSnapshot()` 清回空槽（他们的下一次运行会再生成，内容确定性相同）；**不要试图替 T8 修他们自己的失败用例**（归档路径 toEqual 期望不匹配是 T8 在途工作自己的事）
- 教训：并行任务期间回归验证**只跑自己的测试文件**；跑共享目录后检查 `git status` 里别人文件的 mtime/内容变化

### settle 骨架带 resolve 值的适配
- driver.channel 的 `settle(err?: Error)` 只 resolve void；render-check 要 resolve RenderSnapshot → 改成 `settle(result: RenderSnapshot | Error)` 联合参数 + `instanceof Error` 分流——先到者胜 + finally destroy try/catch + timer 清理三件套逐行同构，仅出口类型扩展
- 超时错误消息用 `${timeoutMs}ms` 而非 driver 的秒格式——注入 50ms 时 "0.05s" 不可读，且测试断言 `/超时.*50ms/` 直观锁注入值生效

### reject 边界：测量差异是数据，基础设施失败才是错误
- heightDelta ≠ 0 **永远 resolve**（那是要采集的证据本身，路径 1 用 delta=265 照常 resolve 即证明）；仅 loadURL/executeJavaScript 抛错、返回非 JSON、h/w/dpr 非有限正数才 reject 中文错误
- 超时最终决策 **reject**（非部分返回）：挂死时第二次值不存在，heightDelta 无意义；T9 编排层负责 try/catch 包裹（renderSnapshot 记空、不阻塞诊断）——责任边界在任务说明里预声明，本模块不越界
- 三层超时：第二次测量脚本内置 5s decode 兜底 → 外层 settle 超时（默认 15s，可注入）→ T9 try/catch

### 两次测量的实现细节
- 第一次脚本四值一次取齐（h/w/dpr/img——img 判 `img.receipt-logo` 存在且 `getAttribute('src') !== null`）；第二次脚本 `decode().then(resolve,resolve)` **成功失败都继续**（证据关心解码安定后的布局，不关心图片好坏）+ `.then(() => JSON.stringify({h}))` 保证测量发生在 decode 定局之后
- fake 窗口 `executeJavaScript` 按**调用序**分派（`calls.executed.length === 1 ? firstJson : secondJson`）比按 code 内容匹配简单可靠；挂死路径返回 `new Promise(() => {})`
- 数据同源闭环：测试用 1842/2107/265 与 fixtures symptom2 renderSnapshot 完全一致——本模块是 fixture 的事实来源（真机诊断出实值后回填）
- 默认窗口工厂 `() => RenderCheckWindow` 无参（driver 的带 html 参数——那边工厂要消费 html，这边不需要）；接口比 DriverPrintWindow 少 print 方法，结构子集独立声明（spec 原文如此）

### 验证基线（后续任务回归参照）
- `npx vitest run tests/unit/printing/diagnostics/render-check.test.ts` → 8/8（4 路径 + destroy 吞异常 + loadURL/exec 失败 + 非 JSON/非法值）
- `npm run typecheck` node+web 双绿；证据 `.omo/evidence/task-7-logo-race.txt` + `.omo/evidence/task-7-decode-timeout.txt`
- T8 在途失败（report.exporter.test.ts 归档路径断言）与本任务无关——勿顺手修

## Task 8 报告导出器落地记录（2026-11-12）

### ★ vitest inline snapshot 首次引入：新快照默认即写（无需 -u）
- 仓库此前零 snapshot 用例；`toMatchInlineSnapshot()` 留空后跑普通 `vitest run` 就会填充（默认 `updateSnapshot: 'new'`——新快照即写、**不匹配**才红），无需 `-u`；复跑无 "Snapshots written" 行即稳定锁
- golden 内容含一整行紧凑 RAW JSON（~2.5K 单行）——vitest 会把它原样嵌进模板字面量；输出无反引号/`${` 故零转义冲突

### 封顶 fake deps 的语义陷阱（本任务最易错点）
- 规格「21 预置 → 归档后 listDir=20 · deleteFile 恰 1 次」隐含：**fake 的 writeFile 不把新文件计入 listDir 状态**（`listDir: () => [...state]` 纯快照）。若 fake 让 writeFile 入列，则 22 列出 → 删 2 次，与规格断言直接冲突
- 实现侧语义自洽：**写后列目录 → 删 (count-20) 个最旧**——真实 fs 下 21 存量+1 新=22 列出删 2 保 20；fake 下 21 列出删 1。两种世界各自正确，勿按单侧观测"修正"另一侧
- 时间戳取自 `collectedAt`（非 Date.now()）：确定值免时钟注入；断言用 `/diagnose-\d{8}-\d{6}\.json$/` 正则而非硬编码时刻——本地钟时区无关（+08:00 输入在 UTC 机器落 023000，在 CST 落 103000）

### 断言细节坑
- archiveHistory 返回/删除路径断言必须带 `diagnostics/history` 两级段：`join(dir,'diagnostics','history',name)`——我在测试侧漏写该段当场翻车（writes 路径对、deletes 期望错）
- deleteFile 收到的是 join 全路径，fake 用 `basename(p)` 回映射裸文件名状态（node:path basename 对 `/`、`\\` 双平台安全）

### 报告层设计决策（T9 消费方注意）
- **toTxtBuffer 承担 CRLF+BOM**（规格「CRLF 行尾由导出 Buffer 层处理」的 Buffer 层=本函数；对齐 txt.exporter 惯例）；buildReportTxt 纯 \n——golden/往返测试友好
- **建议行回退**：`suggestedActions` 空时 needs-dev→'需开发介入'、其余→'人工引导'（L4 引导占位动作 REINSTALL_DRIVER_GUIDE 等本身是 action，有 actions 时透传 join(' + ')）
- **摘要三桶映射**：已自动修复=auto-fixed+verify-passed · 待确认=pending+verify-failed · 需人工/开发=needs-manual+needs-dev+escalated；pass 契约上不产出、混入也不计
- severity 排序用 rank map（critical=0..info=3）+sort 稳定性保同级产出序；renderSnapshot 取 `report.renderSnapshot ?? snapshot.renderSnapshot` 双源兜底
- **golden findings 是手工构造**（T5 未落地——diagnostics/ 目前只有 schema+collect-script）：driver-page-size-ignored(high/printer/needs-dev/空动作) + logo-measurement-race(medium/appConfig/pending/1 动作)；T5 上线后 fixture→findings 真实映射归 T5 表驱动锁，本 golden 只锁报告层形状
- HISTORY_NAME_RE `^diagnose-\d{8}-\d{6}\.json$` 兼做列目录过滤器（历史目录混入异名文件不参与排序封顶）；同秒重复归档同名覆盖、计数不膨胀

### 验证基线（后续任务回归参照）
- `npx vitest run tests/unit/printing/diagnostics/` → 5 文件 38 用例全绿（T8 5 + T7 render-check + T1/T2/T3 既有）；`npm run typecheck` node+web 双绿
- 环境备注：`tests/unit/printing/channels/tcp.channel.test.ts` 1 例「连接超时（不可路由地址）」在本沙箱失败——预置环境 flake，与本任务零关联（隔离复跑确认）
- 证据：`.omo/evidence/task-8-report-golden.txt`（38 绿 + golden 素材 grep + typecheck）+ `.omo/evidence/task-8-redaction-cap.txt`（5 断言 + 脱敏/封顶断言行 + flake 备注）

## Task 6 修复动作构建器与执行器落地记录（2026-11-12）

### ★ Start-Process -ArgumentList 元素双层转义——测试抓到的真 bug
- 提权包装里 `-ArgumentList '-NoProfile','-File','<path>'` 的每个元素是**一个 PS 单引号字符串字面量**：先对内容做单引号翻倍（escapePowerShellSingleQuoted），再整体包 `'…'`；**含空格的元素还要在字面量内再包双引号**（`'"C:\a b\x.ps1"'`）——Start-Process 按空格拼接子进程命令行且**不自动加引号**，含空格路径（用户名带空格的 %TEMP%）会被拆散
- 首版实现漏了外层 `'…'` 包裹（只做了转义没包字面量），wrapper 退化成裸逗号列表——`expect(wrapper).toContain("'-File'")` 一发命中。教训：**转义函数返回的是"内容"，调用方负责"定界符"**，两层缺一不可
- 参数值必须经 Number.isFinite 校验后才可烘进脚本文本（olderThanMinutes 拒负数/NaN/Infinity——有限数无注入面）

### UAC 拒绝（1223）的两层双信号
- wrapper 层（PS）：`Start-Process -Verb RunAs` 被 decline 时抛本地化异常（英文 'canceled' / 中文 '取消'）→ catch 映射 `exit 1223`；额外加了 `HResult -eq -2147023673`（0x800704C7 = HRESULT_FROM_WIN32(1223)，区域无关）——若该异常不携带此 HResult 则静默无效，无害
- runner 层（Node）：`error.code === 1223` 优先 + `message 含 '1223'/'取消'` 兜底（防御 wrapper 层本地化遗漏）。注意 Node 错误 message 含完整命令行，路径含 '1223' 有理论误报面——spec 明示接受此风险（code 优先）
- `-Verb RunAs` 与 stdout 重定向互斥 → **exit code + result-file 是唯一回传**；execUac 的 declined 是 resolve 不是 reject——用户点「否」不是故障，needs-manual 可重试

### exit-through-finally：purge 单一 exit 点的位置学
- `exit N` 在 try 里**会**触发 finally 执行（顺序语义），放 try 里则停服务失败路径永远走不到结果写入；放 finally 里则 exit 与恢复逻辑互相纠缠——**落点：finally 之后 `$result.exitCode = $exitCode` → 写 result-file → `exit $exitCode` 三行收尾**，测试用行号比较锁死 finally → 结果写入 → exit 的顺序
- exit 契约：0 成功 / 2 停服务失败（含 prepare 阶段——机器原样最安全）/ 3 删文件部分失败（服务已恢复）。phase 变量（prepare/stop/delete）区分 catch 落点
- result-file 细节：PS 5.1 `Set-Content -Encoding UTF8` 自带 BOM → **读侧必须 strip `\uFEFF` 再 JSON.parse**（双向 BOM：落盘侧 runner 给 .ps1 前置 BOM，回传侧 PS 写 JSON 自带 BOM）；runner 执行前 `rmSync(force)` 清陈旧结果防上次内容串读（有专门测试锁）

### 其他落地事实
- dryRun 语义：不落盘、不 exec、commands 只回文本；**MIGRATE 也实现了 dryRun**（目录 dryRun=true 与 runner 行为一致，否则 T9 预览流撒谎）——spec 只要求 PURGE，这是超出 spec 的目录一致性修正
- catalog 测试用 `[id, level, needsElevation, requiresConfirm, dryRun]` 五元组表驱动全字段锁（EXPECTED 硬编码 9 行，改目录必须双侧同步——EXPECTED_CHANNELS 同款模式）
- L1 本人过滤：`Owner -eq $env:USERNAME` 谓词在构建器文本 + fake execFile 收到的实参两层断言（证据 task-6-own-jobs-only.txt）
- 提权子进程加 `-WindowStyle Hidden` 防窗口闪烁（外层 execFile windowsHide 只管外层；透明度由 exit code/result-file 保证）
- **tcp.channel.test.ts 环境 flaky 留档**：'不可路由地址连接超时' 用例在本 Linux 开发机间歇失败（stash 掉本任务文件后复跑仍失败，与本任务无关）——后续任务全量跑测试遇到此失败可直接比对
- 验证基线：`npm test -- tests/unit/printing/diagnostics/` → 7 文件 106 用例全绿（T1 9 + T2 9 + T3 13 + T4/T7/T8 29 + 本任务 46）；typecheck node+web 双绿；证据 task-6-purge-guardrails / own-jobs-only / uac-declined 三份

## Task 5 规则引擎落地记录（2026-11-12）

### ★ 前会话「设计未落盘」的续接教训
- 两次续接失败的核心原因是把时间花在反复确认设计而非写盘——本任务按「先写文件，立刻验证」执行：读 schema + 7 组 fixture（一次性并行读）→ 直接落 analyze.ts（15 规则一遍写完）→ 落测试 → 一次全绿，全程零返工
- 设计文档（任务说明里的规则表）已经足够精确（阈值/动作/状态全部预锁定），实现侧不再需要任何决策——**照抄规格比"优化"规格安全**

### 规格边缘语义的落定（后续消费方注意）
- **jobs-stuck-error 触发条件 = 本人错误任务**：他人错误任务只追加 PURGE_QUEUE_RESTART_SPOOLER 动作，不独立触发（L1 只能清本人任务，纯他人滞留不指认）——测试用合成样本双锁（仅本人 → 恰 [CANCEL_ERROR_JOBS]；本人+他人 → 追加 PURGE）
- **printable-area-clip 嵌套在 driver-page-size-ignored 命中内**：纸宽 < 模板-4000 数学上必然 |diff|>1000，嵌套与「同 10 前提」语义等价；clip 是 page-size-ignored 的子集（窄纸场景），两条可同时产出
- **抑制 ≠ 段守卫**：spoolerDead fixture 的 errors 已含 printers/jobs 双段，R2/R3 被段守卫拦截就够——抑制逻辑（spooler-stopped 命中 → 跳过 R2/R3）在 fixture 上无区分度，专门造「spooler 停 + jobs 段正常 + 有滞留任务」的合成样本才锁到
- **空遥测守卫的双输入**：logDisabled（operationalEnabled=false + app1000Events 空）与 healthyMachine（日志开但 1000 事件空）都不产 driver-crash-loop——"没证据"与"遥测关闭"同走不产结论路径；faultingModule='unknown' 的条目也不指认驱动（模块未锁定）
- **R8/R9 互斥性**：WINPRINT 处理器（R8 命中）与 dlpproc 非 WINPRINT（R9 命中）天然互斥，表驱动 mustNotHave 交叉锁定防规则漂移

### fixture 覆盖缺口与合成样本策略
- 7 组黄金样本只正向覆盖 7/15 条规则（R1/R8/R9/R10/R12/R15 + 负向若干）；R2-R7/R11/R13/R14 无 fixture——用 healthyMachine 作底座 spread 替换 printers/system 字段构造合成样本（零新建 JSON 文件，类型由 PrintDiagnosticSnapshot 注解保证）
- printable-area-clip 合成：80mm 模板 + 58mm 纸宽（58000 < 80000-4000）→ clip 与 page-size-ignored 同时命中，一条样本锁两条规则
- 测试任务说明写的 import 路径 `../../fixtures/index` 是错的（从 analyze.test.ts 实际是 `./fixtures/index`；4 级 `../../../../src/` 与 repair.test.ts 同款）——照抄说明路径会解析到 tests/src/ 编译即红，先看同目录既有测试的 import 再写

### 落地事实
- evidence 全部走结构化字段路径（`printers['X'].driver.rawOnlyBit=false` / `renderSnapshot.heightDelta=265`），spooler-stopped 的 evidence 精确锁定 `system.spooler.status='Stopped'`（字符串插值，非硬编码）
- depsFailed 用 `Object.prototype.hasOwnProperty.call(s.errors, sec)`——errors 是 Record<string,string>，in 操作符会误伤原型链上的键（toString 等）
- R10/R11 外层 guard 写成 `!depsFailed(A) || !depsFailed(B)` + 内层各自再查：两规则当前依赖同为 ['printConfig']，但 RULE_DEPENDS_ON 若将来分化，内外双层保证各查各的
- 验证基线：`npm test -- tests/unit/printing/diagnostics/` → 8 文件 142 用例全绿（原 106 + 本任务 36）；`npm run typecheck` node+web 双绿；LSP 双文件零诊断（diagnosis/ 幽灵目录未复发）
- 证据：task-5-rules-tabledriven.txt（142 绿 + typecheck + mustHave/mustNotHave 矩阵锚点）+ task-5-no-telemetry.txt（空遥测守卫源码锚点 + 针对性运行 + 零 node: import 清单）
