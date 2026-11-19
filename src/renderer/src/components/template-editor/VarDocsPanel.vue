<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { QuestionFilled } from '@element-plus/icons-vue'
import { RECEIPT_VAR_DOCS } from '../../../../shared/receipt/template-schema'

/**
 * 模板编辑器·可用变量说明区（TemplateEditorView 拆分批次 4；自包含组件——
 * 消费 shared/receipt/template-schema 的 RECEIPT_VAR_DOCS 单一事实源）。
 *
 * 可折叠紧凑卡片，默认展开；点击变量复制 `{变量}` 插槽原文
 * （file:// 下 clipboard API 可能不可用——静默降级，code 文本可手抄）。
 */

/** 说明区折叠面板展开态（单面板，name='vars'） */
const varsHelpActive = ref<string[]>(['vars'])

/** 变量插槽原文（与 interpolateVariables 的 `{变量}` 语法一致） */
function varSlot(name: string): string {
  return `{${name}}`
}

/** 点击复制 `{变量}`（file:// 下 clipboard API 可能不可用——静默降级，code 文本可手抄） */
async function copyVarSlot(name: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(varSlot(name))
    ElMessage.success('已复制')
  } catch {
    // 剪贴板不可用：不弹错（复制是便利非依赖），用户可对照说明手抄
  }
}
</script>

<template>
  <el-collapse
    v-model="varsHelpActive"
    class="tpl-vars-help"
    data-testid="tpl-vars-help"
  >
    <el-collapse-item name="vars">
      <template #title>
        <span
          class="tpl-vars-help__title"
          data-testid="tpl-vars-help-toggle"
        >
          <el-icon class="tpl-vars-help__icon"><QuestionFilled /></el-icon>
          可用变量（输入 {变量名} 自动替换，点击变量可复制）
        </span>
      </template>
      <p class="tpl-vars-help__intro">
        变量可输入在头部段落、合计行、底部段落的文案中，打印时替换为实际值；未知变量保留原文。
      </p>
      <div class="tpl-vars-help__grid">
        <button
          v-for="v in RECEIPT_VAR_DOCS"
          :key="v.name"
          type="button"
          class="tpl-vars-help__item"
          :title="`点击复制 ${varSlot(v.name)}`"
          data-testid="tpl-var-item"
          @click="copyVarSlot(v.name)"
        >
          <code>{{ varSlot(v.name) }}</code>
          <span>{{ v.description }}</span>
        </button>
      </div>
    </el-collapse-item>
  </el-collapse>
</template>

<style scoped>
/* ── 变量说明区（可折叠紧凑卡片，默认展开——浅底降权，不喧宾夺主）── */
.tpl-vars-help {
  margin-top: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.tpl-vars-help :deep(.el-collapse-item__header) {
  height: 40px;
  padding: 0 16px;
  border-bottom: none;
  background: transparent;
}

.tpl-vars-help :deep(.el-collapse-item__wrap) {
  border-bottom: none;
  background: transparent;
}

.tpl-vars-help :deep(.el-collapse-item__content) {
  padding-bottom: 12px;
}

.tpl-vars-help__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.tpl-vars-help__icon {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.tpl-vars-help__intro {
  margin: 0 0 8px;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.tpl-vars-help__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 4px;
  padding: 0 8px;
}

.tpl-vars-help__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.tpl-vars-help__item:hover {
  background: var(--el-fill-color-light);
}

.tpl-vars-help__item code {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--el-fill-color);
  font-family: 'NSimSun', 'SimSun', monospace;
  font-size: 12px;
  color: var(--el-color-primary);
}

.tpl-vars-help__item span {
  min-width: 0;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
</style>
