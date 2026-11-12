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
