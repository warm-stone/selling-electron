<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'

/**
 * 条码/搜索输入框（Task 11）——收银台扫码枪的焦点锚点。
 *
 * 扫码唯一入口是主进程 before-input-event 检测桥（preload.onBarcode 推送，
 * 焦点在购物车数量框等任意位置都能触发扫码加购）；本输入框因此**不处理
 * Enter 加购**——扫码枪的 Enter 终结键同样会到达此聚焦输入框，双路径消费
 * 同一次扫码会造成重复加购。手动加购路径 = 搜索 + 结果行双击。
 */

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    /** 未命中条码的高亮闪烁（由父视图在扫码 miss 时驱动） */
    miss?: boolean
  }>(),
  { placeholder: '扫码枪即扫即加 / 输入名称或条码搜索', miss: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: string]; clear: [] }>()

const inputRef = ref<{ focus: () => void } | null>(null)

onMounted(() => {
  void nextTick(focus)
})

/** 聚焦输入框（扫码锚点复位；父视图在结账后/未命中时调用） */
async function focus(): Promise<void> {
  await nextTick()
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <el-input
    ref="inputRef"
    :model-value="modelValue"
    :placeholder="props.placeholder"
    :prefix-icon="Search"
    class="barcode-input"
    :class="{ 'barcode-input--miss': props.miss }"
    clearable
    size="large"
    @update:model-value="(v: string) => emit('update:modelValue', v)"
    @clear="() => { emit('update:modelValue', ''); emit('clear'); void focus() }"
  />
</template>

<style scoped>
/* 扫码锚点：大字号、条码等宽字体、琥珀聚焦环（扫码枪一瞄即中的视觉主入口） */
.barcode-input :deep(input) {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 15px;
  letter-spacing: 0.02em;
}

.barcode-input--miss :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
</style>
