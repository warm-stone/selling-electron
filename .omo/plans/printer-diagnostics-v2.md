# 打印机诊断子系统 v2（printer-diagnostics-v2 · 重做版）

## TL;DR

> **Quick Summary**: 首轮真机报告（打印机诊断报告-20261115-170820.txt，DL-5801PW 58mm
> 热敏机）暴露 v1 诊断子系统「机器实际有打印问题但报 0 findings」的失明事故。v2 修复
> 3 个确认采集 bug + 3 个盲区，增补 R16/R17 两条规则承载真机症状 2 的根因链，并为
> driver 通道提供两条实验性 workaround 开关（显式 DPI / 驱动默认页尺寸）+ 观测链，
> 最终以真机复采 + spike C 三组对照实验闭环（Track B）。
>
> **执行方式（用户决策 2026-11-16）**: **全部从零重做**——首轮 v2 实施因 OMO 4.8.1
> delegate-task fire-and-forget 事故被全量回退（9 提交隔离在 `v2-quarantine-backup`
> 分支）。重做**不 cherry-pick 隔离分支**：该分支仅作需求清单/范围对账参照，代码一律
> 在 `printer-diagnostics-v2-redo` 分支重写、逐任务独立验证（typecheck 双绿 + 相关
> 测试全绿 + 逐任务提交）。全程主会话直接实施，不委派子会话（事故根因规避）。

---

## Context

### 真机失明事故（v2 的问题来源）

首轮真机报告 0 findings，但该机器实际有症状 2（driver 通道版面异常：左空白/右截断/
上方大空白/加 logo 内容消失）。复盘定位 6 个缺陷（全部经 librarian + 真机数据双重
查证，事实源 `.omo/notepads/printer-diagnostics/learnings.md`）：

| # | 缺陷 | 根因 | 修复落点 |
|---|------|------|---------|
| Bug1 | 4 台打印机全报 unknown 状态 | Get-Printer PrinterStatus 经 ConvertTo-Json 是**位掩码数字**（0=Normal），v1 按字符串 'normal' 匹配恒落 unknown | collect.runner 位掩码优先级表 + WMI 兜底链（三套枚举独立维护禁合并） |
| Bug2 | 18 条「崩溃事件」全是噪音 | Id=1000 未按 ProviderName 过滤——UndockedHost 遥测噪音冒充 WER 崩溃；message 正则提取易碎 | collect-script ProviderName='Application Error' + -ErrorAction Ignore + props 数组透传；runner 索引解析优先（props[0]=应用/props[3]=模块，守卫 ≥13）+ 正则兜底 |
| Bug3 | 假水平溢出（786px vs 纸宽 221px） | render-check 测 documentElement.scrollWidth = max(视口, 内容)——窄收据报视口地板值（800−14 滚动条 @DPR1.25） | 测量源改 `.receipt-paper` 元素（scrollHeight+offsetTop / scrollWidth），无元素回退 documentElement；隐藏窗口显式 400×600 |
| 盲区4 | printConfig 全空（R10/R11 失明） | v4 驱动走 PrintTicket，Get-PrintConfiguration 常全空 | 四层 fallback 链：printconfiguration → printticketxml（MediaSize 正则）→ win32printerconfig（0.1mm→μm ×100）→ devmode（注册表 blob Base64 → DEVMODEW 偏移解析：dmFields@72/dmPaperSize@78/dmPaperLength@80/dmPaperWidth@82/dmFormName@102-165）；R17 兜底「缺数据≠健康」 |
| 盲区5 | 症状 2 根因链无规则承载 | driver+custom-microns+margins-none+silent 命中 Electron GDI 静默打印已知问题群（#31705/#50481/#39179），v1 无探测 | R16 driver-print-combo-known-issue（high/needs-dev，dpr≠1 进 evidence，三条 workaround 文案） |
| 盲区6 | logo 测量竞态只有证据没有修复 | driver.channel 测量 scrollHeight 时 logo 未解码完（fixture symptom2 Δ265px）→ 页高低估裁内容 | printHtmlViaDriver 步骤 1.5：测量前 LOGO_DECODE_WAIT_SCRIPT（decode 成败都 resolve，30s settle 兜底） |

### 症状 2 根因链（R16 依据）

driver + custom-microns + margins-none + silent = Electron 已知坏组合
（#31705 closed-not-planned / #50481 热敏机右截断）× DPR 1.25（#39179）× v4 驱动
（Get-PrintConfiguration 全空）。收据 HTML 本身健康（538px / Δ0 / 221px 不溢出）。
根治需 Electron 侧升级排查——v2 交付实验性 workaround 开关供真机对照。

---

## 任务清单（Track A：代码修复，分支 printer-diagnostics-v2-redo）

- [x] **T1 契约扩展**（553bf1b）：schema.ts +2 FindingCode（17 码）+ RULE_DEPENDS_ON
      空依赖（R16/R17 沿 R12 先例）+ printConfigs.source? + printOptions.dpi? /
      usePrinterDefaultPageSize?；domain.ts AppSettings +driver_dpi? /
      driver_use_default_page_size?；schema.test.ts 17 码清单 + 空依赖豁免三键锁。
- [x] **T2 采集脚本**（1372eaa）：events.app1000 WER 过滤三件套（ProviderName /
      Ignore / props 透传——PS 只搬运零解析）；printConfig 四层 fallback（段级
      catch 记 error、层 catch 空不记）；测试 try/catch 恰 15、Message 恒 10、
      产物脚本反斜杠/引号静态审计。
- [x] **T3 采集执行器**（8f4b78d）：printerStatus asNumber + PRINTER_STATUS_BITMASK
      优先级表（128>2>1>4>8>16>64>4194304，其余 online）+ WIN32_PRINTER_STATUS_1_7 +
      EXTENDED_PRINTER_STATUS_1_18 + DETECTED_ERROR_STATE_LABELS（in 判定防 ?? 吞
      显式 null）；parseEventsSection props 索引优先；normalizeConfigItem source
      分派 + parseDevmodeB64（<166 字节全空、≥256 取 formName）。
- [x] **T4 真机黄金样本**（1e3806b）：fixtures/real-machine-20261115.json（修复后
      语义终态：4 台 online / WER 0 条 / scrollWidth=221 / printConfigs 全空 v1 形状
      ——Track B 复采后回填实际 source）+ fixtures 8 键锁。
- [x] **T5 规则引擎**（fd3930a）：R16 driver-print-combo-known-issue（组合前提三缺一
      即失活；目标机缺位归 printer-name-mismatch 域）+ R17 printconfig-unavailable
      （`!rescued && (segError || widthMicrons===null)`；info/pending）+ R10/R11
      evidence srcNote 非破坏性增强；真机 golden 回放精确命中集
      ['driver-print-combo-known-issue','printconfig-unavailable']。
- [x] **render-check 测量源修复 + 观测链**（7ea7058）：Bug3 元素级测量（真机 786
      假阳性对照 + 330 真阳性防回归 + 元素缺失回退）；WER 摘要文案；实验键观测装配
      （diagnostics.ipc currentSettingsView 读两键 → printOptions 条件透传；
      useDefaultPageSize=true 时 pageSizeMode 报 'printer-default'——R16 前提随
      实验生效而消失）。
- [x] **T6 driver 通道**（4a96fbf）：LOGO_DECODE_WAIT_SCRIPT 步骤 1.5（try/catch
      不阻塞）；DriverPrintOptions 接口 + print options 条件组装（useDefaultPageSize
      → usePrinterDefaultPageSize:true 且物理无 pageSize 键——Electron 44 互斥契约；
      driverDpi 正整数 → dpi Record {horizontal,vertical}；条件 spread 保证未启用
      键物理不存在）；print.service 接线（PrintSettings 两键 + getChannel 闭包 +
      appSettingsToPrintSettings 映射）；vm 沙箱直跑 decode 脚本 JS 语义锁。
- [x] **T7 settings.ipc**（397ddcb）：parseDriverDpi（`/^\d+$/`，''/脏→null，读侧
      仅格式归一）；validateSettingsPatch（dpi 整数 50-1200 / 布尔两态，非法值
      **中文 throw 含值回显**——静默吞会让真机验证失真；既有键不校验）；
      rowsToAppSettings 条件产出（DB 无行不扩键）；appSettingsPatchToKv（null→''，
      布尔→'1'/'0'）；settings:set 先校验后落库。
- [x] **T8 SettingsView + E2E**（c6e43f1）：「打印高级选项（实验）」折叠区常驻可见
      （非 driver 通道标注「仅 driver 通道生效」而非隐藏）；el-input-number dpi
      50-1200 value-on-clear null + el-switch + A4 回退警告；extractIpcErrorMessage
      剥 invoke 前缀人话回显；driver-experimental.spec.ts 四场景（常驻渲染 / 合法
      保存往返 DB 断言 / 清除路径 null≡'' / 非法值真实 IPC + toast 回显）——
      10/10 绿（含 settings.spec.ts 回归）。
- [x] **T9 收口**：checklist 第 11 节（11.1 复采翻转五项 + 11.2 spike C 三组对照）；
      本计划文档重写；boulder.json 恢复（paused→active，清除事故期 stale
      task_sessions）；learnings.md 重做落地记录；全量验证（见下）。

### 范围对账（vs v2-quarantine-backup 参照）

代码全部重写（用户决策），但需求范围与隔离分支一致，另含两处自主改进：
① DETECTED_ERROR_STATE_LABELS 补 5/6/7（low-toner/no-toner/door-open）；
② 观测链补全——diagnostics.ipc printOptions 读取实验键（参照分支未接线，但
SettingsView 提示文案承诺「设置后诊断报告会记录该实验值」，接线兑现该承诺）。

---

## Track B：真机闭环（待构建交付）

1. 构建 v2 安装包 → 目标机（DL-5801PW）安装；
2. 按 docs/windows-manual-checklist.md 第 11 节执行：
   - 11.1 诊断复采：五项翻转预期（4 台 online / WER 0 条 / 无假溢出 / 恰好
     R16+R17 两条 finding / printConfig source 回填 fixture）；
   - 11.2 spike C 三组对照：① dpi=203 ② usePrinterDefaultPageSize（重点观察
     A4 回退分页）③ 切回 spooler——每组记录版面四症状 + 诊断报告观测值；
3. 实验结论回填 → 定该机推荐配置 / 升级 Electron 根治排查。

## 验证门禁（每任务）

- `npm run typecheck`（node + web 双绿）；
- 相关 vitest 全绿；收口全量：`npx vitest run tests/unit`（1025+ 绿）+
  `npm run test:e2e`；
- 已知环境 flake：tcp.channel.test.ts「连接超时（不可路由地址）」在本 Linux
  开发机间歇失败（learnings 6+ 次复核留档）——非阻塞、勿修。
