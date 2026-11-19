<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'
import type { IpcChannels } from '../../../../shared/types/ipc'
import type { Customer, SaleDetail } from '../../../../shared/types/domain'
import { isValidMobilePhone, INVALID_PHONE_MESSAGE } from '../../../../shared/utils/phone'

/**
 * 销售明细·附加信息编辑区（customer-order-extras 任务 12；仅 completed 单由
 * SaleDetailDialog 渲染——voided 前置隐藏 Q4，后端还会拒）。
 *
 * SalesHistoryView 拆分的自治组件：自持四字段表单态 + 客户电话联想（Q5：
 * 失焦查全等项——命中「将关联」/清空「将解绑」/不变不提示）+ 销售人员下拉
 * （settings:getRecentSalespersons，失败静默清空——allow-create 手输兜底）。
 *
 * 保存走 sales:updateExtra patch 语义：undefined=不动（未变字段不进 patch）、
 * customer:null=显式解绑、customer 裸值=按电话 find-or-create（传命中档案
 * 原值回传，避免 PUT 覆盖丢数据）；成功后 emit('saved', 更新后明细) 由父链
 * 回写 detail——props.detail 变化再触发本组件重拍表单快照 + 重取销售选项
 * （与原 openDetail/saveExtra 的刷新时序一致）。
 */

const props = defineProps<{
  detail: SaleDetail
}>()

const emit = defineEmits<{
  saved: [updated: SaleDetail]
}>()

/** sales:updateExtra patch 形状（与 PosApi sales.updateExtra 第二参同源——均从 IpcChannels 契约派生） */
type SaleExtraPatch = Omit<IpcChannels['sales:updateExtra']['req'], 'sale_id'>

/** 编辑区四字段（初值=当前值快照，diff 后才进 patch——undefined=不动语义） */
interface ExtraEditState {
  isSubsidy: boolean
  orderNote: string
  salesperson: string
  customerPhone: string
}

const extraForm = reactive<ExtraEditState>({
  isSubsidy: false,
  orderNote: '',
  salesperson: '',
  customerPhone: ''
})

/** 打开/保存后重拍的初值快照（非响应式即可——比较只依赖 extraForm 的变化） */
let extraInitial: ExtraEditState = {
  isSubsidy: false,
  orderNote: '',
  salesperson: '',
  customerPhone: ''
}

const extraSaving = ref(false)
const salespersonOptions = ref<string[]>([])

// ── 客户电话联想（Q5：失焦查全等项；命中「将关联」/清空「将解绑」/不变不提示）──

type PhoneHintKind = 'match' | 'unbind' | 'new' | 'invalid'

const phoneHintKind = ref<PhoneHintKind | null>(null)
const phoneMatch = ref<Customer | null>(null)

const phoneHintText = computed<string>(() => {
  switch (phoneHintKind.value) {
    case 'match':
      return `将关联：${phoneMatch.value?.name ?? ''}`
    case 'unbind':
      return '将解绑客户（保存后生效）'
    case 'new':
      return `将以「${extraForm.customerPhone.trim()}」新建客户`
    case 'invalid':
      return INVALID_PHONE_MESSAGE
    default:
      return ''
  }
})

/** 编辑区初值 = 当前附加值（旧单 extras null 全走默认散客态） */
function initExtraEdit(d: SaleDetail): void {
  const e = d.extras
  extraForm.isSubsidy = e?.is_national_subsidy ?? false
  extraForm.orderNote = e?.order_note ?? ''
  extraForm.salesperson = e?.salesperson ?? ''
  extraForm.customerPhone = e?.customer?.phone ?? ''
  extraInitial = {
    isSubsidy: extraForm.isSubsidy,
    orderNote: extraForm.orderNote,
    salesperson: extraForm.salesperson,
    customerPhone: extraForm.customerPhone
  }
  phoneHintKind.value = null
  phoneMatch.value = null
}

/** 最近销售人员下拉（settings:getRecentSalespersons）；失败静默清空——allow-create 手输兜底，不阻断编辑 */
async function loadSalespersonOptions(): Promise<void> {
  try {
    salespersonOptions.value = await window.api.settings.getRecentSalespersons()
  } catch {
    salespersonOptions.value = []
  }
}

// 每次打开明细（含保存后父链回写）都重拍初值 + 重取选项——原 openDetail/
// saveExtra 的时序（本组件仅 completed 单渲染，无需再判状态）
watch(
  () => props.detail,
  (d) => {
    initExtraEdit(d)
    void loadSalespersonOptions()
  },
  { immediate: true }
)

const hasExtraChanges = computed(() => {
  if (props.detail.status !== 'completed') return false
  return (
    extraForm.isSubsidy !== extraInitial.isSubsidy ||
    extraForm.orderNote.trim() !== extraInitial.orderNote ||
    extraForm.salesperson.trim() !== extraInitial.salesperson ||
    extraForm.customerPhone.trim() !== extraInitial.customerPhone
  )
})

/** 按 keyword 查客户列表后取电话全等命中（list 是子串匹配，全等才算关联） */
async function resolvePhoneMatch(phone: string): Promise<Customer | null> {
  const res = await window.api.customers.list({ keyword: phone })
  return res.items.find((c) => c.phone === phone) ?? null
}

async function onPhoneBlur(): Promise<void> {
  const phone = extraForm.customerPhone.trim()
  // 与当前关联一致（含同为空）→ 不动语义：无提示、不进 patch
  if (phone === extraInitial.customerPhone) {
    phoneHintKind.value = null
    phoneMatch.value = null
    return
  }
  if (phone === '') {
    // 走到这里必是「原有关联被清空」→ 显式解绑（保存时 customer: null）
    phoneHintKind.value = 'unbind'
    phoneMatch.value = null
    return
  }
  // 手机号格式不合法：红色提示，不查客户（合法格式才进入关联/新建判定）
  if (!isValidMobilePhone(phone)) {
    phoneHintKind.value = 'invalid'
    phoneMatch.value = null
    return
  }
  const hit = await resolvePhoneMatch(phone)
  // 查询期间输入又变了：过期结果不展示（下次失焦重新判定）
  if (extraForm.customerPhone.trim() !== phone) return
  phoneMatch.value = hit
  phoneHintKind.value = hit ? 'match' : 'new'
}

async function saveExtra(): Promise<void> {
  const current = props.detail
  if (current.status !== 'completed' || extraSaving.value) return

  // patch 只含用户实际改动意图的字段（undefined=不动——后端部分键 upsert 语义）
  const patch: SaleExtraPatch = {}
  if (extraForm.isSubsidy !== extraInitial.isSubsidy) {
    patch.is_national_subsidy = extraForm.isSubsidy
  }
  if (extraForm.orderNote.trim() !== extraInitial.orderNote) {
    patch.order_note = extraForm.orderNote
  }
  if (extraForm.salesperson.trim() !== extraInitial.salesperson) {
    patch.salesperson = extraForm.salesperson
  }
  const phone = extraForm.customerPhone.trim()
  if (phone !== extraInitial.customerPhone) {
    if (phone === '') {
      patch.customer = null
    } else if (!isValidMobilePhone(phone)) {
      // 前端兜底（后端 SALE_EXTRAS_PHONE_INVALID 双防线）——免 IPC 往返直接提示
      ElMessage.error(INVALID_PHONE_MESSAGE)
      return
    } else {
      // 命中档案原值回传（后端 find-or-create 命中则 PUT 覆盖，同值覆写不丢数据）；
      // 未命中传空串 → 建裸电话客户（name 可后续在客户管理补录）
      const hit =
        phoneMatch.value?.phone === phone ? phoneMatch.value : await resolvePhoneMatch(phone)
      patch.customer = {
        name: hit?.name ?? '',
        phone,
        address: hit?.address ?? '',
        note: hit?.note ?? ''
      }
    }
  }

  if (Object.keys(patch).length === 0) return

  extraSaving.value = true
  try {
    // res 即更新后明细（头+items+extras）——上抛父链回写，展示区/表单随之对齐新值
    const updated = await window.api.sales.updateExtra(current.id, patch)
    emit('saved', updated)
    ElMessage.success('附加信息已保存')
  } catch (err) {
    // SALE_ALREADY_VOIDED / 国补需姓名电话等中文文案原样展示（弹窗保持编辑态可重试）
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    extraSaving.value = false
  }
}
</script>

<template>
  <!-- ── 附加信息编辑区（仅 completed 单可见；voided 前置隐藏——Q4）── -->
  <div
    class="sales-history__extra-edit"
    data-testid="extra-edit"
  >
    <el-divider class="sales-history__edit-divider">
      修改附加信息
    </el-divider>
    <el-form
      class="sales-history__edit-form"
      label-width="96px"
    >
      <el-form-item label="国补">
        <el-switch
          v-model="extraForm.isSubsidy"
          data-testid="extra-is-subsidy"
        />
      </el-form-item>
      <el-form-item label="客户电话">
        <el-input
          v-model="extraForm.customerPhone"
          maxlength="32"
          placeholder="输入新电话失焦自动匹配客户；清空即解绑"
          data-testid="extra-customer-phone"
          @blur="onPhoneBlur"
        />
        <div
          v-if="phoneHintKind"
          class="sales-history__phone-hint"
          :class="`sales-history__phone-hint--${phoneHintKind}`"
          data-testid="extra-phone-hint"
        >
          {{ phoneHintText }}
        </div>
      </el-form-item>
      <el-form-item label="销售人员">
        <el-select
          v-model="extraForm.salesperson"
          filterable
          allow-create
          default-first-option
          clearable
          placeholder="选择或输入销售人员"
          data-testid="extra-salesperson"
        >
          <el-option
            v-for="name in salespersonOptions"
            :key="name"
            :label="name"
            :value="name"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="订单备注">
        <el-input
          v-model="extraForm.orderNote"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          data-testid="extra-order-note"
        />
      </el-form-item>
      <el-form-item>
        <el-button
          type="primary"
          :loading="extraSaving"
          :disabled="!hasExtraChanges"
          data-testid="extra-save"
          @click="saveExtra"
        >
          保存修改
        </el-button>
        <span class="sales-history__edit-scope">
          仅客户/国补/备注/销售人员可修改；金额与商品明细不可改
        </span>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
.sales-history__edit-divider {
  margin: 16px 0 14px;
}

.sales-history__edit-form :deep(.el-select) {
  width: 100%;
}

.sales-history__phone-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.sales-history__phone-hint--match {
  color: var(--el-color-success);
}

.sales-history__phone-hint--unbind {
  color: var(--el-color-warning);
}

.sales-history__phone-hint--new {
  color: var(--el-color-primary);
}

.sales-history__phone-hint--invalid {
  color: var(--el-color-danger);
}

.sales-history__edit-scope {
  margin-left: 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
