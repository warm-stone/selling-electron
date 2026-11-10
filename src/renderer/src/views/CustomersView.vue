<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { Edit, Plus, Search } from '@element-plus/icons-vue'
import type { Customer } from '../../../shared/types'
import { isValidMobilePhone, INVALID_PHONE_MESSAGE } from '../../../shared/utils/phone'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'

/**
 * 客户管理页（Task 11）：搜索（防抖 300ms，keyword 匹配姓名/电话）+ 新增/编辑
 * （四字段：姓名/电话/地址/客户备注；电话必填非空 + 手机号格式校验——镜像
 * customer.service 规则；编辑时电话未变放行，兼容存量座机等旧格式档案）。
 *
 * - 无删除：本期客户模块不做删除（按钮与接口均不出现），列表仅【编辑】操作。
 * - 服务端分页：customers:list 契约自带 limit/offset 且返回 total，页大小固定 20，
 *   翻页走 offset 重查（与商品页的前端分页刻意不同——那边契约无分页参数）。
 * - 电话冲突：后端 CUSTOMER_PHONE_EXISTS 的 message 内嵌现有客户姓名
 *   （如「该电话已被客户「张三」使用」）→ ElMessage.error 原样展示且弹窗不关，
 *   让用户改号后重交。
 */

const PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 300

const rows = ref<Customer[]>([])
const total = ref(0)
const loading = ref(false)
const searchText = ref('')
const page = ref(1)

const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const editingRow = ref<Customer | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()

interface CustomerFormState {
  name: string
  phone: string
  address: string
  note: string
}

const form = reactive<CustomerFormState>({
  name: '',
  phone: '',
  address: '',
  note: ''
})

/** 电话必填非空 + 手机号格式（镜像 service 规则；编辑未变放行兼容存量档案） */
const rules: FormRules = {
  phone: [
    {
      required: true,
      validator: (_rule, value: string, callback) => {
        const phone = (value ?? '').trim()
        if (typeof value !== 'string' || phone.length === 0) {
          return callback(new Error('电话不能为空'))
        }
        if (dialogMode.value === 'edit' && phone === editingRow.value?.phone) {
          return callback()
        }
        if (!isValidMobilePhone(phone)) {
          return callback(new Error(INVALID_PHONE_MESSAGE))
        }
        callback()
      },
      trigger: 'blur'
    }
  ]
}

const emptyDescription = computed(() =>
  searchText.value.trim().length > 0 ? '未找到匹配客户，换个关键词试试' : '暂无客户'
)

// ── 数据加载与搜索（服务端分页：limit 固定 20，翻页靠 offset）──

async function load(): Promise<void> {
  loading.value = true
  try {
    const keyword = searchText.value.trim()
    const res = await window.api.customers.list({
      keyword: keyword.length > 0 ? keyword : undefined,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE
    })
    rows.value = res.items
    total.value = res.total
  } catch (err) {
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    loading.value = false
  }
}

/** 翻页重查（page 变更即触发；搜索复位页码也走这条单一路径） */
watch(page, () => {
  void load()
})

let searchTimer: ReturnType<typeof setTimeout> | undefined

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    // 页码非 1 时置 1 由 watch(page) 触发重查；本就在第 1 页则手动重查（避免双请求）
    if (page.value !== 1) {
      page.value = 1
    } else {
      void load()
    }
  }, SEARCH_DEBOUNCE_MS)
}

onMounted(() => {
  void load()
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

// ── 新增 / 编辑（弹窗四字段；提交一律 trim，电话冲突弹窗不关）──

function openCreate(): void {
  dialogMode.value = 'create'
  editingRow.value = null
  Object.assign(form, {
    name: '',
    phone: '',
    address: '',
    note: ''
  })
  dialogVisible.value = true
}

function openEdit(row: Customer): void {
  dialogMode.value = 'edit'
  editingRow.value = row
  Object.assign(form, {
    name: row.name,
    phone: row.phone,
    address: row.address,
    note: row.note
  })
  dialogVisible.value = true
}

async function save(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const payload = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
      note: form.note.trim()
    }
    if (dialogMode.value === 'create') {
      await window.api.customers.create(payload)
      ElMessage.success('客户已创建')
    } else {
      await window.api.customers.update(editingRow.value!.id, payload)
      ElMessage.success('客户已保存')
    }
    dialogVisible.value = false
    await load()
  } catch (err) {
    // 电话冲突（CUSTOMER_PHONE_EXISTS）等业务错误：弹窗不关，展示后端中文
    // message（含现有客户姓名），让用户改号后重新提交
    ElMessage.error(extractIpcErrorMessage(err))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section class="customers-page">
    <header class="page-header">
      <div class="page-title">
        <h2 class="page-title__text">客户管理</h2>
        <span class="page-title__count">共 {{ total }} 位客户</span>
      </div>
      <div class="page-actions">
        <el-input
          v-model="searchText"
          class="page-actions__search"
          placeholder="姓名或电话"
          clearable
          :prefix-icon="Search"
          data-testid="customer-search"
          @input="onSearchInput"
          @clear="onSearchInput"
        />
        <el-button type="warning" :icon="Plus" data-testid="customer-create-btn" @click="openCreate">
          新增客户
        </el-button>
      </div>
    </header>

    <el-table
      v-loading="loading"
      :data="rows"
      row-key="id"
      class="customers-table"
      height="100%"
      data-testid="customer-table"
    >
      <el-table-column label="姓名" min-width="140">
        <template #default="{ row }">
          <span class="cell-name" :class="{ 'cell-name--empty': row.name.length === 0 }">
            {{ row.name.length > 0 ? row.name : '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="电话" width="160">
        <template #default="{ row }">
          <span class="cell-phone">{{ row.phone }}</span>
        </template>
      </el-table-column>
      <el-table-column label="地址" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.address.length > 0" class="cell-text">{{ row.address }}</span>
          <span v-else class="cell-dash">—</span>
        </template>
      </el-table-column>
      <el-table-column label="客户备注" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.note.length > 0" class="cell-text">{{ row.note }}</span>
          <span v-else class="cell-dash">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="创建时间" min-width="160" />
      <el-table-column prop="updated_at" label="更新时间" min-width="160" />
      <el-table-column label="操作" width="110" align="center" fixed="right">
        <template #default="{ row }">
          <!-- 本期无删除（MUST NOT DO）：唯一操作是编辑 -->
          <el-button
            text
            type="primary"
            :icon="Edit"
            data-testid="customer-edit-btn"
            @click="openEdit(row)"
          >
            编辑
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :description="emptyDescription" :image-size="110" />
      </template>
    </el-table>

    <footer class="page-footer">
      <el-pagination
        v-model:current-page="page"
        background
        layout="total, prev, pager, next"
        :total="total"
        :page-size="PAGE_SIZE"
        :pager-count="7"
      />
    </footer>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogMode === 'create' ? '新增客户' : '编辑客户'"
      width="480px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item label="姓名">
          <el-input
            v-model="form.name"
            placeholder="选填，可只记电话"
            data-testid="customer-name"
          />
        </el-form-item>
        <el-form-item label="电话" prop="phone">
          <el-input
            v-model="form.phone"
            placeholder="客户联系电话（必填）"
            data-testid="customer-phone"
          />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.address" placeholder="选填" data-testid="customer-address" />
        </el-form-item>
        <el-form-item label="客户备注">
          <el-input
            v-model="form.note"
            type="textarea"
            :rows="3"
            placeholder="选填"
            data-testid="customer-note"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="warning"
          :loading="submitting"
          data-testid="customer-save-btn"
          @click="save()"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.customers-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 24px 14px;
  box-sizing: border-box;
  gap: 14px;
}

/* ── 页头：标题 + 搜索 + 新增（与商品管理页同构——零售台账气质）── */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
}

.page-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.page-title__text {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}

.page-title__count {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.page-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.page-actions__search {
  width: 260px;
}

/* ── 表格：撑满剩余空间（el-table height=100% 由 flex 撑高）── */
.customers-table {
  flex: 1;
  min-height: 0;
}

.cell-name {
  font-weight: 500;
  color: var(--el-text-color-primary);
}

/* 电话-only 散客（name 空）姓名占位降级 */
.cell-name--empty {
  color: var(--el-text-color-placeholder);
  font-weight: 400;
}

/* 电话是客户唯一查找键——等宽字体呈现（延续商品页条码格气质） */
.cell-phone {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px;
  letter-spacing: 0.03em;
  color: var(--el-text-color-regular);
}

.cell-text {
  color: var(--el-text-color-regular);
}

.cell-dash {
  color: var(--el-text-color-placeholder);
}

/* ── 分页 ── */
.page-footer {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
}
</style>
