
## 2026-11-07 Wave 3 验证发现：客户备注单独填写的数据归宿缝隙
- 场景：结账只填【客户备注】不填电话/姓名/地址——符合用户字面定案（"如填写姓名、地址则必须填写电话，其他均可空"）
- 现状：hasAnyExtra=true 会写 sale_extras 行，但 phone 空 → 不建档 → note 无载体，**静默丢弃**
- 处理决策：service 层保持宽松（镜像用户字面规则，不返工）；**T10 CheckoutDialog 的 UI 层收紧**——客户信息组以电话为锚（填任一客户字段提示需电话），防止无意义输入。E2E/F 审时复核

## 2026-11-07 L2 修复：备注缝隙升级为 UI+service 双防线（文案统一）
- 语义变更（用户终审确认）：「其他均可空」中的客户备注需电话承载——name/address/note 任一非空 ⇒ phone 必填
- service 层镜像（IPC 可绕 UI 直达 service，前端规则不是防线——本项目铁律）：
  - assertValidExtras（checkout）：触发条件 name/address → name/address/note 任一
  - updateExtra PHONE_REQUIRED：同规则（nameT/addressT 基础上加 noteT）
  - 文案统一：'填写客户姓名或地址时，电话不能为空' → '填写客户信息时，电话不能为空'；UI note 分支原 '填写客户信息需提供电话' 一并并入（三触发同一文案）
- 不动项：国补综合校验（finalName/finalPhone）、hasAnyExtra（note 非空仍算「有附加内容」）、customer:null 显式解绑语义
- 测试：extras 单测 +3 用例（checkout note-only 拒绝零落库 / note+phone 合法建档有载体 / updateExtra note patch 拒绝）+ 改写 1 旧用例（note-only 静默丢弃行为已死 → 改为 order_note 合法等价形态，保留 customer_id=null 附加行覆盖）；CheckoutDialog 校验矩阵文案同步；E2E customer-extras 场景 4 红字文案同步
- 验证：vitest 43 文件 693 passed / 1 skipped（存量）+ typecheck node/web 两侧零错误
