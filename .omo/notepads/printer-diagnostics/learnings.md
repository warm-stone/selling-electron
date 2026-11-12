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
