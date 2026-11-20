<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Printer, Refresh } from '@element-plus/icons-vue'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'
import type { AppSettings, PrinterChannel } from '../../../../shared/types'
import {
  RAW_PROBE_READINGS,
  RAW_PROBE_SEGMENT_LABELS,
  RAW_PROBE_VERDICTS
} from '../../../../shared/printing/raw-probe'

/**
 * 设置页·卡片二：打印设置（通道 + 测试打印 + 编码探针 + driver 高级实验区）。
 *
 * 卡片自治（SettingsView 拆分）：自持表单态与打印机列表，挂载时并行
 * settings:get / printing:printers；保存/测试打印/探针的 IPC 与 toast 本组件闭环。
 * 探针判读表 HTML 内联样式（ElMessageBox 内容在 scoped CSS 之外）。
 *
 * 取舍定案（不引共享 settings store）：与 ShopInfoCard 同页各 settings:get 一次
 * （双加载）。保存键集零重叠——本卡只写 printer_channel/printer_name/tcp_host/
 * tcp_port/com_port/auto_cut/driver_*，ShopInfoCard 只写 shop_name/shop_phone/
 * receipt_note（SettingsPatch 为 Partial，互不覆盖），双加载无一致性风险；
 * 换 store 的收益不抵自治卡片闭环被打破的成本（omo 评估取证，用户裁决）。
 */

interface PrinterEntry {
  name: string
  is_default: boolean
}

const loading = ref(true)
const printers = ref<PrinterEntry[]>([])
const printersLoading = ref(false)
const savingPrint = ref(false)
const testing = ref(false)
const probing = ref(false)

const printForm = reactive({
  printer_channel: 'spooler' as PrinterChannel,
  printer_name: '',
  tcp_host: '',
  tcp_port: '',
  com_port: '',
  auto_cut: true,
  /** driver 通道实验键（printer-diagnostics v2）：dpi 可空——null=未设置（不发送 dpi） */
  driver_dpi: null as number | null,
  driver_use_default_page_size: false
})

const CHANNEL_OPTIONS: Array<{ value: PrinterChannel; title: string; desc: string }> = [
  { value: 'spooler', title: '系统打印机', desc: 'Windows 打印后台 RAW 直发' },
  // driver 兜底：得力 DL-5801PW 等「云」热敏机走 spooler 时中文/Logo 不出（固件丢在哪一层
  // 尚未定证——用设置页「编码探针」分辨，见 docs/windows-manual-checklist.md §11.3），
  // 走打印机驱动渲染 HTML（同 Word 打印路径）则全兼容——详见 driver.channel.ts
  { value: 'driver', title: '驱动渲染', desc: '使用打印机原生驱动' },
  { value: 'tcp', title: '网络打印机', desc: '打印机网口直连 host:9100' },
  { value: 'serial', title: '串口打印机', desc: 'COM 口直连（备用通道）' }
]

async function loadSettings(): Promise<void> {
  const settings: AppSettings = await window.api.settings.get()
  printForm.printer_channel = settings.printer_channel
  printForm.printer_name = settings.printer_name ?? ''
  printForm.tcp_host = settings.tcp_host ?? ''
  printForm.tcp_port = settings.tcp_port === null ? '' : String(settings.tcp_port)
  printForm.com_port = settings.com_port ?? ''
  printForm.auto_cut = settings.auto_cut
  // v2 实验键回显：DB 无行 → 键缺省 → null/false（消费语义一致）
  printForm.driver_dpi = settings.driver_dpi ?? null
  printForm.driver_use_default_page_size = settings.driver_use_default_page_size ?? false
}

async function loadPrinters(): Promise<void> {
  printersLoading.value = true
  try {
    printers.value = await window.api.printing.printers()
  } catch (err) {
    // G11：无打印机/平台不支持 → 主进程已归一为 []；此处兜底网络级异常
    printers.value = []
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.warning(`打印机列表获取失败：${detail}`)
  } finally {
    printersLoading.value = false
  }
}

onMounted(async () => {
  try {
    await Promise.all([loadSettings(), loadPrinters()])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`设置加载失败：${detail}`)
  } finally {
    loading.value = false
  }
})

async function savePrint(): Promise<void> {
  savingPrint.value = true
  try {
    await window.api.settings.set({
      printer_channel: printForm.printer_channel,
      printer_name: printForm.printer_name,
      tcp_host: printForm.tcp_host,
      tcp_port: printForm.tcp_port === '' ? null : Number.parseInt(printForm.tcp_port, 10),
      com_port: printForm.com_port,
      auto_cut: printForm.auto_cut,
      // v2 实验键随行（保存链路不变——主进程 settings:set 值域校验兜底）
      driver_dpi: printForm.driver_dpi,
      driver_use_default_page_size: printForm.driver_use_default_page_size
    })
    ElMessage.success('打印设置已保存')
  } catch (err) {
    ElMessage.error(`保存失败：${extractIpcErrorMessage(err)}`)
  } finally {
    savingPrint.value = false
  }
}

/** 打印表单 → IPC 请求（测试打印与编码探针共用：空字符串 → null） */
function printRequestFromForm() {
  return {
    printer_channel: printForm.printer_channel,
    printer_name: printForm.printer_name === '' ? null : printForm.printer_name,
    tcp_host: printForm.tcp_host === '' ? null : printForm.tcp_host,
    tcp_port: printForm.tcp_port === '' ? null : Number.parseInt(printForm.tcp_port, 10),
    com_port: printForm.com_port === '' ? null : printForm.com_port
  }
}

async function testPrint(): Promise<void> {
  testing.value = true
  try {
    const result = await window.api.printing.testPrint(printRequestFromForm())
    if (result.ok) {
      ElMessage.success('测试打印已发送')
    } else {
      ElMessage.error(result.error ?? '测试打印失败')
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`测试打印失败：${detail}`)
  } finally {
    testing.value = false
  }
}

/**
 * RAW 编码探针（F1）：先把探针页发出去，再弹判读表——用户是拿着纸对照看的，
 * 先弹表会把「发送中」的等待和「看纸」的步骤混在一起。关闭弹框（含右上角 X）
 * 不算失败，吹掉 reject。
 */
async function rawProbe(): Promise<void> {
  probing.value = true
  try {
    const result = await window.api.printing.rawProbe(printRequestFromForm())
    if (!result.ok) {
      ElMessage.error(result.error ?? '编码探针打印失败')
      return
    }
    await ElMessageBox.alert(probeGuideHtml(), '编码探针已发送——照着纸判读', {
      dangerouslyUseHTMLString: true,
      confirmButtonText: '我已看过纸',
      customStyle: { width: '900px', maxWidth: '94vw' }
    }).catch(() => undefined)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`编码探针打印失败：${detail}`)
  } finally {
    probing.value = false
  }
}

/** 探针判读表 HTML（ElMessageBox 内容在 scoped CSS 之外，样式一律内联） */
function probeGuideHtml(): string {
  const th =
    'style="text-align:left;padding:4px 8px;border-bottom:1px solid #dcdfe6;white-space:nowrap"'
  const td = 'style="padding:6px 8px;border-bottom:1px solid #ebeef5;vertical-align:top"'
  const rows = RAW_PROBE_READINGS.map((r) => {
    const label = RAW_PROBE_SEGMENT_LABELS[r.id]
    return (
      `<tr><td ${td}><b>${label}</b>` +
      `<div style="color:#909399;font-size:12px">纸上：${r.prints}</div></td>` +
      `<td ${td}>${r.bytes}</td>` +
      `<td ${td}>出字/出图 → ${r.ifWorks}</td>` +
      `<td ${td}>空白/乱码 → ${r.ifFails}</td></tr>`
    )
  }).join('')
  const verdicts = RAW_PROBE_VERDICTS.map(
    (v) => `<li style="margin-bottom:4px"><b>${v.when}</b> → ${v.then}</li>`
  ).join('')
  return (
    // 探针 v2 起判读表有 8 段：限高 + 滚动，避免弹框超出屏幕（ElMessageBox 不自带滚动）
    '<div style="font-size:13px;line-height:1.6;max-height:60vh;overflow:auto">' +
    '<table style="border-collapse:collapse;width:100%"><thead><tr>' +
    `<th ${th}>段</th><th ${th}>发的字节</th><th ${th}>通过说明</th><th ${th}>失败说明</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    '<p style="margin:12px 0 4px"><b>结论速查</b></p>' +
    `<ul style="margin:0;padding-left:18px">${verdicts}</ul></div>`
  )
}
</script>

<template>
  <!-- ═══ 卡片二：打印设置（通道 + 测试打印）═══ -->
  <el-card
    v-loading="loading"
    class="settings-card"
    shadow="never"
  >
    <template #header>
      <div class="card-head">
        <span
          class="card-head__marker"
          aria-hidden="true"
        />
        <span class="card-head__title">打印设置</span>
        <span class="card-head__desc">小票机连接通道与测试</span>
      </div>
    </template>

    <el-form
      label-position="top"
      class="settings-form"
      @submit.prevent
    >
      <el-form-item label="打印通道">
        <el-radio-group
          v-model="printForm.printer_channel"
          class="channel-group"
        >
          <el-radio
            v-for="opt in CHANNEL_OPTIONS"
            :key="opt.value"
            :value="opt.value"
            class="channel-radio"
            border
          >
            <span class="channel-radio__title">{{ opt.title }}</span>
            <span class="channel-radio__desc">{{ opt.desc }}</span>
          </el-radio>
        </el-radio-group>
      </el-form-item>

      <!-- spooler / driver 分区：同走系统打印机名（spooler RAW 直发 / driver 驱动渲染 HTML） -->
      <template v-if="printForm.printer_channel === 'spooler' || printForm.printer_channel === 'driver'">
        <el-form-item label="打印机">
          <div class="printer-picker">
            <el-select
              v-model="printForm.printer_name"
              class="printer-select"
              placeholder="自动选择"
              :loading="printersLoading"
            >
              <el-option
                label="自动选择"
                value=""
                data-testid="printer-auto-option"
              />
              <el-option
                v-for="p in printers"
                :key="p.name"
                :label="p.is_default ? `${p.name}（默认）` : p.name"
                :value="p.name"
              />
            </el-select>
            <el-button
              class="printer-refresh"
              :icon="Refresh"
              circle
              :loading="printersLoading"
              aria-label="刷新打印机列表"
              @click="loadPrinters"
            />
          </div>
          <!-- 提示分通道：spooler 空名=系统默认机；driver 需具体机名（空名后端报错，前端不拦，测试打印即反馈） -->
          <div class="field-hint">
            <template v-if="printForm.printer_channel === 'driver'">
              中文/图片经打印机驱动渲染，适合「云」热敏机；速度略慢于指令直发，需选择具体打印机。
            </template>
            <template v-else>
              热敏小票机请选择系统中已安装的小票打印机；列表为空时保持「自动选择」即可。
            </template>
          </div>
        </el-form-item>
      </template>

      <!-- tcp 分区 -->
      <template v-else-if="printForm.printer_channel === 'tcp'">
        <div class="form-grid form-grid--tcp">
          <el-form-item label="打印机地址">
            <el-input
              v-model="printForm.tcp_host"
              data-testid="tcp-host-input"
              placeholder="如：192.168.1.50"
            />
          </el-form-item>
          <el-form-item label="端口">
            <el-input
              v-model="printForm.tcp_port"
              data-testid="tcp-port-input"
              placeholder="9100"
              inputmode="numeric"
            />
          </el-form-item>
        </div>
        <div class="field-hint field-hint--block">
          默认端口 9100（ESC/POS 标准网络打印端口）。
        </div>
      </template>

      <!-- serial 分区 -->
      <template v-else>
        <el-form-item label="串口设备路径">
          <el-input
            v-model="printForm.com_port"
            data-testid="com-port-input"
            placeholder="\\.\COM1"
          />
          <div class="field-hint field-hint--block">
            Windows 设备路径如 \\.\COM1；Linux 环境请手动输入设备路径（如 /dev/ttyUSB0）。
          </div>
        </el-form-item>
      </template>

      <!-- ═══ 打印高级选项（实验）折叠区（v2）：常驻可见——非 driver 通道仅标注
           「仅 driver 通道生效」而非隐藏（避免用户切通道后找不到开关去哪了）═══ -->
      <el-collapse
        class="advanced-collapse"
        data-testid="driver-advanced-collapse"
      >
        <el-collapse-item name="driverAdvanced">
          <template #title>
            <span
              class="advanced-collapse__title"
              data-testid="driver-advanced-collapse-title"
            >
              打印高级选项（实验）
            </span>
            <span
              v-if="printForm.printer_channel !== 'driver'"
              class="advanced-collapse__inert"
              data-testid="driver-advanced-inert-hint"
            >
              仅 driver 通道生效
            </span>
          </template>
          <el-form-item label="打印 DPI">
            <el-input-number
              v-model="printForm.driver_dpi"
              data-testid="driver-dpi-input"
              :min="50"
              :max="1200"
              :step="1"
              :value-on-clear="null"
              class="dpi-input"
              placeholder="留空=默认（不发送 dpi）"
            />
            <div
              class="field-hint field-hint--block"
              data-testid="driver-dpi-hint"
            >
              热敏打印机常见 203；设置后诊断报告会记录该实验值。
            </div>
          </el-form-item>
          <el-form-item label="使用驱动默认页尺寸">
            <div class="switch-row">
              <el-switch
                v-model="printForm.driver_use_default_page_size"
                data-testid="driver-page-size-switch"
              />
              <span class="switch-row__state">
                {{ printForm.driver_use_default_page_size ? '开' : '关' }}
              </span>
            </div>
            <div
              class="field-hint field-hint--block"
              data-testid="driver-page-size-warning"
            >
              启用后由驱动决定页尺寸；若驱动无法提供默认尺寸将回退 A4（连续纸会被按 A4 分页）。
            </div>
          </el-form-item>
        </el-collapse-item>
      </el-collapse>

      <el-divider class="settings-divider" />

      <el-form-item label="打印后自动切纸">
        <div class="auto-cut-row">
          <el-switch
            v-model="printForm.auto_cut"
            class="auto-cut-switch"
          />
          <span class="auto-cut-state">{{ printForm.auto_cut ? '开' : '关' }}</span>
        </div>
        <div class="field-hint field-hint--block">
          仅作为新建默认模板时的初始值参考；实际打印以小票模板中的「打印后切纸」设置优先。
        </div>
      </el-form-item>
    </el-form>

    <footer class="card-foot">
      <span class="card-foot__hint">
        测试打印发一张完整样张小票（中文店名 + 商品明细）；编码探针打一张四段判读页，用于定位系统打印通道的中文编码（仅 RAW 通道）。
      </span>
      <div class="card-foot__actions">
        <el-button
          plain
          data-testid="raw-probe-btn"
          :loading="probing"
          @click="rawProbe"
        >
          编码探针
        </el-button>
        <el-button
          :icon="Printer"
          data-testid="test-print-btn"
          :loading="testing"
          @click="testPrint"
        >
          测试打印
        </el-button>
        <el-button
          type="primary"
          data-testid="save-print-btn"
          :loading="savingPrint"
          @click="savePrint"
        >
          保存
        </el-button>
      </div>
    </footer>
  </el-card>
</template>

<style scoped>
/* ── 通道单选卡（四选一带描述）── */
.channel-group {
  display: flex;
  gap: 10px;
  width: 100%;
}

.channel-radio {
  flex: 1;
  margin-right: 0;
  height: auto;
  padding: 10px 14px;
  border-radius: 8px;
  display: flex;
  align-items: flex-start;
}

.channel-radio :deep(.el-radio__label) {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 0 0 8px;
  white-space: normal;
}

.channel-radio__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.channel-radio__desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.channel-radio.is-checked {
  border-color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}

.channel-radio.is-checked .channel-radio__title {
  color: var(--el-color-warning-dark-2);
}

/* ── spooler/driver 打印机选择行（两通道共用）── */
.printer-picker {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
}

.printer-select {
  flex: 1;
}

/* ── 自动切纸行 ── */
.auto-cut-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.auto-cut-state {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

/* ── 打印高级选项（实验）折叠区（v2）：常驻可见，非 driver 通道标注 inert ── */
.advanced-collapse {
  width: 100%;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  margin-bottom: 18px;
}

.advanced-collapse :deep(.el-collapse-item__header) {
  padding: 0 14px;
  border-bottom-color: transparent;
  background: transparent;
  gap: 10px;
}

.advanced-collapse :deep(.el-collapse-item__wrap) {
  border-bottom-color: transparent;
  background: transparent;
}

.advanced-collapse :deep(.el-collapse-item__content) {
  padding: 8px 14px 4px;
}

.advanced-collapse__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* inert 标注（非 driver 通道）：折叠区常驻、开关仍在——只提示生效条件 */
.advanced-collapse__inert {
  font-size: 12px;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  border-radius: 4px;
  padding: 1px 8px;
}

.dpi-input {
  width: 200px;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.switch-row__state {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.settings-divider {
  margin: 4px 0 18px;
}
</style>
