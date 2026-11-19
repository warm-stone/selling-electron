<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown, ArrowUp, Delete, Plus, QuestionFilled, Upload } from '@element-plus/icons-vue'
import type { LineAlign } from '../../../../shared/receipt/char-grid'
import type {
  Section,
  SectionSize,
  TotalLine
} from '../../../../shared/receipt/template-schema'
import { RECEIPT_VAR_DOCS } from '../../../../shared/receipt/template-schema'
import type { LogoInfo } from '../../../../shared/types'
import { useTemplateDraft, type ListTarget } from './template-draft'

/**
 * 段落行编辑器（TemplateEditorView 拆分批次 4）：头部段落 / 合计区 / 底部段落
 * 三组共用（段落级为止，G14——无拖拽/逐元素样式；行操作=上移/下移/删除/添加）。
 *
 * 草稿经 useTemplateDraft 注入（页面级单一 reactive 模型——行内 v-model 直接
 * 读写，实时预览即时刷新；组头/文案/testid 差异收敛在 TARGET_META）。
 * image 段落的 Logo 选择：列表与上传态由父视图下发（logos/uploadingLogo props），
 * 上传动作 emit('upload-logo') 由父视图走 IPC 闭环。
 */

const props = defineProps<{
  target: ListTarget
  /** 设置页上传的多 Logo（image 段落选择 + 缩略图） */
  logos: LogoInfo[]
  uploadingLogo: boolean
}>()

const emit = defineEmits<{
  'upload-logo': []
}>()

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

/** 三组差异（标题/副题/变量弹注/testid/文案/行 key 前缀）——单 prop 驱动 */
const TARGET_META = {
  header: {
    title: '头部段落',
    sub: '小票顶部：店名 / 电话 / 分隔线',
    varsPopover: true,
    rowTestId: 'tpl-row-header',
    addTestId: 'tpl-add-header',
    addText: '添加头部段落',
    emptyText: '暂无段落',
    keyPrefix: 'h'
  },
  footer: {
    title: '底部段落',
    sub: '小票尾部：时间 / 致谢 / 备注',
    varsPopover: true,
    rowTestId: 'tpl-row-footer',
    addTestId: 'tpl-add-footer',
    addText: '添加底部段落',
    emptyText: '暂无段落',
    keyPrefix: 'f'
  },
  totals: {
    title: '合计区',
    sub: '小计之后的金额行（label 支持变量插槽）',
    varsPopover: false,
    rowTestId: 'tpl-row-total',
    addTestId: 'tpl-add-total',
    addText: '添加合计行',
    emptyText: '暂无合计行',
    keyPrefix: 't'
  }
} as const

const meta = computed(() => TARGET_META[props.target])

const draft = useTemplateDraft()

/** header/footer 分支行列表（totals 分支在模板内直读 draft.totals） */
const sections = computed<Section[]>(() =>
  props.target === 'totals' ? [] : (draft[props.target] as Section[])
)

// ── 段落行操作（上移/下移/删除/添加——段落级为止，G14）──

function listAt(): Array<Section | TotalLine> {
  return draft[props.target] as Array<Section | TotalLine>
}

function addLine(): void {
  if (props.target === 'totals') {
    draft.totals.push({ type: 'total', label: '合计: ￥{total}', align: 'right' })
  } else {
    ;(draft[props.target] as Section[]).push({ type: 'text', content: '', align: 'left' })
  }
}

function removeLine(idx: number): void {
  listAt().splice(idx, 1)
}

function moveLine(idx: number, step: -1 | 1): void {
  const arr = listAt()
  const to = idx + step
  if (to < 0 || to >= arr.length) return
  const [moved] = arr.splice(idx, 1)
  arr.splice(to, 0, moved)
}

function contentPlaceholder(type: Section['type']): string {
  if (type === 'divider') return '分隔线无需内容'
  return '文案，支持 {变量} 插槽'
}

/** 变量插槽原文（组头弹注展示；与 interpolateVariables 的 `{变量}` 语法一致） */
function varSlot(name: string): string {
  return `{${name}}`
}

/** image 段落当前选中 logo 的缩略图 dataURL（未选中 → undefined） */
function logoThumbUrl(logoId: number | undefined): string | undefined {
  if (logoId === undefined) return undefined
  return props.logos.find((l) => l.id === logoId)?.data_url
}
</script>

<template>
  <section class="tpl-group">
    <div class="tpl-group__head">
      <h4 class="tpl-group__title">
        {{ meta.title }}
        <span class="tpl-group__sub">{{ meta.sub }}</span>
      </h4>
      <el-popover v-if="meta.varsPopover" placement="left-start" :width="280" trigger="click">
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

    <!-- ── 合计区分支（label 单行文案 + 对齐/字号/加粗）── -->
    <template v-if="target === 'totals'">
      <p v-if="draft.totals.length === 0" class="section-list__empty">{{ meta.emptyText }}</p>
      <div
        v-for="(t, i) in draft.totals"
        :key="`${meta.keyPrefix}-${i}`"
        class="section-row section-row--total"
        :data-testid="meta.rowTestId"
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
          <el-button :icon="ArrowUp" text :disabled="i === 0" @click="moveLine(i, -1)" />
          <el-button
            :icon="ArrowDown"
            text
            :disabled="i === draft.totals.length - 1"
            @click="moveLine(i, 1)"
          />
          <el-button :icon="Delete" text type="danger" @click="removeLine(i)" />
        </div>
      </div>

      <el-button
        class="section-add"
        text
        type="primary"
        :icon="Plus"
        :data-testid="meta.addTestId"
        @click="addLine"
      >
        {{ meta.addText }}
      </el-button>
    </template>

    <!-- ── 头部/底部段落分支（类型 + Logo/文案 + 对齐/字号/加粗）── -->
    <template v-else>
      <p v-if="sections.length === 0" class="section-list__empty">{{ meta.emptyText }}</p>
      <div
        v-for="(s, i) in sections"
        :key="`${meta.keyPrefix}-${i}`"
        class="section-row"
        :data-testid="meta.rowTestId"
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
              @click="emit('upload-logo')"
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
          <el-button :icon="ArrowUp" text :disabled="i === 0" @click="moveLine(i, -1)" />
          <el-button
            :icon="ArrowDown"
            text
            :disabled="i === sections.length - 1"
            @click="moveLine(i, 1)"
          />
          <el-button :icon="Delete" text type="danger" @click="removeLine(i)" />
        </div>
      </div>

      <el-button
        class="section-add"
        text
        type="primary"
        :icon="Plus"
        :data-testid="meta.addTestId"
        @click="addLine"
      >
        {{ meta.addText }}
      </el-button>
    </template>
  </section>
</template>

<style scoped>
/* 组卡片骨架（.tpl-group 家族）在 assets/template-editor.css——视图与本组件共用 */

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

/* ── 段落行编辑器 ── */
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
</style>
