<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { useCartStore } from '../../stores/cart.store'
import { formatMoney } from '../../../../shared/utils/money'
import { isValidMobilePhone, INVALID_PHONE_MESSAGE } from '../../../../shared/utils/phone'
import type { CheckoutExtrasInput, Customer } from '../../../../shared/types'

/**
 * 结账弹窗（Task 10）：CartPanel「结账」→ 收银台打开本弹窗收集客户/订单附加信息。
 *
 * 职责边界：本组件只管表单（校验 / 电话失焦预填 / 组装 extras），sales:checkout
 * 的 IPC 调用与成功后链路（清车 + 小票预览）在父视图 confirm 回调——语义与
 * 旧直连结账完全一致；取消直接关闭，购物车完整保留、零落库。
 *
 * 校验规则镜像后端 SaleService（错误文案逐字一致）：
 * - name/address/note 任一非空 ⇒ phone 必填（'填写客户信息时，电话不能为空'）
 * - 国补开 ⇒ name + phone 必填（'参与国补需填写客户姓名和电话'）
 * - phone 非空 ⇒ 手机号格式（'请输入正确的手机号（1 开头 11 位）'）
 * - ★客户备注缝隙（issues.md L2 修复）：客户信息组以电话为锚——任一客户字段
 *   （含 note）有值而电话为空即阻断，防止「只填客户备注」无载体（phone 空 →
 *   不建档 → note 无处安放）；service 层已镜像同规则（UI+service 双防线）。
 */

const props = defineProps<{
  /** v-model:visible——弹窗开关（父视图控制；任何关闭路径均为取消，购物车不动） */
  visible: boolean
  /** 提交中（父视图 sales:checkout IPC 进行中）——确认按钮 loading 防双击 */
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  /** 校验通过 → 组装好的 extras（全空 undefined=快单路径）；IPC 调用在父视图 */
  confirm: [extras: CheckoutExtrasInput | undefined]
}>()

const cart = useCartStore()

/** 合计金额（整数分 → 元显示，G1：本组件零浮点金额运算） */
const totalText = computed(() => `¥${formatMoney(cart.totalCents)}`)

// ── 表单状态（弹窗打开时整体重置，每次结账独立）──

interface CheckoutFormState {
  name: string
  phone: string
  address: string
  note: string
  isNationalSubsidy: boolean
  orderNote: string
  salesperson: string
}

const INITIAL_FORM: CheckoutFormState = {
  name: '',
  phone: '',
  address: '',
  note: '',
  isNationalSubsidy: false,
  orderNote: '',
  salesperson: ''
}

const form = reactive<CheckoutFormState>({ ...INITIAL_FORM })
const formRef = ref<FormInstance>()

/** 电话失焦查客户的命中行（预填来源 + 「已关联」提示）；未命中/散客态为 null */
const matchedCustomer = ref<Customer | null>(null)

/** 最近销售人员选项（每次打开重拉：上单刚用过的姓名即时入列——T8 结账会 push 队列） */
const salespersons = ref<string[]>([])

/**
 * 校验规则（镜像后端 + 备注缝隙收紧）。规则间按优先级短路：国补 > 客户字段；
 * 同一 phone 字段覆盖 name/address/note 三种触发（统一文案），与后端逐字
 * 一致保证提示不漂移。
 */
const rules: FormRules = {
  phone: [
    {
      trigger: ['blur', 'change'],
      validator: (_rule, value: string, callback) => {
        const phone = (value ?? '').trim()
        if (phone !== '') {
          // 非空先过手机号格式（后端 SALE_EXTRAS_PHONE_INVALID，文案逐字一致）
          return isValidMobilePhone(phone)
            ? callback()
            : callback(new Error(INVALID_PHONE_MESSAGE))
        }
        // 国补开 ⇒ phone 必填（后端规则二，文案逐字一致）
        if (form.isNationalSubsidy) return callback(new Error('参与国补需填写客户姓名和电话'))
        // name/address/note 任一非空 ⇒ phone 必填（后端规则一，文案逐字一致）
        if (
          form.name.trim() !== '' ||
          form.address.trim() !== '' ||
          form.note.trim() !== ''
        ) {
          return callback(new Error('填写客户信息时，电话不能为空'))
        }
        callback()
      }
    }
  ],
  name: [
    {
      trigger: ['blur', 'change'],
      validator: (_rule, value: string, callback) => {
        // 国补开 ⇒ name 必填（后端规则二，文案逐字一致）
        if (form.isNationalSubsidy && (value ?? '').trim() === '') {
          return callback(new Error('参与国补需填写客户姓名和电话'))
        }
        callback()
      }
    }
  ]
}

// ── 电话失焦查客户：命中预填，未命中清提示 ──

async function onPhoneBlur(): Promise<void> {
  const phone = form.phone.trim()
  if (phone === '') {
    // 电话清空 → 客户信息组回初始（散客态）：客户字段以电话为锚，无电话即无效
    matchedCustomer.value = null
    form.name = ''
    form.address = ''
    form.note = ''
    return
  }
  try {
    const res = await window.api.customers.list({ keyword: phone })
    // keyword 模糊命中名称/电话——只认 phone 全等项，防同名客户误关联
    const hit = res.items.find((c) => c.phone === phone) ?? null
    matchedCustomer.value = hit
    if (hit !== null) {
      form.name = hit.name
      form.address = hit.address
      form.note = hit.note
    }
  } catch {
    // 查询失败不阻断：预填是便利非依赖，后端结账仍以电话 findOrCreate 为准
    matchedCustomer.value = null
  }
}

// ── 弹窗开关：重置表单 + 拉取销售人员 ──

async function loadSalespersons(): Promise<void> {
  try {
    salespersons.value = await window.api.settings.getRecentSalespersons()
  } catch {
    // 非关键路径：静默回落 []，allow-create 手输不受影响，不打断结账
    salespersons.value = []
  }
}

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    // 每次结账独立：表单回初始不残留上次输入（destroy-on-close 使校验态天然全新）
    Object.assign(form, INITIAL_FORM)
    matchedCustomer.value = null
    // 每次打开重拉：上单用过的销售人员即时入列（T8 结账事务会 push 队列）
    void loadSalespersons()
  },
  // immediate：真实应用初始 visible=false 走 early-return 零副作用；
  // 直开挂载（visible=true）也完成重置 + 拉取，行为不依赖挂载路径
  { immediate: true }
)

// 国补开关切换即时重校验：开 → 姓名/电话必填即刻浮出；关 → 相关错误消散
watch(
  () => form.isNationalSubsidy,
  () => {
    if (!props.visible) return
    void formRef.value?.validateField(['name', 'phone']).catch(() => undefined)
  }
)

// ── 确认：校验 → 组装 extras（全空 undefined=快单路径）→ 交父视图调 IPC ──

function buildExtras(): CheckoutExtrasInput | undefined {
  const customer = {
    name: form.name.trim(),
    phone: form.phone.trim(),
    address: form.address.trim(),
    note: form.note.trim()
  }
  const orderNote = form.orderNote.trim()
  const salesperson = form.salesperson.trim()
  const hasCustomer =
    customer.name !== '' ||
    customer.phone !== '' ||
    customer.address !== '' ||
    customer.note !== ''
  // 字段全空（trim 后）→ undefined：快单路径（不落 sale_extras 行，与旧结账零行为差异）
  if (!hasCustomer && !form.isNationalSubsidy && orderNote === '' && salesperson === '') {
    return undefined
  }
  // 空串安全：后端 trim 后归一（'' → null / 不入最近销售人员队列）
  return {
    customer,
    is_national_subsidy: form.isNationalSubsidy,
    order_note: orderNote,
    salesperson
  }
}

async function onConfirm(): Promise<void> {
  if (props.submitting) return // 防双击（父视图 IPC 进行中；loading 态按钮亦不可再点）
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  emit('confirm', buildExtras())
}

/** 取消：直接关闭——购物车完整保留、零 IPC、零落库 */
function onCancel(): void {
  emit('update:visible', false)
}
</script>

<template>
  <el-dialog
    :model-value="props.visible"
    title="结账"
    width="520px"
    align-center
    :close-on-click-modal="false"
    destroy-on-close
    class="checkout-dialog"
    @update:model-value="(v: boolean | string | number) => { if (!v) onCancel() }"
  >
    <!-- 合计条：收银主 CTA 的琥珀强调（与 CartPanel 合计同视觉语言） -->
    <div class="checkout-dialog__total" data-testid="checkout-total">
      <span class="checkout-dialog__total-label">合计金额</span>
      <span class="checkout-dialog__total-value">{{ totalText }}</span>
    </div>

    <el-form ref="formRef" :model="form" :rules="rules" label-width="88px" @submit.prevent>
      <!-- ── 客户信息组：以电话为锚（失焦自动关联已有客户）── -->
      <div class="checkout-dialog__section-title">客户信息</div>
      <el-form-item label="姓名" prop="name">
        <el-input
          v-model="form.name"
          maxlength="60"
          placeholder="选填"
          data-testid="checkout-customer-name"
        />
      </el-form-item>
      <el-form-item label="电话" prop="phone">
        <el-input
          v-model="form.phone"
          class="checkout-dialog__phone"
          maxlength="32"
          placeholder="失焦自动关联已有客户"
          data-testid="checkout-customer-phone"
          @blur="onPhoneBlur"
        />
        <div
          v-if="matchedCustomer !== null"
          class="checkout-dialog__customer-hint"
          data-testid="checkout-customer-hint"
        >
          已关联客户：{{ matchedCustomer.name }}（信息已带入，可修改）
        </div>
      </el-form-item>
      <el-form-item label="地址" prop="address">
        <el-input
          v-model="form.address"
          maxlength="120"
          placeholder="选填"
          data-testid="checkout-customer-address"
        />
      </el-form-item>
      <el-form-item label="客户备注" prop="note">
        <el-input
          v-model="form.note"
          maxlength="200"
          placeholder="选填，随客户档案保存（需填电话）"
          data-testid="checkout-customer-note"
        />
      </el-form-item>

      <!-- ── 订单信息组 ── -->
      <div class="checkout-dialog__section-title">订单信息</div>
      <el-form-item label="参与国补">
        <el-switch v-model="form.isNationalSubsidy" data-testid="checkout-subsidy-switch" />
        <div class="checkout-dialog__hint">国补订单需登记客户姓名和电话</div>
      </el-form-item>
      <el-form-item label="订单备注">
        <el-input
          v-model="form.orderNote"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="选填，仅随本单保存"
          data-testid="checkout-order-note"
        />
      </el-form-item>
      <el-form-item label="销售人员">
        <el-select
          v-model="form.salesperson"
          class="checkout-dialog__salesperson"
          filterable
          allow-create
          default-first-option
          clearable
          placeholder="输入姓名或选择"
          data-testid="checkout-salesperson-select"
        >
          <el-option v-for="name in salespersons" :key="name" :label="name" :value="name" />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button
        class="checkout-dialog__cancel"
        data-testid="checkout-dialog-cancel"
        @click="onCancel()"
      >
        取消
      </el-button>
      <el-button
        type="warning"
        class="checkout-dialog__confirm"
        data-testid="checkout-dialog-confirm"
        :loading="props.submitting"
        @click="void onConfirm()"
      >
        确认结账
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 合计条：琥珀浅底收据式金额条（warning-light-9 底 + light-7 描边，与 CartPanel 合计的 warning 数值同源） */
.checkout-dialog__total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 16px;
  margin-bottom: 16px;
  border: 1px solid var(--el-color-warning-light-7);
  border-radius: var(--el-border-radius-base);
  background: var(--el-color-warning-light-9);
}

.checkout-dialog__total-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.checkout-dialog__total-value {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  color: var(--el-color-warning);
}

/* 分组标题：虚线分隔呼应小票纸美学（receipt divider 同视觉语言） */
.checkout-dialog__section-title {
  margin: 4px 0 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--el-text-color-secondary);
}

/* 电话：代码/号码字段惯例（同 BarcodeInput/SN 输入的等宽字体） */
.checkout-dialog__phone :deep(input) {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 13.5px;
  letter-spacing: 0.02em;
}

/* 已关联客户提示（预填命中附注） */
.checkout-dialog__customer-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-color-success);
}

/* 开关/控件旁的规则附注 */
.checkout-dialog__hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
}

.checkout-dialog__salesperson {
  width: 100%;
}
</style>
