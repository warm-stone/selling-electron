<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useCartStore } from '@renderer/stores/cart.store'
import type { Product } from '../../../../shared/types'

/**
 * SN 加购弹窗（T2.A）：双击 SN 商品 / 扫 SN 商品条码命中共用入口（D-SN5）。
 *
 * 双路径防重复（R2，同 BarcodeInput 经验）：扫码枪的 Enter 终结键会同时
 * 到达聚焦输入框与全局桥——本输入框**不处理 Enter 提交**，扫码统一走
 * onBarcode 桥（弹窗打开期间自订阅，扫码即自动确认）；手动输入只能点
 * 「确认」按钮提交。父视图（PosView）在弹窗打开期间跳过自身的扫码查询，
 * 同一次扫码仅本弹窗消费一次。
 *
 * 确认校验（D-SN6 拒绝态）：findSn → 不存在 / 已售（带原单号）/ 不属于
 * 该商品 / 同 SN 已在购物车，逐态明确报错；全部通过才加购 SN 行（qty=1）。
 */

const props = defineProps<{
  /** v-model:visible——弹窗开关（父视图控制） */
  visible: boolean
  /** 绑定的 SN 商品（弹窗内加购的目标商品） */
  product: Product | null
}>()

const emit = defineEmits<{ 'update:visible': [value: boolean]; close: []; added: [] }>()

const cart = useCartStore()

const snInput = ref('')
const submitting = ref(false)
const inputRef = ref<{ focus: () => void } | null>(null)

// ── 扫码桥：弹窗打开期间订阅，扫码即填入并自动确认 ──

let unsubscribeBarcode: (() => void) | undefined

function subscribeBarcode(): void {
  if (unsubscribeBarcode) return
  unsubscribeBarcode = window.api.onBarcode((code) => {
    snInput.value = code
    void confirmSn()
  })
}

function teardownBarcode(): void {
  unsubscribeBarcode?.()
  unsubscribeBarcode = undefined
}

watch(
  () => props.visible,
  (open) => {
    if (open) {
      snInput.value = ''
      subscribeBarcode()
      void nextTick(() => inputRef.value?.focus())
    } else {
      teardownBarcode()
    }
  }
)

onBeforeUnmount(teardownBarcode)

// ── 确认：findSn 四态校验 → 加购 SN 行 ──

function extractIpcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const matched = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return matched ? matched[1]! : raw
}

async function confirmSn(): Promise<void> {
  const sn = snInput.value.trim()
  if (sn.length === 0) {
    ElMessage.warning('请输入或扫描 SN')
    return
  }
  if (!props.product || submitting.value) return
  submitting.value = true
  try {
    const hit = await window.api.products.findSn(sn)
    if (hit === null) {
      ElMessage.error('SN 不存在或已删除')
      return
    }
    if (hit.sn.status === 'sold') {
      ElMessage.warning(`该 SN 已售出（单号 ${hit.sn.sale_no ?? '—'}）`)
      return
    }
    if (hit.sn.product_id !== props.product.id) {
      ElMessage.error('SN 不属于该商品')
      return
    }
    try {
      cart.addItem(hit.product, sn)
    } catch (err) {
      // 同 SN 已在购物车（D-SN7 拒绝态，store 抛错由本层展示）
      ElMessage.error(err instanceof Error ? err.message : String(err))
      return
    }
    ElMessage.success(`已加入购物车：${hit.product.name}`)
    emit('added')
    closeDialog()
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    submitting.value = false
  }
}

function closeDialog(): void {
  emit('update:visible', false)
  emit('close')
}
</script>

<template>
  <el-dialog
    :model-value="props.visible"
    title="SN 加购"
    width="420px"
    align-center
    destroy-on-close
    class="sn-entry-dialog"
    @update:model-value="(v: boolean | string | number) => { if (!v) closeDialog() }"
  >
    <div v-if="props.product" class="sn-entry">
      <div class="sn-entry__product">
        <span class="sn-entry__product-name" :title="props.product.name">{{ props.product.name }}</span>
        <span v-if="props.product.barcode" class="sn-entry__product-barcode">
          {{ props.product.barcode }}
        </span>
      </div>
      <el-input
        ref="inputRef"
        v-model="snInput"
        class="sn-entry__input"
        placeholder="扫码枪直接扫入，或手动输入 SN"
        size="large"
        clearable
        data-testid="sn-entry-input"
      />
      <p class="sn-entry__hint">扫码即自动确认；手动输入后请点击「确认」按钮</p>
    </div>
    <template #footer>
      <el-button data-testid="sn-entry-cancel" @click="closeDialog()">取消</el-button>
      <el-button
        type="primary"
        :loading="submitting"
        data-testid="sn-entry-confirm"
        @click="void confirmSn()"
      >
        确认
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 商品标识行：名称 + 条码（与收银台结果行的视觉语言一致） */
.sn-entry__product {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
  min-width: 0;
}

.sn-entry__product-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sn-entry__product-barcode {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px;
  letter-spacing: 0.03em;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

/* SN 输入：扫码锚点（等宽字体，同 BarcodeInput） */
.sn-entry__input :deep(input) {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 15px;
  letter-spacing: 0.02em;
}

.sn-entry__hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
}
</style>
