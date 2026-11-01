<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Picture, Printer, Refresh } from '@element-plus/icons-vue'
import type { AppSettings, PrinterChannel } from '../../../shared/types'

interface PrinterEntry {
  name: string
  is_default: boolean
}

const loading = ref(true)
const printers = ref<PrinterEntry[]>([])
const printersLoading = ref(false)
const logoDataUrl = ref<string | null>(null)
const uploadingLogo = ref(false)
const savingShop = ref(false)
const savingPrint = ref(false)
const testing = ref(false)

const shopForm = reactive({ shop_name: '', shop_phone: '', receipt_note: '' })

const printForm = reactive({
  printer_channel: 'spooler' as PrinterChannel,
  printer_name: '',
  tcp_host: '',
  tcp_port: '',
  com_port: '',
  auto_cut: true
})

const CHANNEL_OPTIONS: Array<{ value: PrinterChannel; title: string; desc: string }> = [
  { value: 'spooler', title: '系统打印机', desc: 'Windows 打印后台 RAW 直发（推荐）' },
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

async function loadLogo(): Promise<void> {
  const { data_url } = await window.api.settings.getLogoDataUrl()
  logoDataUrl.value = data_url
}

onMounted(async () => {
  try {
    await Promise.all([loadSettings(), loadPrinters(), loadLogo()])
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
      auto_cut: printForm.auto_cut
    })
    ElMessage.success('打印设置已保存')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`保存失败：${detail}`)
  } finally {
    savingPrint.value = false
  }
}

async function testPrint(): Promise<void> {
  testing.value = true
  try {
    const result = await window.api.printing.testPrint({
      printer_channel: printForm.printer_channel,
      printer_name: printForm.printer_name === '' ? null : printForm.printer_name,
      tcp_host: printForm.tcp_host === '' ? null : printForm.tcp_host,
      tcp_port: printForm.tcp_port === '' ? null : Number.parseInt(printForm.tcp_port, 10),
      com_port: printForm.com_port === '' ? null : printForm.com_port
    })
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

async function onUploadLogo(): Promise<void> {
  uploadingLogo.value = true
  try {
    const before = logoDataUrl.value
    await window.api.settings.uploadLogo()
    await loadLogo()
    if (logoDataUrl.value !== before) {
      ElMessage.success('Logo 已更新')
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`Logo 上传失败：${detail}`)
  } finally {
    uploadingLogo.value = false
  }
}

async function onClearLogo(): Promise<void> {
  try {
    await window.api.settings.set({ logo_path: null })
    logoDataUrl.value = null
    ElMessage.success('Logo 已清除')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ElMessage.error(`Logo 清除失败：${detail}`)
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

        <!-- spooler 分区 -->
        <template v-if="printForm.printer_channel === 'spooler'">
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
            <div class="field-hint">
              热敏小票机请选择系统中已安装的小票打印机；列表为空时保持「自动选择」即可。
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
        <span class="card-foot__hint">测试打印发送最小样张：初始化 + 居中 test + 切纸。</span>
        <div class="card-foot__actions">
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

    <!-- ═══ 卡片三：小票 Logo（文件系统存储 + dataURL 预览）═══ -->
    <el-card class="settings-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span class="card-head__marker" aria-hidden="true"></span>
          <span class="card-head__title">小票 Logo</span>
          <span class="card-head__desc">打印在小票头部</span>
        </div>
      </template>

      <div class="logo-row">
        <div class="logo-preview" :class="{ 'is-empty': !logoDataUrl }">
          <img
            v-if="logoDataUrl"
            :src="logoDataUrl"
            alt="小票 Logo 预览"
            class="logo-preview__img"
            data-testid="logo-preview"
          />
          <el-icon v-else class="logo-preview__empty" :size="26"><Picture /></el-icon>
        </div>
        <div class="logo-actions">
          <el-button
            type="primary"
            plain
            data-testid="upload-logo-btn"
            :loading="uploadingLogo"
            @click="onUploadLogo"
          >
            上传 Logo
          </el-button>
          <el-button data-testid="clear-logo-btn" :disabled="!logoDataUrl" @click="onClearLogo">
            清除
          </el-button>
          <p class="logo-hint">仅支持 PNG，建议黑白图、宽不超过 300 像素。</p>
        </div>
      </div>
    </el-card>
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

/* ── 通道单选卡（三选一带描述）── */
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

/* ── spooler 打印机选择行 ── */
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

/* ── Logo 卡片 ── */
.logo-row {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.logo-preview {
  width: 104px;
  height: 104px;
  flex-shrink: 0;
  border-radius: 8px;
  border: 1px solid var(--el-border-color);
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.logo-preview.is-empty {
  border-style: dashed;
  background: var(--el-fill-color-lighter);
}

.logo-preview__img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.logo-preview__empty {
  color: var(--el-text-color-placeholder);
}

.logo-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}

.logo-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
</style>
