import { describe, expect, it, vi } from 'vitest'
import {
  appSettingsToPrintSettings,
  createPrintOrchestrator,
  parseTemplateRow,
  pngBufferToDataUrl,
  withVoidedMark,
  type PrintOrchestratorDeps
} from '../../../src/main/printing/print.service'
import type { PrintChannel } from '../../../src/main/printing/channels/print-channel'
import { DEFAULT_TEMPLATES } from '../../../src/shared/receipt/default-template'
import type { ReceiptTemplate } from '../../../src/shared/receipt/template-schema'
import { encodeGbk } from '../../../src/main/printing/escpos/gb2312-encoder'
import type { AppSettings, PrintTemplate, SaleDetail } from '../../../src/shared/types'

/**
 * Task 15 — 打印编排单测（DI 注入 mock 数据/通道，**不走真打印机**）：
 *  - buildReceiptPayload 组装（vars formatMoney 元显示 + items display-ready + 同源模板）
 *  - voided 单 footer 前追加「=== 已作废 ===」段落（D19，预览/打印同源）
 *  - printSale：生成字节（1b40 开头 / GBK 店名 / 1d564200 全切结尾）传入串行队列
 *  - 连续 printSale 严格串行（队列不交叠）；坏 config_json 回落内置默认模板
 */

// ─────────────────────────── 固定样例数据 ───────────────────────────

const SALE: SaleDetail = {
  id: 7,
  sale_no: '20261101-0003',
  total_cents: 1050,
  item_count: 3,
  status: 'completed',
  voided_at: null,
  created_at: '2026-11-01 12:30:05',
  items: [
    {
      id: 1,
      sale_id: 7,
      product_id: 1,
      product_name: '可口可乐 330ml',
      barcode: '6901234567890',
      quantity: 2,
      unit_price_cents: 350,
      subtotal_cents: 700
    },
    {
      id: 2,
      sale_id: 7,
      product_id: null,
      product_name: '早餐面包（已断链快照）',
      barcode: null,
      quantity: 1,
      unit_price_cents: 350,
      subtotal_cents: 350
    }
  ]
}

const VOIDED_SALE: SaleDetail = { ...SALE, status: 'voided', voided_at: '2026-11-01 13:00:00' }

const SETTINGS: AppSettings = {
  shop_name: '测试便利店',
  shop_phone: '13800000000',
  receipt_note: '谢谢惠顾，欢迎再次光临',
  logo_path: null,
  printer_channel: 'tcp',
  printer_name: null,
  tcp_host: '127.0.0.1',
  tcp_port: 19910,
  com_port: null,
  auto_cut: true
}

const TEMPLATE_ROW: PrintTemplate = {
  id: 1,
  name: '默认小票（80mm）',
  paper_width: '80mm',
  config_json: JSON.stringify(DEFAULT_TEMPLATES['80mm']),
  is_default: true,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-01 00:00:00'
}

/** 捕获型 mock 通道：记录每次 send 的字节（测试断言字节传入队列） */
function captureChannel(): { channel: PrintChannel; sent: Uint8Array[] } {
  const sent: Uint8Array[] = []
  return {
    sent,
    channel: {
      name: 'tcp',
      send: async (bytes: Uint8Array) => {
        sent.push(new Uint8Array(bytes))
      }
    }
  }
}

/** 默认依赖（可局部覆盖）：mock repo 数据 + 捕获通道 */
function makeDeps(
  overrides: Partial<PrintOrchestratorDeps> = {}
): { deps: PrintOrchestratorDeps; sent: Uint8Array[] } {
  const { channel, sent } = captureChannel()
  const deps: PrintOrchestratorDeps = {
    getSaleDetail: vi.fn(() => SALE),
    getDefaultTemplate: vi.fn(() => TEMPLATE_ROW),
    getSettings: vi.fn(() => SETTINGS),
    readLogoFile: vi.fn(async () => null),
    createChannel: vi.fn(() => channel),
    ...overrides
  }
  return { deps, sent }
}

// ─────────────────────────── 纯函数 ───────────────────────────

describe('appSettingsToPrintSettings（T7 getChannel 参数归一）', () => {
  it('可空字段 null → ""/undefined；通道与端口透传', () => {
    expect(
      appSettingsToPrintSettings({
        ...SETTINGS,
        printer_name: null,
        tcp_host: null,
        tcp_port: null,
        com_port: null
      })
    ).toEqual({
      printer_channel: 'tcp',
      printer_name: '',
      tcp_host: '',
      tcp_port: undefined,
      com_port: undefined
    })
  })
})

describe('parseTemplateRow（config_json 解析 + 坏配置兜底）', () => {
  it('合法 config_json round-trip 返回解析模板', () => {
    expect(parseTemplateRow(TEMPLATE_ROW)).toEqual(DEFAULT_TEMPLATES['80mm'])
  })

  it('脏 JSON / 残缺结构 → 按行声明纸宽回落内置默认模板（预览/打印不崩溃）', () => {
    const badJson: PrintTemplate = { ...TEMPLATE_ROW, config_json: '{oops' }
    expect(parseTemplateRow(badJson)).toEqual(DEFAULT_TEMPLATES['80mm'])

    // T2 seed fixture 形态：仅 { paperWidth, cutPaper }（残缺结构）→ 回落
    const partial: PrintTemplate = {
      ...TEMPLATE_ROW,
      paper_width: '58mm',
      config_json: JSON.stringify({ paperWidth: '58mm', cutPaper: true })
    }
    expect(parseTemplateRow(partial)).toEqual(DEFAULT_TEMPLATES['58mm'])
  })
})

describe('withVoidedMark（D19 作废标记段落）', () => {
  it('footer 前插入「=== 已作废 ===」（倍高居中加粗），原 footer 顺延，原模板不可变', () => {
    const marked = withVoidedMark(DEFAULT_TEMPLATES['80mm'])
    expect(marked.footer[0]).toEqual({
      type: 'text',
      content: '=== 已作废 ===',
      align: 'center',
      size: 'doubleHeight',
      bold: true
    })
    expect(marked.footer.slice(1)).toEqual(DEFAULT_TEMPLATES['80mm'].footer)
    // 原模板不可变（未混入作废段落）
    expect(DEFAULT_TEMPLATES['80mm'].footer).toHaveLength(2)
    expect(DEFAULT_TEMPLATES['80mm'].footer.some((s) => s.content === '=== 已作废 ===')).toBe(false)
  })
})

describe('pngBufferToDataUrl', () => {
  it('PNG Buffer → image/png dataURL（前缀 + base64 载荷）', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const url = pngBufferToDataUrl(png)
    expect(url).toBe(`data:image/png;base64,${png.toString('base64')}`)
  })
})

// ─────────────────────────── 组装（G7 同源核心） ───────────────────────────

describe('buildReceiptPayload（vars + items display-ready 组装）', () => {
  it('vars：shopName/shopPhone/receiptNote 来自 settings；total/itemCount formatMoney 元显示；datetime 本地透传', async () => {
    const { deps } = makeDeps()
    const payload = await createPrintOrchestrator(deps).buildReceiptPayload(7)

    expect(payload.vars).toMatchObject({
      shopName: '测试便利店',
      shopPhone: '13800000000',
      receiptNote: '谢谢惠顾，欢迎再次光临',
      saleNo: '20261101-0003',
      datetime: '2026-11-01 12:30:05',
      total: '10.50',
      itemCount: '3'
    })
  })

  it('data.items：数量/单价/小计 display-ready（formatMoney 恰 2 位小数，buildItemLine 直接输入）', async () => {
    const { deps } = makeDeps()
    const payload = await createPrintOrchestrator(deps).buildReceiptPayload(7)

    expect(payload.data.items).toEqual([
      { name: '可口可乐 330ml', quantity: '2', unitPrice: '3.50', subtotal: '7.00' },
      { name: '早餐面包（已断链快照）', quantity: '1', unitPrice: '3.50', subtotal: '3.50' }
    ])
  })

  it('模板行 config_json 解析为 ReceiptTemplate；completed 单 footer 无作废段落', async () => {
    const { deps } = makeDeps()
    const payload = await createPrintOrchestrator(deps).buildReceiptPayload(7)

    expect(payload.template).toEqual(DEFAULT_TEMPLATES['80mm'])
    expect(payload.template.footer.some((s) => s.content === '=== 已作废 ===')).toBe(false)
  })

  it('模板无 image 段落 → 不读 Logo 文件（readLogoFile 零调用）', async () => {
    const readLogoFile = vi.fn(async () => Buffer.from('png'))
    const { deps } = makeDeps({ readLogoFile })
    const payload = await createPrintOrchestrator(deps).buildReceiptPayload(7)

    expect(payload.logoBuffer).toBeNull()
    expect(readLogoFile).not.toHaveBeenCalled()
  })

  it('未找到销售单 → 抛可诊断错误（id 回显）', async () => {
    const { deps } = makeDeps({ getSaleDetail: vi.fn(() => undefined) })
    await expect(createPrintOrchestrator(deps).buildReceiptPayload(999)).rejects.toThrow(
      /未找到销售单.*999/
    )
  })
})

describe('buildReceiptPayload voided 单（D19：预览与打印同源加印作废标记）', () => {
  it('footer[0] 为「=== 已作废 ===」倍高居中段落，其余 footer 顺延', async () => {
    const { deps } = makeDeps({ getSaleDetail: vi.fn(() => VOIDED_SALE) })
    const payload = await createPrintOrchestrator(deps).buildReceiptPayload(7)

    expect(payload.sale.status).toBe('voided')
    expect(payload.template.footer[0]).toEqual({
      type: 'text',
      content: '=== 已作废 ===',
      align: 'center',
      size: 'doubleHeight',
      bold: true
    })
    expect(payload.template.footer.slice(1)).toEqual(DEFAULT_TEMPLATES['80mm'].footer)
  })
})

describe('previewSale（printing:preview 载荷）', () => {
  it('与 buildReceiptPayload 同源：template/sale/data/vars 一致 + logoUrl null（无 Logo）', async () => {
    const { deps } = makeDeps()
    const orchestrator = createPrintOrchestrator(deps)
    const payload = await orchestrator.buildReceiptPayload(7)
    const preview = await orchestrator.previewSale(7)

    expect(preview.template).toEqual(payload.template)
    expect(preview.sale).toEqual(payload.sale)
    expect(preview.data).toEqual(payload.data)
    expect(preview.vars).toEqual(payload.vars)
    expect(preview.logoUrl).toBeNull()
  })

  it('模板含 image 段落 + Logo 文件存在 → logoBuffer 转 dataURL（Buffer 不跨 IPC）', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const templateWithLogo: ReceiptTemplate = {
      ...DEFAULT_TEMPLATES['80mm'],
      header: [{ type: 'image' }, ...DEFAULT_TEMPLATES['80mm'].header]
    }
    const { deps } = makeDeps({
      getDefaultTemplate: vi.fn(() => ({
        ...TEMPLATE_ROW,
        config_json: JSON.stringify(templateWithLogo)
      })),
      readLogoFile: vi.fn(async () => png)
    })
    const preview = await createPrintOrchestrator(deps).previewSale(7)

    expect(preview.logoUrl).toBe(pngBufferToDataUrl(png))
    expect(preview.logoUrl).toMatch(/^data:image\/png;base64,/)
  })
})

// ─────────────────────────── 打印（字节 → 串行队列） ───────────────────────────

describe('printSale（生成字节 → enqueuePrintJob）', () => {
  it('字节以 1b40 1b520f 开头（init + 中文页），含 GBK 店名与明细行，以 1d564200 全切结尾', async () => {
    const { deps, sent } = makeDeps()
    await createPrintOrchestrator(deps).printSale(7)

    expect(sent).toHaveLength(1)
    const hex = Buffer.from(sent[0]!).toString('hex')
    expect(hex.startsWith('1b401b520f')).toBe(true)
    // GBK 店名与明细行（组装数据真实进入字节——同源证据）
    expect(hex).toContain(encodeGbk('测试便利店').toString('hex'))
    expect(hex).toContain(encodeGbk('可口可乐 330ml').toString('hex'))
    expect(hex.endsWith('1d564200')).toBe(true) // 默认模板 cutPaper=true
    expect(sent[0]!.length).toBeGreaterThan(200)
  })

  it('通道按当前设置解析（createChannel 收到 tcp/host/port 归一值）', async () => {
    const createChannel = vi.fn(() => captureChannel().channel)
    const { deps } = makeDeps({ createChannel })
    await createPrintOrchestrator(deps).printSale(7)

    expect(createChannel).toHaveBeenCalledWith({
      printer_channel: 'tcp',
      printer_name: '',
      tcp_host: '127.0.0.1',
      tcp_port: 19910,
      com_port: undefined
    })
  })

  it('voided 单打印：字节含「=== 已作废 ===」GBK 段（D19 打印侧）', async () => {
    const { deps, sent } = makeDeps({ getSaleDetail: vi.fn(() => VOIDED_SALE) })
    await createPrintOrchestrator(deps).printSale(7)

    const hex = Buffer.from(sent[0]!).toString('hex')
    expect(hex).toContain(encodeGbk('=== 已作废 ===').toString('hex'))
  })

  it('发送失败向上抛（G3：入队错误交 ipc 层转 ok:false——不影响已落库销售）', async () => {
    const failing: PrintChannel = {
      name: 'tcp',
      send: async () => {
        throw new Error('ECONNREFUSED')
      }
    }
    const { deps } = makeDeps({ createChannel: vi.fn(() => failing) })

    await expect(createPrintOrchestrator(deps).printSale(7)).rejects.toThrow(/已自动重试 1 次/)
  })

  it('连续 printSale 严格串行：job2 的 send 在 job1 完成后才开始（队列不交叠）', async () => {
    const events: string[] = []
    let releaseFirst: (() => void) | undefined
    const gated: PrintChannel = {
      name: 'tcp',
      send: async () => {
        const n = events.filter((e) => e.startsWith('start')).length
        events.push(`start:${n}`)
        if (n === 0) await new Promise<void>((r) => (releaseFirst = r))
        events.push(`end:${n}`)
      }
    }
    const { deps } = makeDeps({ createChannel: vi.fn(() => gated) })
    const orchestrator = createPrintOrchestrator(deps)

    const job1 = orchestrator.printSale(7)
    const job2 = orchestrator.printSale(7)
    await new Promise((r) => setTimeout(r, 20))

    // job1 挂起未放行 → job2 必须还在等（串行证明）
    expect(events).toEqual(['start:0'])

    releaseFirst?.()
    await job1
    await job2
    expect(events).toEqual(['start:0', 'end:0', 'start:1', 'end:1'])
  })
})
