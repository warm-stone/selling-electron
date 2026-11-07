# Learnings

## 任务 3：销售人员最近输入纯函数模块（salesperson-history.ts）

- settings 表 value 一律 TEXT → 最近销售人员队列用 JSON 数组字符串序列化（key `recent_salespersons`），parse 侧参照 settings.ipc.ts parseBool 的脏值防御风格：null/undefined/损坏 JSON/非数组全回落 `[]`
- 解析侧不做去重（只 String 化→trim→滤空串），去重置顶职责全在 push 侧：`[trimmed, ...list.filter(x => x !== trimmed)].slice(0, 10)` 一行表达「移到队首 + 逐出队尾」
- 不可变契约细节：push 空串返回的是 `[...list]` 副本而非原引用（调用方统一拿到新数组，避免别名陷阱）；测试用 `expect(result).not.toBe(original)` 锁定
- parse 的 String 化意味着历史数据里的非字符串项（数字/null/bool）也能安全复原，JSON 损坏只影响最近输入列表不影响结账主流程

## 任务 1：005 数据库迁移（customers + sale_extras）

- **加迁移的隐性必改点**：新增 version 5 后，migrator.test.ts 既有用例里所有 `user_version` 断言（原 `toBe(4)`）与 `namedUserTables` 长度断言（原 `toHaveLength(10)`）必须同步 bump 到 5/12，否则全挂。003 时代断言被 bump 到 4 是先例——这不是"改测试语义"而是版本机械更新，每次加迁移都躲不开
- `migrate()` 会把 pending 迁移全部跑完：legacyDbV2/V3 构造的存量库升级后同样直达最新版，所以 003/004 存量升级用例里的 version 断言也要一并 bump
- 测试侧构造停在 version N 的存量库模式（legacyDbV4）：显式 `?raw` import 各迁移 SQL → 顺序 `db.exec` → 手动 `db.pragma('user_version = N')`；之后 `migrate()` 只补跑 N+1 起的迁移
- better-sqlite3 的 UNIQUE 违约 message 为 `UNIQUE constraint failed: customers.phone`，测试断言用 `/UNIQUE constraint failed/` 正则（既有惯例）
- **customers.phone NOT NULL UNIQUE 的坑（下游 repo 任务注意）**：`INSERT INTO customers(phone) VALUES('')` 只能成功一次——空串占位散客不可复用同值，二插必抛 SQLITE_CONSTRAINT；且 phone 无 DEFAULT，INSERT 必须显式给值（NOT NULL 无默认）
- FK 目标合法性依赖 001 的 `sales.id INTEGER PRIMARY KEY AUTOINCREMENT`；`database.ts` 的 `foreign_keys = ON` 使 sale_extras 的 REFERENCES 是实约束——下游必须拿到真实 saleId 后才能 INSERT sale_extras（幽灵 sale_id 抛 `FOREIGN KEY constraint failed`）
- sale_extras.sale_id 兼任 PRIMARY KEY（1:1 旁挂设计）：同一订单天然只能挂一行附加信息，无需额外唯一判断；is_national_subsidy 是 INTEGER 0/1（SQLite 无 bool，全项目沿用此约定）

## 任务 6：settings:getRecentSalespersons 读通道（settings.ipc.ts）

- 读通道组装零新序列化逻辑：`readRecentSalespersons(repo)` 单行组合 `repo.get(KEY)` + `parseRecentSalespersons`，repo 无 key 返回 null 被 parse 的脏值防御天然吞掉 → 三态容错（null/损坏 JSON/非数组全回落 []）不需要 handler 侧任何分支
- 最小 repo 面 interface（`RecentSalespersonsReaderRepo { get(key): string | null }`）照 LogoWriterRepo 惯例：纯助手依赖注入窄接口而非 SettingsRepo 全型，vitest 可用任意 stub；结构兼容使生产侧直接传真 repo 零适配
- 「不泄漏」的测试锁定方式：先 `repo.set(RECENT_SALESPERSONS_KEY, '["x"]')` 证行确实存在，再断言 `rowsToAppSettings(repo.getAll())` 无 recent_salespersons 键且 `Object.keys().sort()` 恰好白名单 9 键（exact-shape 防增防删双向）；无前置 set 的版本会在 set 失效时假通过
- top-level import salesperson-history（纯函数零依赖）不破坏 settings.ipc.ts 的 vitest 纯 Node 导入——只有 electron 本身需要懒 require，纯 TS 模块顶层 import 无害
- req `{}` 契约下 handler 签名写 `(_event, _req: {} | undefined)` 与 preload `invoke(ch, {})` 显式传参对齐（settings:req: void 的通道则直接省略 req 参数，两者刻意不同）

## 任务 5：订单附加信息 DAL（sale-extra.repo.ts）

- **better-sqlite3 无 `??` 展开占位符**：`WHERE sale_id IN (??)` 会抛 `near "?": syntax error`——必须按入参个数动态生成 `?,?,?` 占位符字符串再 `prepare`。空数组提前返回空 Map 不跑 SQL（避免 `IN ()` 语法错误）。这与 settings.repo 的 `setMany` 批量思路不同（settings 是循环单条 upsert，sale_extras 批量查是真 IN 查询）
- **upsert 双语句方案**（INSERT...ON CONFLICT DO NOTHING + 动态 SET UPDATE）：单条 `INSERT...ON CONFLICT(sale_id) DO UPDATE SET` 无法优雅处理「patch 只含部分键时 INSERT 部分用默认值、UPDATE 部分只改出现的键」——DO UPDATE 的 SET 子句里对未提供键用 `excluded.列` 会覆盖回默认值（丢已有数据）。故拆两步：① DO NOTHING 建行（未提供键走 DEFAULT）② 动态拼 `UPDATE SET 只含 patch 出现的列 WHERE sale_id=?`。patch 无键时跳过 UPDATE（建行已足够）
- **引用语义验证手法**：insert 后 `UPDATE customers SET name='张三丰'` 再 getWithCustomer → customer.name 即时反映新值。这证明了 customer_id 只存引用、LEFT JOIN 取最新行——与 sale_items 的商品快照（product_name 落库即固化）形成刻意对比。下游若需要快照语义须在 insert 时另行落库
- **is_national_subsidy 双向映射在 repo 层**：insert/upsert 入参 boolean → INTEGER 0/1（`boolToInt`），getWithCustomer/findBySaleIds 出参 INTEGER → boolean（`=== 1`）。DB 层永远不存 bool，全项目沿用此约定（见 learnings 任务 1）
- **getWithCustomer 的 LEFT JOIN 平铺手法**：customers 列用 `c_id/c_name/...` 前缀避免与 sale_extras 列名冲突；customer_id 非空但客户行不存在时 c.* 全 NULL（理论上 FK 保证不会发生，repo 层防御性 `c_id !== null` 判定后才组装 Customer 对象）
- **无自有 db.transaction**（D-SN8 豁免前提）：insert/upsert 只提供单条预编译语句，事务由调用方（service.checkout 结账事务）包裹。被外层事务包裹时 better-sqlite3 自动降级为 SAVEPOINT（嵌套安全，见 sale.repo.ts 注释）
- **测试构造 sales 行的坑**：`INSERT INTO sales (sale_no, total_cents, item_count) VALUES (?, 700, 2)` 的 SQL 字面量里只有 1 个 `?` 占位符但传 3 个参数会抛 `Too many parameter values were provided`——占位符个数必须与 bind 参数严格一致（要么全用占位符 `VALUES (?, ?, ?)`，要么全字面量 `VALUES ('20261101-0001', 700, 2)`）

## 任务 4：客户 DAL（customer.repo.ts）

- **D-SN8 跨 repo 豁免的实际形态**：customer.repo 与 product.repo 的事务惯例刻意相反——全部方法单条预编译语句、零自有 `db.transaction`（insert = INSERT + SELECT 回读两语句无包裹，同连接读己之写，结账事务内外均安全）；T7/T8 可放心把 insert/update 直接包进外层事务，不会产生 SAVEPOINT 嵌套语义
- **动态 SET × 预编译缓存的冲突解法**：「只 SET patch 中出现的键」与「语句缓存在工厂体内」天然冲突——落地为键组合 → Statement 的 Map 缓存（4 键非空子集至多 15 个，逐组合惰性预编译）；列名走 `UPDATE_KEYS` 白名单、值全参数绑定，无拼接注入面。键过滤用 `patch[k] !== undefined`（显式 undefined 的键跳过，防 better-sqlite3 绑定 undefined 抛错）
- **updated_at「刷新」断言的秒级分辨率坑**：`datetime('now','localtime')` 只有秒精度——同秒内 update 前后 updated_at 相等，`not.toBe` 断言会 flaky。确定性写法：测试先手动回拨 `updated_at = '2000-01-01 00:00:00'` 再 update，断言 `not.toBe('2000-01-01...')` + `startsWith(今日本地日期)`
- **本地 better-sqlite3.d.ts 的 namespace 已提供 `Database.Statement` 类型**——语句缓存容器（Map<string, Database.Statement>）无需绕道 ReturnType 派生
- 空 patch update no-op（0 键提前 return，不开语句）；list 的 keyword/total 双语句对（list/listAll + count/countAll）照 products:list 的 escapeLike + `ESCAPE '\'` 通配符字面匹配惯例

## 任务 7：客户管理业务层（customer.service.ts + customers.ipc.ts）

- **ServiceError 逐字复刻的实操细节**：`constructor(readonly code, message)` 参数属性 + `this.name = 'CustomerServiceError'`；message 内嵌现有客户姓名（`该电话已被客户「${existing.name}」使用`）——findByPhone 命中行直接取 name 组文案，renderer 零二次查询直接展示
- **update 查重「排除自身」不是优化是必须**：自己电话传原值（trim 后等于库中现值）也会 findByPhone 命中自己——不判 `hit.id !== id` 则「改个备注都报电话冲突」；测试用例 5 锁定该语义
- **UNIQUE 兜底 catch 的可达性条件**：patch 不含 phone 时其余列无 UNIQUE 约束，兜底映射必须加 `normalized.phone !== undefined` 前置——否则理论上可能把无关 SQL 错误吞成 PHONE_EXISTS；create 无需此判断（phone 恒有值）
- **无 any 收窄 better-sqlite3 错误形态**：`err instanceof Error && ((err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('UNIQUE'))` 双形态识别（code 优先、message 兜底），`as { code?: unknown }` 非 any 合法收窄
- **IPC 薄层归一的分寸**：create 四字段 `?? ''`（缺 phone → 可诊断的 CUSTOMER_PHONE_REQUIRED 中文文案，而非 undefined.trim() 的 TypeError）；update 的 id 哨兵 `?? -1`（照 sales:void 惯例）→ service 回读落空 → NOT_FOUND；list 的 keyword/limit/offset 全 undefined 透传，trim/缺省 20/0/上限 100 clamp 统一在 service（IPC 零业务规则）
- **repo 静默语义的 service 兜底实测**：update(99999) repo 静默 0 行 → service 回读 getById 落空 → CUSTOMER_NOT_FOUND（'客户不存在（可能已被删除）'——本期无删除，防御性保留错误码值得）
- **并行任务的 typecheck 验证口径**：node 侧报错全在 sale.service.ts（T8 进行中 import 未使用）时以「自己的文件零错误」为通过线——全量 tsc 输出里过滤不出本任务文件即干净，不越界修并行半成品（T8 会自己收尾）
- **create 拦截顺序的落库断言**：phone 空串用例追加 `SELECT COUNT(*)` 断言零落库——锁定拦截发生在 INSERT 前（DB 侧空串可插一次的坑必须 service 前置，见任务 1）

## 任务 8：checkout 附加信息 + updateExtra + getDetail 装配（sale.service）

- **T2 占位替换的隐性消费方**：sale.repo.getDetail 改为返回 `Omit<SaleDetail,'extras'>`（extras 装配上移 service 层，repo 不跨表 JOIN——保持销售 DAL 单一职责）后，除 sale.service 两处外还有第三个消费方 printing.ipc.ts:161（orchestrator getSaleDetail 回调，print.service deps 接口要完整 SaleDetail）必须同补 `saleExtraRepo.getWithCustomer` 接线——替换契约必填字段的占位前先 grep 全部调用点，否则 typecheck 才暴露
- **"电话空 → 不建档"不是偷懒而是安全语义**：phone 是唯一查找键 + NOT NULL UNIQUE（空串占位只可插一次）→ customer 处理条件收窄为 `phone trim 非空`；只有 note 的 customer 不建档只写 extras 行（customer_id=null），既避开空串二插 UNIQUE 崩事务，又通过校验规则闭环（name/address 非空 ⇒ phone 必填，phone 非空不反向要求 name）
- **updateExtra 的 final 状态校验形态（Q5）**：final customer = `patch.customer !== undefined ? patch 值 : existing JOIN 值`（null 是显式提供的"解绑"值，与 undefined"不动"三态区分）；推论：解绑国补单客户（customer:null）会被 final subsidy 校验拦截——想解绑必须同时取消国补标记，这是综合校验的自然结果而非特例分支
- **回滚验收主测试的"预置已售"手法**：`UPDATE product_sns SET status='sold'` 直接 SQL 预置（不经 checkout 二次结账），保证 sales 初始 0 行可断言四表零残留；若用先结账再卖同 SN 的写法，第一单已存在，sales=0 断言不成立
- **SELECT \* 直读的 toEqual 形状坑（测试侧）**：extraRow/customerRow 直读含 sale_id/id/created_at/updated_at 列——精确断言要么补齐全字段（sale_id: receipt.id），要么 toMatchObject；存量测试常用 toMatchObject 正是为此
- **settings 事务内写回滚零残留可测**：settingsRepo.set 是单条 INSERT OR REPLACE 预编译语句（D-SN8 豁免前提成立），checkout 事务内 push recent_salespersons 后中途失败 → settings 表无该 key 行（`repo.get(KEY) === null` 断言），无需手工清理

## 任务 9：日报国补小计 + 明细两列（repo JOIN + 三导出器 + ReportsView 原子变更）

- **聚合 JOIN 的零倍增前提**：sale_extras.sale_id 兼任 PK（1:1 旁挂）→ `LEFT JOIN sale_extras` 后 COUNT(*)/SUM(total_cents) 语义不变；无需 GROUP BY sales.id 防行倍增——这是 1:1 表设计的红利，若未来改 1:N 必须重审
- **国补小计的 SQL 形态**：`COALESCE(SUM(CASE WHEN se.is_national_subsidy = 1 THEN total_cents ELSE 0 END), 0)`——NULL = 1 判定不成立走 ELSE 0（LEFT JOIN 未命中的旧单天然归非国补）；外层 COALESCE 兜空集日（SUM 无行返回 NULL 非 0——与既有 total_cents 同款双保险）
- **尾部追加原则的实操收益**：xlsx 明细 getCell('D')（合计列金额格式）与汇总 B2（总销售额）零改动即保持兼容——E2E reports.spec 的 td nth(2)/nth(3)、`.el-tag` 计数、汇总 B2/B3/B4 断言全部不受波及；ReportsView 国补列 false 渲染纯文本「否」而非 el-tag 正是为此（tag 计数只数状态列）
- **docs docx 表头断言手法**：jszip 解 document.xml → 首个 `<w:tbl>` 的首 `<w:tr>` → `<w:t(?: [^>]*)?>([^<]*)` 提取单元格文本数组——`toEqual` 7 项同时锁列序与长度；`<w:tr[^>]*>` 容 trPr 属性、`</w:tr>` 与 `</w:trPr>` 不混淆（`>` 边界锚定）
- **月报禁区的回归锁**：三个导出器测试各加「月报零国补内容」断言（txt not.toContain / xlsx A5 null / docx not.toContain）——把 MUST NOT DO 的范围纪律固化成可执行断言，防止后续任务误染月报
- **汇总行/列宽的条件采样**：xlsx 汇总新行标签（国补销售额（元）= 16 半角）长于既有最长样本（总销售额（元）= 14）——autoWidth 的 samples 数组必须条件展开纳入新标签，否则列宽不足内容被裁；「不改既有列宽」的约束针对列序坐标，自适应重算是设计内行为
- **T2 占位替换的检验捷径**：report.service.test 既有 4 处 exact-shape（toEqual）在真实 JOIN 后**零修改即过**——测试库无 sale_extras 行时 LEFT JOIN 产出的 false/null/0 与占位值恒等，占位语义「旧单准确」的声明被反向验证；新场景断言另起 describe（insertExtra helper + FK 先插 sale 后插 extras）
- **跨任务全量跑的 flaky 判别**：工作区并行任务（T7/T8 的 customer/sale 文件在 git status 可见）导致偶发失败时，用失败片段 grep 定位归属文件——属他人领域且重跑即绿则与本任务无因果，不追不修（范围纪律）

## 任务 12：销售明细弹窗附加信息区（SalesHistoryView 展示+编辑）

- **vi.hoisted 前置 window.api stub 是硬需求**：SalesHistoryView → printing.store import 链在**模块顶层**即读 `window.api.invoke`（printing.store:17 typedInvoke 工厂调用），beforeEach 里赋值来不及——必须 `vi.hoisted` 内先 `window.api = {...}` 再静态 import 视图；jsdom 环境先于 hoisted 就绪，`window` 可用。mock 对象全测试共享同一引用（printing.store 持首份 invoke fn），per-test 只 mockReset + 重设 implementation，不重建对象
- **vitest.config.ts 需补 `@renderer` alias**：组件 SFC 用 `@renderer/*` import（SalesHistoryView 的 ReceiptPreviewDialog/printing.store），vitest 侧此前未注册——ReceiptPreview/CustomersView 既有组件测试恰好只走相对路径未暴露。三方同步源：electron.vite.config.ts renderer alias + tsconfig.web.json paths + vitest.config.ts resolve.alias
- **EP attrs 落点差异**：el-input 的 data-testid 落在 inner input（attrs 转发给原生 input，setValue 直达）；el-switch/el-select/el-button 落在根元素。el-switch 激活态 class 是 `is-checked`（无 --wide 之类宽度 class），点击根元素即切换 modelValue
- **script setup 内部状态的测试侧直达**：@vue/test-utils `wrapper.vm` 经 createVMProxy 读 setupState——`vm.extraForm.salesperson = 'x'` 可写（reactive 直达）；el-select allow-create 的下拉交互 jsdom 不便，salesperson 字段单走此通道，其余（switch click/input blur/textarea setValue/button click）全走真实 DOM 事件。TS 收窄 `(wrapper.vm as unknown as {...})` 非 any
- **patch 组装防 stale-match**：blur 联想结果存 phoneMatch 后，用户可能改输入未再 blur 直接保存——saveExtra 内 `phoneMatch.phone === 当前输入` 才复用，否则补查 customers.list（测试锁定：无 blur 直接保存也发补查）
- **命中档案必须原值回传**：updateExtra 的 find-or-create「命中即 PUT 覆盖档案」——UI 只传 phone 会把既有客户 name/address/note 覆写为空串（数据丢失）；正确做法是 blur/save 联想命中后回传命中行四字段原值（同值覆写 no-op），未命中才传空串建裸电话客户
- **「保存后刷新」零额外 IPC**：updateExtra res 即更新后完整 SaleDetail（头+items+extras），赋值 detail + initExtraEdit 重拍表单快照即完成「重新拉 detail」语义；引用语义验证点（改档案重开反映）由 openDetail 每次重拉 sales:detail 天然满足
- **消费契约类型的组件内派生**：`type SaleExtraPatch = Omit<IpcChannels['sales:updateExtra']['req'], 'sale_id'>`——与 preload SalesApi.updateExtra 第二参同源，契约改动自动传导
- **el-tag 计数惯例延伸到弹窗**：detail-extras 容器内 .el-tag 恒为 subsidy?1:0（true→success「国补」，false→纯文本「否」），编辑区零 el-tag；列表页状态列 tag 在容器外互不干扰
- **T14 E2E 关键 selector（第 7 组：订单侧改附加）**：展示区容器 `[data-testid="detail-extras"]`、客户四行 `detail-customer-name/-phone/-address/-note`、散客占位 `detail-customer-placeholder`、国补 `detail-subsidy`（内 .el-tag 或文本「否」）、备注/人员 `detail-order-note`/`detail-salesperson`；编辑区容器 `extra-edit`（仅 completed 渲染）、四字段 `extra-is-subsidy`/`extra-customer-phone`/`extra-salesperson`/`extra-order-note`、电话联想提示 `extra-phone-hint`（将关联：X / 将解绑客户（保存后生效） / 将以「X」新建客户）、保存按钮 `extra-save`（无改动禁用、保存中 is-loading）。入口：行按钮「查看明细」或双击行
- **并行任务全量跑判别（T7 纪律再现）**：全量 7 失败稳定归属 CustomersView.test.ts（T11 弹窗不关断言）/CheckoutDialog.test.ts（T10 校验矩阵），失败为断言逻辑非模块解析——与 vitest alias 新增无因果；typecheck:web 唯一错误在 CustomersView.vue:166（T11 漏 patch: 包装），grep 本任务三文件零错误即过线

## 任务 11：客户管理页（CustomersView + 路由 + 菜单）

- **【关键】vitest 下 el-form 校验静默假通过（测试假绿级坑）**：element-plus 的 .mjs 子模块默认被 vitest 外部化走 Node 原生 ESM import，其内部 `import AsyncValidator from 'async-validator'` 因 Node 不认 __esModule 拿到 `{__esModule, default}` 对象而非构造器 → `new AsyncValidator()` 同步抛 TypeError → `onValidationFailed(undefined)` 解构再抛 → field 级 validate reject(undefined)、**form 级 validate() 把 undefined 展开进 catch 后 resolve true**——校验规则完全跳过但测试照样绿。修复：vitest.config.ts `test.server.deps.inline: ['element-plus']`（走 vite interop 拿到真 Schema）。生产 renderer 走 vite/rollup 打包无此问题。**后续任何 el-form 组件测试都依赖这行配置，删了即全体假绿**
- 诊断手法：monkey-patch `AsyncValidator.prototype.validate` 打日志（>> AV HIT 不出现=构造器就没拿到）；validateState 卡 'validating' + reject(undefined) = doValidate 同步炸的特征签名
- **el-dialog 关闭断言策略**：destroy-on-close 的内容销毁挂 leave transition 的 afterLeave（0 时长回退依赖 nextFrame=2×rAF，jsdom 不推进）→ `exists()===false` 必 flaky；改断言 `.el-overlay` 的 `style.display==='none'`（v-show 同步生效，用户视角等价）。弹窗保持打开断言 `display!=='none'`
- el-form 错误文案（.el-form-item__error）经 `refDebounced(validateState, 100)` 显示——断言前须真实 `setTimeout ≥150ms`，flushPromises 等不到
- jsdom 挂载 el-table 需 stub ResizeObserver（纯空实现即可渲染行）；ElMessage spy 用 `vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: () => undefined }))`——**MessageHandler 是 `{ close }` 接口不是裸函数**，返回裸函数 vue-tsc 报错；同一 element-plus 模块实例 spy 对组件 import 生效
- **T7 遗留 preload 类型 bug（本次顺手修正）**：`customers:update` 第二参数类型写成 `Omit<req,'id'>`——Omit 只删了 id 还剩 `{ patch: {...} }` 嵌套。按类型调用（传嵌套）会让 handler `req.patch={patch:...}` → service 收 0 个有效键 → **编辑保存静默 no-op**（回读返回原行，不报错）。修正为 `IpcChannels['customers:update']['req']['patch']`（index.ts + index.d.ts 双文件同步改，实现零改动）。教训：Omit 派生 patch 形状要 Omit 到叶子，别只剥外层 id
- 服务端分页单路径模式：`watch(page, () => void load())` + 搜索防抖回调里「page!==1 则置 1（watch 触发重查），否则手动 load()」——避免复位页码时双请求
- 电话冲突链路（对齐后端语义）：前端只做 phone trim 非空（文案「电话不能为空」，与后端 CUSTOMER_PHONE_REQUIRED 的「客户电话不能为空」刻意区分）；CUSTOMER_PHONE_EXISTS 的 message 含现有客户姓名，catch 里 ElMessage.error(extractIpcErrorMessage(err)) + 弹窗不关 + 不刷新——用户改号重交
- 搜索防抖测试：`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` 限定只 fake 定时器（别 fake Date/微任务），200ms 未触发 + 300ms 触发两段断言

### T14 E2E 关键 selector（CustomersView）
- 搜索框 `[data-testid="customer-search"]`（placeholder「姓名或电话」）；新增按钮 `[data-testid="customer-create-btn"]`
- 行内编辑 `[data-testid="customer-edit-btn"]`（每行一个，可 .first() 或配合行文本定位）；表格 `[data-testid="customer-table"]`
- 弹窗表单 `[data-testid="customer-name" / "customer-phone" / "customer-address" / "customer-note"]`，保存 `[data-testid="customer-save-btn"]`
- 空态文案「暂无客户」/ 搜索空态「未找到匹配客户，换个关键词试试」；电话冲突错误走 `.el-message--error` 含「该电话已被客户」；无删除按钮/接口（MUST NOT DO 固化：测试断言全页无「删除」文案）

## 任务 10：CheckoutDialog + PosView 接线（结账弹窗）

- **T13 E2E 适配依赖的 selector 定案**：确认按钮 class `.checkout-dialog__confirm`（同 data-testid），取消 `.checkout-dialog__cancel`；其余 testid——合计 `checkout-total`、客户四输入 `checkout-customer-name/phone/address/note`、国补开关 `checkout-subsidy-switch`、订单备注 `checkout-order-note`、销售人员 `checkout-salesperson-select`、关联提示 `checkout-customer-hint`
- **EP 表单错误文案渲染有 100ms 防抖**：`shouldShowError` 读的是 `refDebounced(validateState, 100)`——`is-error` class 即时但文案延后；组件测试断言错误文案必须 `vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout'] })` + `advanceTimersByTime(150)` + flushPromises（照 T11 防抖同款）；只断言阻断（不 emit）则无需 timers
- **EP jsdom 组件测试三件套**（T11 套路复用）：ResizeObserver stub 必需（popper/表格布局）；`window.api = {...} as unknown as Window['api']` 部分注入（组件只消费 getRecentSalespersons/customers.list 两通道）；el-input 的 attrs（含 data-testid）透传到原生 input/textarea → `find('[data-testid=x]').setValue/trigger('blur')` 直用
- **el-select 下拉选项跨 wrapper 断言**：popper 无条件 teleport 到 body → `document.body.querySelectorAll('.el-select-dropdown__item')`（先 `.el-select__wrapper` click 打开）；afterEach 必须 `wrapper.unmount()` 清 teleport 残留防跨用例泄漏
- **SFC 可测性要求全相对路径 import**：vitest.config.ts 无 `@renderer` alias——CheckoutDialog.vue 用 `../../stores/cart.store` + `../../../../shared/...`（CartPanel 的 @renderer 写法只因其无组件测试）；PosView 挂在视图层不受限
- **watch(visible) 直开挂载不触发**：mount 时 visible=true 不会跑 onChange——补 `{ immediate: true }`（真实应用初始 false 走 early-return 零副作用）；另观察到加 immediate 前后 validate() 出现整体放行→阻断的翻转（未完全归因的挂载时序敏感，复跑稳定为正确行为，二次出现优先怀疑这里）
- **extras 组装空串安全**：后端 trim 归一（order_note/salesperson `'' → null`，salesperson 空不入最近队列）——UI 侧全空→undefined（快单）、有值→全字段 trim 串照传即可，无需前置归一
- **电话失焦查客户只认 phone 全等**：keyword 模糊命中名称/电话，`.find(c => c.phone === phone)` 防同名客户误关联；查询失败静默（预填是便利非依赖，后端 findOrCreate 仍以电话为准）；电话清空失焦→客户组整体重置（客户信息以电话为锚——note 缝隙的 UI 收紧同源于此）
- **国补开关 watch 即时重校验**：`validateField(['name','phone']).catch(() => undefined)`（EP validateField invalid 时 reject 必须吞）；切换浮出/消散错误优于提交时才报
- **弹窗确认回调架构**：弹窗只管表单（校验/预填/组装 extras）emit confirm；IPC（`window.api.sales.checkout(items, extras)`——preload 包装替代 typedInvoke+cast，返回已类型化 SaleDetail）与成功链路（关弹窗→cart.clear→openPreview→loadProducts，G3 语义原样）留在 PosView——取消零 IPC、失败弹窗不关可改后重试
- **防双击双层**：弹窗侧 `if (props.submitting) return` 守卫 + el-button `:loading`（loading 态本身不可点）；父视图 checkingOut 同步置位驱动两处

## 任务 14：客户与附加信息 E2E（customer-extras.spec.ts，10 用例两轮全绿）

- **T14 实测 selector 补遗**：CheckoutDialog 合计金额条 `checkout-total` testid 在容器 div（文本「合计金额¥3.50」含 label）——精确金额断言用容器内 `.checkout-dialog__total-value`；弹窗本体定位用 `.el-dialog` filter `hasText: '合计金额'`（本弹窗独有文案，与小票预览/销售明细互斥不撞车）
- **el-select allow-create 录值的稳态手法**：点根元素开下拉 → `locator('input').fill(文本)` 触发过滤 → 按 aria-controls 圈定的 `#listboxId .el-select-dropdown__item` 点创建选项（比 Enter 键路径确定——不依赖 default-first-option 高亮时序）；录入后根元素 `toContainText` 验证已选中
- **【关键坑】el-select 下拉 popper 不收会拦截后续按钮点击**：`expectSelectOptionVisible` 只点开断言不录入，下拉保持展开时其覆盖层（`el-popper-container` 内 `is-hovering` 的 option li）拦截取消按钮 pointer events（30s 超时反复 retry）——收起手法：点弹窗内非交互区（合计条 div）触发 EP select 的 click-outside 收起；勿用 Escape（el-dialog 默认 esc-close 可能连带关弹窗）
- **【关键坑】跨用例残留 success toast 叠加 strict 冲突**：上一用例「已加入购物车」toast（3s 退场）未消失时下一用例的「已导出」toast 入场——`.el-message--success` 解析出 2 元素 strict violation；修复：toast 断言一律按文案 `filter({ hasText: '已导出' })` 定位本条，`toHaveCount(0, { timeout: 6000 })` 等全部退场（比 reports.spec 原版 helper 更稳——原版依赖用例间天然时距）
- **勾国补 + 换绑新电话的组合语义**（场景 7 设计依据）：updateExtra 综合校验下 final subsidy=true 且新客户 name='' 必被拦（「参与国补需填写客户姓名和电话」）——改附加的「改国补」走开→关（目标单先有国补），换绑裸电话才放行；编辑区无姓名输入框是根因（find-or-create 裸电话 name 只能空）
- **电话冲突场景的号码编排**：场景 7 find-or-create 先占了 13900139000（裸档），场景 8 新增李四同号必冲突——顺势把「再建同号冲突」拆两段：先冲突（message 含空名「」）、改号 13900139001 重交成功、编辑改名李四丰后再建同号得带名冲突 message（「李四丰」）——一次编排覆盖两种 message 形态
- **串行共享实例的状态接力**：`subsidySaleNo`/`subsidy9SaleNo` 模块级变量在 DB 断言块内顺路捕获（scenario 2/9），供后续销售记录双击定位与导出行定位复用；购物车跨场景接力（场景 4 取消保留 → 场景 5 复用 → 显式清车），结账成功自动清车无需手动
- **xlsx 导出行定位**：明细 sheet 按单号扫 `A2..A{actualRowCount}` 找行号再断言 `F/G` 列值（'是'/'国补订单留档'）——比写死行号稳（repo ORDER BY created_at,id 但行号耦合数据）；docx 读回照 docx.exporter.test 的 jszip → document.xml → `<w:tbl>` 首行 `<w:t>` 提取 7 列表头
- **场景 7 的下游闭环断言**：明细弹窗改国补/备注后，日报表 td nth(5)=「否」+ nth(6)=新备注 + subsidy el-tag--success 恰 1 个——单点编辑的报表下游影响在同 spec 内锁定（跨页接力：/sales-history → /pos → /reports）

## 任务 13：CheckoutDialog 存量 E2E 适配（结账"一键落库"→"弹窗确认"）

- **17 处清单法（grep 即工单）**：`grep -rn "cart-panel__checkout" tests/e2e/ tests/e2e-qa/` 输出即完整工作清单——11 click（pos 1 / print-flow 2 / template-editor 1 / sn-products helper 1 / qa-edge 2 / qa-integration 4）+ 6 断言（pos 4 + qa-edge 2，disabled/enabled 逻辑与弹窗无关，零改动核验通过）
- **标准插入 5 行**：点结账 → `expect('.checkout-dialog__confirm').toBeVisible()` → click——不填任何字段直接确认 = 散客快单路径（后端 extras undefined，与旧一键结账零行为差异）；弹窗动画用 toBeVisible 惯例等待，Playwright click 自带 actionability（fade 不动 bounding box），零固定 sleep
- **notepad selector 记录与实际 DOM 的偏差**：T10 learnings 记「确认按钮 class `.checkout-dialog__confirm`（同 data-testid）」——实际 data-testid 是连字符 `checkout-dialog-confirm`（双下划线只是 class）；教训：notepad 是索引不是事实源，动手前必须读组件 template 段核（任务书"以实际 DOM 为准"即为此）
- **dialog 过滤正则含「结账」的特例**：template-editor 的 `filter({ hasText: /小票|预览|结账/ })` 瞬时命中关闭动画中的确认弹窗（strict mode 双匹配）——插入后补 `expect(confirmBtn).toBeHidden()` 等销毁（destroy-on-close）再断言；其余 10 处过滤串 '小票预览' 与确认弹窗无文本交集，天然免疫
- **serial 套件被存量失败挡路的分段验证法**：qa-integration describe.serial 遇 A1-进货（陈旧）失败即级联跳过下游 4 处结账用例——`--grep-invert "A1-进货"` 跑通插入 #6（止步跳过进货的库存差量 18 vs -2）；`--grep "前置|目标"` 组合逐点验证 #7（17 vs -1）/#8（止步新模板 footer 前置缺失，预览已开单号已提取）/ #9（A5 全绿）——插入点后的预览/单号/打印断言全过即证明插入本身正确
- **存量失败归属判别（stash 对照）**：smoke 菜单 7→8（T11 遗漏）、A1-进货/A3-模板编辑（UI 进化未同步）三处均 stash 干净 HEAD 复现——与本任务无因果，记录 problems.md 报告不修（范围纪律：qa 非结账用例禁改）

## 任务 13 收口（Wave 5）：存量归属判别 + 菜单计数机械同步

- **归属判别的实证规程**：不凭推测下结论——`git stash → git checkout 4920f1f → npx playwright test -c playwright.qa.config.ts --grep "A1-设置|A1-商品|A1-进货" → git checkout - && git stash pop`；4920f1f 复现失败 = 计划前存量（报告不修），通过 = 计划内引入（须二分修复）。本次 A1-进货/A3-模板编辑 均在 4920f1f 复现 → 双双存量。辅助铁证：`git diff 4920f1f HEAD --stat -- tests/e2e-qa/` 为空（计划 commits 零触碰 qa 文件）
- **判别脚本的安全写法**：playwright 失败退出码非零——多步判别命令用换行分隔（非 && 链），保证 checkout - / stash pop 恢复步骤必然执行；untracked 文件（T14 spec）checkout 原地保留且不在 qa testDir 内零干扰
- **行号漂移自检**：同一测试在 HEAD 报 504:7、在 4920f1f 报 495:7——差值恰为工作区未提交的 +19 行（我的插入），证明两处跑的是不同版本测试文件，判别口径自洽
- **smoke 菜单计数的隐性第二处**：加 NAV_ITEMS 条目必须同步 IMPLEMENTED_ROUTES——smoke 第 3 用例遍历点击 NAV_ITEMS，未实现路由断言占位页（placeholder-page__title/建设中）；新路由已实现却不加白名单 → 对真实页面断言占位必挂。标题/count/数组三处之外容易漏这处
- **最终收口状态**：基线 88/88 全绿（75+smoke 恢复 3+customer-extras 10）；qa 8 passed/1 failed（A1-进货，实证存量）+11 serial 级联——「属存量 → 其余全绿即可」达成，无本计划新增失败

## L3：F2 审查 3 个 minor nit 清理（零行为变化）

- **`req?.extras ?? undefined` 是恒等式**：optional chaining 的结果类型本身就是 `T | undefined`，`?? undefined` 纯冗余——IPC 薄层里同模式的 `req?.items ?? []` 有语义（缺省空数组），但 extras 的缺省值就是 undefined，两者别混淆
- **extractIpcErrorMessage 实为 5 份拷贝而非 4 份**：grep 全仓才发现 stores/printing.store.ts 还藏着一份（T8 模式，实现语义相同但 `matched[1]` 无非空断言 `!`）。因不在 L3 授权文件集（与 L1/L2 并行零交集约束）未动，留待后续 nit——下次提取公共 util 前先全仓 grep，别信审查报告的计数
- **renderer 专属 util 选址**：renderer/src 下原本没有 utils/ 目录（formatMoney 在 shared/utils），本次新建 `renderer/src/utils/ipc-error.ts` 并以 `@renderer/utils/...` 别名 import（与 `@renderer/stores`、`@renderer/components` 既有惯例对齐）——跨 main/renderer 复用的才进 shared，纯 renderer 的放这里
- **动态 SQL 语句缓存的键设计**：照 customer.repo updateStmtCache 模式，cacheKey = 白名单列名 `join(',')`；列联合类型用 `type UpsertCol = (typeof UPSERT_COLUMNS)[number]['col']` 从 as const 数组派生，避免手写重复且无注入面（列名非用户输入）
- **并行任务下的验证归因法**：vitest 唯一失败先查 git status/diff 对照改动归属，再看错误栈调用链——本次失败测试直调 `service.checkout` 在 `assertValidExtras` 抛错（L1/L2 自己的校验收紧 vs 测试期望中间态），链路不经过 IPC 层/视图层/repo 层任何我改的文件；两次运行失败数 2→1 也佐证对方活跃推进中。禁止越界代修并行领域的测试
