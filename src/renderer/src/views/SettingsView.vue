<script setup lang="ts">
import { computed } from 'vue'
import { Search } from '@element-plus/icons-vue'
import DiagnosisDialog from '@renderer/components/settings/DiagnosisDialog.vue'
import LogoManagerCard from '@renderer/components/settings/LogoManagerCard.vue'
import PrintSettingsCard from '@renderer/components/settings/PrintSettingsCard.vue'
import ShopInfoCard from '@renderer/components/settings/ShopInfoCard.vue'
import { usePrintingStore } from '@renderer/stores/printing.store'

/**
 * 系统设置页（Task 19）：页头 + 四卡片编排。
 *
 * 卡片组件自治（各自加载/保存/toast 闭环——DiagnosisDialog 拆分先例的推广）：
 * - ShopInfoCard       卡片一：店铺信息（settings:get/set）
 * - PrintSettingsCard  卡片二：打印设置（通道/测试打印/编码探针/高级实验区）
 * - LogoManagerCard    卡片三：小票多 Logo 管理
 * - 卡片四打印机诊断本页内联（本体仅 printing store 的两个按钮编排，
 *   报告对话框为 DiagnosisDialog——T10 既有拆分）
 *
 * 卡片骨架共享样式在 assets/settings-cards.css（本页经非 scoped style 块
 * 全局加载一次——卡片拆为独立组件后，父页 scoped 样式无法跨组件生效）。
 */

/** 打印诊断（T10）：状态与动作全在 printing store（对话框为纯渲染子组件） */
const printingStore = usePrintingStore()

/** 对话框在「采集中」与「已有报告」时展示；诊断失败态由 error toast 承担（不弹窗） */
const diagnosisDialogVisible = computed(
  () =>
    printingStore.diagnosisState === 'collecting' || printingStore.diagnosisState === 'report'
)
</script>

<template>
  <section class="settings-page">
    <header class="page-head">
      <h1 class="page-head__title">系统设置</h1>
      <p class="page-head__sub">店铺信息、打印通道与小票 Logo 集中管理</p>
    </header>

    <ShopInfoCard />

    <PrintSettingsCard />

    <LogoManagerCard />

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

<!-- 卡片骨架共享样式（全局加载一次；选择器全部收敛在 .settings-page 命名空间下） -->
<style src="../assets/settings-cards.css"></style>

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

/* ── 诊断卡片说明（T10）── */
.diagnosis-intro {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}
</style>
