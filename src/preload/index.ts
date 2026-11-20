import { contextBridge, ipcRenderer } from 'electron'
import type { PosApi } from '../shared/types/ipc'

/**
 * preload 桥：window.api 的运行时实现。
 *
 * 类型单一真源 = shared/types/ipc.ts：
 * - `const api: PosApi` —— 方法签名（req 整形 + res 类型）全部由契约派生，
 *   本文件不再手写任何返回类型注解（历史教训：手写镜像与契约漂移，
 *   sales:checkout 曾声明 Sale 实际 SaleDetail）；
 * - window.api 的全局类型声明在 index.d.ts（仅 3 行，引用同一 PosApi）。
 *
 * 便捷参数 → 通道请求体的整形规则（如 checkout(items, extras) →
 * { items, extras }）由 PosApi 接口钉死，实现只做透传。
 */
const api: PosApi = {
  ping: () => 'pong',

  /**
   * 底层类型化 IPC 入口（G8）：renderer 侧经 shared/types/ipc.ts 的
   * createTypedInvoke 包装后按 IpcChannels 契约调用，通道名不散落裸字符串。
   *
   * 已接受风险（P3，本批不收窄——omo 评估 + 用户裁决）：本入口对 preload
   * 暴露面是 string 通道（类型约束在 renderer 侧 wrapper）。不做运行时通道
   * 白名单的理由是成本收益：renderer 不加载远程内容 + contextIsolation +
   * nodeIntegration:false 已闭合主要威胁面，收窄需改 5 个 createTypedInvoke
   * 调用点，属纵深防御而非补缺口。
   * ★ 触发重估条件：一旦未来任何页面开始加载远程内容（http 页面/远程组件），
   *   立即改为按 typedHandle 运行时注册集（typed-handle.getRegisteredChannels）
   *   做通道白名单校验。
   */
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),

  /**
   * 扫码枪条码订阅（主进程 before-input-event 检测桥推送，绕过 IME）。
   * 返回取消订阅函数（页面卸载时调用，防泄漏）。
   */
  onBarcode: (cb) => {
    const listener = (_event: unknown, code: string): void => cb(code)
    ipcRenderer.on('scanner:barcode', listener)
    return () => ipcRenderer.removeListener('scanner:barcode', listener)
  },

  // ── 销售（Task 10：结账 + 作废 + 查询；Task 2 契约：附加信息）──
  sales: {
    /** 结账（单事务落库；返回完整明细 头+items+extras；金额整数分） */
    checkout: (items, extras) => ipcRenderer.invoke('sales:checkout', { items, extras }),
    /** 整单作废（事务回滚库存 + status='voided'） */
    void: (saleId) => ipcRenderer.invoke('sales:void', { sale_id: saleId }),
    /** 销售列表（按日期/状态/客户姓名/电话/国补过滤，最新在前） */
    list: (filters) => ipcRenderer.invoke('sales:list', filters ?? {}),
    /** 单据明细（头 + items + extras） */
    detail: (saleId) => ipcRenderer.invoke('sales:detail', { sale_id: saleId }),
    /** 修改销售附加信息（sale_extras 1:1 upsert；customer null = 显式解绑） */
    updateExtra: (saleId, patch) =>
      ipcRenderer.invoke('sales:updateExtra', { sale_id: saleId, ...patch })
  },

  // ── 进货（Task 9：入库单 + 库存联动 + 流水）──
  purchases: {
    /** 新建进货单（单事务：单据+快照明细+库存累加+流水；金额整数分） */
    create: (req) => ipcRenderer.invoke('purchases:create', req),
    /** 进货单列表（头+明细，最新在前；可选日期过滤） */
    list: (filters) => ipcRenderer.invoke('purchases:list', filters ?? {})
  },

  // ── 商品（Task 8：CRUD + 搜索 + 手动库存调整流水）──
  products: {
    /** 商品列表；keyword 匹配名称子串/条码前缀（行含 willOrphan） */
    list: (keyword) => ipcRenderer.invoke('products:list', { keyword }),
    /** 新建商品（金额整数分；初始库存非 0 时主进程写流水 source='manual'） */
    create: (req) => ipcRenderer.invoke('products:create', req),
    /** 编辑名称/默认售价/SN 前缀（条码/tracking 不可改——契约语义） */
    update: (req) => ipcRenderer.invoke('products:update', req),
    /** 手动调整库存为绝对目标值（主进程写流水 source='manual'——G5） */
    updateStock: (req) => ipcRenderer.invoke('products:updateStock', req),
    /** 逻辑删除（软删）商品；返回 willOrphan=删除时关联的历史单据行数 */
    delete: (id) => ipcRenderer.invoke('products:delete', { id }),
    /** 按 SN 精查（收银扫码第一优先级 D-SN5；未命中/已删除返回 null） */
    findSn: (sn) => ipcRenderer.invoke('products:findSn', { sn }),
    /** 商品 SN 列表（默认在库；includeSold 含已售，已售行带关联单号） */
    listSns: (productId, includeSold) =>
      ipcRenderer.invoke('products:listSns', {
        product_id: productId,
        include_sold: includeSold
      }),
    /** 删在库 SN（逻辑删除 + stock-1 + manual 流水；已售拒绝） */
    deleteSn: (snId) => ipcRenderer.invoke('products:deleteSn', { sn_id: snId })
  },

  // ── 客户（Task 2 契约层：结账客户信息）──
  customers: {
    /** 分页搜索（keyword 匹配名称/电话；返回行 + 总数） */
    list: (opts) => ipcRenderer.invoke('customers:list', opts ?? {}),
    /** 新建客户（phone NOT NULL UNIQUE；重号主进程报错） */
    create: (req) => ipcRenderer.invoke('customers:create', req),
    /** 局部更新（patch 至少一键；返回更新后全行） */
    update: (id, patch) => ipcRenderer.invoke('customers:update', { id, patch })
  },

  // ── 设置（Task 19：店铺信息 / 打印配置；多 Logo 架构）──
  settings: {
    /** 全量设置（缺 key 走默认值：通道 spooler、auto_cut true 等） */
    get: () => ipcRenderer.invoke('settings:get'),
    /** 增量保存（Partial upsert，事务写入；返回保存后的全量设置） */
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    /** Logo 列表（主进程读文件转 dataURL；文件缺失的行自动跳过） */
    listLogos: () => ipcRenderer.invoke('settings:listLogos'),
    /**
     * Logo 上传（主进程原生对话框选 png → 复制 userData/logos/<uuid>.png +
     * 入库）；用户取消时列表不变。返回完整最新列表。
     */
    uploadLogo: () => ipcRenderer.invoke('settings:uploadLogo'),
    /**
     * 删除 Logo（DB 行 + 文件；模板引用残留由渲染端跳过）。
     * 返回完整最新列表。
     */
    deleteLogo: (id) => ipcRenderer.invoke('settings:deleteLogo', { id }),
    /** 最近销售人员（recent_salespersons JSON 队列，新→旧；脏值主进程回落 []） */
    getRecentSalespersons: () => ipcRenderer.invoke('settings:getRecentSalespersons', {})
  },

  // ── 打印（Task 19：打印机枚举 + 测试打印；Task 15：小票预览 + 打印）──
  printing: {
    /** 系统打印机列表（Linux/无窗口环境优雅降级为 []——G11） */
    printers: () => ipcRenderer.invoke('printing:printers'),
    /**
     * 测试打印（真实生成链路：样例数据 + 当前默认模板 → 通道载荷）。
     * req 为设置页当前打印表单值；走串行队列（PrintQueue）。
     */
    testPrint: (req) => ipcRenderer.invoke('printing:testPrint', req),
    /**
     * RAW 编码探针（F1）：一张纸按顺序打多段编码假设，纸上结果决定系统
     * 打印通道能不能修好中文；driver 通道后端直接拒。
     */
    rawProbe: (req) => ipcRenderer.invoke('printing:rawProbe', req),
    /** 小票预览（Task 15）：与打印字节同一组装源头（G7） */
    preview: (saleId) => ipcRenderer.invoke('printing:preview', { sale_id: saleId }),
    /**
     * 小票打印（Task 15）：串行队列 best-effort；失败返回 { ok:false, error }
     * （error 含通道名 + 重打引导）——销售已落库不受影响（G3）。
     */
    print: (saleId) => ipcRenderer.invoke('printing:print', { sale_id: saleId }),
    /** 打印诊断（printer-diagnostics T1）：采集 → 规则 → 报告 */
    diagnose: (printerName) => ipcRenderer.invoke('printing:diagnose', { printerName }),
    /** 执行修复动作（L1 自动 / L2 确认后执行）；verify 为动作后复核报告 */
    repair: (actionId, targetPrinter) =>
      ipcRenderer.invoke('printing:repair', { actionId, targetPrinter }),
    /** 导出诊断报告（主进程 showSaveDialog 后写文件；成功返回 filePath） */
    exportReport: (report) => ipcRenderer.invoke('printing:diagnoseExport', { report })
  },

  // ── 模板（Task 16：小票模板 CRUD + 设默认）──
  templates: {
    /** 模板列表（按创建序；is_default 行为默认模板） */
    list: () => ipcRenderer.invoke('templates:list'),
    /** 新建（config_json 为模板 JSON 字符串；首个模板自动成为默认） */
    create: (req) => ipcRenderer.invoke('templates:create', req),
    /** 局部更新（name / config_json 至少其一） */
    update: (req) => ipcRenderer.invoke('templates:update', req),
    /** 删除（唯一模板时主进程守卫抛错） */
    delete: (id) => ipcRenderer.invoke('templates:delete', { id }),
    /** 设为默认（事务互斥：全表清零 → 目标置一） */
    setDefault: (id) => ipcRenderer.invoke('templates:setDefault', { id })
  },

  // ── 报表（Task 14：日/月报查询；Task 17：导出 .txt/.xlsx/.docx）──
  reports: {
    /** 日报（剔除 voided；空数据日零值不抛错；明细行带 status 标记） */
    daily: (date) => ipcRenderer.invoke('reports:daily', { date }),
    /** 月报（剔除 voided；含按日分桶 buckets——空月为 []） */
    monthly: (month) => ipcRenderer.invoke('reports:monthly', { month }),
    /**
     * 导出报表（主进程 showSaveDialog → 写文件 → 打开所在文件夹；
     * E2E_EXPORT_DIR 注入时直写固定目录——E2E 钩子）。
     * file_path null = 用户取消。
     */
    export: (req) => ipcRenderer.invoke('reports:export', req)
  }
}

contextBridge.exposeInMainWorld('api', api)
