import { isPrintChannelKind, type PrintChannel, type PrintChannelKind } from './channels/print-channel'
import { SerialChannel, DEFAULT_SERIAL_PORT } from './channels/serial.channel'
import { SpoolerChannel } from './channels/spooler.channel'
import { TcpChannel } from './channels/tcp.channel'
import { generateReceiptBytes, type ReceiptPrintVars } from './escpos/escpos-generator'
import { isValidReceiptTemplate } from '../db/repositories/template.repo'
import { DEFAULT_TEMPLATES } from '../../shared/receipt/default-template'
import type { SaleReceiptData } from '../../shared/receipt/item-columns'
import type { ReceiptTemplate, ReceiptVars } from '../../shared/receipt/template-schema'
import { formatMoney } from '../../shared/utils/money'
import type { AppSettings, PrintTemplate, SaleDetail } from '../../shared/types'

/**
 * Task 7 — print.service（通道编排部分）。
 *
 * - 通道编排（Task 7）：getChannel 分发 + PrintQueue 串行队列（上方，勿改）。
 * - 打印编排（Task 15，本段）：模板 + 销售 → generateReceiptBytes → 串行队列——
 *   预览（previewSale）与打印（printSale）共用同一份 buildReceiptPayload 组装
 *   代码（G7：两条渲染路径同源，Buffer 与 dataURL 的分叉只发生在分支出口）。
 *   T19（设置页）消费 getChannel 校验与 listSystemPrinters。
 */

/** 打印相关设置（settings 表键名与 ER 设计逐字一致） */
export interface PrintSettings {
  /** 'spooler' | 'tcp' | 'serial'；缺省默认 spooler（D5 主通道） */
  printer_channel?: PrintChannelKind
  /** spooler 通道：系统打印机名 */
  printer_name?: string
  /** tcp 通道：打印机 IP */
  tcp_host?: string
  /** tcp 通道：端口（默认 9100） */
  tcp_port?: number
  /** serial 通道：串口设备路径（默认 \\.\COM1） */
  com_port?: string
}

/**
 * 按设置分发通道实例。
 * 注意：printer_channel 值来自 DB 字符串，运行时校验（脏数据抛可诊断错误）。
 */
export function getChannel(settings: PrintSettings): PrintChannel {
  const kind = settings.printer_channel ?? 'spooler'
  if (!isPrintChannelKind(kind)) {
    throw new Error(`未知的打印通道：${String(kind)}（可选：spooler / tcp / serial）`)
  }
  switch (kind) {
    case 'spooler':
      return new SpoolerChannel({ printerName: settings.printer_name ?? '' })
    case 'tcp':
      return new TcpChannel({ host: settings.tcp_host ?? '', port: settings.tcp_port })
    case 'serial':
      return new SerialChannel({ port: settings.com_port ?? DEFAULT_SERIAL_PORT })
  }
}

/**
 * 打印任务串行队列（连续结账不交叠）：
 *  - Promise 链保证 job 严格按入队顺序执行，前一个 settle 后一个才开始；
 *  - 失败自动重试 1 次（同一字节重发）；
 *  - 二次失败：向调用方 reject（UI 引导重打，销售已落库不受影响——G3），队列继续。
 */
export class PrintQueue {
  private queueTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly channel: PrintChannel) {}

  enqueuePrintJob(bytes: Uint8Array): Promise<void> {
    const run = this.queueTail.then(() => this.sendWithRetry(bytes))
    // ★ 队尾吞掉失败：确保后续 job 不被前序 rejection 阻断（死锁防线）；
    //   失败本身仍通过返回的 run 交给调用方。
    this.queueTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async sendWithRetry(bytes: Uint8Array): Promise<void> {
    try {
      await this.channel.send(bytes)
    } catch {
      try {
        await this.channel.send(bytes)
      } catch (secondError) {
        const detail = secondError instanceof Error ? secondError.message : String(secondError)
        throw new Error(`打印任务失败（已自动重试 1 次）：${detail}`)
      }
    }
  }
}

// ═══════════════════ Task 15：打印编排（预览/打印同源组装） ═══════════════════

/** 打印编排器依赖（DI 注入：生产用 repo 实现，vitest 用 mock 数据/通道——单测不走真打印机） */
export interface PrintOrchestratorDeps {
  /** 销售明细（sale.repo.getDetail；未找到返回 undefined） */
  getSaleDetail(saleId: number): SaleDetail | undefined
  /** 默认模板行（template.repo.getDefault，含惰性 seed） */
  getDefaultTemplate(): PrintTemplate
  /** 全量设置（T19 rowsToAppSettings 映射后的 AppSettings） */
  getSettings(): AppSettings
  /** 按 logo id 读 Logo 文件 → PNG Buffer（行/文件不存在或不可读 → null）；生产实现在 ipc 装配处（logo repo 查行 → 读文件） */
  readLogoById(logoId: number): Promise<Buffer | null>
  /** 通道工厂：缺省 getChannel；测试注入 mock 通道捕获字节 */
  createChannel?(settings: PrintSettings): PrintChannel
}

/**
 * 打印载荷（组装产物——预览与打印的共同源头，G7）。
 * logoBuffers 仅主进程消费（generateReceiptBytes 的光栅输入；不跨 IPC）。
 */
export interface ReceiptPayload {
  /** 模板（voided 单已含「已作废」段落副本；config_json 已解析） */
  template: ReceiptTemplate
  sale: SaleDetail
  /** 明细行（display-ready：formatMoney 已格式化，buildItemLines 直接输入） */
  data: SaleReceiptData
  /** 变量插槽值（纯字符串，IPC 安全——T3 冻结契约形态） */
  vars: ReceiptVars
  /** Logo PNG 集合（image 段落 logoId → Buffer；读不到的 id 不在其中，warn 诊断） */
  logoBuffers: Map<number, Buffer>
}

/**
 * printing:preview 返回载荷：ReceiptPayload 的 IPC 形态——logoBuffers →
 * dataURL 集合（Buffer 不跨 IPC；契约 res 只声明 template+sale，本形态
 * 为其运行时结构超集）。
 */
export interface PreviewPayload {
  template: ReceiptTemplate
  sale: SaleDetail
  data: SaleReceiptData
  vars: ReceiptVars
  /** Logo dataURL 集合（logoId → dataURL；未引用/读取失败 → 无该 key，ReceiptPreview 的 logoUrls prop） */
  logoUrls: Record<number, string>
}

/** AppSettings → PrintSettings（T7 getChannel 参数；可空字段 null → ''/undefined 归一） */
export function appSettingsToPrintSettings(s: AppSettings): PrintSettings {
  return {
    printer_channel: s.printer_channel,
    printer_name: s.printer_name ?? '',
    tcp_host: s.tcp_host ?? '',
    tcp_port: s.tcp_port ?? undefined,
    com_port: s.com_port ?? undefined
  }
}

/**
 * 模板行 config_json 解析：结构非法（脏 JSON / 残缺结构）时按行声明的纸宽
 * 回落内置默认模板——预览/打印不因坏配置崩溃（编辑器保存链路有守卫，
 * 本兜底覆盖手改 DB 等旁路写入）。
 */
export function parseTemplateRow(row: PrintTemplate): ReceiptTemplate {
  try {
    const parsed: unknown = JSON.parse(row.config_json)
    if (isValidReceiptTemplate(parsed)) return parsed
  } catch {
    // 落入下方默认模板兜底
  }
  return DEFAULT_TEMPLATES[row.paper_width]
}

/** voided 单模板副本：footer 前插入「已作废」段落（倍高居中加粗——D19） */
export function withVoidedMark(template: ReceiptTemplate): ReceiptTemplate {
  return {
    ...template,
    footer: [
      { type: 'text', content: '=== 已作废 ===', align: 'center', size: 'doubleHeight', bold: true },
      ...template.footer
    ]
  }
}

/** PNG Buffer → dataURL（预览侧 Logo 数据源；MIME 固定 image/png——上传已限定） */
export function pngBufferToDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

/**
 * 收集模板 header/footer 中 image 段落引用的 logoId 集合
 * （去重升序；logoId 未指定的 image 段落不算——渲染时静默跳过）。
 * buildReceiptPayload（打印/预览）与测试打印（printing.ipc）共用的纯函数。
 */
export function collectSectionLogoIds(template: ReceiptTemplate): number[] {
  const ids = new Set<number>()
  for (const section of [...template.header, ...template.footer]) {
    if (section.type === 'image' && section.logoId !== undefined) ids.add(section.logoId)
  }
  return [...ids].sort((a, b) => a - b)
}

export function createPrintOrchestrator(deps: PrintOrchestratorDeps) {
  // 通道在 send 时按**当前设置**解析（设置页改通道后下一次打印即生效）；
  // PrintChannel.name 委派当前通道（仅日志/文案用途）。
  const resolveChannel = (): PrintChannel => {
    const settings = appSettingsToPrintSettings(deps.getSettings())
    return deps.createChannel ? deps.createChannel(settings) : getChannel(settings)
  }
  const settingsBoundChannel: PrintChannel = {
    get name(): PrintChannelKind {
      return resolveChannel().name
    },
    send: (bytes: Uint8Array): Promise<void> => resolveChannel().send(bytes)
  }

  // 串行队列：编排器实例级单例——生产装配一次（printing.ipc），连续结账的
  // 打印任务经同一队列严格串行不交叠（计划 MUST NOT：打印不得并行）。
  const queue = new PrintQueue(settingsBoundChannel)

  /**
   * 组装打印载荷（G7 唯一数据源）：sale 明细 → 默认模板 → settings →
   * ReceiptVars（formatMoney 元显示）+ ReceiptItemLine[]（display-ready）+
   * logoBuffers（image 段落 logoId → PNG Buffer）。
   * 预览（previewSale）与打印（printSale）共用本产物——两套渲染不得两套组装。
   */
  async function buildReceiptPayload(saleId: number): Promise<ReceiptPayload> {
    const sale = deps.getSaleDetail(saleId)
    if (!sale) throw new Error(`未找到销售单（id=${saleId}）`)

    const baseTemplate = parseTemplateRow(deps.getDefaultTemplate())
    // D19：作废单重打在 footer 前加印「已作废」——组装期生效（预览同步可见）
    const template = sale.status === 'voided' ? withVoidedMark(baseTemplate) : baseTemplate

    const settings = deps.getSettings()
    const vars: ReceiptVars = {
      shopName: settings.shop_name,
      shopPhone: settings.shop_phone,
      receiptNote: settings.receipt_note,
      saleNo: sale.sale_no,
      // created_at 即 DB localtime 写入（本地格式，G10 日界同钟）——原样透传
      datetime: sale.created_at,
      total: formatMoney(sale.total_cents),
      itemCount: String(sale.item_count)
    }
    const data: SaleReceiptData = {
      items: sale.items.map((it) => ({
        name: it.product_name,
        quantity: String(it.quantity),
        unitPrice: formatMoney(it.unit_price_cents),
        subtotal: formatMoney(it.subtotal_cents)
      }))
    }

    // 多 Logo：模板 image 段落引用的 logoId 逐个读取（主进程 Buffer，生成器
    // 光栅输入——G6）；读不到（行/文件缺失）→ warn 诊断后跳过，不影响打印
    const logoBuffers = new Map<number, Buffer>()
    for (const logoId of collectSectionLogoIds(template)) {
      const buf = await deps.readLogoById(logoId)
      if (buf) {
        logoBuffers.set(logoId, buf)
      } else {
        console.warn(`[print] 模板引用 logoId=${logoId} 但文件不可读，已跳过`)
      }
    }

    return { template, sale, data, vars, logoBuffers }
  }

  /** 预览载荷（printing:preview res）：与打印字节同一组装源头，logoBuffers → dataURL 集合分叉 */
  async function previewSale(saleId: number): Promise<PreviewPayload> {
    const payload = await buildReceiptPayload(saleId)
    const logoUrls: Record<number, string> = {}
    for (const [logoId, buf] of payload.logoBuffers) {
      logoUrls[logoId] = pngBufferToDataUrl(buf)
    }
    return {
      template: payload.template,
      sale: payload.sale,
      data: payload.data,
      vars: payload.vars,
      logoUrls
    }
  }

  /** 打印（printing:print 主链）：组装 → 生成字节 → 串行队列入队 */
  async function printSale(saleId: number): Promise<void> {
    const payload = await buildReceiptPayload(saleId)
    const vars: ReceiptPrintVars = {
      ...payload.vars,
      logoBuffers: payload.logoBuffers
    }
    const bytes = await generateReceiptBytes(payload.template, payload.data, vars)
    // G3：入队失败向上抛（ipc 层转 { ok:false, error }），已落库销售不受影响
    await queue.enqueuePrintJob(bytes)
  }

  return { buildReceiptPayload, previewSale, printSale }
}

export type PrintOrchestrator = ReturnType<typeof createPrintOrchestrator>
