<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Picture, Printer, Refresh, Search } from '@element-plus/icons-vue'
import DiagnosisDialog from '@renderer/components/settings/DiagnosisDialog.vue'
import { usePrintingStore } from '@renderer/stores/printing.store'
import type { AppSettings, PrinterChannel } from '../../../shared/types'
import {
  RAW_PROBE_READINGS,
  RAW_PROBE_SEGMENT_LABELS,
  RAW_PROBE_VERDICTS
} from '../../../shared/printing/raw-probe'

interface PrinterEntry {
  name: string
  is_default: boolean
}

/** window.api.settings 的 Logo 条目类型（preload 契约：listLogos/uploadLogo/deleteLogo 返回） */
type LogoInfo = Awaited<ReturnType<typeof window.api.settings.listLogos>>[number]

const loading = ref(true)
const printers = ref<PrinterEntry[]>([])
const printersLoading = ref(false)
const logos = ref<LogoInfo[]>([])
const uploadingLogo = ref(false)
const savingShop = ref(false)
const savingPrint = ref(false)
const testing = ref(false)
const probing = ref(false)

const shopForm = reactive({ shop_name: '', shop_phone: '', receipt_note: '' })

/** 剥除 Electron invoke 序列化前缀（v2：设置保存失败 toast 人话回显；同 printing.store 模式） */
function extractIpcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const matched = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return matched ? matched[1] : raw
}

/** 打印诊断（T10）：状态与动作全在 printing store（对话框为纯渲染子组件） */
const printingStore = usePrintingStore()

/** 对话框在「采集中」与「已有报告」时展示；诊断失败态由 error toast 承担（不弹窗） */
const diagnosisDialogVisible = computed(
  () =>
    printingStore.diagnosisState === 'collecting' || printingStore.diagnosisState === 'report'
)

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
  shopForm.shop_name = settings.shop_name
  shopForm.shop_phone = settings.shop_phone
  shopForm.receipt_note = settings.receipt_note
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

async function loadLogos(): Promise<void> {
  logos.value = await window.api.settings.listLogos()
}

onMounted(async () => {
  try {
    await Promise.all([loadSettings(), loadPrinters(), loadLogos()])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`设置加载失败：${detail}`)
  } finally {
    loading.value = false
  }
})

async function saveShop(): Promise<void> {
  savingShop.value = true
  try {
    await window.api.settings.set({
      shop_name: shopForm.shop_name,
      shop_phone: shopForm.shop_phone,
      receipt_note: shopForm.receipt_note
    })
    ElMessage.success('店铺信息已保存')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`保存失败：${detail}`)
  } finally {
    savingShop.value = false
  }
}

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

async function onUploadLogo(): Promise<void> {
  uploadingLogo.value = true
  try {
    const next = await window.api.settings.uploadLogo()
    // 原生对话框用户取消 → 返回原列表（长度不变不 toast，避免误导）
    const added = next.length > logos.value.length
    logos.value = next
    if (added) ElMessage.success('Logo 已上传')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`Logo 上传失败：${detail}`)
  } finally {
    uploadingLogo.value = false
  }
}

async function onDeleteLogo(logo: LogoInfo): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除 Logo「${logo.display_name}」？引用它的小票模板将不再打印该图。`,
      '删除 Logo',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    logos.value = await window.api.settings.deleteLogo(logo.id)
    ElMessage.success('Logo 已删除')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`Logo 删除失败：${detail}`)
  }
}
</script>

<template>
  <section class="settings-page" v-loading="loading">
    <header class="page-head">
      <h1 class="page-head__title">系统设置</h1>
      <p class="page-head__sub">店铺信息、打印通道与小票 Logo 集中管理</p>
    </header>

    <!-- ═══ 卡片一：店铺信息（小票模板变量源头：shopName / shopPhone / receiptNote）═══ -->
    <el-card class="settings-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span class="card-head__marker" aria-hidden="true"></span>
          <span class="card-head__title">店铺信息</span>
          <span class="card-head__desc">打印在小票头部与底部</span>
        </div>
      </template>

      <el-form label-position="top" class="settings-form" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="店名">
            <el-input
              v-model="shopForm.shop_name"
              data-testid="shop-name-input"
              placeholder="如：好又多超市"
              maxlength="30"
            />
          </el-form-item>
          <el-form-item label="联系电话">
            <el-input
              v-model="shopForm.shop_phone"
              data-testid="shop-phone-input"
              placeholder="如：138-0000-0000"
              maxlength="20"
            />
          </el-form-item>
        </div>
        <el-form-item label="小票备注">
          <el-input
            v-model="shopForm.receipt_note"
            type="textarea"
            :rows="2"
            maxlength="60"
            show-word-limit
            data-testid="receipt-note-input"
            placeholder="如：谢谢惠顾，欢迎再次光临"
          />
        </el-form-item>
      </el-form>

      <footer class="card-foot">
        <span class="card-foot__hint">保存后，新小票的店名 / 电话 / 备注随之更新。</span>
        <el-button type="primary" data-testid="save-shop-btn" :loading="savingShop" @click="saveShop">
          保存
        </el-button>
      </footer>
    </el-card>

    <!-- ═══ 卡片二：打印设置（通道 + 测试打印）═══ -->
    <el-card class="settings-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span class="card-head__marker" aria-hidden="true"></span>
          <span class="card-head__title">打印设置</span>
          <span class="card-head__desc">小票机连接通道与测试</span>
        </div>
      </template>

      <el-form label-position="top" class="settings-form" @submit.prevent>
        <el-form-item label="打印通道">
          <el-radio-group v-model="printForm.printer_channel" class="channel-group">
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
                <el-option label="自动选择" value="" data-testid="printer-auto-option" />
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
          <div class="field-hint field-hint--block">默认端口 9100（ESC/POS 标准网络打印端口）。</div>
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
        <el-collapse class="advanced-collapse" data-testid="driver-advanced-collapse">
          <el-collapse-item name="driverAdvanced">
            <template #title>
              <span class="advanced-collapse__title" data-testid="driver-advanced-collapse-title">
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
              <div class="field-hint field-hint--block" data-testid="driver-dpi-hint">
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
              <div class="field-hint field-hint--block" data-testid="driver-page-size-warning">
                启用后由驱动决定页尺寸；若驱动无法提供默认尺寸将回退 A4（连续纸会被按 A4 分页）。
              </div>
            </el-form-item>
          </el-collapse-item>
        </el-collapse>

        <el-divider class="settings-divider" />

        <el-form-item label="打印后自动切纸">
          <div class="auto-cut-row">
            <el-switch v-model="printForm.auto_cut" class="auto-cut-switch" />
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
          <el-button plain data-testid="raw-probe-btn" :loading="probing" @click="rawProbe">
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
          <el-button type="primary" data-testid="save-print-btn" :loading="savingPrint" @click="savePrint">
            保存
          </el-button>
        </div>
      </footer>
    </el-card>

    <!-- ═══ 卡片三：小票 Logo（多 Logo 管理：此处上传，小票模板的图片段落选用）═══ -->
    <el-card class="settings-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span class="card-head__marker" aria-hidden="true"></span>
          <span class="card-head__title">小票 Logo</span>
          <span class="card-head__desc">可上传多张，在小票模板的图片段落中选择使用</span>
        </div>
      </template>

      <div v-if="logos.length > 0" class="logo-grid" data-testid="logo-grid">
        <div v-for="logo in logos" :key="logo.id" class="logo-cell" data-testid="logo-item">
          <div class="logo-cell__thumb">
            <img
              :src="logo.data_url"
              :alt="logo.display_name"
              class="logo-cell__img"
              data-testid="logo-preview"
            />
          </div>
          <span class="logo-cell__name" :title="logo.display_name">{{ logo.display_name }}</span>
          <el-button
            text
            type="danger"
            size="small"
            :icon="Delete"
            data-testid="logo-delete-btn"
            @click="onDeleteLogo(logo)"
          >
            删除
          </el-button>
        </div>
      </div>
      <div v-else class="logo-empty">
        <el-icon :size="26" class="logo-empty__icon"><Picture /></el-icon>
        <p class="logo-empty__text">暂未上传 Logo，上传后可在小票模板中选择使用</p>
      </div>

      <footer class="card-foot">
        <span class="card-foot__hint">仅支持 PNG，建议黑白图、宽不超过 300 像素。</span>
        <el-button
          type="primary"
          plain
          data-testid="upload-logo-btn"
          :loading="uploadingLogo"
          @click="onUploadLogo"
        >
          上传 Logo
        </el-button>
      </footer>
    </el-card>

    <!-- ═══ 卡片四：打印机诊断（printer-diagnostics T10——采集 → 规则 → 报告 → 修复建议）═══ -->
    <el-card class="settings-card diagnosis-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span class="card-head__marker" aria-hidden="true"></span>
          <span class="card-head__title">打印机诊断</span>
          <span class="card-head__desc">打印异常时一键采集环境、定位根因</span>
        </div>
      </template>

      <p class="diagnosis-intro">
        诊断会采集系统打印服务状态、每台打印机的驱动与端口、队列任务与事件日志（仅 Windows，约需数秒），
        生成可导出的诊断报告；发现的问题会附带可执行的修复动作或人工处理引导。
      </p>

      <footer class="card-foot">
        <span class="card-foot__hint">诊断只读不改系统；修复动作执行前会再次向您确认。</span>
        <div class="card-foot__actions">
          <el-button
            :disabled="printingStore.diagnosisReport === null"
            data-testid="diagnosis-export-btn"
            @click="printingStore.exportDiagnosisReport()"
          >
            导出报告
          </el-button>
          <el-button
            type="primary"
            :icon="Search"
            data-testid="diagnosis-start-btn"
            :loading="printingStore.diagnosisState === 'collecting'"
            @click="printingStore.diagnose()"
          >
            开始诊断
          </el-button>
        </div>
      </footer>
    </el-card>

    <!-- 诊断报告对话框（三区渲染 + 修复动作确认流；IPC 与 toast 在 store） -->
    <DiagnosisDialog
      :visible="diagnosisDialogVisible"
      :report="printingStore.diagnosisReport"
      :loading="printingStore.diagnosisState === 'collecting'"
      @update:visible="printingStore.closeDiagnosis()"
      @repair="(actionId, targetPrinter) => printingStore.repairAction(actionId, targetPrinter)"
      @export="printingStore.exportDiagnosisReport()"
    />
  </section>
</template>

<style scoped>
.settings-page {
  max-width: 780px;
  margin: 0 auto;
  padding: 28px 32px 48px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: 100%;
  box-sizing: border-box;
}

/* ── 页头：琥珀侧标呼应侧边栏品牌色 ── */
.page-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-head__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
  display: flex;
  align-items: center;
}

.page-head__title::before {
  content: '';
  width: 5px;
  height: 20px;
  margin-right: 10px;
  border-radius: 2px;
  background: var(--el-color-warning);
}

.page-head__sub {
  margin: 0 0 0 15px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

/* ── 卡片 ── */
.settings-card {
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
}

.settings-card :deep(.el-card__header) {
  padding: 14px 20px;
  background: var(--el-fill-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.settings-card :deep(.el-card__body) {
  padding: 20px;
}

.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.card-head__marker {
  width: 4px;
  height: 14px;
  border-radius: 1px;
  background: var(--el-color-warning);
  align-self: center;
}

.card-head__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.card-head__desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ── 表单 ── */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 16px;
}

.form-grid--tcp {
  grid-template-columns: 3fr 2fr;
}

.settings-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.settings-form :deep(.el-form-item__label) {
  font-weight: 500;
  color: var(--el-text-color-regular);
  padding-bottom: 4px;
}

.field-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.field-hint--block {
  margin-bottom: 4px;
}

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

/* ── 卡片底栏 ── */
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}

.card-foot__hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}

.card-foot__actions {
  display: flex;
  gap: 10px;
}

/* ── Logo 卡片：多 Logo 响应式网格（缩略图限高保持比例 + 名称 + 删除）── */
.logo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}

.logo-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 10px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: #fff;
}

.logo-cell__thumb {
  display: flex;
  width: 100%;
  height: 64px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.logo-cell__img {
  max-width: 100%;
  max-height: 64px;
  object-fit: contain;
}

.logo-cell__name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

/* ── Logo 空态 ── */
.logo-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 0 20px;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.logo-empty__icon {
  color: var(--el-text-color-placeholder);
}

.logo-empty__text {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ── 诊断卡片说明（T10）── */
.diagnosis-intro {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}
</style>
