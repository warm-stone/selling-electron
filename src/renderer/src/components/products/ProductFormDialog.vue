<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import type { ProductRow, ProductTracking } from '../../../../shared/types'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'

/**
 * 商品新增/编辑弹窗（ProductsView 拆分；组件自治——SnEntryDialog/CheckoutDialog
 * 先例模式）：自持双类型表单态（批量计 / SN——D-SN1 建后不可转，SN 商品多
 * 【SN 前缀】D-SN2、禁初始库存与手动调库 D-SN11），元↔分边界转换（G1），
 * create/update/updateStock IPC 与 toast 本组件闭环；成功后 emit('saved')
 * 由父视图刷新列表。编辑模式从 row 带入初值（条码/tracking 只读分支）。
 */

const props = defineProps<{
  visible: boolean
  mode: 'create' | 'edit'
  /** 编辑对象（mode='edit' 时必传；create 时 null） */
  row: ProductRow | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()

interface ProductFormState {
  barcode: string
  name: string
  stock: number
  /** 默认售价（元，2 位小数；null=未设）——提交前转分 */
  price: number | null
  /** 计存类型：仅建档可选（D-SN1 建后不可转）；编辑时从行带入，仅作展示与分支 */
  tracking: ProductTracking
  /** SN 前缀（仅 SN 商品；提交前 trim，空串=不启用——D-SN2） */
  snPrefix: string
}

/** 建档默认「SN 商品」（一物一码为主业态）；批量计需显式切换 */
const DEFAULT_TRACKING: ProductTracking = 'sn'

const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive<ProductFormState>({
  barcode: '',
  name: '',
  stock: 0,
  price: null,
  tracking: DEFAULT_TRACKING,
  snPrefix: ''
})

const rules: FormRules = {
  name: [
    {
      required: true,
      validator: (_rule, value: string, callback) => {
        if (typeof value !== 'string' || value.trim().length === 0) {
          callback(new Error('商品名称不能为空'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

// ── 金额边界转换（G1：元浮点仅存在于本弹窗输入边界）──

function yuanToCents(yuan: number | null): number | null {
  return yuan === null ? null : Math.round(yuan * 100)
}

function centsToYuan(cents: number | null): number | null {
  return cents === null ? null : cents / 100
}

/** 打开时初始化表单（原 ProductsView openCreate/openEdit 逻辑——零行为变化） */
watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    if (props.mode === 'create' || props.row === null) {
      Object.assign(form, {
        barcode: '',
        name: '',
        stock: 0,
        price: null,
        tracking: DEFAULT_TRACKING,
        snPrefix: ''
      })
    } else {
      const row = props.row
      Object.assign(form, {
        barcode: row.barcode ?? '',
        name: row.name,
        stock: row.stock,
        price: centsToYuan(row.default_price_cents),
        tracking: row.tracking,
        snPrefix: row.sn_prefix
      })
    }
  }
)

async function save(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const cents = yuanToCents(form.price)
    if (props.mode === 'create') {
      await window.api.products.create({
        barcode: form.barcode.trim().length > 0 ? form.barcode.trim() : null,
        name: form.name.trim(),
        default_price_cents: cents,
        // SN 商品库存恒 0（D-SN11：一律进货录入，主进程同侧强制）
        stock: form.tracking === 'sn' ? 0 : form.stock,
        tracking: form.tracking,
        // 仅 SN 商品带前缀（trim 后空串=不启用——D-SN2；冲突由 service 校验 D-SN14）
        ...(form.tracking === 'sn' ? { sn_prefix: form.snPrefix.trim() } : {})
      })
      ElMessage.success(
        form.tracking === 'sn' ? 'SN 商品已创建，SN 请从进货录入' : '商品已创建'
      )
    } else {
      const row = props.row!
      await window.api.products.update({
        id: row.id,
        name: form.name.trim(),
        default_price_cents: cents,
        // update 契约：sn_prefix 省略=保持现值，显式传值（含 ''）才覆盖——SN 商品必传
        ...(row.tracking === 'sn' ? { sn_prefix: form.snPrefix.trim() } : {})
      })
      // SN 商品禁手动调库（D-SN11，主进程同侧拒绝）；批量计保持原逻辑
      if (row.tracking === 'quantity' && form.stock !== row.stock) {
        await window.api.products.updateStock({ id: row.id, stock: form.stock })
      }
      ElMessage.success('商品已保存')
    }
    emit('update:visible', false)
    emit('saved')
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    submitting.value = false
  }
}

function close(): void {
  emit('update:visible', false)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="mode === 'create' ? '新增商品' : '编辑商品'"
    width="480px"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => emit('update:visible', v)"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="96px"
    >
      <el-form-item
        v-if="mode === 'create'"
        label="类型"
      >
        <el-radio-group
          v-model="form.tracking"
          data-testid="product-tracking"
        >
          <el-radio-button value="sn">
            SN 商品
          </el-radio-button>
          <el-radio-button value="quantity">
            批量计商品
          </el-radio-button>
        </el-radio-group>
        <div class="form-hint">
          商品类型创建后不可修改
        </div>
      </el-form-item>
      <!-- 编辑 SN 商品：只读类型标识（D-SN1 禁互转，不提供切换） -->
      <el-form-item
        v-if="mode === 'edit' && form.tracking === 'sn'"
        label="类型"
      >
        <el-tag
          type="warning"
          effect="plain"
        >
          SN 商品
        </el-tag>
        <div class="form-hint">
          类型创建后不可修改；库存为在库 SN 数，从进货录入
        </div>
      </el-form-item>
      <el-form-item label="条码">
        <el-input
          v-model="form.barcode"
          :disabled="mode === 'edit'"
          maxlength="64"
          placeholder="扫码或手动输入，可留空"
        />
        <div
          v-if="mode === 'edit'"
          class="form-hint"
        >
          条码创建后不可修改
        </div>
      </el-form-item>
      <el-form-item
        label="名称"
        prop="name"
      >
        <el-input
          v-model="form.name"
          maxlength="60"
          show-word-limit
          placeholder="商品名称"
        />
      </el-form-item>
      <!-- 批量计：初始库存/调整为库存（原逻辑逐字节不变）；SN 商品隐藏（D-SN11） -->
      <el-form-item
        v-if="form.tracking === 'quantity'"
        :label="mode === 'create' ? '初始库存' : '调整为库存'"
      >
        <el-input-number
          v-model="form.stock"
          :precision="0"
          :step="1"
          class="form-number"
        />
        <div class="form-hint">
          允许负值（盘点差异可记负，行标红提示）
        </div>
      </el-form-item>
      <!-- SN 商品：SN 前缀（可改，影响以后进货匹配——D-SN2） -->
      <el-form-item
        v-if="form.tracking === 'sn'"
        label="SN 前缀"
      >
        <el-input
          v-model="form.snPrefix"
          maxlength="32"
          placeholder="选填，进货扫 SN 自动匹配商品用"
          data-testid="product-sn-prefix"
        />
        <div class="form-hint">
          非空前缀不能与其他 SN 商品相同或互为前缀；留空表示不启用
        </div>
      </el-form-item>
      <el-form-item label="默认售价">
        <el-input-number
          v-model="form.price"
          :min="0"
          :precision="2"
          :step="0.5"
          :controls="false"
          class="form-number"
          placeholder="元"
        />
        <div class="form-hint">
          单位元；留空表示不设加购默认价
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="close">
        取消
      </el-button>
      <el-button
        type="warning"
        :loading="submitting"
        @click="save()"
      >
        保存
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-number {
  width: 200px;
}

.form-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
