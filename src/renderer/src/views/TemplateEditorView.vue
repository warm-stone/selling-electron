<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormRules } from 'element-plus'
import {
  ArrowDown,
  ArrowUp,
  Delete,
  DocumentChecked,
  DocumentCopy,
  Plus,
  QuestionFilled,
  Upload
} from '@element-plus/icons-vue'
import ReceiptPreview from '@renderer/components/receipt/ReceiptPreview.vue'
import { PAPER_COLUMNS, type LineAlign, type PaperWidth } from '../../../shared/receipt/char-grid'
import { DEFAULT_TEMPLATES } from '../../../shared/receipt/default-template'
import {
  ITEM_COLUMN_WIDTHS,
  type ItemColumnWidths,
  type SaleReceiptData
} from '../../../shared/receipt/item-columns'
import type {
  ReceiptTemplate,
  ReceiptVars,
  Section,
  SectionSize,
  TotalLine
} from '../../../shared/receipt/template-schema'
import { RECEIPT_VAR_DOCS } from '../../../shared/receipt/template-schema'
import type { PrintTemplate } from '../../../shared/types'
import { formatMoney, parseMoneyToCents } from '../../../shared/utils/money'

/**
 * 小票模板编辑器（Task 16）：左侧模板列表（新建/复制/删除）+ 右侧表单区
 * （段落级配置，G14——无拖拽/逐元素样式）+ 底部实时预览。
 *
 * 实时预览数据流：表单 draft（reactive）→ previewTemplate（computed，即
 * 表单的响应式 watch，**不保存也即时刷新**）→ ReceiptPreview（T12 组件，
 * 样例数据 shopName='测试商店' / 三行商品含超长名；logo 列表经设置页
 * 上传，image 段落按 logoId 选用并传入预览渲染）。
 * 表单字段与 shared/receipt/template-schema 的 ReceiptTemplate 一一对应
 * （type/align/size 枚举逐字复用），保存经 repo 校验守卫落库。
 */

/** window.api.settings 的 Logo 条目类型（preload 契约：listLogos/uploadLogo/deleteLogo 返回） */
type LogoInfo = Awaited<ReturnType<typeof window.api.settings.listLogos>>[number]

type Option<T extends string> = { value: T; label: string }

const TYPE_OPTIONS: Option<Section['type']>[] = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片 Logo' },
  { value: 'divider', label: '分隔线' }
]

const ALIGN_OPTIONS: Option<LineAlign>[] = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' }
]

const SIZE_OPTIONS: Option<SectionSize>[] = [
  { value: 'normal', label: '标准' },
  { value: 'doubleHeight', label: '倍高' },
  { value: 'doubleWidth', label: '倍宽' },
  { value: 'quad', label: '双倍' }
]

// ── 实时预览样例数据（虚构店铺 + 三行商品，含超长中文名验证名称列折行；金额经 shared/utils/money 组装——G1）──
const SAMPLE_ITEMS: SaleReceiptData = {
  items: [
    { name: '经典奶茶（大杯）', quantity: '2', unitPrice: '15.00', subtotal: '30.00' },
    { name: '现烤菠萝包', quantity: '1', unitPrice: '6.50', subtotal: '6.50' },
    { name: '招牌秘制香辣鸡腿堡超级套餐（含饮品小食各一份）', quantity: '1', unitPrice: '39.90', subtotal: '39.90' }
  ]
}

const sampleVars = computed<ReceiptVars>(() => {
  const cents = SAMPLE_ITEMS.items.reduce((s, it) => s + parseMoneyToCents(it.subtotal), 0)
  const count = SAMPLE_ITEMS.items.reduce((s, it) => s + Number(it.quantity), 0)
  return {
    shopName: '测试商店',
    shopPhone: '138-0000-0000',
    receiptNote: '欢迎再次光临',
    saleNo: '20261101-0001',
    datetime: '2026-11-01 12:30:00',
    total: formatMoney(cents),
    itemCount: String(count)
  }
})

// ── 表单模型（与 ReceiptTemplate 字段一一对应）──

interface TemplateDraft {
  name: string
  paperWidth: PaperWidth
  cutPaper: boolean
  header: Section[]
  items: {
    showHeader: boolean
    nameLabel: string
    qtyLabel: string
    priceLabel: string
    subtotalLabel: string
    /**
     * 列宽覆盖（Partial：undefined 键 = 未覆盖，沿用纸宽默认）。
     * 恒为对象（空对象起步）便于 el-input-number 直接绑定；
     * 序列化时未覆盖键不写入 JSON（见 serializeColumnWidths）。
     */
    columnWidths: Partial<ItemColumnWidths>
  }
  totals: TotalLine[]
  footer: Section[]
}

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

// ── Logo 列表（设置页上传的多 Logo：image 段落选择 + 预览渲染）──

const logos = ref<LogoInfo[]>([])
const uploadingLogo = ref(false)

/** logo id → dataURL 映射（ReceiptPreview 预览渲染用） */
const logoUrlsMap = computed<Record<number, string>>(() =>
  Object.fromEntries(logos.value.map((l) => [l.id, l.data_url]))
)

async function loadLogos(): Promise<void> {
  logos.value = await window.api.settings.listLogos()
}

/** image 段落当前选中 logo 的缩略图 dataURL（未选中 → undefined） */
function logoThumbUrl(logoId: number | undefined): string | undefined {
  if (logoId === undefined) return undefined
  return logos.value.find((l) => l.id === logoId)?.data_url
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
    ElMessage.error(`Logo 上传失败：${ipcErrorMessage(err)}`)
  } finally {
    uploadingLogo.value = false
  }
}

// ── IPC 错误文案（Electron invoke 序列化前缀剥除——T8 模式）──

function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const m = raw.match(/^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  return m ? (m[1] as string) : raw
}

// ── 变量说明区（可折叠，默认展开；点击变量复制插槽原文）──

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

// ── 段落行操作（上移/下移/删除/添加——段落级为止，G14）──

type ListTarget = 'header' | 'footer' | 'totals'

function listAt(target: ListTarget): Array<Section | TotalLine> {
  return draft[target] as Array<Section | TotalLine>
}

function addLine(target: ListTarget): void {
  if (target === 'totals') {
    draft.totals.push({ type: 'total', label: '合计: ￥{total}', align: 'right' })
  } else {
    draft[target].push({ type: 'text', content: '', align: 'left' })
  }
}

function removeLine(target: ListTarget, idx: number): void {
  listAt(target).splice(idx, 1)
}

function moveLine(target: ListTarget, idx: number, step: -1 | 1): void {
  const arr = listAt(target)
  const to = idx + step
  if (to < 0 || to >= arr.length) return
  const [moved] = arr.splice(idx, 1)
  arr.splice(to, 0, moved)
}

function contentPlaceholder(type: Section['type']): string {
  if (type === 'divider') return '分隔线无需内容'
  return '文案，支持 {变量} 插槽'
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
    ElMessage.error(`保存失败：${ipcErrorMessage(err)}`)
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
    ElMessage.error(`删除失败：${ipcErrorMessage(err)}`)
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
    ElMessage.error(`设置默认失败：${ipcErrorMessage(err)}`)
  }
}

onMounted(async () => {
  try {
    await loadTemplates()
    autoSelect()
  } catch (err) {
    ElMessage.error(`模板加载失败：${ipcErrorMessage(err)}`)
  } finally {
    loading.value = false
  }
  // Logo 列表独立加载：失败不阻断模板编辑（image 段落选择降级为空列表 + 引导上传）
  try {
    await loadLogos()
  } catch (err) {
    ElMessage.warning(`Logo 列表加载失败：${ipcErrorMessage(err)}`)
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

        <el-collapse v-model="varsHelpActive" class="tpl-vars-help" data-testid="tpl-vars-help">
          <el-collapse-item name="vars">
            <template #title>
              <span class="tpl-vars-help__title" data-testid="tpl-vars-help-toggle">
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

          <section class="tpl-group">
            <div class="tpl-group__head">
              <h4 class="tpl-group__title">
                头部段落
                <span class="tpl-group__sub">小票顶部：店名 / 电话 / 分隔线</span>
              </h4>
              <el-popover placement="left-start" :width="280" trigger="click">
                <template #reference>
                  <el-icon class="tpl-vars-trigger" data-testid="tpl-vars">
                    <QuestionFilled />
                  </el-icon>
                </template>
                <div class="tpl-vars">
                  <p class="tpl-vars__title">内容可用变量插槽（打印时替换为实值）</p>
                  <p v-for="v in RECEIPT_VAR_DOCS" :key="v.name" class="tpl-vars__row">
                    <code>{{ varSlot(v.name) }}</code>
                    <span>{{ v.description }}</span>
                  </p>
                </div>
              </el-popover>
            </div>

            <p v-if="draft.header.length === 0" class="section-list__empty">暂无段落</p>
            <div
              v-for="(s, i) in draft.header"
              :key="`h-${i}`"
              class="section-row"
              data-testid="tpl-row-header"
            >
              <div class="section-row__main">
                <el-select v-model="s.type" data-testid="tpl-type">
                  <el-option v-for="o in TYPE_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
                </el-select>
                <!-- image 段落：Logo 选择（多 Logo；清空 = 未指定）+ 缩略图 + 上传入口 -->
                <div v-if="s.type === 'image'" class="logo-picker">
                  <el-select
                    v-model="s.logoId"
                    data-testid="tpl-logo-select"
                    class="logo-picker__select"
                    placeholder="未指定 Logo"
                    clearable
                    :disabled="logos.length === 0"
                  >
                    <el-option v-for="l in logos" :key="l.id" :value="l.id" :label="l.display_name" />
                  </el-select>
                  <el-image
                    v-if="logoThumbUrl(s.logoId)"
                    class="logo-picker__thumb"
                    :src="logoThumbUrl(s.logoId)"
                    fit="contain"
                    alt="已选 Logo 缩略图"
                  />
                  <el-button
                    text
                    type="primary"
                    :icon="Upload"
                    data-testid="tpl-logo-upload"
                    :loading="uploadingLogo"
                    @click="onUploadLogo"
                  >
                    上传
                  </el-button>
                  <span v-if="logos.length === 0" class="logo-picker__hint">
                    请先在 设置→小票Logo 上传
                  </span>
                </div>
                <el-input
                  v-else
                  v-model="s.content"
                  data-testid="tpl-content"
                  :disabled="s.type !== 'text'"
                  :placeholder="contentPlaceholder(s.type)"
                />
                <el-select v-model="s.align" data-testid="tpl-align" placeholder="对齐">
                  <el-option v-for="o in ALIGN_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
                </el-select>
                <el-select v-model="s.size" data-testid="tpl-size" placeholder="字号">
                  <el-option v-for="o in SIZE_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
                </el-select>
                <el-switch v-model="s.bold" data-testid="tpl-bold" />
              </div>
              <div class="section-row__ops">
                <el-button :icon="ArrowUp" text :disabled="i === 0" @click="moveLine('header', i, -1)" />
                <el-button
                  :icon="ArrowDown"
                  text
                  :disabled="i === draft.header.length - 1"
                  @click="moveLine('header', i, 1)"
                />
                <el-button :icon="Delete" text type="danger" @click="removeLine('header', i)" />
              </div>
            </div>

            <el-button
              class="section-add"
              text
              type="primary"
              :icon="Plus"
              data-testid="tpl-add-header"
              @click="addLine('header')"
            >
              添加头部段落
            </el-button>
          </section>

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

          <section class="tpl-group">
            <div class="tpl-group__head">
              <h4 class="tpl-group__title">
                合计区
                <span class="tpl-group__sub">小计之后的金额行（label 支持变量插槽）</span>
              </h4>
            </div>

            <p v-if="draft.totals.length === 0" class="section-list__empty">暂无合计行</p>
            <div
              v-for="(t, i) in draft.totals"
              :key="`t-${i}`"
              class="section-row section-row--total"
              data-testid="tpl-row-total"
            >
              <div class="section-row__main">
                <el-input
                  v-model="t.label"
                  data-testid="tpl-label"
                  placeholder="行文案，如 合计: ￥{total}"
                />
                <el-select v-model="t.align" data-testid="tpl-align" placeholder="对齐">
                  <el-option v-for="o in ALIGN_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
                </el-select>
                <el-select v-model="t.size" data-testid="tpl-size" placeholder="字号">
                  <el-option v-for="o in SIZE_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
                </el-select>
                <el-switch v-model="t.bold" data-testid="tpl-bold" />
              </div>
              <div class="section-row__ops">
                <el-button :icon="ArrowUp" text :disabled="i === 0" @click="moveLine('totals', i, -1)" />
                <el-button
                  :icon="ArrowDown"
                  text
                  :disabled="i === draft.totals.length - 1"
                  @click="moveLine('totals', i, 1)"
                />
                <el-button :icon="Delete" text type="danger" @click="removeLine('totals', i)" />
              </div>
            </div>

            <el-button
              class="section-add"
              text
              type="primary"
              :icon="Plus"
              data-testid="tpl-add-total"
              @click="addLine('totals')"
            >
              添加合计行
            </el-button>
          </section>

          <section class="tpl-group">
            <div class="tpl-group__head">
              <h4 class="tpl-group__title">
                底部段落
                <span class="tpl-group__sub">小票尾部：时间 / 致谢 / 备注</span>
              </h4>
              <el-popover placement="left-start" :width="280" trigger="click">
                <template #reference>
                  <el-icon class="tpl-vars-trigger" data-testid="tpl-vars">
                    <QuestionFilled />
                  </el-icon>
                </template>
                <div class="tpl-vars">
                  <p class="tpl-vars__title">内容可用变量插槽（打印时替换为实值）</p>
                  <p v-for="v in RECEIPT_VAR_DOCS" :key="v.name" class="tpl-vars__row">
                    <code>{{ varSlot(v.name) }}</code>
                    <span>{{ v.description }}</span>
                  </p>
                </div>
              </el-popover>
            </div>

            <p v-if="draft.footer.length === 0" class="section-list__empty">暂无段落</p>
            <div
              v-for="(s, i) in draft.footer"
              :key="`f-${i}`"
              class="section-row"
              data-testid="tpl-row-footer"
            >
              <div class="section-row__main">
                <el-select v-model="s.type" data-testid="tpl-type">
                  <el-option v-for="o in TYPE_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
                </el-select>
                <!-- image 段落：Logo 选择（多 Logo；清空 = 未指定）+ 缩略图 + 上传入口 -->
                <div v-if="s.type === 'image'" class="logo-picker">
                  <el-select
                    v-model="s.logoId"
                    data-testid="tpl-logo-select"
                    class="logo-picker__select"
                    placeholder="未指定 Logo"
                    clearable
                    :disabled="logos.length === 0"
                  >
                    <el-option v-for="l in logos" :key="l.id" :value="l.id" :label="l.display_name" />
                  </el-select>
                  <el-image
                    v-if="logoThumbUrl(s.logoId)"
                    class="logo-picker__thumb"
                    :src="logoThumbUrl(s.logoId)"
                    fit="contain"
                    alt="已选 Logo 缩略图"
                  />
                  <el-button
                    text
                    type="primary"
                    :icon="Upload"
                    data-testid="tpl-logo-upload"
                    :loading="uploadingLogo"
                    @click="onUploadLogo"
                  >
                    上传
                  </el-button>
                  <span v-if="logos.length === 0" class="logo-picker__hint">
                    请先在 设置→小票Logo 上传
                  </span>
                </div>
                <el-input
                  v-else
                  v-model="s.content"
                  data-testid="tpl-content"
                  :disabled="s.type !== 'text'"
                  :placeholder="contentPlaceholder(s.type)"
                />
                <el-select v-model="s.align" data-testid="tpl-align" placeholder="对齐">
                  <el-option v-for="o in ALIGN_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
                </el-select>
                <el-select v-model="s.size" data-testid="tpl-size" placeholder="字号">
                  <el-option v-for="o in SIZE_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
                </el-select>
                <el-switch v-model="s.bold" data-testid="tpl-bold" />
              </div>
              <div class="section-row__ops">
                <el-button :icon="ArrowUp" text :disabled="i === 0" @click="moveLine('footer', i, -1)" />
                <el-button
                  :icon="ArrowDown"
                  text
                  :disabled="i === draft.footer.length - 1"
                  @click="moveLine('footer', i, 1)"
                />
                <el-button :icon="Delete" text type="danger" @click="removeLine('footer', i)" />
              </div>
            </div>

            <el-button
              class="section-add"
              text
              type="primary"
              :icon="Plus"
              data-testid="tpl-add-footer"
              @click="addLine('footer')"
            >
              添加底部段落
            </el-button>
          </section>
        </el-form>
      </div>

      <section class="tpl-preview">
        <div class="tpl-preview__head">
          <span class="tpl-preview__title">实时预览</span>
          <span class="tpl-preview__hint">编辑即时刷新，无需保存 · 样例数据（{{ sampleVars.shopName }}）</span>
        </div>
        <div class="tpl-preview__stage">
          <ReceiptPreview
            :template="previewTemplate"
            :data="SAMPLE_ITEMS"
            :vars="sampleVars"
            :logo-urls="logoUrlsMap"
          />
        </div>
      </section>
    </section>
  </div>
</template>

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

.tpl-group {
  margin-top: 14px;
  padding: 14px 16px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.tpl-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.tpl-group__title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.tpl-group__head .tpl-group__title {
  margin: 0;
}

.tpl-group__sub {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.tpl-vars-trigger {
  font-size: 16px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
}

.tpl-vars-trigger:hover {
  color: var(--el-color-primary);
}

.tpl-vars__title {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tpl-vars__row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
  font-size: 12px;
}

.tpl-vars__row code {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--el-fill-color);
  font-family: 'NSimSun', 'SimSun', monospace;
  color: var(--el-color-primary);
}

.tpl-vars__row span {
  color: var(--el-text-color-regular);
}

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

/* ── 段落行编辑器 ── */
.section-list__empty,
.tpl-items :deep(.el-form-item) {
  margin-bottom: 0;
}

.section-list__empty {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.section-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
  padding: 9px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);
}

.section-row__main {
  flex: 1;
  display: grid;
  grid-template-columns: 118px minmax(200px, 1fr) 96px 106px 44px;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.section-row--total .section-row__main {
  grid-template-columns: minmax(220px, 1fr) 96px 106px 44px;
}

.section-row__ops {
  display: flex;
  flex-shrink: 0;
}

.section-row__ops .el-button {
  margin: 0;
  padding: 6px;
}

.section-add {
  margin-top: 2px;
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

/* ── 列宽输入（与列头文案输入同列对齐）+ 合计提示 ── */
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

/* ── image 段落：Logo 选择行（select + 缩略图 + 上传）── */
.logo-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.logo-picker__select {
  flex: 1;
  min-width: 0;
}

.logo-picker__thumb {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  background: #ffffff;
}

.logo-picker__hint {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ── 实时预览（底部常驻，T12 ReceiptPreview 同源渲染） ── */
.tpl-preview {
  flex: 0 0 auto;
  padding: 10px 20px 14px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-darker);
}

.tpl-preview__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
}

.tpl-preview__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.tpl-preview__hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tpl-preview__stage {
  display: flex;
  justify-content: center;
  max-height: 400px;
  overflow: auto;
  padding: 12px 0;
}
</style>
