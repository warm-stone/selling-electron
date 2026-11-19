<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormRules } from 'element-plus'
import { Delete, DocumentChecked, DocumentCopy, Plus } from '@element-plus/icons-vue'
import SectionListEditor from '@renderer/components/template-editor/SectionListEditor.vue'
import TemplatePreviewPane from '@renderer/components/template-editor/TemplatePreviewPane.vue'
import VarDocsPanel from '@renderer/components/template-editor/VarDocsPanel.vue'
import {
  provideTemplateDraft,
  type TemplateDraft
} from '@renderer/components/template-editor/template-draft'
import { extractIpcErrorMessage } from '@renderer/utils/ipc-error'
import { PAPER_COLUMNS, type PaperWidth } from '../../../shared/receipt/char-grid'
import { DEFAULT_TEMPLATES } from '../../../shared/receipt/default-template'
import {
  ITEM_COLUMN_WIDTHS,
  type ItemColumnWidths
} from '../../../shared/receipt/item-columns'
import type { ReceiptTemplate } from '../../../shared/receipt/template-schema'
import type { LogoInfo, PrintTemplate } from '../../../shared/types'

/**
 * 小票模板编辑器（Task 16）：左侧模板列表（新建/复制/删除）+ 右侧表单区
 * （段落级配置，G14——无拖拽/逐元素样式）+ 底部实时预览。
 *
 * 拆分（巨型视图治理批次 4）：
 * - VarDocsPanel        可用变量说明区（RECEIPT_VAR_DOCS 单一事实源 + 点击复制）
 * - SectionListEditor   头部/合计/底部三组段落行编辑（上移/下移/删除/添加 +
 *                       image 段落 Logo 选择；草稿经 provideTemplateDraft 注入）
 * - TemplatePreviewPane 底部实时预览（样例数据自包含）
 * 本页仅留：模板列表/选中、表单模型（draft）与 CRUD/设默认编排、明细列
 * （列头文案 + 列宽联动校验）、Logo 列表加载与上传 IPC。
 *
 * 实时预览数据流：表单 draft（reactive）→ previewTemplate（computed，即
 * 表单的响应式 watch，**不保存也即时刷新**）→ TemplatePreviewPane（T12
 * ReceiptPreview 同源渲染；logo 列表经设置页上传，image 段落按 logoId 选用）。
 * 表单字段与 shared/receipt/template-schema 的 ReceiptTemplate 一一对应
 * （type/align/size 枚举逐字复用），保存经 repo 校验守卫落库。
 */

// ── 表单模型（与 ReceiptTemplate 字段一一对应；接口在 template-draft.ts，
//    经 provide 下发段落编辑子组件——同一 reactive 对象，行内编辑即时联动预览）──

function cloneDefault(width: PaperWidth): ReceiptTemplate {
  return JSON.parse(JSON.stringify(DEFAULT_TEMPLATES[width])) as ReceiptTemplate
}

function draftFromTemplate(name: string, t: ReceiptTemplate): TemplateDraft {
  return {
    name,
    paperWidth: t.paperWidth,
    cutPaper: t.cutPaper,
    header: t.header.map((s) => ({ ...s })),
    items: {
      showHeader: t.items.showHeader ?? true,
      nameLabel: t.items.nameLabel ?? '商品',
      qtyLabel: t.items.qtyLabel ?? '数量',
      priceLabel: t.items.priceLabel ?? '单价',
      subtotalLabel: t.items.subtotalLabel ?? '小计',
      // {...undefined} = {}：空覆盖起步；已保存的覆盖键浅拷贝保留
      columnWidths: { ...t.items.columnWidths }
    },
    totals: t.totals.map((x) => ({ ...x })),
    footer: t.footer.map((s) => ({ ...s }))
  }
}

const draft = reactive<TemplateDraft>(draftFromTemplate('新模板', cloneDefault('80mm')))
provideTemplateDraft(draft)

const rules: FormRules = {
  name: [{ required: true, whitespace: true, message: '请输入模板名称', trigger: 'blur' }]
}

const templates = ref<PrintTemplate[]>([])
const selectedId = ref<number | null>(null)
const defaultChoice = ref(false)
const loading = ref(true)
const saving = ref(false)

const selected = computed<PrintTemplate | null>(
  () => templates.value.find((t) => t.id === selectedId.value) ?? null
)
const isDraft = computed(() => selectedId.value === null)

/**
 * 列宽覆盖序列化：只写入已填键（undefined 键不落 JSON，保持模板干净）；
 * 全空 → undefined（不写入 columnWidths 字段，沿用纸宽默认）。
 */
function serializeColumnWidths(): Partial<ItemColumnWidths> | undefined {
  const src = draft.items.columnWidths
  const out: Partial<ItemColumnWidths> = {}
  let filled = false
  for (const key of ['name', 'qty', 'price', 'subtotal'] as const) {
    const v = src[key]
    if (v !== undefined) {
      out[key] = v
      filled = true
    }
  }
  return filled ? out : undefined
}

function buildTemplate(): ReceiptTemplate {
  return {
    paperWidth: draft.paperWidth,
    header: draft.header,
    items: {
      type: 'items',
      showHeader: draft.items.showHeader,
      nameLabel: draft.items.nameLabel,
      qtyLabel: draft.items.qtyLabel,
      priceLabel: draft.items.priceLabel,
      subtotalLabel: draft.items.subtotalLabel,
      columnWidths: serializeColumnWidths()
    },
    totals: draft.totals,
    footer: draft.footer,
    cutPaper: draft.cutPaper
  }
}

const previewTemplate = computed<ReceiptTemplate>(() => buildTemplate())

// ── 列宽配置联动（校验规则与 shared resolveColumnWidths 一致：四键齐全 + 总和 = 总列数）──

/** 当前纸宽默认列宽（输入框 placeholder 展示） */
const defaultWidths = computed<ItemColumnWidths>(() => ITEM_COLUMN_WIDTHS[draft.paperWidth])

/** 当前纸宽总列数（「合计 X / 48」展示与保存校验基准） */
const paperColumns = computed(() => PAPER_COLUMNS[draft.paperWidth])

/** 已填列宽键集合（undefined = 未覆盖） */
const filledWidthKeys = computed<Array<keyof ItemColumnWidths>>(() =>
  (['name', 'qty', 'price', 'subtotal'] as const).filter(
    (k) => draft.items.columnWidths[k] !== undefined
  )
)

/** 已填列宽总和 */
const columnWidthsSum = computed(() =>
  filledWidthKeys.value.reduce((sum, k) => sum + (draft.items.columnWidths[k] ?? 0), 0)
)

/** 列宽覆盖不合法：已填任一键但未四键齐全，或齐全而总和 ≠ 总列数（全空 = 未覆盖，合法） */
const columnWidthsInvalid = computed(() => {
  const keys = filledWidthKeys.value
  if (keys.length === 0) return false
  if (keys.length < 4) return true
  return columnWidthsSum.value !== paperColumns.value
})

/** el-input-number 写入（EP 清空 emit null/undefined → 归一为未覆盖 undefined） */
function setColumnWidth(key: keyof ItemColumnWidths, val: number | null | undefined): void {
  draft.items.columnWidths[key] = val ?? undefined
}

// ── Logo 列表（设置页上传的多 Logo：image 段落选择 + 预览渲染；
//    段落行内的选择在 SectionListEditor——列表/上传态由本页下发）──

const logos = ref<LogoInfo[]>([])
const uploadingLogo = ref(false)

/** logo id → dataURL 映射（预览渲染用） */
const logoUrlsMap = computed<Record<number, string>>(() =>
  Object.fromEntries(logos.value.map((l) => [l.id, l.data_url]))
)

async function loadLogos(): Promise<void> {
  logos.value = await window.api.settings.listLogos()
}

async function onUploadLogo(): Promise<void> {
  uploadingLogo.value = true
  try {
    const next = await window.api.settings.uploadLogo()
    // 原生对话框用户取消 → 列表不变（长度不变不 toast，避免误导）
    const added = next.length > logos.value.length
    logos.value = next
    if (added) ElMessage.success('Logo 已上传')
  } catch (err) {
    ElMessage.error(`Logo 上传失败：${extractIpcErrorMessage(err)}`)
  } finally {
    uploadingLogo.value = false
  }
}

// ── 列表与选中 ──

async function loadTemplates(): Promise<void> {
  templates.value = await window.api.templates.list()
}

function selectTemplate(t: PrintTemplate): void {
  selectedId.value = t.id
  Object.assign(draft, draftFromTemplate(t.name, JSON.parse(t.config_json) as ReceiptTemplate))
  defaultChoice.value = t.is_default
}

function autoSelect(): void {
  const target = templates.value.find((t) => t.is_default) ?? templates.value[0]
  if (target) {
    selectTemplate(target)
  } else {
    newDraft()
  }
}

// ── 新建 / 复制 / 保存 / 删除 / 设默认 ──

function newDraft(): void {
  selectedId.value = null
  Object.assign(draft, draftFromTemplate('新模板', cloneDefault('80mm')))
  defaultChoice.value = false
}

function duplicateDraft(): void {
  const source = buildTemplate()
  Object.assign(draft, draftFromTemplate(`${draft.name || '模板'} 副本`, source))
  selectedId.value = null
  defaultChoice.value = false
}

async function save(): Promise<void> {
  if (!draft.name.trim()) return
  // 列宽覆盖保存前校验：已填任一键时必须四键齐全且总和 = 纸宽总列数
  if (columnWidthsInvalid.value) {
    ElMessage.warning(
      `明细列宽需四列齐全且总和等于 ${paperColumns.value}（当前合计 ${columnWidthsSum.value}）`
    )
    return
  }
  saving.value = true
  const configJson = JSON.stringify(buildTemplate())
  try {
    if (selectedId.value === null) {
      const created = await window.api.templates.create({
        name: draft.name.trim(),
        paper_width: draft.paperWidth,
        config_json: configJson
      })
      selectedId.value = created.id
      ElMessage.success('模板已创建')
    } else {
      await window.api.templates.update({
        id: selectedId.value,
        name: draft.name.trim(),
        config_json: configJson
      })
      ElMessage.success('模板已保存')
    }
    await loadTemplates()
    const current = templates.value.find((t) => t.id === selectedId.value)
    if (current) defaultChoice.value = current.is_default
  } catch (err) {
    ElMessage.error(`保存失败：${extractIpcErrorMessage(err)}`)
  } finally {
    saving.value = false
  }
}

async function removeSelected(): Promise<void> {
  if (selectedId.value === null) return
  try {
    await ElMessageBox.confirm(`确定删除模板「${draft.name}」？删除后不可恢复。`, '删除模板', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await window.api.templates.delete(selectedId.value)
    selectedId.value = null
    ElMessage.success('模板已删除')
    await loadTemplates()
    autoSelect()
  } catch (err) {
    ElMessage.error(`删除失败：${extractIpcErrorMessage(err)}`)
  }
}

async function onDefaultChange(val: string | number | boolean | undefined): Promise<void> {
  if (val !== true) {
    defaultChoice.value = true
    ElMessage.warning('至少保留一个默认模板：请在其他模板上改设默认')
    return
  }
  if (selectedId.value === null) {
    defaultChoice.value = false
    ElMessage.warning('请先保存模板，再设为默认')
    return
  }
  try {
    await window.api.templates.setDefault(selectedId.value)
    await loadTemplates()
    defaultChoice.value = true
    ElMessage.success('已设为默认模板')
  } catch (err) {
    defaultChoice.value = false
    ElMessage.error(`设置默认失败：${extractIpcErrorMessage(err)}`)
  }
}

onMounted(async () => {
  try {
    await loadTemplates()
    autoSelect()
  } catch (err) {
    ElMessage.error(`模板加载失败：${extractIpcErrorMessage(err)}`)
  } finally {
    loading.value = false
  }
  // Logo 列表独立加载：失败不阻断模板编辑（image 段落选择降级为空列表 + 引导上传）
  try {
    await loadLogos()
  } catch (err) {
    ElMessage.warning(`Logo 列表加载失败：${extractIpcErrorMessage(err)}`)
  }
})
</script>

<template>
  <div class="template-editor">
    <aside class="tpl-sidebar" v-loading="loading">
      <div class="tpl-sidebar__head">
        <div>
          <h2 class="tpl-sidebar__title">我的模板</h2>
          <p class="tpl-sidebar__count">共 {{ templates.length }} 个</p>
        </div>
        <el-button type="primary" :icon="Plus" data-testid="tpl-new" @click="newDraft">
          新建
        </el-button>
      </div>

      <div class="tpl-list">
        <p v-if="templates.length === 0" class="tpl-list__empty">
          暂无模板，点击「新建」从默认样式开始
        </p>
        <button
          v-for="t in templates"
          :key="t.id"
          type="button"
          class="tpl-item"
          :class="{ 'tpl-item--active': t.id === selectedId }"
          data-testid="tpl-item"
          @click="selectTemplate(t)"
        >
          <span class="tpl-item__name">{{ t.name }}</span>
          <span class="tpl-item__meta">
            <el-tag size="small" :type="t.paper_width === '58mm' ? 'warning' : 'info'" effect="plain">
              {{ t.paper_width }}
            </el-tag>
            <el-tag v-if="t.is_default" size="small" type="success">默认</el-tag>
          </span>
        </button>
      </div>

      <div class="tpl-sidebar__actions">
        <el-button
          :icon="DocumentCopy"
          data-testid="tpl-copy"
          :disabled="templates.length === 0"
          @click="duplicateDraft"
        >
          复制当前
        </el-button>
        <el-button
          type="danger"
          plain
          :icon="Delete"
          data-testid="tpl-delete"
          title="至少保留一个模板"
          :disabled="isDraft || templates.length <= 1"
          @click="removeSelected"
        >
          删除
        </el-button>
      </div>
    </aside>

    <section class="tpl-main">
      <div class="tpl-form">
        <div class="tpl-form__toolbar">
          <div class="tpl-form__heading">
            <h3 class="tpl-form__title">{{ isDraft ? '新模板' : draft.name }}</h3>
            <el-tag v-if="isDraft" size="small" type="warning" data-testid="tpl-draft-tag">
              未保存
            </el-tag>
            <el-tag v-else-if="selected?.is_default" size="small" type="success">默认模板</el-tag>
          </div>
          <el-button
            type="primary"
            :icon="DocumentChecked"
            :loading="saving"
            :disabled="!draft.name.trim()"
            data-testid="tpl-save"
            @click="save"
          >
            保存
          </el-button>
        </div>

        <VarDocsPanel />

        <el-form :model="draft" :rules="rules" label-position="top">
          <section class="tpl-group">
            <h4 class="tpl-group__title">基本信息</h4>
            <div class="tpl-grid-basic">
              <el-form-item label="模板名称" prop="name" class="tpl-basic__name">
                <el-input
                  v-model="draft.name"
                  data-testid="tpl-name"
                  placeholder="如：门店小票 80mm"
                  maxlength="30"
                />
              </el-form-item>
              <el-form-item label="纸宽">
                <el-radio-group v-model="draft.paperWidth" data-testid="tpl-paper">
                  <el-radio value="80mm" data-testid="tpl-paper-80">80mm（48 列）</el-radio>
                  <el-radio value="58mm" data-testid="tpl-paper-58">58mm（32 列）</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="打印后切纸">
                <el-switch v-model="draft.cutPaper" data-testid="tpl-cut" />
              </el-form-item>
              <el-form-item label="默认模板">
                <el-radio-group
                  v-model="defaultChoice"
                  data-testid="tpl-default"
                  @change="onDefaultChange"
                >
                  <el-radio :value="true">设为默认</el-radio>
                  <el-radio :value="false">非默认</el-radio>
                </el-radio-group>
              </el-form-item>
            </div>
          </section>

          <SectionListEditor
            target="header"
            :logos="logos"
            :uploading-logo="uploadingLogo"
            @upload-logo="onUploadLogo"
          />

          <section class="tpl-group">
            <div class="tpl-group__head">
              <h4 class="tpl-group__title">
                明细列
                <span class="tpl-group__sub">商品行四列表头文案与列宽（留空沿用纸宽默认）</span>
              </h4>
            </div>
            <div class="tpl-items">
              <el-form-item label="打印列头" class="tpl-items__switch">
                <el-switch v-model="draft.items.showHeader" data-testid="tpl-items-header" />
              </el-form-item>
              <el-form-item label="商品列">
                <el-input v-model="draft.items.nameLabel" data-testid="tpl-col-name" />
              </el-form-item>
              <el-form-item label="数量列">
                <el-input v-model="draft.items.qtyLabel" data-testid="tpl-col-qty" />
              </el-form-item>
              <el-form-item label="单价列">
                <el-input v-model="draft.items.priceLabel" data-testid="tpl-col-price" />
              </el-form-item>
              <el-form-item label="小计列">
                <el-input v-model="draft.items.subtotalLabel" data-testid="tpl-col-subtotal" />
              </el-form-item>

              <el-form-item label="名称列宽">
                <el-input-number
                  :model-value="draft.items.columnWidths.name"
                  data-testid="tpl-col-w-name"
                  class="tpl-width-input"
                  :min="1"
                  :precision="0"
                  :placeholder="`默认 ${defaultWidths.name}`"
                  controls-position="right"
                  @update:model-value="(v: number | undefined) => setColumnWidth('name', v)"
                />
              </el-form-item>
              <el-form-item label="数量列宽">
                <el-input-number
                  :model-value="draft.items.columnWidths.qty"
                  data-testid="tpl-col-w-qty"
                  class="tpl-width-input"
                  :min="1"
                  :precision="0"
                  :placeholder="`默认 ${defaultWidths.qty}`"
                  controls-position="right"
                  @update:model-value="(v: number | undefined) => setColumnWidth('qty', v)"
                />
              </el-form-item>
              <el-form-item label="单价列宽">
                <el-input-number
                  :model-value="draft.items.columnWidths.price"
                  data-testid="tpl-col-w-price"
                  class="tpl-width-input"
                  :min="1"
                  :precision="0"
                  :placeholder="`默认 ${defaultWidths.price}`"
                  controls-position="right"
                  @update:model-value="(v: number | undefined) => setColumnWidth('price', v)"
                />
              </el-form-item>
              <el-form-item label="小计列宽">
                <el-input-number
                  :model-value="draft.items.columnWidths.subtotal"
                  data-testid="tpl-col-w-subtotal"
                  class="tpl-width-input"
                  :min="1"
                  :precision="0"
                  :placeholder="`默认 ${defaultWidths.subtotal}`"
                  controls-position="right"
                  @update:model-value="(v: number | undefined) => setColumnWidth('subtotal', v)"
                />
              </el-form-item>

              <div
                class="tpl-items__widths"
                :class="{ 'is-invalid': columnWidthsInvalid }"
                data-testid="tpl-col-w-sum"
              >
                <span>合计 {{ columnWidthsSum }} / {{ paperColumns }}</span>
                <span
                  v-if="columnWidthsInvalid"
                  class="tpl-items__widths-warn"
                  data-testid="tpl-col-w-warn"
                >
                  已填列宽须四列齐全且总和等于 {{ paperColumns }}，留空则沿用默认
                </span>
              </div>
            </div>
          </section>

          <SectionListEditor
            target="totals"
            :logos="logos"
            :uploading-logo="uploadingLogo"
            @upload-logo="onUploadLogo"
          />

          <SectionListEditor
            target="footer"
            :logos="logos"
            :uploading-logo="uploadingLogo"
            @upload-logo="onUploadLogo"
          />
        </el-form>
      </div>

      <TemplatePreviewPane :template="previewTemplate" :logo-urls="logoUrlsMap" />
    </section>
  </div>
</template>

<!-- 组卡片骨架共享样式（全局加载一次；选择器全部收敛在 .template-editor 命名空间下） -->
<style src="../assets/template-editor.css"></style>

<style scoped>
.template-editor {
  display: flex;
  height: 100%;
  min-height: 0;
}

/* ── 左栏：模板列表 ── */
.tpl-sidebar {
  flex: 0 0 300px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}

.tpl-sidebar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 10px;
}

.tpl-sidebar__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.tpl-sidebar__count {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tpl-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 12px;
}

.tpl-list__empty {
  margin: 12px 4px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.tpl-item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  padding: 10px 12px;
  border: none;
  border-left: 3px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.tpl-item:hover {
  background: var(--el-fill-color-light);
}

.tpl-item--active {
  border-left-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.tpl-item__name {
  font-size: 13px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tpl-item__meta {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.tpl-sidebar__actions {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.tpl-sidebar__actions .el-button {
  flex: 1;
  margin: 0;
}

/* ── 右栏：表单区（上） + 实时预览（下） ── */
.tpl-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.tpl-form {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 16px 24px 28px;
}

.tpl-form__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.tpl-form__heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tpl-form__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 基本信息网格 ── */
.tpl-grid-basic {
  display: flex;
  flex-wrap: wrap;
  gap: 0 28px;
  align-items: flex-start;
}

.tpl-grid-basic :deep(.el-form-item) {
  margin-bottom: 0;
}

.tpl-basic__name {
  width: 300px;
}

/* ── 明细列（列头文案 + 列宽输入 + 合计提示）── */
.tpl-items :deep(.el-form-item) {
  margin-bottom: 0;
}

.tpl-items {
  display: grid;
  grid-template-columns: 110px repeat(4, minmax(120px, 1fr));
  gap: 0 16px;
  align-items: start;
}

.tpl-items__switch {
  grid-column: 1 / -1;
  margin-bottom: 10px;
}

.tpl-width-input {
  width: 100%;
}

.tpl-items__widths {
  grid-column: 1 / -1;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tpl-items__widths.is-invalid {
  color: var(--el-color-danger);
}

.tpl-items__widths-warn {
  margin-left: 6px;
}
</style>
