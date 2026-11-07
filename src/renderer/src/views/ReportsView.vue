<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import { createTypedInvoke } from '../../../shared/types/ipc'
import type { DailyReport, MonthlyReport } from '../../../shared/types/domain'
import { formatMoney } from '../../../shared/utils/money'

/**
 * 报表统计（Task 18）：日报/月报双 tab + 三格式导出集成。
 *
 * - 汇总数字全部来自 service 返回值（reports:daily/monthly 剔除 voided——D3），
 *   UI 层零合计重算；金额分→元仅在本页显示边界经 formatMoney（G1）。
 * - 导出走 reports:export（T17 链路：主进程 dialog → 写文件 → 打开所在文件夹）；
 *   file_path null = 用户取消（静默返回，不打扰）。
 * - 空数据日汇总卡片显示 0.00 / 0，表格 el-empty，导出按钮保持可用
 *   （导出含零值的空表——T17 exporter 空态契约）。
 */

type ExportFormat = 'txt' | 'xlsx' | 'docx'

/** el-dropdown @command 回调签名（command 值由本页模板写死，cast 安全） */
type DropdownCommand = string | number | object

const typedInvoke = createTypedInvoke(window.api.invoke)

const activeTab = ref<'daily' | 'monthly'>('daily')

// ── 日期工具（本地时区，与 created_at 的 datetime('now','localtime') 同钟）──

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function localDateStr(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function localMonthStr(offsetMonths: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() + offsetMonths)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

function dayDate(offsetDays: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d
}

function monthDate(offsetMonths: number): Date {
  const d = new Date()
  d.setMonth(d.getMonth() + offsetMonths)
  return d
}

// ── 日报（默认今天）──

const activeDate = ref(localDateStr(0))
const dailyReport = ref<DailyReport | null>(null)
const dailyLoading = ref(false)

/** 高频日期快捷入口（同时是 E2E 的日期交互路径——零日历面板操作，T13 定式） */
const dateShortcuts = [
  { text: '今天', value: (): Date => dayDate(0) },
  { text: '昨天', value: (): Date => dayDate(-1) },
  { text: '一周前', value: (): Date => dayDate(-7) },
  { text: '一个月前', value: (): Date => dayDate(-30) }
]

async function refreshDaily(): Promise<void> {
  dailyLoading.value = true
  try {
    dailyReport.value = await typedInvoke('reports:daily', { date: activeDate.value })
  } catch (err) {
    ElMessage.error(`日报加载失败：${errorMessage(err)}`)
  } finally {
    dailyLoading.value = false
  }
}

watch(activeDate, () => {
  void refreshDaily()
})

// ── 月报（默认本月）──

const activeMonth = ref(localMonthStr(0))
const monthlyReport = ref<MonthlyReport | null>(null)
const monthlyLoading = ref(false)

const monthShortcuts = [
  { text: '本月', value: (): Date => monthDate(0) },
  { text: '上月', value: (): Date => monthDate(-1) }
]

async function refreshMonthly(): Promise<void> {
  monthlyLoading.value = true
  try {
    monthlyReport.value = await typedInvoke('reports:monthly', { month: activeMonth.value })
  } catch (err) {
    ElMessage.error(`月报加载失败：${errorMessage(err)}`)
  } finally {
    monthlyLoading.value = false
  }
}

watch(activeMonth, () => {
  void refreshMonthly()
})

// ── 导出（reports:export；当前 tab 的 period 随 kind 联动）──

const exporting = ref<ExportFormat | null>(null)

async function handleExport(
  kind: 'daily' | 'monthly',
  period: string,
  format: ExportFormat
): Promise<void> {
  exporting.value = format
  try {
    const { file_path } = await typedInvoke('reports:export', { kind, period, format })
    if (file_path === null) return // 用户在保存对话框取消——静默返回
    const fileName = file_path.replaceAll('\\', '/').split('/').pop() ?? file_path
    ElMessage.success(`已导出：${fileName}`)
  } catch (err) {
    ElMessage.error(`导出失败：${errorMessage(err)}`)
  } finally {
    exporting.value = null
  }
}

function exportDaily(command: DropdownCommand): void {
  void handleExport('daily', activeDate.value, command as ExportFormat)
}

function exportMonthly(command: DropdownCommand): void {
  void handleExport('monthly', activeMonth.value, command as ExportFormat)
}

onMounted(() => {
  // 两 tab 并行预取（POS 单日/单月数据量小，切 tab 零等待）
  void refreshDaily()
  void refreshMonthly()
})

// ── 工具 ──

/** 剥除 Electron invoke 序列化前缀，取纯中文消息（T8 模式） */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const match = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return match ? match[1] : raw
}
</script>

<template>
  <section class="reports">
    <header class="reports__header">
      <div>
        <h2 class="reports__title">报表统计</h2>
        <p class="reports__sub">
          按日/按月汇总销售数据（自动剔除已作废订单），支持导出 .txt / .xlsx / .docx
        </p>
      </div>
    </header>

    <el-tabs v-model="activeTab" class="reports__tabs">
      <!-- ═══ 日报 ═══ -->
      <el-tab-pane label="日报" name="daily">
        <div class="reports__pane">
          <div class="reports__toolbar">
            <!-- el-date-picker 的 $attrs 落在 teleport popper 上（data-testid 不可用）；
                 class 单独 fallthrough 到 input wrapper——E2E 用修饰 class 定位 -->
            <el-date-picker
              v-model="activeDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="选择日期"
              :clearable="false"
              :shortcuts="dateShortcuts"
              class="reports__date-picker reports__date-picker--daily"
            />
            <div class="reports__toolbar-spacer" aria-hidden="true"></div>
            <!-- 导出锚点用原生 wrapper div（el-dropdown 根为 ElTooltip 包装，attr 传递不可靠） -->
            <div class="reports__export" data-testid="daily-export">
              <el-dropdown trigger="click" @command="exportDaily">
                <el-button type="primary" :loading="exporting !== null">
                  <el-icon class="reports__export-icon"><Download /></el-icon>
                  导出日报
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="txt">导出 .txt（纯文本）</el-dropdown-item>
                    <el-dropdown-item command="xlsx">导出 .xlsx（Excel）</el-dropdown-item>
                    <el-dropdown-item command="docx">导出 .docx（Word）</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>

          <div class="reports__stats" data-testid="daily-stats">
            <div class="stat-card">
              <span class="stat-card__label">总销售额（元）</span>
              <strong class="stat-card__value stat-card__value--money">{{
                formatMoney(dailyReport?.total_cents ?? 0)
              }}</strong>
            </div>
            <div class="stat-card">
              <span class="stat-card__label">订单数</span>
              <strong class="stat-card__value">{{ dailyReport?.order_count ?? 0 }}</strong>
            </div>
            <!-- 尾部追加国补卡（既有 nth 序号零破坏——E2E stats.nth(0)/nth(1) 不受影响） -->
            <div class="stat-card">
              <span class="stat-card__label">国补销售额（元）</span>
              <strong class="stat-card__value stat-card__value--money">{{
                formatMoney(dailyReport?.subsidy_total_cents ?? 0)
              }}</strong>
            </div>
          </div>

          <el-table
            v-loading="dailyLoading"
            :data="dailyReport?.sales ?? []"
            class="reports__table"
            row-key="id"
            data-testid="daily-table"
          >
            <el-table-column prop="sale_no" label="单号" min-width="140" />
            <el-table-column prop="created_at" label="时间" min-width="160" />
            <el-table-column prop="item_count" label="商品数" width="90" align="center" />
            <el-table-column label="合计（元）" width="120" align="right">
              <template #default="{ row }">
                <span class="reports__amount">{{ formatMoney(row.total_cents) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90" align="center">
              <template #default="{ row }">
                <el-tag
                  :type="row.status === 'voided' ? 'danger' : 'primary'"
                  disable-transitions
                >
                  {{ row.status === 'voided' ? '已作废' : '已完成' }}
                </el-tag>
              </template>
            </el-table-column>
            <!-- 尾部追加两列（定案）：td nth 序号零破坏——E2E rowA.nth(2)/nth(3) 不受影响；
                 false 渲染纯文本「否」而非 el-tag——E2E rows.locator('.el-tag') 计数只数状态列 -->
            <el-table-column label="是否国补" width="100" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.is_national_subsidy" type="success" disable-transitions>
                  国补
                </el-tag>
                <span v-else>否</span>
              </template>
            </el-table-column>
            <el-table-column prop="order_note" label="订单备注" min-width="160" />
            <template #empty>
              <el-empty description="当日无销售" :image-size="100" />
            </template>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ═══ 月报 ═══ -->
      <el-tab-pane label="月报" name="monthly">
        <div class="reports__pane">
          <div class="reports__toolbar">
            <el-date-picker
              v-model="activeMonth"
              type="month"
              value-format="YYYY-MM"
              placeholder="选择月份"
              :clearable="false"
              :shortcuts="monthShortcuts"
              class="reports__date-picker reports__date-picker--monthly"
            />
            <div class="reports__toolbar-spacer" aria-hidden="true"></div>
            <div class="reports__export" data-testid="monthly-export">
              <el-dropdown trigger="click" @command="exportMonthly">
                <el-button type="primary" :loading="exporting !== null">
                  <el-icon class="reports__export-icon"><Download /></el-icon>
                  导出月报
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="txt">导出 .txt（纯文本）</el-dropdown-item>
                    <el-dropdown-item command="xlsx">导出 .xlsx（Excel）</el-dropdown-item>
                    <el-dropdown-item command="docx">导出 .docx（Word）</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>

          <div class="reports__stats" data-testid="monthly-stats">
            <div class="stat-card">
              <span class="stat-card__label">总销售额（元）</span>
              <strong class="stat-card__value stat-card__value--money">{{
                formatMoney(monthlyReport?.total_cents ?? 0)
              }}</strong>
            </div>
            <div class="stat-card">
              <span class="stat-card__label">订单数</span>
              <strong class="stat-card__value">{{ monthlyReport?.order_count ?? 0 }}</strong>
            </div>
          </div>

          <el-table
            v-loading="monthlyLoading"
            :data="monthlyReport?.buckets ?? []"
            class="reports__table"
            row-key="date"
            data-testid="monthly-table"
          >
            <el-table-column prop="date" label="日期" min-width="140" />
            <el-table-column label="销售额（元）" min-width="140" align="right">
              <template #default="{ row }">
                <span class="reports__amount">{{ formatMoney(row.total_cents) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="order_count" label="订单数" width="100" align="center" />
            <template #empty>
              <el-empty description="当月无销售" :image-size="100" />
            </template>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.reports {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px 24px;
  box-sizing: border-box;
  gap: 16px;
}

.reports__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}

.reports__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}

.reports__sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

/* el-tabs 撑满剩余高度：tabs 根节点 flex 化 + content 区伸缩 */
.reports__tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.reports__tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: visible;
}

.reports__pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 16px;
}

.reports__toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.reports__toolbar-spacer {
  flex: 1;
}

.reports__export-icon {
  margin-right: 4px;
}

/* ── 汇总卡片（数字优先：大字 tabular-nums，销售额主色强调）── */
.reports__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 20px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.stat-card__label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.stat-card__value {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.stat-card__value--money {
  color: var(--el-color-primary);
}

.reports__table {
  flex: 1;
}

.reports__amount {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
