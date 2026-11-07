# Decisions

## 任务 2：共享契约层（domain 类型 + IPC 通道 + preload API）

- **Sale 本体零污染铁律的落地形态**：附加列走两条独立通道——日报明细行用 `SaleWithExtras extends Sale`（仅 +`is_national_subsidy`/`order_note` 两个平铺列，`reports:daily` 专用）；单据明细用 `SaleDetail.extras: SaleExtraInfo | null`（旁挂行整体，`sales:detail`/`sales:updateExtra`/`printing:preview` 消费）。`sales:list`/`printing` 等只读消费方对两者零感知，不发生连锁改动
- **`SaleDetail.extras` 必填非可选**：旧单（迁移前/无 sale_extras 行）显式 `null`，禁止空对象冒充——`null` 与「无附加行」语义一一对应，可选字段（`extras?:`）无法表达该区分
- **`SaleExtraInfo` = sale_extras 行 + LEFT JOIN customers 平铺**：`customer: Customer | null` 内嵌（customer_id 非空才带行），`sales:updateExtra` res / `sales:detail` 共用同一形态，避免下游各拼各的
- **`CheckoutExtrasInput` 全字段可选 + 整体可选**：`sales:checkout` req 为 `{ items, extras? }`，不传 extras 即不落 sale_extras 行（旧结账路径零行为变化）；`customer?: CheckoutCustomerInput | null` 传裸值，建新/匹配由 service 决定
- **typed IPC 三处同步铁律执行**：5 个新通道（customers:list/create/update、sales:updateExtra、settings:getRecentSalespersons）在 IpcChannels 接口、IPC_CHANNEL_NAMES 数组、ipc.test.ts EXPECTED_CHANNELS 三处同步登记；`satisfies readonly (keyof IpcChannels)[]` 保证接口侧漏登记编译期即炸，测试清单保证数组侧漏登记运行期即炸
- **`settings:getRecentSalespersons` req 定为 `{}` 而非 void**：预留未来参数位（如 limit），`{}` 通道 typedInvoke 调用须显式传 `{}`；与 `settings:get`（req: void）形成刻意区别
- **preload 双文件同步是隐性第三处登记**：`src/preload/index.ts`（实现）与 `src/preload/index.d.ts`（renderer `window.api` 类型）必须同改——漏 index.d.ts 则下游 renderer 任务调 `window.api.customers.*` 编译不过（文件内多处「结构同步」注释即此契约）
- **preload 签名防漂移模式**：参数类型直接用 `IpcChannels['customers:list']['req']` 索引类型 + `Omit<..., 'sale_id'>` 派生 patch 形状（照 templates 命名空间既有惯例），契约改动自动传导，零手工重复
- **契约扩展的最小波及面**：`SaleDetail`/`DailyReport` 加必填字段迫使构造点做「T2 契约接线占位」——sale.repo.getDetail 平铺 `extras: null`、report.service.daily 映射 `is_national_subsidy: false / order_note: null / subsidy_total_cents: 0`。当前无 sale_extras 行写入，占位值即旧单准确语义；后续 Wave 的 sale_extras JOIN/upsert 任务必须替换这两处（grep `T2 契约接线占位` 定位）
- **exact-shape 测试断言随契约机械更新**：report.service.test.ts 4 处 `toEqual` 补 `subsidy_total_cents: 0` + 行级 `is_national_subsidy: false, order_note: null`；export-report.fixture / print-orchestration.test 同理（导出器/打印暂不读新字段，输出断言不变）
- **`sales:checkout` res 的 Sale/SaleDetail 不一致保持原样**（范围纪律）：IpcChannels res 仍为 Sale，preload 返回仍为 SaleDetail，已知问题不在本任务修
- **recent_salespersons 不进 AppSettings**（定案重申）：走独立 `settings:getRecentSalespersons` 通道读 settings 表 TEXT JSON 队列，与 `AppSettings` 白名单零交集
