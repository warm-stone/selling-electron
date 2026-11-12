/**
 * 打印诊断 PowerShell 采集脚本构建器（printer-diagnostics 计划 Wave 2 / T3）。
 *
 * 契约要点（消费方：T4 落盘执行 + 归一化解析）：
 * - **完全静态**：零参数、零 I/O、零运行时值拼接——buildCollectScript() 两次调用
 *   返回全等文本（测试用 === 锁死）。脚本内容恒定，才可能对内容做静态审计；
 *   打印机名等动态值永远不进脚本（无注入面）。
 * - **编码防御（Metis 发现 C 的落地点）**：脚本第 1 行（任何输出前）强制
 *   `[Console]::OutputEncoding = UTF-8（无 BOM）`——GBK 控制台下 stdout 仍是
 *   UTF-8，ConvertTo-Json 输出的中文（打印机名/驱动名/事件 Message）不被控制台
 *   代码页损坏。`.ps1` 落盘 BOM / chcp / maxBuffer 是执行器（T4）职责，本模块
 *   只保证脚本自身可预测：零中文字面量（段名/字段全英文，降低编码风险）。
 * - **exit 0 恒定契约**：与 spooler 打印通道（exit 2 = 发送失败）的关键差异——
 *   采集脚本 exit code 恒为 0，部分失败记在各段 JSON（catch 落
 *   `@{ error = $_.Exception.Message }`），执行器永远信任「有输出 = 可解析」。
 *   10 段独立 try/catch，段间互不拖垮。
 * - **段名 = schema.ts DiagnosticSectionName 十段**：printers / wmi / jobs /
 *   ports / drivers / spooler / spoolDir / events / tcpProbe / printConfig；
 *   段内字段名对齐 PrintDiagnosticSnapshot（T4 归一化解析的目标形状）。
 * - **PS 5.1 语法 only**：无 `??` / 无三元 / 无 `&&`/`||` 管道符；TCP 探测用
 *   ConnectAsync + Wait(3000)（同步 Connect 对不可路由地址会挂 20s+）；
 *   避开 $host 等只读自动变量（用 $targetHost/$targetPort）。
 * - **零副作用**：只读命令（枚举/查询/探测），无任何 Remove-/Stop-/Start-/
 *   Set-/net stop——采集不改变系统状态；不读 PrintService/Operational 内容
 *   （只 ListLog 查 IsEnabled）；不用 Get-WmiObject（只用 Get-CimInstance）。
 */

/** 采集脚本行（完全静态的拼装原料——顺序即段顺序，尾行恒为 exit 0） */
const SCRIPT_LINES: readonly string[] = [
  // ---- header：任何输出前先钉死 stdout 编码（GBK 控制台防御）----
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Continue'",
  '$out = [ordered]@{}',
  '# Printer diagnostics collection (PS 5.1, static script, zero parameters).',
  '# Always exits 0 - partial failures are recorded per-section in the JSON.',
  '',
  // ---- section: printers ----
  '# --- section: printers ---',
  'try {',
  '  $out.printers = @(Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Type,Shared,Published | ConvertTo-Json -Depth 4)',
  '} catch {',
  "  $out.printers = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: wmi ----
  '# --- section: wmi ---',
  'try {',
  '  $out.wmi = @(Get-CimInstance Win32_Printer | Select-Object Name,WorkOffline,ExtendedDetectedErrorState,ExtendedPrinterStatus,Attributes,Local,Network,Default,PortName,DriverName,PrintProcessor,Manufacturer | ConvertTo-Json -Depth 4)',
  '} catch {',
  "  $out.wmi = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: jobs ----
  '# --- section: jobs ---',
  'try {',
  '  $out.jobs = @(Get-CimInstance Win32_PrintJob | Select-Object Name,Document,JobStatus,Owner,JobId,Size,TimeSubmitted,StatusMask | ConvertTo-Json -Depth 4)',
  '} catch {',
  "  $out.jobs = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: ports ----
  '# --- section: ports ---',
  'try {',
  '  $out.ports = @(Get-PrinterPort | Select-Object Name,Description,PrinterHostAddress,PortNumber,Protocol,SNMPEnabled | ConvertTo-Json -Depth 4)',
  '} catch {',
  "  $out.ports = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: drivers ----
  '# --- section: drivers ---',
  'try {',
  '  $out.drivers = @(Get-PrinterDriver | Select-Object Name,Manufacturer,DriverVersion,DriverDate,ConfigFile | ConvertTo-Json -Depth 4)',
  '} catch {',
  "  $out.drivers = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: spooler ----
  '# --- section: spooler ---',
  'try {',
  '  $svc = Get-Service -Name Spooler',
  '  $out.spooler = @{',
  '    status = $svc.Status.ToString()',
  '    startType = $svc.StartType.ToString()',
  '    dependents = @($svc.DependentServices | ForEach-Object { $_.Name })',
  '  }',
  '} catch {',
  "  $out.spooler = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: spoolDir ----
  '# --- section: spoolDir ---',
  'try {',
  "  $reg = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers' -Name DefaultSpoolDirectory -ErrorAction SilentlyContinue",
  '  $dir = if ($reg -and $reg.DefaultSpoolDirectory) { $reg.DefaultSpoolDirectory } else { "$env:SystemRoot\\System32\\spool\\PRINTERS" }',
  '  $out.spoolDir = @{',
  '    spoolDir = $dir',
  '    files = @(Get-ChildItem $dir -Force -ErrorAction SilentlyContinue | Group-Object Extension | ForEach-Object { @{ext=$_.Name; count=$_.Count} })',
  '  }',
  '} catch {',
  "  $out.spoolDir = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: events（整体一个 try/catch；内部三部分各自 SilentlyContinue 容错）----
  '# --- section: events ---',
  'try {',
  '  $out.events = @{ admin = @(); app1000 = @(); operationalEnabled = $false }',
  "  $out.events.admin = @(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-PrintService/Admin';StartTime=(Get-Date).AddDays(-7)} -MaxEvents 50 -ErrorAction SilentlyContinue | ForEach-Object { @{time=$_.TimeCreated.ToString('o'); id=$_.Id} })",
  "  $out.events.app1000 = @(Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000;StartTime=(Get-Date).AddDays(-7)} -MaxEvents 20 -ErrorAction SilentlyContinue | ForEach-Object { @{time=$_.TimeCreated.ToString('o'); message=$_.Message} })",
  '  $out.events.operationalEnabled = $false',
  "  $logInfo = Get-WinEvent -ListLog 'Microsoft-Windows-PrintService/Operational' -ErrorAction SilentlyContinue",
  '  if ($logInfo) { $out.events.operationalEnabled = [bool]$logInfo.IsEnabled }',
  '} catch {',
  "  $out.events = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: tcpProbe（独立再查一次端口，不依赖 $out.ports；ConnectAsync+Wait(3000) 防挂死）----
  '# --- section: tcpProbe ---',
  'try {',
  '  $probeResults = @()',
  "  foreach ($p in (Get-PrinterPort -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'IP_*' })) {",
  '    $targetHost = $p.PrinterHostAddress',
  '    $targetPort = if ($p.PortNumber) { $p.PortNumber } else { 9100 }',
  '    $reachable = $false',
  '    try {',
  '      $tcp = New-Object System.Net.Sockets.TcpClient',
  '      $task = $tcp.ConnectAsync($targetHost, $targetPort)',
  '      if ($task.Wait(3000) -and $tcp.Connected) { $reachable = $true }',
  '      $tcp.Close()',
  '    } catch {',
  '      $reachable = $false',
  '    }',
  "    $probeResults += @{name=$p.Name; host=$targetHost; port=$targetPort; reachable=$reachable}",
  '  }',
  '  $out.tcpProbe = $probeResults',
  '} catch {',
  "  $out.tcpProbe = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- section: printConfig（内层空 catch：单台配置缺失不拖垮整段）----
  '# --- section: printConfig ---',
  'try {',
  '  $configs = @()',
  '  foreach ($prn in (Get-Printer -ErrorAction SilentlyContinue)) {',
  '    try {',
  '      $cfg = Get-PrintConfiguration -PrinterName $prn.Name -ErrorAction SilentlyContinue',
  '      if ($cfg) {',
  "        $configs += @{printerName=$prn.Name; paperSize=$cfg.PaperSize; widthMicrons=$cfg.Width; heightMicrons=$cfg.Length; orientation=$cfg.Orientation}",
  '      }',
  '    } catch { }',
  '  }',
  '  $out.printConfig = $configs',
  '} catch {',
  "  $out.printConfig = @{ error = $_.Exception.Message }",
  '}',
  '',
  // ---- tail：总输出 + exit 0 恒定（部分失败在数据里，绝不变 exit code）----
  '$out | ConvertTo-Json -Depth 6 -Compress',
  'exit 0'
]

/** 完整脚本文本（模块加载时拼一次——静态性即由它保证） */
const COLLECT_SCRIPT = SCRIPT_LINES.join('\n')

/**
 * 返回诊断采集 PowerShell 脚本（PS 5.1）——纯函数：零参数、零 I/O、
 * 零运行时值拼接，任何时刻调用返回同一文本（=== 全等）。
 *
 * 段名/字段契约见 schema.ts（DiagnosticSectionName / PrintDiagnosticSnapshot）；
 * 执行（execFile / .ps1 落盘 BOM / chcp / maxBuffer）归 T4，本模块不执行任何东西。
 */
export function buildCollectScript(): string {
  return COLLECT_SCRIPT
}
