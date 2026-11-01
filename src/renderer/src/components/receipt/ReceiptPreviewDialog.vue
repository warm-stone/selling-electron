<script setup lang="ts">
import { computed } from 'vue'
import ReceiptPreview from '@renderer/components/receipt/ReceiptPreview.vue'
import { usePrintingStore } from '@renderer/stores/printing.store'
import type { PaperWidth } from '../../../../shared/receipt/char-grid'

/**
 * 小票预览弹窗（Task 15，可复用组件）。
 *
 * 状态全部来自 printing store（全局）：PosView（结账成功）与
 * SalesHistoryView（重打）共用本弹窗——同一份 PreviewPayload 驱动
 * ReceiptPreview 渲染（G7：与打印字节同一组装源头）。
 *
 * 边界（计划 MUST NOT）：弹窗内不做打印设置修改（设置页职责）、
 * 不做打印以外的任何动作；「立即打印」只调 printing:print。
 */
const store = usePrintingStore()

/** 弹窗宽度随模板纸宽自适应（纸张 307/221px + 弹窗内边距余量） */
const DIALOG_WIDTH_PX: Record<PaperWidth, string> = { '58mm': '380px', '80mm': '460px' }

const dialogWidth = computed<string>(() =>
  store.payload ? DIALOG_WIDTH_PX[store.payload.template.paperWidth] : DIALOG_WIDTH_PX['80mm']
)

const isVoided = computed(() => store.payload?.sale.status === 'voided')
</script>

<template>
  <el-dialog
    v-model="store.visible"
    :title="store.title"
    :width="dialogWidth"
    align-center
    destroy-on-close
    class="receipt-preview-dialog"
  >
    <template v-if="store.payload">
      <el-alert
        v-if="isVoided"
        type="warning"
        :closable="false"
        show-icon
        class="receipt-preview-dialog__voided"
      >
        该单已作废，重打小票将加印「已作废」标记
      </el-alert>
      <div class="receipt-preview-dialog__stage">
        <ReceiptPreview
          :template="store.payload.template"
          :data="store.payload.data"
          :vars="store.payload.vars"
          :logo-url="store.payload.logoUrl ?? undefined"
        />
      </div>
    </template>
    <template #footer>
      <el-button :disabled="store.printing" @click="store.close()">取消</el-button>
      <el-button
        type="primary"
        :loading="store.printing"
        data-testid="preview-print-btn"
        @click="store.print()"
      >
        立即打印
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 纸张展示台：深色底衬托白纸（预览拟真） */
.receipt-preview-dialog__stage {
  display: flex;
  justify-content: center;
  padding: 16px 12px;
  background: var(--el-fill-color-darker);
  border-radius: var(--el-border-radius-small);
  overflow: auto;
}

.receipt-preview-dialog__voided {
  margin-bottom: 12px;
}
</style>
