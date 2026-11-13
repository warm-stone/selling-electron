# 打印机诊断子系统（printer-diagnostics）

## TL;DR

> **Quick Summary**: 在 selling-electron（Windows POS）内建打印机诊断子系统：单次 PowerShell 聚合采集（无提权、编码安全）→ 纯函数规则引擎分析（15 条规则含项目专属云打印机/Generic-Text-Only/渲染层规则）→ L1-L4 分级修复（L1 静默自动 / L2 UAC / L3 确认 / L4 引导）→ 重采验证闭环；交付设置页诊断面板 + 单文件 txt 报告（含 raw JSON 附录）+ userData 历史留档。
>
> **Deliverables**:
> - `src/main/printing/diagnostics/`：schema / collect-script / collect.runner / analyze / repair-script / repair.runner / render-check / report.exporter / diagnose.service 九模块
> - 3 个 typed IPC 通道（printing:diagnose / printing:repair / printing:diagnoseExport）五处联动登记
> - SettingsView 第四张诊断卡片 + 三区诊断对话框 + 修复确认流
> - 7 组黄金样本 fixtures（含两台真实故障机的症状复刻）作为规则引擎验收基准
> - txt 报告导出（三层结构 + raw JSON 附录 + UTF-8 BOM + 脱敏）+ history 留档封顶
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 5 waves（Wave 1: 1 任务 → Wave 2: 2 → Wave 3: 5 并行 → Wave 4: 2 → FINAL: 4 审查）
> **Critical Path**: 1 契约 → 3 采集脚本 → 4 采集执行器 → 9 编排装配 → 10 UI+E2E → F1-F4

---

## Context

### Original Request
用户原话："目标机器打印机状况复杂，设计诊断程序或脚本，对目标机器信息进行收集，之后收集信息再进行修复"。后续补充两台真实故障机症状：①spooler 通道无法打印中文、图片；②driver 通道左侧空白、右侧截断、上方大面积空白、加 logo 后小票内容消失。

### Interview Summary
**Key Discussions**:
- 形态：集成到应用内（用户确认；独立脚本形态排除）
- 平台：仅 Windows（用户确认；Linux 按 G11 优雅降级，CI 全绿）
- 修复自动化：L1 静默自动 + L2 UAC 确认 + L3 确认执行 + L4 仅引导（用户确认）
- L1 自动修复在 diagnose 返回前服务端完成（HP PSDr "auto-fixed" 体验）
- 报告交付：单文件 txt（三层人读 + raw JSON 附录）+ userData 历史留档（用户确认方向）
- 黄金样本 7 组 fixtures 作为验收基准（用户确认，含症状扩展）

**Research Findings**:
- 仓库可复用基建：spooler.channel.ts 的 ExecFileFn 注入 + 纯 spec builder + G11 守卫模式；export.service.ts 导出链（Buffer→dialog→写→reveal，E2E_EXPORT_DIR 钩子）；PrintQueue 串行队列；printing:print 的 { ok, error } 信封
- 外部命令矩阵：Get-Printer/Win32_Printer（Attributes RAW_ONLY 4096 位、PrintProcessor、Manufacturer）/Win32_PrintJob（StatusMask 位图）/Get-PrinterPort（WSD-* 模式）/Get-PrinterDriver/Get-Service/注册表 spool 目录/Get-WinEvent（PrintService Admin 99 + Application 1000）/TCP probe 9100/515/Get-PrintConfiguration（纸张）
- 全部 Get-* 采集（除 Get-PrinterProperty，已裁剪）无需管理员
- Electron 症状 2 证据：#31705（silent print GDI 忽略 pageSize，closed not planned）、#50481（v30+ 边距回归热敏机右截断——与症状一致）、#39179（dpi workaround）、Electron 41+ usePrinterDefaultPageSize（本 app 44 可用）

### Metis Review
**Identified Gaps**（全部已并入设计）:
- 发现 A：`Set-PrinterPort` 不存在（幻觉命令）→ DISABLE_SNMP 实际需提权 → 保守重分级：DISABLE_SNMP 降 L4 引导、WSD→TCP 归 L2 UAC、spike 后可调（待用户最终确认）
- 发现 B：PrintService/Operational 日志默认禁用（7 个事件 ID 仅 99 可见）→ 新增一次性提权动作 ENABLE_PRINT_LOG + 事件规则容忍空数据不误报 pass（待用户最终确认）
- 发现 C：编码链路四坑（PS 5.1 stdout GBK / .ps1 须 UTF-8 BOM / chcp 无效 / maxBuffer 1MB）→ 编码层 guardrail 全量采纳
- IPC 通道 = 五处联动（ipc.ts ×2 + ipc.test.ts EXPECTED_CHANNELS + preload ×2 + main/index.ts），不复制 printing:testPrint 裸字符串豁口
- CI 仅 tag(v*) 触发 windows-latest；日常验证走本地 npm run test:e2e
- 提权 runner：-Verb RunAs 不能配 -RedirectStandardOutput → result-file + 显式 exit code 契约；UAC 拒绝 = Win32Exception NativeErrorCode 1223 → needs-manual
- L1 仅取消当前用户任务（MS-PRSOD）；findings 去重（spooler-stopped 抑制 jobs-stuck 派生）
- 仓库惯例：src/ 内不放 .spec.ts（测试全在 tests/unit/）→ 模块命名 collect-script.ts / collect.runner.ts

---

## Work Objectives

### Core Objective
在应用内对 Windows 目标机的打印机环境做无副作用采集 → 规则引擎诊断 → L1-L4 分级修复 → 复验闭环，并产出可导出报告；对两台真实故障机症状给出可定位的 findings 与修复/引导。

### Concrete Deliverables
- `src/main/printing/diagnostics/schema.ts` 等 9 模块 + `src/main/ipc/diagnostics.ipc.ts`
- `src/shared/types/ipc.ts` 新增 3 通道 + `src/preload/index.ts`(+`index.d.ts`) 扩展
- `src/renderer/src/views/SettingsView.vue` 第四张 el-card + pinia store 扩展
- `tests/unit/printing/diagnostics/`（fixtures 7 组 + 各模块单测）+ `tests/e2e/` 诊断场景
- `docs/windows-manual-checklist.md` 新增「打印机诊断」真机验证节（含 spike 验证点）

### Definition of Done
- [ ] `npm run typecheck` 全绿（node + web 两侧）
- [ ] `npm test` 全部通过（含新增单测与 7 组 fixtures 表驱动）
- [ ] `npm run test:e2e` 诊断面板场景通过（本地，mock IPC）
- [ ] reports/诊断报告 fixture golden 快照测试通过（BOM + 三层结构 + JSON 附录往返）

### Must Have
- 采集脚本：UTF-8 BOM 落盘、首行 `[Console]::OutputEncoding`、每段独立 try/catch、exit 0 + JSON 内嵌 section errors、PS 5.1 语法、`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`
- 执行器：maxBuffer ≥ 4MB、30s 超时、非 win32 显式拒绝（G11 模式 A，对齐 spooler.channel.ts:185-192）
- 规则引擎：只消费结构化字段（StatusMask/Attributes 位图、exit code、数值），零本地化消息文本解析；spooler-stopped 抑制 jobs-stuck 派生规则；每规则声明 dependsOnSections + scope + evidence 路径；事件数据缺失不得判 pass
- 修复：L1 仅本人任务；L2 金标准序列 5 护栏（WaitForStatus 30s / 停后重读目录 / finally 无条件 Start-Service / 恢复依赖服务 / 年龄过滤选项）；UAC 拒绝（1223）→ needs-manual 非 failed；result-file + 显式 exit code 契约
- IPC：三通道五处联动一次到位；诊断动作通道 { ok, error } 信封；防重入守卫
- 报告：txt UTF-8 BOM + 三层结构 + `=== RAW JSON BEGIN/END ===` 标记 + schemaVersion + DocumentName 脱敏；history 保留 20 次封顶
- 编排：COLLECT → ANALYZE → L1（本人任务）→ VERIFY（dependsOnSections 子集重采，未消除 → escalated）
- 采集含 app 侧快照：settings、Electron 版本、driver 通道 print options、模板要素（logo 有无/尺寸）

### Must NOT Have (Guardrails)
- 不使用 `Set-PrinterPort`（不存在的命令）
- 不解析任何本地化 PowerShell 错误消息文本
- 不在 diagnose 返回前做任何提权操作；不无点击自动提权；不做定时/自动诊断钩子
- 不实现 WS-Discovery Resolve 客户端（只用注册表/DeviceURL 只读数据源）
- 不做 Get-PrinterProperty/DEVMODE 提权扩展采集（首版裁剪）
- 不自动改写打印参数（症状 2 的 Electron 层根因只产 needs-dev finding + workaround 引导：dpi / usePrinterDefaultPageSize / 反向切 spooler 通道建议）
- 不做驱动自动安装/卸载（L4 仅引导）；不做 history 浏览 UI；不做报告 i18n（中文单语言）；不做网络诊断 beyond TCP probe
- 云打印机名单 = 源码 const 数组（首批 Deli DL-5801PW），不做配置系统
- 不引入任何新 npm 依赖
- 不复制 printing:testPrint 的裸字符串通道豁口（必须走 typed 契约五处联动）
- src/ 内不新建 .spec.ts 测试文件（测试全在 tests/unit/）

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES（vitest 747 用例 + Playwright _electron E2E + CI windows-latest tag 触发）
- **Automated tests**: tests-after 但实现+测试=一个任务（项目模式：命令/脚本 spec 断言不执行 + fake execFile + 表驱动）
- **Framework**: vitest（单测）+ Playwright _electron（E2E）

### QA Policy
每任务 QA = vitest 运行断言（fake 注入，Linux 可跑）+ 最终 F3 真机语义验证（CI windows 或本地）。证据存 `.omo/evidence/task-{N}-{slug}.{ext}`。
- PS 脚本资产：vitest 字节级断言（BOM / OutputEncoding 行 / 段标记 / exit 0 / 无 PS7 语法）
- 执行器/修复器：fake execFile / fake 窗口工厂注入
- 规则引擎：7 fixtures 表驱动 → 断言 findings codes / actions / 抑制
- UI：Playwright（选择器级断言 + E2E_EXPORT_DIR 落盘断言）
- 真机项（PowerShell 实跑/UAC 弹窗/WSD spike/Electron 打印矩阵）：归入任务 10 的 docs 真机清单（F3 审查核对清单存在性）

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1（契约地基）:
└── Task 1: schema.ts 类型契约 + IPC 五处联动（4/5 处） [unspecified-high]

Wave 2（数据与脚本，依赖 1）:
├── Task 2: 7 组黄金样本 fixtures [quick]
└── Task 3: 采集 PS 脚本构建 collect-script.ts [unspecified-high]

Wave 3（核心引擎，5 路并行，依赖 1/2/3）:
├── Task 4: 采集执行器 collect.runner.ts（依赖 3） [unspecified-high]
├── Task 5: 规则引擎 analyze.ts + 15 条规则（依赖 2） [deep]
├── Task 6: 修复构建与执行器 repair-script/runner（依赖 1） [unspecified-high]
├── Task 7: 渲染自检 render-check.ts（依赖 1） [unspecified-high]
└── Task 8: 报告导出器 report.exporter.ts（依赖 2） [quick]

Wave 4（集成收口）:
├── Task 9: 编排服务 diagnose.service + IPC 薄层 + 装配（依赖 4,5,6,7,8） [deep]
└── Task 10: 诊断面板 UI + store + E2E + 真机清单（依赖 1；E2E 验证依赖 9） [visual-engineering]

Wave FINAL（4 路并行审查，全部完成后）:
├── F1: 计划合规审计 [oracle]
├── F2: 代码质量审查 [unspecified-high]
├── F3: 真实 QA 执行 [unspecified-high]
└── F4: 范围保真检查 [deep]
→ 呈现结果 → 用户明确 okay

Critical Path: 1 → 3 → 4 → 9 → 10 → F1-F4
Max Concurrent: 5（Wave 3）
```

### Dependency Matrix（全任务）

| 任务 | 依赖 | 被依赖（blocks） |
|---|---|---|
| 1 | - | 2,3,5,6,7,8,10 |
| 2 | 1 | 5,8 |
| 3 | 1 | 4 |
| 4 | 3 | 9 |
| 5 | 2 | 9 |
| 6 | 1 | 9 |
| 7 | 1 | 9 |
| 8 | 2 | 9 |
| 9 | 4,5,6,7,8 | 10（E2E 部分） |
| 10 | 1（开发），9（E2E 验证） | F |
| F1-F4 | 全部 | - |

### Agent Dispatch Summary

- **Wave 1**: 1 → `unspecified-high`
- **Wave 2**: 2 → `quick`；3 → `unspecified-high`
- **Wave 3**: 4 → `unspecified-high`；5 → `deep`；6 → `unspecified-high`；7 → `unspecified-high`；8 → `quick`
- **Wave 4**: 9 → `deep`；10 → `visual-engineering`
- **FINAL**: F1 → `oracle`；F2 → `unspecified-high`；F3 → `unspecified-high`；F4 → `deep`

---

## TODOs

- [x] 1. 诊断类型契约 + IPC 通道五处联动（4/5 处）

  **What to do**:
  - 新建 `src/main/printing/diagnostics/schema.ts`：
    - `PrintDiagnosticSnapshot`：`printers[]`（name/isDefault/local/network/shared/status{state,detectedError,source}/driver{name,matchesInstalled,printProcessor,manufacturer,rawOnlyBit}/port{name,type,hostAddress,portNumber,snmpEnabled,reachable}/queue{jobCount,errorJobs,deletingJobs,spoolFiles{spl,shd}}/jobs[]{document,owner,statusMask,isOwnedByCurrentUser}）+ `system{spooler{status,startType,dependents}, eventLog{adminEvents[],app1000Events[],operationalEnabled}, printConfigs[]{printerName,paperSize,widthMicrons,heightMicrons,orientation}}` + `app{settings{channel,printerName,templatePaperWidth}, electronVersion, printOptions, templateFacts{hasLogo,logoPx,cssPadding}}` + `renderSnapshot?`（render-check.ts 产出：immediatelyMeasured/afterImgDecode/heightDelta/scrollWidth/paperWidthPx/horizontalOverflow/dpr——规则 12 的消费源；symptom2 fixture 携带此字段）+ `errors{section→message}` + `raw{section→string}`
    - `Finding`：`code`（15 枚举）/`severity`(critical|high|medium|info)/`scope`(machine|printer|appConfig)/`printerName?`/`evidence`（结构化字段路径引用，如 `system.spooler.status='Stopped'`）/`suggestedActions: RepairActionId[]`/`status`(pass|auto-fixed|pending|verify-passed|verify-failed|needs-manual|needs-dev|escalated)
    - `RepairActionId` 枚举：`CANCEL_ERROR_JOBS`(L1) / `SWITCH_TO_DRIVER_CHANNEL`(L1) / `SWITCH_TO_SPOOLER_CHANNEL`(L1，症状 2 反向 workaround) / `PURGE_QUEUE_RESTART_SPOOLER`(L2) / `MIGRATE_WSD_TO_TCP`(L2，重分级后) / `ENABLE_PRINT_LOG`(L2，一次性) / `DISABLE_SNMP`(L4，降级为引导) / 驱动类引导(L4)
    - `RepairAction`：`id`/`level`/`needsElevation`/`requiresConfirm`/`description`(中文人话)/`dryRun`
    - `DiagnosticReport`：`schemaVersion`(const 1)/`collectedAt`(ISO 8601)/`snapshot`/`findings`/`renderSnapshot?`
    - `RULE_DEPENDS_ON: Record<FindingCode, CollectSection[]>`（VERIFY 子集重采的依赖映射，编译期保证）
  - `src/shared/types/ipc.ts`：IpcChannels 增 `printing:diagnose`（req `{printerName?}` / res `{ok, error?, report?}`）、`printing:repair`（req `{actionId, targetPrinter?}` / res `{ok, error?, verify?}`）、`printing:diagnoseExport`（req `{report}` / res `{ok, filePath?, error?}`）+ `IPC_CHANNEL_NAMES` 数组同步
  - `tests/unit/shared/ipc.test.ts`：EXPECTED_CHANNELS 增 3 通道
  - `src/preload/index.ts` + `index.d.ts`：`api.printing.diagnose/repair/exportReport` 三方法（对齐既有 typed invoke 模式）
  - 单测：契约测试更新后全绿

  **Must NOT do**:
  - 不在 `src/main/index.ts` 注册 handler（归任务 9，避免引用未实现模块）
  - 不复制 `printing:testPrint` 的裸字符串豁口——三通道必须全部进 typed 契约
  - schema 字段不得用 `any`；15 个 Finding code 一次定义齐全（后续任务引用）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`——类型契约是全系统地基，字段设计需对照采集矩阵/规则清单/修复目录三方需求，且五处联动易漏
  - **Skills**: []（纯 TS 类型工作，无技能域重叠）

  **Parallelization**:
  - **Can Run In Parallel**: NO（Wave 1 单任务，全部后续任务的地基）
  - **Parallel Group**: Wave 1
  - **Blocks**: 2, 3, 5, 6, 7, 8, 10
  - **Blocked By**: None

  **References**:
  - `src/shared/types/ipc.ts:36-206`——IpcChannels 表 + IPC_CHANNEL_NAMES 的登记模式（两处都要改，有 EXPECTED_CHANNELS 单测防漏）
  - `src/main/ipc/printing.ipc.ts:264`——`{ ok, error }` 信封形状（诊断动作通道对齐此模式）
  - `src/preload/index.ts:46-263`——preload typed API 的组织方式（printing 命名空间下加三方法）+ `index.d.ts` 双声明
  - `src/shared/types/domain.ts:307-320`——AppSettings/PrinterChannel 现有类型（snapshot.app.settings 复用）
  - `src/main/printing/channels/driver.channel.ts:41-53`——PAPER_WIDTH_MICRONS/HEIGHT_SAFETY_PAD 常量（printOptions 快照字段命名参考）
  - **WHY**: 五处联动是 Metis 确认的仓库硬约束（有契约漂移先例）；schema 字段名必须与任务 3 PS 脚本输出 JSON、任务 5 规则引擎消费、任务 8 报告渲染三方对齐——本任务是它们的唯一契约源

  **Acceptance Criteria**:
  - [ ] `npm run typecheck` 全绿
  - [ ] `npm test -- tests/unit/shared/ipc.test.ts` 通过（EXPECTED_CHANNELS 含 3 新通道）
  - [ ] `schema.ts` 导出 RULE_DEPENDS_ON 覆盖全部 15 个 Finding code（单测断言键集合相等）

  **QA Scenarios**:
  ```
  Scenario: 契约登记完整性
    Tool: Bash
    Steps:
      1. grep -c "printing:diagnose\|printing:repair\|printing:diagnoseExport" src/shared/types/ipc.ts
         # Expected: ≥6（IpcChannels 3 处类型 + IPC_CHANNEL_NAMES 3 处字面量）
      2. npm test -- tests/unit/shared/ipc.test.ts
         # Expected: 0 failed；输出含 3 新通道名
      3. npx tsc --noEmit -p tsconfig.node.json --composite false && npx vue-tsc --noEmit -p tsconfig.web.json --composite false
         # Expected: 双侧 0 error
    Expected Result: 三通道在类型层/常量层/测试层一致登记，preload 类型可用
    Failure Indicators: EXPECTED_CHANNELS 断言失败；preload index.d.ts 与 index.ts 声明不一致导致 web typecheck 报错
    Evidence: .omo/evidence/task-1-contract-check.txt（命令输出）

  Scenario: 防豁口回归（负面）
    Tool: Bash
    Steps:
      1. grep -rn "ipcRenderer.invoke('printing:diagnose'" src/preload/
         # Expected: 匹配且该调用走 createTypedInvoke/typed 契约（非裸字符串拼接通道名）
      2. grep -c "printing:testPrint" src/shared/types/ipc.ts
         # Expected: 0 或已有豁口不新增（新通道零裸字符串）
    Expected Result: 新通道无裸字符串豁口
    Evidence: .omo/evidence/task-1-no-raw-string.txt
  ```

  **Commit**: YES（独立提交）
  - Message: `feat(diagnosis): 诊断类型契约与 IPC 通道登记`
  - Files: `src/main/printing/diagnostics/schema.ts`, `src/shared/types/ipc.ts`, `tests/unit/shared/ipc.test.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`
  - Pre-commit: `npm run typecheck && npm test -- tests/unit/shared/ipc.test.ts`

- [x] 2. 黄金样本 fixtures（7 组）

  **What to do**:
  - 新建 `tests/unit/printing/diagnostics/fixtures/`：
    - `symptom1-driver-raw-garbled.json`：DriverName=厂商热敏驱动、RAW_ONLY 位=0、PrintProcessor=WINPRINT、中文打印机名（测编码链路）
    - `symptom1-cloud-utf8.json`：DriverName/Manufacturer 含"得力 DL-5801PW"、PrintProcessor=厂商自定义、RAW_ONLY=0、spooler 正常
    - `symptom2-driver-layout.json`：printConfigs 驱动纸张=A4（widthMicrons≈210000）≠ app 模板 80mm、renderSnapshot 含 immediatelyMeasured=1842px / afterImgDecode=2107px（Δ265）、scrollWidth 恰好等于纸宽（无水平溢出）
    - `spooler-dead.json`：system.spooler.status='Stopped'、errors 含 Get-Printer RPC 失败、jobs 含多条 error 任务（测抑制）
    - `log-disabled.json`：eventLog.operationalEnabled=false、adminEvents 空、其余健康（测"缺遥测不误报 pass"）
    - `printer-name-mismatch.json`：app.settings.printerName='POS-80'、printers[] 仅含 'POS-80 (副本 2)'
    - `healthy-machine.json`：全绿基线（含 1 台 RAW_ONLY=1 的 Generic/Text Only）
    - `index.ts`：导出 7 组 `as PrintDiagnosticSnapshot`（类型守卫即验收）
  - 单测 `fixtures.test.ts`：每组断言关键特征字段存在且形状合法（防 JSON 拼写漂移）

  **Must NOT do**:
  - fixture 内容不得偏离 schema 字段名（靠 `as PrintDiagnosticSnapshot` 编译期锁定）
  - 不在 fixtures 里预写 findings/期望结论——期望断言写在任务 5 的表驱动测试里（fixtures 只是输入）

  **Recommended Agent Profile**:
  - **Category**: `quick`——schema 已定后的结构化 JSON 编写，模式明确
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（与任务 3 同 Wave 2）
  - **Parallel Group**: Wave 2（with Task 3）
  - **Blocks**: 5, 8
  - **Blocked By**: 1

  **References**:
  - `src/main/printing/diagnostics/schema.ts`（任务 1 产物）——字段唯一契约源
  - `tests/unit/printing/channels/spooler.channel.test.ts`——仓库测试组织惯例（describe/it 中文描述）
  - `docs/windows-manual-checklist.md:56-70`——症状 1 两场景的领域描述（fixture 语义来源：乱码→Generic/Text Only、云机→driver 通道）
  - `src/main/printing/channels/driver.channel.ts:7-14`——DL-5801PW 云固件行为描述（symptom1-cloud-utf8 的证据字段依据）
  - **WHY**: 7 组 fixtures 是任务 5 规则引擎与任务 8 报告 golden 快照的共同输入；症状数据必须与真机表现一致（RAW_ONLY 位值、PrintProcessor 区分、A4 纸宽微米值、Δ高度数值都是规则判定的直接原料）

  **Acceptance Criteria**:
  - [ ] `npm test -- tests/unit/printing/diagnostics/fixtures.test.ts` 通过
  - [ ] 7 组 fixture 全部通过 `PrintDiagnosticSnapshot` 类型检查（vitest 运行即证明）

  **QA Scenarios**:
  ```
  Scenario: fixtures 类型安全与特征完备
    Tool: Bash
    Steps:
      1. npm test -- tests/unit/printing/diagnostics/fixtures.test.ts
         # Expected: 7 组全部断言通过（含各 fixture 特征字段存在性）
      2. npx tsc --noEmit -p tsconfig.node.json --composite false
         # Expected: fixtures 的 as 断言无类型错误
    Expected Result: 7 组输入数据可被后续任务直接消费
    Failure Indicators: 字段名拼写漂移导致 as 断言失败；特征字段缺失
    Evidence: .omo/evidence/task-2-fixtures-check.txt

  Scenario: 症状复刻保真（负面防退化）
    Tool: Bash
    Steps:
      1. grep -c "DL-5801PW" tests/unit/printing/diagnostics/fixtures/symptom1-cloud-utf8.json
         # Expected: ≥1
      2. grep -c "2107" tests/unit/printing/diagnostics/fixtures/symptom2-driver-layout.json
         # Expected: ≥1（afterImgDecode 值）
      3. grep -c "副本 2" tests/unit/printing/diagnostics/fixtures/printer-name-mismatch.json
         # Expected: ≥1
    Expected Result: 两台真实故障机症状特征字段全部落位
    Evidence: .omo/evidence/task-2-symptom-fidelity.txt
  ```

  **Commit**: YES（groups with 无，独立提交）
  - Message: `feat(diagnosis): 7 组黄金样本 fixtures`
  - Files: `tests/unit/printing/diagnostics/fixtures/`
  - Pre-commit: `npm test -- tests/unit/printing/diagnostics/fixtures.test.ts`

- [x] 3. 采集 PowerShell 脚本构建器（collect-script.ts）

  **What to do**:
  - 新建 `src/main/printing/diagnostics/collect-script.ts`：纯函数 `buildCollectScript(): string` 返回固定 PS 5.1 脚本文本（零 I/O、零参数拼接——内容完全静态）
  - 脚本结构（顺序执行 10 段，每段独立 try/catch，输出累积进 `$out` 哈希）：
    - 第 0 行（任何输出前）：`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)` + `$ErrorActionPreference='Continue'`
    - (a) `Get-Printer | Select Name,DriverName,PortName,PrinterStatus,Type,Shared,Published`
    - (b) `Get-CimInstance Win32_Printer | Select Name,WorkOffline,ExtendedDetectedErrorState,ExtendedPrinterStatus,Attributes,Local,Network,Default,PortName,DriverName,PrintProcessor,Manufacturer`
    - (c) `Get-CimInstance Win32_PrintJob | Select Name,Document,JobStatus,Owner,JobId,Size,TimeSubmitted,StatusMask`
    - (d) `Get-PrinterPort | Select Name,Description,PrinterHostAddress,PortNumber,Protocol,SNMPEnabled`
    - (e) `Get-PrinterDriver | Select Name,Manufacturer,DriverVersion,DriverDate,ConfigFile`
    - (f) `Get-Service Spooler`（含 `DependentServices` 展开）+ `StartType`
    - (g) 注册表读 `HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers` 的 `DefaultSpoolDirectory` → `Get-ChildItem -Force` 按 `.SPL/.SHD` 分组计数（目录读不到 → error section）
    - (h) `Get-WinEvent` PrintService/Admin 近 7 天（Id 99/307/1/22/23/237/368，`-MaxEvents 50`，`-EA SilentlyContinue`）+ `Get-WinEvent -ListLog` 检测 Operational `IsEnabled`（**不读 Operational 内容**，禁用态只标记）+ Application log `Application Error` Id 1000（faulting module 字段，`-MaxEvents 20`）
    - (i) 对 (d) 中每个 `IP_*` 端口：`New-Object Net.Sockets.TcpClient` 连 9100/515，3s 超时（`Task.Delay(3000)` + `WaitAny`），结果进 ports 数组
    - (j) `Get-PrintConfiguration | Select PrinterName,PaperSize,Width,Length,DuplexingUnits,Orientation`（每台打印机一条）
    - 尾部：`$out | ConvertTo-Json -Depth 6 -Compress` 输出 stdout + **`exit 0` 永远**（部分失败记 section error，不变成 exit code）
  - 单测 `collect-script.test.ts`（结构断言，不执行）：
    - 首行含 OutputEncoding；含全部 10 段标记（段注释 `# section: printers` 等）
    - try/catch 计数 ≥10；结尾 `exit 0` + `ConvertTo-Json`
    - PS 5.1 语法约束：无 `??`、无 `? :` 三元（正则断言）
    - JSON 字段名与 schema.ts 对齐（抽查 printers/jobs/ports 核心字段名出现在 Select 表达式）

  **Must NOT do**:
  - 不用 `Get-WmiObject`（PS7 已移除）；不用 `??`/三元（PS 5.1 不支持）
  - 不读 PrintService/Operational 内容（默认禁用，只检测 IsEnabled）
  - 脚本内不拼接任何运行时参数（打印机名等）——完全静态，落盘后内容可哈希
  - 不含任何 `Remove-`/`Stop-`/写操作命令——采集零副作用

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`——Windows 域知识密集（WMI/CIM 类字段、事件日志通道、注册表路径），编码 guardrail 细节多
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（与任务 2 同 Wave 2）
  - **Parallel Group**: Wave 2（with Task 2）
  - **Blocks**: 4
  - **Blocked By**: 1

  **References**:
  - `src/main/printing/channels/spooler.channel.ts:56-166`——内联 PS 脚本的仓库模式（here-string + Add-Type + exit code 契约）；`escapePowerShellSingleQuoted` 不需要（本脚本无参数注入）
  - `.omo/notepads/pos-electron-app/learnings.md:136-152`——PS 真机坑（here-string `'@` 顶行、冷编译、32K 限制→本设计用 -File 落盘规避）
  - `src/main/printing/diagnostics/schema.ts`（任务 1）——JSON 字段名契约
  - 外部（已在研究档案）：Win32_PrintJob StatusMask 位图（bit2=Error、bit4=Deleting）、Win32_Printer Attributes（RAW_ONLY=4096、WORK_OFFLINE=1024）、PrintService/Admin Id 99 与 Application 1000 语义
  - **WHY**: 编码四坑（GBK stdout/BOM/chcp/maxBuffer）与"exit 0 + section errors"契约是 Metis 发现 C 的直接防线；字段名与 schema 对齐是 fixtures/analyze 可消费的前提

  **Acceptance Criteria**:
  - [ ] `npm test -- tests/unit/printing/diagnostics/collect-script.test.ts` 通过
  - [ ] 断言覆盖：OutputEncoding 首行 / 10 段标记 / try-catch≥10 / exit 0 / 无 PS7 语法 / 核心字段名与 schema 对齐

  **QA Scenarios**:
  ```
  Scenario: 脚本结构安全断言
    Tool: Bash
    Steps:
      1. npm test -- tests/unit/printing/diagnostics/collect-script.test.ts
         # Expected: 全部结构断言通过
      2. node -e "const s=require('./out/...')" 或 vitest 内直接 import buildCollectScript
         # 断言脚本文本不含: 'Remove-Printer', 'Stop-Service', 'net stop', 'Set-PrinterPort', '??'
    Expected Result: 零副作用 + PS 5.1 兼容 + 编码契约落位
    Failure Indicators: 断言失败（缺段/含写操作/含 PS7 语法）
    Evidence: .omo/evidence/task-3-script-assertions.txt

  Scenario: 字段名契约对齐（负面）
    Tool: Bash
    Steps:
      1. 从 buildCollectScript() 输出提取 Select 字段名（正则）
      2. 与 schema.ts 的 snapshot 字段对照（printers/driver/port/queue 关键 15 字段）
         # Expected: 全部对齐（拼写一致）
    Expected Result: PS 输出 JSON 可直接反序列化为 snapshot.printers 等节
    Evidence: .omo/evidence/task-3-field-alignment.txt
  ```

  **Commit**: YES
  - Message: `feat(diagnosis): 采集 PowerShell 脚本构建器（编码安全 + 段隔离）`
  - Files: `src/main/printing/diagnostics/collect-script.ts`, `tests/unit/printing/diagnostics/collect-script.test.ts`
  - Pre-commit: `npm test -- tests/unit/printing/diagnostics/collect-script.test.ts`

- [x] 4. 采集执行器（collect.runner.ts）

  **What to do**:
  - 新建 `src/main/printing/diagnostics/collect.runner.ts`：
    - `runCollect(options?: { execFileFn?, platform?, userDataDir? })`：
      1. platform 守卫：非 win32 → reject 中文明确错误（对齐 spooler.channel.ts:185-192 的 G11 模式 A）
      2. 落盘 `<userDataDir>/diagnostics/collect.ps1`（UTF-8 **BOM**：`Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]), Buffer.from(script,'utf8')])`；目录递归创建；内容固定可哈希——每次覆盖写，幂等）
      3. `execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ps1Path], { windowsHide: true, timeout: 30000, maxBuffer: 4*1024*1024, encoding: 'utf8' })`
      4. stdout `JSON.parse` → 逐 section 归一化（脏数据防御，对齐 printer-enumerator 的 normalize 模式）；section error 转入 `snapshot.errors`
      5. 合成 app 侧快照：settings（注入的 getter）、`process.versions.electron`、driver 通道 printOptions 常量、模板要素（logo 有无/px、cssPadding）——由 `AppInfoProvider` 注入（DI，单测 fake）
  - 单测 `collect.runner.test.ts`（fake execFile，照 spooler.channel.test.ts:18-37 的 makeFakeExecFile 模式）：
    - 成功：返回完整 snapshot；落盘文件字节级断言（前 3 字节 = EF BB BF + 首行 OutputEncoding）
    - 部分失败：stdout 含 section error → snapshot.errors 记录、其余 section 正常、**不 throw**
    - 超时：fake 永不回调 → 30s 预算内 reject 超时错误（fake 时间断言）
    - 非 win32：platform:'linux' 注入 → reject 明确错误
    - stdout 非 JSON：reject 可诊断错误（含前 100 字符预览）

  **Must NOT do**:
  - 不用 `exec`/shell 拼接（只 execFile + 参数数组）
  - maxBuffer 不得用默认 1MB（Metis 发现 C）
  - 落盘不得漏 BOM（PS 5.1 中文脚本无 BOM 会解析期损坏）
  - 不捕获后吞错——所有失败路径 reject 中文可诊断错误（含 section 名/exit code/stderr 摘要）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`——编码链路与错误路径是安全关键，fake 注入点多
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（Wave 3 内与 5/6/7/8 并行）
  - **Parallel Group**: Wave 3
  - **Blocks**: 9
  - **Blocked By**: 3

  **References**:
  - `src/main/printing/channels/spooler.channel.ts:19-33, 180-222`——ExecFileFn 类型注入 + defaultExecFile + sendRawToPrinter 的平台守卫/错误上抛模式（本任务照抄骨架）
  - `tests/unit/printing/channels/spooler.channel.test.ts:18-37`——makeFakeExecFile 模板（fake 的 error/stdout/stderr 回调形状）
  - `src/main/printing/channels/printer-enumerator.ts:25-35`——脏数据防御归一模式（normalizePrinter：逐字段 typeof 检查后取舍）
  - `src/main/printing/diagnostics/collect-script.ts`（任务 3）——被落盘的脚本文本
  - **WHY**: BOM/maxBuffer/timeout 三项是 Metis 编码发现的核心防线；exit 0 + section errors 契约让"部分失败"变成数据而非异常——这是 spooler 死机时采集仍能返回 spooler-stopped finding 的前提

  **Acceptance Criteria**:
  - [ ] `npm test -- tests/unit/printing/diagnostics/collect.runner.test.ts` 通过（5 条路径：成功/部分失败/超时/非 win32/非 JSON）
  - [ ] 落盘文件 BOM 字节断言与 OutputEncoding 行断言在测试内通过

  **QA Scenarios**:
  ```
  Scenario: 采集成功路径（fake）
    Tool: Bash
    Steps:
      1. npm test -- tests/unit/printing/diagnostics/collect.runner.test.ts -t "成功"
         # Expected: snapshot 各 section 解析成功；落盘 .ps1 前 3 字节 EF BB BF
    Expected Result: 完整 snapshot + BOM 落盘
    Evidence: .omo/evidence/task-4-runner-success.txt

  Scenario: spooler 死机不拖垮采集（负面——部分失败）
    Tool: Bash
    Steps:
      1. fake execFile 返回 stdout：{"printers":{"error":"RPC 服务器不可用"},"system":{...正常...}}
      2. 断言：不 throw；snapshot.errors.printers 存在；snapshot.system.spooler.status='Stopped'
         # 规则引擎后续可判 spooler-stopped（RPC 失败本身是 evidence）
    Expected Result: 部分失败 → 结构化 errors + 其余数据完整
    Failure Indicators: 任何 section error 导致整体 reject（违反 exit 0 契约）
    Evidence: .omo/evidence/task-4-partial-failure.txt

  Scenario: 编码与超时防线（负面）
    Tool: Bash
    Steps:
      1. 断言 execFile 调用参数含 maxBuffer ≥ 4194304 且 timeout ≤ 30000（fake 捕获 options）
      2. fake 挂起不回调 → 断言 30s 内 reject（vitest fake timers）
      3. platform 注入 'linux' → 断言 reject 消息含 "仅 Windows"
    Expected Result: 三条防线全部生效
    Evidence: .omo/evidence/task-4-guardrails.txt
  ```

  **Commit**: YES
  - Message: `feat(diagnosis): 采集执行器（BOM 落盘 + maxBuffer + 超时预算）`
  - Files: `src/main/printing/diagnostics/collect.runner.ts`, `tests/unit/printing/diagnostics/collect.runner.test.ts`
  - Pre-commit: `npm test -- tests/unit/printing/diagnostics/collect.runner.test.ts`

- [x] 5. 规则引擎（analyze.ts，15 条规则）

  **What to do**:
  - 新建 `src/main/printing/diagnostics/analyze.ts`：纯函数 `analyzeSnapshot(snapshot: PrintDiagnosticSnapshot): Finding[]`（零 I/O）
  - 15 条规则（每条 = 一个 `(snapshot) => Finding | null` 谓词，输出含 code/severity/scope/evidence（结构化字段路径+值）/suggestedActions）：
    1. `spooler-stopped`（critical/machine）：system.spooler.status ≠ 'Running'（evidence 引 RPC error 如有）
    2. `jobs-stuck-error`（high/printer）：jobs 含 StatusMask bit2 且 isOwnedByCurrentUser=true → CANCEL_ERROR_JOBS；含他人 error 任务 → 建议升级 L2
    3. `jobs-stuck-deleting`（high/printer）：StatusMask bit4 或 spoolFiles.shd > 0 → PURGE_QUEUE_RESTART_SPOOLER
    4. `port-wsd-instability`（medium/printer）：port.name 前缀 WSD- 且 printer offline → MIGRATE_WSD_TO_TCP（L2）
    5. `snmp-false-offline`（medium/printer）：port TCP 9100 reachable=true + 状态 offline + snmpEnabled=true → DISABLE_SNMP（L4 引导，重分级后）
    6. `driver-missing`（high/printer）：printer.driverName ∉ drivers 清单 → L4 引导
    7. `driver-crash-loop`（high/machine）：app1000Events 中 faulting application ∈ {spoolsv, printisolationhost, splwow64} 且 faulting module ∈ 某 driver 的 ConfigFile/依赖 → L4 引导（PaperCut 归因法）
    8. `raw-garbled-risk`（medium/printer）：driver 非 Generic/Text Only 且 Attributes RAW_ONLY 位=0 且 PrintProcessor=WINPRINT → L4 引导（装 Generic/Text Only）
    9. `cloud-printer-raw-utf8`（high/printer）：`CLOUD_PRINTER_MODELS` 名单匹配（Manufacturer/DriverName 含"DL-5801PW"等）或 PrintProcessor ≠ WINPRINT 且厂商云机特征 → SWITCH_TO_DRIVER_CHANNEL
    10. `driver-page-size-ignored`（high/printer）：app.settings.channel='driver' 且 printConfigs 驱动纸张 ≠ 模板纸宽（微米级对比，容差 1mm）→ needs-dev + SWITCH_TO_SPOOLER_CHANNEL 建议
    11. `printable-area-clip`（medium/printer）：驱动可打印宽 < 请求页宽（若可得）→ needs-dev
    12. `logo-measurement-race`（high/appConfig）：renderSnapshot.afterImgDecode - immediatelyMeasured > 50px → needs-dev（evidence 含两个测量值）
    13. `printer-offline-flag`（medium/printer）：Attributes WORK_OFFLINE(1024) 位=1 → 引导取消"脱机使用打印机"
    14. `queue-paused`（medium/printer）：PrinterStatus/JobStatus 含 paused → 引导恢复
    15. `printer-name-mismatch`（high/appConfig）：app.settings.printerName ∉ printers[].name → 引导重选（evidence 列出系统侧近似名）
  - `CLOUD_PRINTER_MODELS: readonly string[]`（const，首批 `['DL-5801PW']`，匹配 DriverName/Manufacturer 子串）
  - **抑制逻辑**（precedence）：spooler-stopped 命中时抑制 2/3（派生症状）；每规则先查 `suppressedBy`
  - **空遥测守卫**：规则 7 在 eventLog 空且 operationalEnabled=false 时返回 null（**绝不**因缺数据判 pass 或告警）——输出"遥测不可用"info 级 finding 一次
  - 表驱动单测 `analyze.test.ts`：7 组 fixtures → 断言每组 findings codes 集合 + 关键 suggestedActions + 抑制行为（spooler-dead fixture 断言无 jobs-stuck）+ 每规则至少 1 正 1 负样本

  **Must NOT do**:
  - 不解析任何本地化消息文本（只消费 StatusMask/Attributes 位、枚举值、数值）
  - 规则不得有副作用（纯函数）；不修改 snapshot
  - 缺数据不得产出 pass 类结论

  **Recommended Agent Profile**:
  - **Category**: `deep`——15 条规则逻辑密集且互相有抑制关系，evidence 链要求精确到字段路径，表驱动断言量大
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（Wave 3 内）
  - **Parallel Group**: Wave 3
  - **Blocks**: 9
  - **Blocked By**: 2（fixtures）

  **References**:
  - `tests/unit/printing/diagnostics/fixtures/`（任务 2）——表驱动输入
  - `src/main/printing/diagnostics/schema.ts`（任务 1）——RULE_DEPENDS_ON 与 Finding 类型
  - 外部研究档案（已在 Context 记录）：StatusMask 位图（bit2 Error/bit4 Deleting/bit32 Offline）、Attributes（RAW_ONLY 4096/WORK_OFFLINE 1024）、PaperCut faulting-module 归因法
  - `docs/windows-manual-checklist.md:56-70`——规则 8/9 的领域语义来源（乱码/云机两条修复路径）
  - **WHY**: 抑制关系与空遥测守卫是 Metis 指令的核心正确性属性；两台真实故障机必须被 7 fixtures 精确命中（这是整个子系统存在的理由）

  **Acceptance Criteria**:
  - [ ] `npm test -- tests/unit/printing/diagnostics/analyze.test.ts` 通过
  - [ ] 表驱动断言：symptom1-driver-raw-garbled → 含 raw-garbled-risk；symptom1-cloud-utf8 → 含 cloud-printer-raw-utf8 且建议 SWITCH_TO_DRIVER_CHANNEL；symptom2 → 含 driver-page-size-ignored + logo-measurement-race；spooler-dead → 含 spooler-stopped 且**不含** jobs-stuck-*；log-disabled → 无 crash-loop 类误报；name-mismatch → 命中规则 15；healthy → findings 为空或仅 info

  **QA Scenarios**:
  ```
  Scenario: 两台真实故障机症状命中（验收核心）
    Tool: Bash
    Steps:
      1. npm test -- tests/unit/printing/diagnostics/analyze.test.ts
         # Expected: 7 组 fixtures 断言全绿（含上述精确 code/动作断言）
    Expected Result: 症状 1 两变体 + 症状 2 双规则全部命中
    Failure Indicators: 任一 fixture 期望 code 缺失或多余（抑制失败=多余）
    Evidence: .omo/evidence/task-5-rules-tabledriven.txt

  Scenario: 空遥测不误报（负面）
    Tool: Bash
    Steps:
      1. 以 log-disabled fixture 运行 analyzeSnapshot
      2. 断言：findings 不含 driver-crash-loop；不含任何 severity=pass 性质的"健康"结论
         # Expected: 最多一条 info 级"事件遥测不可用"
    Expected Result: 缺数据 = 无结论，而非健康结论
    Evidence: .omo/evidence/task-5-no-telemetry.txt
  ```

  **Commit**: YES
  - Message: `feat(diagnosis): 规则引擎 15 条规则 + 云打印机名单`
  - Files: `src/main/printing/diagnostics/analyze.ts`, `tests/unit/printing/diagnostics/analyze.test.ts`
  - Pre-commit: `npm test -- tests/unit/printing/diagnostics/analyze.test.ts`

- [x] 6. 修复动作构建器与执行器（repair-script.ts + repair.runner.ts）

  **What to do**:
  - 新建 `src/main/printing/diagnostics/repair-script.ts`：纯函数命令/脚本构建（不执行）：
    - `buildCancelErrorJobsCommand(printerName)`（L1）：`Get-PrintJob -PrinterName X | Where-Object {$_.JobStatus -like '*Error*'} | Remove-PrintJob`（**本人任务**过滤由 runner 侧传入 owner 条件或脚本内 `$env:USERNAME` 对比 Owner）
    - `buildPurgeQueueScript()`（L2）：金标准序列——`#Requires -RunAsAdministrator` 自检 + 依赖服务记录 + 注册表读 spool 目录 + `Stop-Service -Force` + `WaitForStatus('Stopped',30s)` + 停后重读目录删除 + `finally` 无条件 `Start-Service` + 恢复依赖服务 + 年龄过滤参数（`-OlderThanMinutes`）+ 结果写 result-file（JSON：删除文件数/各步耗时/失败文件列表）+ 显式 `exit 0/2/3`（0 成功/2 停服务失败/3 删文件部分失败）
    - `buildWsdMigrateCommands(printerName, hostAddress)`（L2）：Add-PrinterPort + Set-Printer -PortName + **保留旧 WSD 端口不删**（回滚路径）+ 测试页验证提示
    - `buildEnablePrintLogCommand()`（L2，一次性）：`wevtutil sl Microsoft-Windows-PrintService/Operational /e:true`
    - `buildRepairActionCatalog(): RepairAction[]`：L1-L4 目录（含 dryRun 标记、requiresConfirm、needsElevation、中文 description）
  - 新建 `src/main/printing/diagnostics/repair.runner.ts`：
    - `runRepairAction(actionId, ctx)`：L1 直执行（execFile，execFileFn 注入）；L2 经 `powershell.exe -Command "Start-Process powershell -Verb RunAs -ArgumentList '-File <script>' -Wait -PassThru"` + 读 result-file + exit code 映射；**UAC 拒绝**：catch Win32Exception `NativeErrorCode===1223` → 返回 needs-manual Finding 状态（非 failed）；dry-run 模式（输出命令文本不执行）
    - `SWITCH_TO_DRIVER_CHANNEL` / `SWITCH_TO_SPOOLER_CHANNEL`：不走 PS——调注入的 settings 写入（DI，改 settings.printer_channel）
  - 单测 `repair.test.ts`（spec 断言不执行 + fake 路径）：
    - purge 脚本 5 护栏断言（WaitForStatus/finally Start-Service/重读目录/依赖恢复/年龄过滤各一条）
    - UAC 拒绝：fake execFile 抛含 1223 的错误 → needs-manual 返回、无 throw
    - result-file 契约：exit code 2 → 中文错误含 result-file 路径
    - WSD 迁移：断言命令含 Add-PrinterPort 且**不含** Remove-PrinterPort（保留旧端口）
    - 通道切换：fake settings 写入断言 printer_channel 变更

  **Must NOT do**:
  - 不使用 `Set-PrinterPort`（不存在的命令——Must NOT 顶层条款）
  - L1 不得删非本人任务（脚本内 owner 过滤必须有）
  - purge 序列不得在无 `finally Start-Service` 结构下输出
  - 提权脚本不得依赖 stdout 回传（-Verb RunAs 与重定向互斥）——只走 exit code + result-file
  - 不做驱动安装/删除的执行代码（L4 仅目录描述与引导文案）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`——Windows 服务操作与 UAC 链是系统安全关键，guardrail 密集
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（Wave 3 内）
  - **Parallel Group**: Wave 3
  - **Blocks**: 9
  - **Blocked By**: 1

  **References**:
  - `src/main/printing/channels/spooler.channel.ts:134-166`——buildXxxCommand 纯函数 + spec 形状（file/args）模式，本任务照抄
  - `src/main/printing/channels/spooler.channel.ts:180-222`——执行器骨架（platform 守卫/execFileFn 注入/错误上抛）
  - `src/main/db/repositories/settings.repo.ts`——settings 写入（SWITCH_* 动作的 DI 目标；注意 learnings.md:527 的 AppSettings null 归一陷阱）
  - 外部研究档案：net stop 同步/sc 竞态/Restart-Service 幂等；MS-PRSOD 跨用户任务限制；-Verb RunAs 与 -RedirectStandardOutput 互斥；1223=ERROR_CANCELLED
  - **WHY**: 5 护栏与 UAC 契约直接来自 Metis 发现（A）与外部研究的生产脚本提炼；WSD 保留旧端口是回滚安全线

  **Acceptance Criteria**:
  - [ ] `npm test -- tests/unit/printing/diagnostics/repair.test.ts` 通过
  - [ ] 断言覆盖：5 护栏 / UAC 1223→needs-manual / result-file / WSD 不删旧端口 / 通道切换 fake

  **QA Scenarios**:
  ```
  Scenario: L1 本人任务过滤（安全核心）
    Tool: Bash
    Steps:
      1. 断言 buildCancelErrorJobsCommand 输出含 Owner 与当前用户比对条件（或 runner 侧过滤逻辑的单测）
      2. fake jobs：本人 error 任务 ×1 + 他人 error 任务 ×1 → 断言仅本人任务进删除命令
    Expected Result: 跨用户任务不进 L1（升 L2 由编排层处理）
    Evidence: .omo/evidence/task-6-own-jobs-only.txt

  Scenario: UAC 拒绝优雅降级（负面）
    Tool: Bash
    Steps:
      1. fake execFile 抛 Error 且附加 NativeErrorCode=1223
      2. runRepairAction(PURGE_QUEUE_RESTART_SPOOLER)
         # Expected: 返回 {status:'needs-manual'}；不 throw；错误消息含"已取消授权"类中文引导
    Expected Result: UAC 拒绝 = 需人工，非失败，UI 不挂起
    Failure Indicators: 抛异常或返回 failed（违反 needs-manual 契约）
    Evidence: .omo/evidence/task-6-uac-declined.txt

  Scenario: purge 金标准护栏完整
    Tool: Bash
    Steps:
      1. 提取 buildPurgeQueueScript() 文本
      2. 逐条断言：WaitForStatus / finally.*Start-Service / 注册表 DefaultSpoolDirectory / DependentServices 恢复 / OlderThanMinutes 参数
    Expected Result: 5 护栏全部在脚本结构中
    Evidence: .omo/evidence/task-6-purge-guardrails.txt
  ```

  **Commit**: YES
  - Message: `feat(diagnosis): 修复动作构建与执行器（L1/L2 + UAC 链 + result-file 契约）`
  - Files: `src/main/printing/diagnostics/repair-script.ts`, `src/main/printing/diagnostics/repair.runner.ts`, `tests/unit/printing/diagnostics/repair.test.ts`
  - Pre-commit: `npm test -- tests/unit/printing/diagnostics/repair.test.ts`

- [x] 7. 渲染自检（render-check.ts）

  **What to do**:
  - 新建 `src/main/printing/diagnostics/render-check.ts`：
    - `runRenderCheck(template, data, vars, logoBuffers, createWindowFn?)`：复用 `generateReceiptHtml`（driver/receipt-html.ts）生成收据 HTML → 隐藏窗口（`show:false`，DI 窗口工厂对齐 driver.channel.ts 的 DriverPrintWindow 模式）加载 data: URL → **两次测量**：
      1. 立即测：`executeJavaScript('JSON.stringify({h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth,imgH:(()=>{const i=document.querySelector("img.receipt-logo");return i?i.getBoundingClientRect().height:0})()})')`
      2. 等待 logo 解码后测：`await new Promise(r=>{const i=document.querySelector('img.receipt-logo'); i?i.decode().finally(r):r()})` 后再测 scrollHeight
    - 产出 `RenderSnapshot`：`{immediatelyMeasured, afterImgDecode, heightDelta, scrollWidth, paperWidthPx, horizontalOverflow: boolean, dpr}`（dpr 归一：`window.devicePixelRatio` 记录，测量值标注原始 px）
    - finally destroy 窗口 + 15s 超时（settle 先到者胜，对齐 driver.channel.ts:98-117 模式）
    - `hasLogo=false` 时跳过第二次测量（heightDelta=0）
  - 单测 `render-check.test.ts`（fake 窗口工厂，模式照 driver.channel 的测试注入）：
    - 两次测量返回不同值（1842/2107）→ RenderSnapshot.heightDelta=265
    - fake img.decode 挂起 → 15s 超时路径
    - 无 logo → 单次测量
    - scrollWidth > paperWidthPx → horizontalOverflow=true

  **Must NOT do**:
  - 窗口不得 show；不得干扰打印串行队列（纯只读测量）
  - 不修改 driver.channel.ts 的生产打印路径（本模块只读复用 generateReceiptHtml）
  - 测量不得依赖 CSS zoom/transform 的视觉值（getBoundingClientRect 的 transform 后值与布局值都要记录时，标注清楚哪个是判据——判据用布局值 scrollHeight）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`——Electron 窗口生命周期 + 测量时序语义（decode() 异步）需精确
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（Wave 3 内）
  - **Parallel Group**: Wave 3
  - **Blocks**: 9
  - **Blocked By**: 1

  **References**:
  - `src/main/printing/channels/driver.channel.ts:27-73`——DriverPrintWindow 最小接口 + 默认窗口工厂（懒 require electron）+ DI 注入模式——本任务直接复用同构接口
  - `src/main/printing/channels/driver.channel.ts:119-183`——loadURL→executeJavaScript→settle/timeout/finally destroy 全流程骨架（本任务镜像）
  - `src/main/printing/driver/receipt-html.ts:279-318`——generateReceiptHtml 签名（template/data/vars/logoBuffers 四参）与 data-paper-width 机制
  - `src/main/printing/driver/receipt-html.ts:130-132`——logo base64 img + max-width 逻辑（测量对象）
  - **WHY**: 症状 2 的 logo-measurement-race 规则（任务 5 规则 12）的 evidence 直接来自本模块的 heightDelta——两次测量差是定位"内容消失"bug 的决定性数据；复用同构窗口接口保证测试注入一致性

  **Acceptance Criteria**:
  - [ ] `npm test -- tests/unit/printing/diagnostics/render-check.test.ts` 通过（4 条路径）
  - [ ] fake 注入零 Electron 依赖（vitest 纯 Node 跑通即证明）

  **QA Scenarios**:
  ```
  Scenario: logo 时序差测量（症状 2 核心 evidence）
    Tool: Bash
    Steps:
      1. fake 窗口：第一次 executeJavaScript 返回 {h:1842,w:307,imgH:0}；
         decode 完成后第二次返回 {h:2107,...}
      2. runRenderCheck(...) → 断言 RenderSnapshot = {immediatelyMeasured:1842, afterImgDecode:2107, heightDelta:265}
    Expected Result: Δ 高度被精确捕获（fixture symptom2 的数据来源即此）
    Evidence: .omo/evidence/task-7-logo-race.txt

  Scenario: decode 挂起超时（负面）
    Tool: Bash
    Steps:
      1. fake img.decode 永不 resolve → 断言 15s 内 settle（vitest fake timers）
         # Expected: 返回部分 RenderSnapshot（immediatelyMeasured 有值，afterImgDecode 标 timeout）而非挂死
    Expected Result: 自检自身不成为新故障源
    Evidence: .omo/evidence/task-7-decode-timeout.txt
  ```

  **Commit**: YES
  - Message: `feat(diagnosis): 渲染自检（logo 时序与溢出测量）`
  - Files: `src/main/printing/diagnostics/render-check.ts`, `tests/unit/printing/diagnostics/render-check.test.ts`
  - Pre-commit: `npm test -- tests/unit/printing/diagnostics/render-check.test.ts`

- [x] 8. 报告导出器（report.exporter.ts）

  **What to do**:
  - 新建 `src/main/printing/diagnostics/report.exporter.ts`：
    - `buildReportTxt(report: DiagnosticReport): string`：三层结构——
      - 层 1 摘要：时间戳/应用版本/Electron 版本/OS/结论行（N 台打印机、M 问题、X 已修、Y 待确认、Z 需开发）
      - 层 2 明细：每条 finding 一段（[severity] code / 中文描述 / evidence 链 / 建议（已执行|待确认|引导步骤）/ 状态）
      - 层 3 定位数据：渲染快照（两次测量值/Δ/溢出）+ 事件日志摘录（Id 计数 + 最近 5 条时间戳）
      - 附录：`=== RAW JSON BEGIN ===` + `JSON.stringify(report)` + `=== RAW JSON END ===`（供离线重分析往返提取）
    - 脱敏：`jobs[].document` 截断至 20 字符 + 前缀 `订单`/顾客名类字段不进 txt 明细层（raw JSON 层同样脱敏——脱敏在 build 前对 snapshot 做一次变换）
    - `archiveHistory(report, userDataDir)`：写 `<userDataDir>/diagnostics/history/diagnose-<yyyyMMdd-HHmmss>.json`；目录内超 20 个文件删最旧（封顶）
    - 导出集成：复用 `export.service.ts` 的 `exportReport` 链（txt Buffer 加 UTF-8 BOM——Windows 记事本中文兼容）
  - 单测 `report.exporter.test.ts`：
    - golden 快照：symptom2 fixture → buildReportTxt 输出 `toMatchSnapshot()`（含中文/BOM 前提由 Buffer 断言）
    - 往返：txt 中提取 RAW JSON BEGIN/END 之间内容 → `JSON.parse` 成功且 schemaVersion=1
    - 脱敏：fixture 含超长 document（40 字符订单名）→ txt 与 raw 层均只含 20 字符
    - 封顶：fake 目录预置 21 个历史文件 → archiveHistory 后剩 20（删最旧断言）
    - Buffer BOM：导出 Buffer 前 3 字节 = EF BB BF

  **Must NOT do**:
  - 不引入新依赖（纯字符串模板）；不做 i18n（中文单语言）
  - raw JSON 不得含未脱敏的 document/owner 全文
  - history 不封顶不得上线（20 上限是 Must Have）

  **Recommended Agent Profile**:
  - **Category**: `quick`——模式已定（txt 模板 + 既有导出链），主要是格式化函数与快照测试
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（Wave 3 内）
  - **Parallel Group**: Wave 3
  - **Blocks**: 9
  - **Blocked By**: 2（fixtures 做 golden 输入）

  **References**:
  - `src/main/export/export.service.ts:27-103`——exportReport(input, format, deps) DI 链与 E2E_EXPORT_DIR 钩子（直接复用；SaveDialogOptionsLike 形状照抄）
  - `src/main/export/txt.exporter.ts`——UTF-8 BOM + CRLF 的 txt 产物惯例（README 记载）
  - `src/main/printing/diagnostics/schema.ts`（任务 1）——DiagnosticReport/Finding 类型
  - `tests/unit/printing/diagnostics/fixtures/symptom2-driver-layout.json`（任务 2）——golden 快照输入
  - **WHY**: 三层结构 + raw JSON 附录是用户确认的交付物设计；BOM/脱敏/封顶是 Metis 指令（Notepad 兼容/POS 隐私/磁盘防膨胀）

  **Acceptance Criteria**:
  - [ ] `npm test -- tests/unit/printing/diagnostics/report.exporter.test.ts` 通过（5 条：golden/往返/脱敏/封顶/BOM）

  **QA Scenarios**:
  ```
  Scenario: 报告三层结构与往返解析
    Tool: Bash
    Steps:
      1. npm test -- tests/unit/printing/diagnostics/report.exporter.test.ts
         # Expected: golden 快照匹配；RAW JSON 段可 JSON.parse 且 schemaVersion===1
      2. 断言 txt 含 '=== RAW JSON BEGIN ===' 与 '=== RAW JSON END ===' 各一次
    Expected Result: 单文件双用途（人读+机器读）成立
    Evidence: .omo/evidence/task-8-report-golden.txt

  Scenario: 脱敏与封顶（负面防线）
    Tool: Bash
    Steps:
      1. fixture document=40 字符 → 断言 txt 与内嵌 JSON 中该字段 ≤20 字符
      2. 预置 21 个 history 文件 → archiveHistory → 目录扫描断言 =20 且最旧被删
    Expected Result: 隐私与磁盘双防线生效
    Failure Indicators: raw 层漏脱敏；历史文件超 20
    Evidence: .omo/evidence/task-8-redaction-cap.txt
  ```

  **Commit**: YES
  - Message: `feat(diagnosis): 诊断报告导出器（三层 txt + raw JSON + history 封顶）`
  - Files: `src/main/printing/diagnostics/report.exporter.ts`, `tests/unit/printing/diagnostics/report.exporter.test.ts`
  - Pre-commit: `npm test -- tests/unit/printing/diagnostics/report.exporter.test.ts`

- [x] 9. 编排服务 + IPC 薄层 + 装配（diagnose.service.ts + diagnostics.ipc.ts）

  **What to do**:
  - 新建 `src/main/printing/diagnostics/diagnose.service.ts`：`createDiagnoseService(deps)`（全 DI：collect/analyze/repair/renderCheck/settings getter/printQueue 状态查询/execFileFn）：
    - `diagnose(printerName?)`：防重入守卫（in-flight 标记，重入 → 中文错误）→ PrintQueue busy 检查（忙 → 错误提示"有打印任务进行中"）→ runCollect → analyzeSnapshot → **L1 先行**（对 findings 中 suggestedActions 含 CANCEL_ERROR_JOBS 的：执行 + 标 auto-fixed）→ VERIFY（对已执行动作按 RULE_DEPENDS_ON 重采子集 → 比对 finding 消除：消除=verify-passed / 未消除=escalated+升级建议）→ 组装 DiagnosticReport → archiveHistory → 返回
    - `repair(actionId, targetPrinter?)`：查 RepairAction 目录（requiresConfirm 由前端确认后调用）→ runRepairAction → L2/L3 执行后 VERIFY 子集重采 → 返回 {ok, verify}
    - `exportReport(report)`：buildReportTxt → export.service 导出（dialog fake 注入点）
  - 新建 `src/main/ipc/diagnostics.ipc.ts`：`registerDiagnosticsIpc(db)`（懒 require electron，T2 模式）：三 handler 参数校验（actionId 枚举校验/report 形状校验）→ 调 service → `{ ok, error }` 信封（错误首段含动作名）
  - `src/main/index.ts`：app.whenReady 内 `registerDiagnosticsIpc(db)`（第五处联动收口）
  - 单测 `diagnose.service.test.ts` + `diagnostics.ipc.test.ts`（全 fake 注入）：
    - 编排流转：fake collect/analyze → 断言 L1 在 analyze 后、return 前被调用（调用序断言）
    - VERIFY：fake 二次 collect 返回仍含问题 → finding=escalated；消除 → verify-passed
    - 防重入：并发两次 diagnose → 第二次 reject
    - PrintQueue busy → 拒绝修复类动作
    - export：fake dialog → 断言 filePath 返回
    - IPC 层：actionId 非法 → {ok:false}；G11（platform fake linux → 明确错误）

  **Must NOT do**:
  - diagnose 返回前不得执行任何提权动作（L1 仅本人无提权任务）
  - service 不得直接 require electron（全部经 DI——vitest 纯 Node 可测）
  - VERIFY 不得全量重采（按 RULE_DEPENDS_ON 子集）

  **Recommended Agent Profile**:
  - **Category**: `deep`——编排状态机（防重入/L1 时序/VERIFY 子集/升级链）是全子系统行为核心，集成点多
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES（与任务 10 开发部分同 Wave 4；但 10 的 E2E 验证依赖本任务）
  - **Parallel Group**: Wave 4
  - **Blocks**: 10（E2E 部分）
  - **Blocked By**: 4, 5, 6, 7, 8

  **References**:
  - `src/main/ipc/printing.ipc.ts`——IPC 薄层范本（懒 require/参数校验/{ok,error} 信封/错误首段含上下文）
  - `src/main/printing/print.service.ts`——PrintQueue 串行队列（busy 状态查询的 DI 来源；编排器 deps 模式 PrintOrchestratorDeps）
  - `src/main/index.ts:72-80`——registerXxxIpc 装配点（第五处联动）
  - `src/main/export/export.service.ts:76-103`——exportReport 集成（任务 8 已建适配）
  - 任务 1 的 RULE_DEPENDS_ON + 任务 5/6 的 analyze/repair 接口——编排的原材料
  - **WHY**: L1 在返回前完成 + VERIFY 子集重采是用户确认的核心体验（HP PSDr 模式）；防重入与 PrintQueue 互斥是 Metis 并发指令的落地

  **Acceptance Criteria**:
  - [ ] `npm test -- tests/unit/printing/diagnostics/diagnose.service.test.ts tests/unit/ipc/diagnostics.ipc.test.ts` 通过
  - [ ] `npm run typecheck` 全绿（含 main/index.ts 装配）

  **QA Scenarios**:
  ```
  Scenario: 编排时序（L1 先行 + VERIFY 闭环）
    Tool: Bash
    Steps:
      1. fake 依赖注入（collect 首次返回含 error jobs 的 snapshot；repair 记录调用序）
      2. diagnose() → 断言调用序 = [collect, analyze, repair(CANCEL_ERROR_JOBS), collect(子集), 返回]
         # Expected: report 中该 finding.status='verify-passed'
      3. fake 二次 collect 仍含问题 → 断言 status='escalated' 且含升级建议
    Expected Result: 用户点一次诊断看到的是终态（已修+已验证）
    Evidence: .omo/evidence/task-9-orchestration.txt

  Scenario: 并发与互斥防线（负面）
    Tool: Bash
    Steps:
      1. 第一次 diagnose 挂起（fake collect 延迟）期间第二次调用 → 断言 reject 且消息含"正在进行"
      2. fake printQueue busy=true → repair() → 断言拒绝且消息含"打印任务进行中"
    Expected Result: 双守卫生效，无竞态
    Evidence: .omo/evidence/task-9-guards.txt
  ```

  **Commit**: YES
  - Message: `feat(diagnosis): 编排服务 + IPC 薄层 + 装配（L1 先行 + VERIFY 闭环 + 防重入）`
  - Files: `src/main/printing/diagnostics/diagnose.service.ts`, `src/main/ipc/diagnostics.ipc.ts`, `src/main/index.ts`, `tests/unit/printing/diagnostics/diagnose.service.test.ts`, `tests/unit/ipc/diagnostics.ipc.test.ts`
  - Pre-commit: `npm run typecheck && npm test`

- [x] 10. 诊断面板 UI + store + E2E + 真机验证清单

  **What to do**:
  - `src/renderer/src/stores/printing.store.ts` 扩展：`diagnose()/repairAction(actionId)/exportDiagnosisReport()` 三 action + 状态 `diagnosisState: idle|collecting|report|error`（复用 extractIpcErrorMessage + ElMessage 上报惯例）
  - `src/renderer/src/views/SettingsView.vue`：打印卡片内（测试打印按钮旁）加「打印机诊断」按钮 → `el-dialog` 三区：
    - 区 1 系统概况：spooler 徽章（el-tag success/danger）+ 事件摘要一行
    - 区 2 打印机列表：每台一行（名称 + 状态徽章 + 驱动名 + RAW 标记）
    - 区 3 发现问题：按 severity 排序；每条含描述/evidence 摘要/操作区——L1 auto-fixed 绿标（"已自动修复 ✓"）、L2/L3「修复」按钮（点击弹确认框：破坏半径文案，如"将清空本机所有打印机队列任务"）、L4「查看引导」可展开步骤（el-collapse）、needs-dev 标签 + 「导出报告」提示
    - 对话框底部：「导出报告」按钮（调 diagnoseExport → 成功 ElMessage 显示 filePath）
    - UAC 拒绝路径：repair 返回 needs-manual → ElMessage info 引导文案（非 error 红条）
  - E2E `tests/e2e/diagnosis.spec.ts`（Playwright _electron，mock window.api 层或真实 IPC——按既有 e2e 模式）：
    - 场景 1：设置页含诊断按钮，点击后对话框渲染（mock report：3 findings 各状态一）
    - 场景 2：L2 修复确认流（点修复→确认框出现→确认→按钮 loading→结果更新）
    - 场景 3：导出报告（E2E_EXPORT_DIR 环境变量下断言文件生成）
  - `docs/windows-manual-checklist.md` 新增「10. 打印机诊断（真机验证）」节：
    - 诊断按钮跑通（真机 PowerShell 采集——Windows 10/11 x64 + 热敏机）
    - spike 验证点清单：Add-PrinterPort 标准用户权限实测 / WSD DeviceURL→IP 可得性实测 / Electron 44 打印矩阵（pageSize/margins/dpi/usePrinterDefaultPageSize 组合 × 目标机型——症状 2 根因定位）/ UAC 拒绝真机路径 / Remove-PrintJob 跨用户行为
    - 结果汇总表加第 10 行
  - `npm run typecheck`（web 侧）+ `npm test` + `npm run test:e2e` 全绿

  **Must NOT do**:
  - 不新增路由/页面（设置页第四张卡片内对话框承载）；不动既有三张卡片结构
  - UI 文案不得含英文术语堆砌（中文人话 + code 作小字标注）
  - E2E 不得依赖真实打印机（mock IPC 层；真机项归 docs 清单人工节）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`——Element Plus 对话框三区布局 + 状态徽章 + 交互流（确认/loading/折叠引导）是 UI 主体工作
  - **Skills**: [`playwright`]——E2E 场景编写（_electron 启动/选择器/断言与既有 92 场景同栈）
    - playwright：本项目 E2E 全部 Playwright _electron，技能域完全重叠

  **Parallelization**:
  - **Can Run In Parallel**: 开发部分 YES（契约类型就绪即可写 UI）；E2E 验证部分 NO（依赖 9 的 handler）
  - **Parallel Group**: Wave 4（with Task 9，E2E 在 9 完成后收口）
  - **Blocks**: F1-F4
  - **Blocked By**: 1（类型）；E2E 依赖 9

  **References**:
  - `src/renderer/src/views/SettingsView.vue:190/240/372`——既有三张 el-card 结构与测试打印按钮区（:126 testPrint 调用）——第四卡片照此组织
  - `src/renderer/src/stores/printing.store.ts`——pinia action + ElMessage 上报模式（res.ok 分支）
  - `src/renderer/src/utils/ipc-error.ts`——extractIpcErrorMessage（错误展示统一入口）
  - `tests/e2e/`（helpers/global-setup）——_electron.launch 模式、E2E_EXPORT_DIR 钩子（export.service.ts:87-92）
  - `docs/windows-manual-checklist.md`——清单文档体例（操作步骤/预期结果/勾选框），新节照此写
  - **WHY**: 诊断面板是用户确认的交付形态；UAC 拒绝的 needs-manual info 提示（非红色 error）是 Metis 指令的 UI 落点；真机清单承载所有无法在 Linux CI 验证的 spike 项

  **Acceptance Criteria**:
  - [ ] `npm run typecheck`（web）+ `npm test` 全绿
  - [ ] `npm run test:e2e` 含诊断 3 场景全绿
  - [ ] docs/windows-manual-checklist.md 含「10. 打印机诊断」节且含 5 个 spike 验证点

  **QA Scenarios**:
  ```
  Scenario: 诊断面板渲染与三区结构
    Tool: Playwright (_electron)
    Steps:
      1. 启动 app → 点击左侧「设置」
      2. 断言 .settings-print-card 内含「打印机诊断」按钮
      3. 点击 → 断言 el-dialog 可见且含三区标识（系统概况/打印机列表/发现问题）
      4. mock report 注入 3 findings → 断言列表 3 条、auto-fixed 项含绿标、L2 项含「修复」按钮
    Expected Result: 三区对话框按设计渲染
    Failure Indicators: 对话框不弹出/区缺失/findings 空渲染
    Evidence: .omo/evidence/task-10-panel-render.png（截图）

  Scenario: L2 修复确认流（含 UAC 拒绝分支）
    Tool: Playwright (_electron)
    Steps:
      1. 点击 L2 finding 的「修复」→ 断言确认框出现且含破坏半径文案（"清空"字样）
      2. 确认 → mock repair 返回 needs-manual → 断言出现 info 级提示（非 error 红条）
    Expected Result: 确认流 + UAC 拒绝优雅降级链路可见
    Evidence: .omo/evidence/task-10-repair-flow.png

  Scenario: 导出报告落盘（负面：导出取消）
    Tool: Playwright (_electron)
    Steps:
      1. 点「导出报告」→ mock dialog 返回路径 → 断言 E2E_EXPORT_DIR 下生成 .txt 且 ElMessage 显示路径
      2. mock dialog 取消 → 断言无异常、无文件
    Expected Result: 导出成功/取消双路径正常
    Evidence: .omo/evidence/task-10-export.txt（目录列表）
  ```

  **Commit**: YES
  - Message: `feat(diagnosis): 设置页诊断面板 + E2E + 真机验证清单`
  - Files: `src/renderer/src/views/SettingsView.vue`, `src/renderer/src/stores/printing.store.ts`, `tests/e2e/diagnosis.spec.ts`, `docs/windows-manual-checklist.md`
  - Pre-commit: `npm run typecheck && npm test && npm run test:e2e`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [~] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns（Set-PrinterPort / 消息文本解析 / src/**/*.spec.ts / 新 npm 依赖 / 裸字符串 IPC）— reject with file:line if found. Check evidence files exist in .omo/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [~] F2. **Code Quality Review** — `unspecified-high`
  Run `npm run typecheck` + `npm test`. Review all changed files for: `as any`/`@ts-ignore`、empty catches、console.log 残留、unused imports、AI slop（过度注释/过度抽象/泛型命名 data/result）。重点：schema.ts 类型完备性、analyze.ts 规则 evidence 路径真实性、PS 脚本 PS 5.1 兼容。
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [~] F3. **Real Manual QA** — `unspecified-high`（+ `playwright` skill）
  From clean state: `npm run test:e2e` 全量（含诊断面板新场景）；执行每任务 QA 场景抽查（重点：fixtures 表驱动全绿、报告 golden 快照、BOM 字节断言、防重入、G11 拒绝）；核对 docs/windows-manual-checklist.md 诊断节存在且含 spike 验证点。Save evidence to `.omo/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [~] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do"，read actual diff（git log/diff）。Verify 1:1——计划内全建（无遗漏）、计划外未建（无蔓延，尤其：无 DEVMODE 采集、无 WS-Discovery 客户端、无打印参数自动改写、无新依赖）。Check "Must NOT do" compliance per task. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **1**: `feat(diagnosis): 诊断类型契约与 IPC 通道登记` - src/main/printing/diagnostics/schema.ts, src/shared/types/ipc.ts, tests/unit/shared/ipc.test.ts, src/preload/index.ts, src/preload/index.d.ts
- **2**: `feat(diagnosis): 7 组黄金样本 fixtures` - tests/unit/printing/diagnostics/fixtures/
- **3**: `feat(diagnosis): 采集 PowerShell 脚本构建器（编码安全 + 段隔离）` - src/main/printing/diagnostics/collect-script.ts + 单测
- **4**: `feat(diagnosis): 采集执行器（BOM 落盘 + maxBuffer + 超时预算）` - collect.runner.ts + 单测
- **5**: `feat(diagnosis): 规则引擎 15 条规则 + 云打印机名单` - analyze.ts + 表驱动单测
- **6**: `feat(diagnosis): 修复动作构建与执行器（L1/L2 + UAC 链 + result-file 契约）` - repair-script.ts, repair.runner.ts + 单测
- **7**: `feat(diagnosis): 渲染自检（logo 时序与溢出测量）` - render-check.ts + 单测
- **8**: `feat(diagnosis): 诊断报告导出器（三层 txt + raw JSON + history 封顶）` - report.exporter.ts + 单测
- **9**: `feat(diagnosis): 编排服务 + IPC 薄层 + 装配（L1 先行 + VERIFY 闭环 + 防重入）` - diagnose.service.ts, diagnostics.ipc.ts, src/main/index.ts + 单测
- **10**: `feat(diagnosis): 设置页诊断面板 + E2E + 真机验证清单` - SettingsView.vue, printing.store.ts, tests/e2e/, docs/windows-manual-checklist.md
- Pre-commit（每任务）: `npm run typecheck && npm test`
- **F 波后**: 用户 okay → `chore(diagnosis): 诊断子系统收尾`

---

## Success Criteria

### Verification Commands
```bash
npm run typecheck          # Expected: node + web 两侧 0 error
npm test                   # Expected: 全部通过（原 747 + 新增诊断用例）
npm run test:e2e           # Expected: 含诊断面板场景全绿
grep -r "Set-PrinterPort" src/ tests/   # Expected: 无匹配
ls .omo/evidence/          # Expected: task-1..10 + final-qa 证据文件
```

### Final Checklist
- [ ] All "Must Have" present（编码 guardrail / G11 拒绝 / 规则结构化消费 / UAC 1223 / 五处联动 / BOM+脱敏+封顶 / 编排闭环）
- [ ] All "Must NOT Have" absent（13 项 guardrails）
- [ ] 7 组 fixtures 表驱动全绿（两台真实故障机症状可被诊断命中）
- [ ] typecheck / vitest / e2e 全绿
- [ ] docs/windows-manual-checklist.md 含诊断真机验证节 + spike 验证点
